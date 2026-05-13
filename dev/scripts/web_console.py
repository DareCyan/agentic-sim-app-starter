from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import mimetypes
import os
import re
import signal
import socket
import sqlite3
import struct
import tempfile
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from common import (
    configure_stdio,
    detect_build_success,
    ensure_dir,
    format_display_time,
    is_process_running,
    load_runtime_state,
    now_local_iso,
    read_json,
    resolve_path,
    setup_logger,
    setup_stream_logger,
    update_runtime_state,
    windows_subprocess_kwargs,
)
from pipeline_monitor_lib import collect_state_files, handle_state_file, run_loop

REPO_ROOT = Path(__file__).resolve().parents[2]
SUCCESS_STATUSES = {"pushed", "completed", "dry_run_success_detected"}
INSTALL_DIR = REPO_ROOT / "dev" / "install"
BUNDLE_NAME = "com.example.hmdemo"


# ===== HDC device helpers (adapted from dev/install/images_app.py) =====

def _hdc_run(args: list[str], timeout: int = 30, **kw: Any) -> subprocess.CompletedProcess:
    return subprocess.run(["hdc"] + args, capture_output=True, text=True, timeout=timeout, **windows_subprocess_kwargs(), **kw)


def _sim_log(server: Any, msg: str) -> None:
    server.sim_build_logs.append(msg)
    server.logger.info("[sim-build] %s", msg)


def _sim_run(server: Any, device_id: str) -> None:
    """Run the full install+send workflow in a background thread."""
    steps = [
        "检查 HDC 命令",
        "连接设备",
        "卸载旧应用",
        "安装 HAP",
        "启动应用",
        "传输文件",
        "关闭应用",
    ]
    hap_path = INSTALL_DIR / "entry-default-signed.hap"
    output_folder = INSTALL_DIR / "output"

    try:
        server.sim_build_state = "running"
        server.sim_build_logs.clear()
        server.sim_build_step = 0

        # Step 0: check HDC
        _sim_log(server, f"[1/{len(steps)}] {steps[0]}...")
        try:
            _hdc_run(["--version"], timeout=5)
            _sim_log(server, "HDC 命令可用")
        except Exception as e:
            _sim_log(server, f"错误: HDC 命令不可用 - {e}")
            server.sim_build_state = "error"
            return
        server.sim_build_step = 1

        # Step 1: connect device
        _sim_log(server, f"[2/{len(steps)}] {steps[1]}: {device_id}")
        try:
            r = _hdc_run(["-t", device_id, "shell", "echo", "test"], timeout=10)
            if r.returncode != 0:
                _sim_log(server, "设备未连接，尝试 tconn...")
                _hdc_run(["tconn", device_id], timeout=10)
                time.sleep(2)
            _sim_log(server, f"设备 {device_id} 已连接")
        except Exception as e:
            _sim_log(server, f"错误: 设备连接失败 - {e}")
            server.sim_build_state = "error"
            return
        server.sim_build_step = 2

        # Start screen mirror loop (skip if already running for this device)
        if not server.sim_screen_running:
            try:
                _deploy_hosscrcpy(server, device_id)
                server.sim_screen_running = True
                threading.Thread(target=_sim_screen_loop, args=(server, device_id), name="sim-screen", daemon=True).start()
            except Exception as e:
                server.logger.warning("[screen-mirror] deploy failed in sim_run: %s", e)

        # Step 2: uninstall old app
        _sim_log(server, f"[3/{len(steps)}] {steps[2]}: {BUNDLE_NAME}")
        try:
            _hdc_run(["-t", device_id, "uninstall", BUNDLE_NAME], timeout=30)
            _sim_log(server, "旧应用已卸载（或不存在）")
        except Exception as e:
            _sim_log(server, f"卸载警告: {e}")
        server.sim_build_step = 3

        # Step 3: install HAP
        _sim_log(server, f"[4/{len(steps)}] {steps[3]}: {hap_path}")
        if not hap_path.exists():
            _sim_log(server, f"错误: HAP 文件不存在 - {hap_path}")
            server.sim_build_state = "error"
            return
        try:
            r = _hdc_run(["-t", device_id, "install", "-r", str(hap_path)], timeout=60)
            if r.returncode != 0:
                _sim_log(server, f"安装失败: {r.stderr}")
                server.sim_build_state = "error"
                return
            _sim_log(server, "HAP 安装成功")
            time.sleep(3)
        except Exception as e:
            _sim_log(server, f"错误: 安装异常 - {e}")
            server.sim_build_state = "error"
            return
        server.sim_build_step = 4

        # Step 4: start app
        _sim_log(server, f"[5/{len(steps)}] {steps[4]}: {BUNDLE_NAME}")
        try:
            r = _hdc_run(["-t", device_id, "shell", "aa", "start", "-a", "EntryAbility", "-b", BUNDLE_NAME], timeout=10)
            if r.returncode != 0:
                _sim_log(server, f"启动失败: {r.stderr}")
                server.sim_build_state = "error"
                return
            _sim_log(server, "应用已启动")
            time.sleep(2)
        except Exception as e:
            _sim_log(server, f"错误: 启动异常 - {e}")
            server.sim_build_state = "error"
            return
        server.sim_build_step = 5

        # Step 5: send files
        _sim_log(server, f"[6/{len(steps)}] {steps[5]}: {output_folder}")
        if not output_folder.exists():
            _sim_log(server, f"错误: output 目录不存在 - {output_folder}")
            server.sim_build_state = "error"
            return
        try:
            r = _hdc_run(
                ["-t", device_id, "file", "send", "-b", BUNDLE_NAME, ".", "./data/storage/el2/base/flight"],
                timeout=120,
                cwd=str(output_folder),
            )
            if r.returncode != 0:
                _sim_log(server, f"文件传输失败: {r.stderr or r.stdout}")
                server.sim_build_state = "error"
                return
            _sim_log(server, "文件传输成功")
        except Exception as e:
            _sim_log(server, f"错误: 传输异常 - {e}")
            server.sim_build_state = "error"
            return
        server.sim_build_step = 6

        # Step 6: stop app
        _sim_log(server, f"[7/{len(steps)}] {steps[6]}: {BUNDLE_NAME}")
        try:
            _hdc_run(["-t", device_id, "shell", "aa", "force-stop", BUNDLE_NAME], timeout=10)
            _sim_log(server, "应用已关闭")
        except Exception as e:
            _sim_log(server, f"关闭警告: {e}")

        _sim_log(server, "全部完成!")
        server.sim_build_state = "done"

    except Exception as e:
        _sim_log(server, f"未预期错误: {e}")
        server.sim_build_state = "error"
    finally:
        server.sim_screen_running = False


# ===== Screen mirror: HOScrcpy gRPC H.264 streaming =====

HOSCRCPY_DEVICE_PORT = 5000  # device-side port (-p param), Java default
HOSCRCPY_LOCAL_PORT = 36537  # local forwarding port (Java uses random 36000-37000)
HOSCRCPY_SO_REMOTE = "/data/local/tmp/libscreen_casting.z.so"
HOSCRCPY_AGENT_REMOTE = "/data/local/tmp/agent.so"
HOSCRCPY_GRPC_SOCKET = "scrcpy_grpc_socket"

# Kernel version → .so filename mapping (extracted from hosscrcpy-1.0.15-beta.jar)
_KERNEL_SO_MAP = {
    "5.10": "libscrcpy_server_5.10-20260114.z.so",
    "6.3": "libscrcpy_server_unix_6.3.1-20260113.z.so",
    "6.4": "libscrcpy_server_unix_6.4-20260113.z.so",
    "6.5": "libscrcpy_server_unix_6.5-20260313.z.so",
}
_FALLBACK_SO = "libscrcpy_server0.z.so"

# .so files — selection depends on uitest version:
#   uitest >= 6.0.2.2 → Unix kernel .so only (reverse order: 6.5 → 6.4 → 6.3.1)
#   uitest < 6.0.2.2 → HongMeng kernel .so (server1,2,3, 5.10)
_UNIX_SO_FILES = [
    "libscrcpy_server_unix_6.5-20260313.z.so",
    "libscrcpy_server_unix_6.4-20260113.z.so",
    "libscrcpy_server_unix_6.3.1-20260113.z.so",
]
_HONGMENG_SO_FILES = [
    "libscrcpy_server1.z.so",
    "libscrcpy_server2.z.so",
    "libscrcpy_server3.z.so",
    "libscrcpy_server_5.10-20260114.z.so",
]


def _hdc_get_kernel_version(device_id: str) -> str:
    """Get device kernel major.minor version (e.g. '5.10', '6.5')."""
    r = _hdc_run(["-t", device_id, "shell", "uname", "-r"], timeout=5)
    ver = r.stdout.strip()
    # "5.10.93" → "5.10"
    parts = ver.split(".")
    if len(parts) >= 2:
        return f"{parts[0]}.{parts[1]}"
    return ver


def _find_hosscrcpy_native() -> Path:
    """Find directory containing extracted .so files."""
    script_dir = Path(__file__).resolve().parent
    native_dir = script_dir / "hosscrcpy_native"
    if native_dir.is_dir():
        return native_dir
    raise RuntimeError("hosscrcpy_native/ directory not found next to web_console.py")


def _deploy_hosscrcpy(server: Any, device_id: str) -> None:
    """Prepare device for hosscrcpy streaming — deploy agent, wake screen."""
    native_dir = _find_hosscrcpy_native()

    # Kill existing uitest daemon
    _hdc_run(["-t", device_id, "shell", "pkill", "-f", "uitest"], timeout=3)
    _hdc_run(["-t", device_id, "shell", "rm", "-f", HOSCRCPY_SO_REMOTE, HOSCRCPY_AGENT_REMOTE], timeout=3)
    time.sleep(0.5)

    # Check uitest availability and store version
    r = _hdc_run(["-t", device_id, "shell", "/system/bin/uitest", "--version"], timeout=5)
    uitest_ver = r.stdout.strip().split("\n")[-1].strip() if r.stdout.strip() else ""
    server._uitest_version = uitest_ver
    server.logger.info("[screen-mirror] uitest version: %s (rc=%d)", uitest_ver, r.returncode)

    kernel = _hdc_get_kernel_version(device_id)
    server.logger.info("[screen-mirror] device kernel: %s", kernel)

    # Deploy agent.so — match Java version-based selection logic
    # uitest >= 5.1.1.2 → 1.1.3, >= 6.0.2.1 → 1.1.12, default → 1.2.3
    for agent_name in ["uitest_agent_1.1.3.so", "uitest_agent_1.2.3.so", "uitest_agent_1.1.12.so", "uitest_agent_1.1.5.so"]:
        agent_path = native_dir / agent_name
        if agent_path.exists():
            _hdc_run(["-t", device_id, "file", "send", str(agent_path), HOSCRCPY_AGENT_REMOTE], timeout=30)
            server.logger.info("[screen-mirror] deployed %s", agent_name)
            break

    # Prepare device: wake up, keep screen on
    _hdc_run(["-t", device_id, "shell", "power-shell", "wakeup"], timeout=3)
    _hdc_run(["-t", device_id, "shell", "power-shell", "setmode", "602"], timeout=3)
    _hdc_run(["-t", device_id, "shell", "power-shell", "timeout", "-o", "86400000"], timeout=3)

    server._hosscrcpy_device_id = device_id
    server.logger.info("[screen-mirror] device prepared, will try all .so files in streaming loop")


def _cleanup_hosscrcpy(server: Any, device_id: str) -> None:
    """Stop uitest on device and remove port forwarding."""
    try:
        _hdc_run(["-t", device_id, "fport", "rm", f"tcp:{HOSCRCPY_LOCAL_PORT}", f"localabstract:{HOSCRCPY_GRPC_SOCKET}"], timeout=3)
    except Exception:
        pass
    try:
        _hdc_run(["-t", device_id, "fport", "rm", f"tcp:{HOSCRCPY_LOCAL_PORT}", f"tcp:{HOSCRCPY_DEVICE_PORT}"], timeout=3)
    except Exception:
        pass
    try:
        _hdc_run(["-t", device_id, "shell", "pkill", "-f", "uitest"], timeout=3)
    except Exception:
        pass
    try:
        _hdc_run(["-t", device_id, "shell", "rm", "-f", HOSCRCPY_SO_REMOTE], timeout=3)
    except Exception:
        pass
    server.logger.info("[screen-mirror] hosscrcpy cleaned up")


def _socket_closed(sock):
    """Check if a socket is still open."""
    if sock is None:
        return True
    try:
        sock.settimeout(0)
        data = sock.recv(1, socket.MSG_PEEK)
        return False
    except (BlockingIOError, socket.timeout):
        return False
    except Exception:
        return True


def _reconnect_socket(port=HOSCRCPY_LOCAL_PORT):
    """Create a new socket connection to the device."""
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s.settimeout(5)
        s.connect(("127.0.0.1", port))
        return s
    except Exception:
        return None


def _sim_screen_loop(server: Any, device_id: str) -> None:
    """Screen streaming loop — try each .so for gRPC, fall back to hdc snapshots."""
    import json as _json

    def _try_so_grpc(so_name):
        """Deploy a specific .so, start uitest, attempt gRPC streaming. Returns frame count."""
        import grpc as _grpc
        from scrcpy_pb2 import Empty
        from scrcpy_pb2_grpc import ScrcpyServiceStub

        native_dir = _find_hosscrcpy_native()
        so_path = native_dir / "libscrcpy" / so_name
        if not so_path.exists():
            server.logger.info("[screen-mirror] %s not found, skip", so_name)
            return 0

        server.logger.info("[screen-mirror] === trying %s ===", so_name)

        # Kill existing uitest
        _hdc_run(["-t", device_id, "shell", "pkill", "-f", "uitest"], timeout=3)
        time.sleep(0.5)

        # Deploy this .so
        _hdc_run(["-t", device_id, "file", "send", str(so_path), HOSCRCPY_SO_REMOTE], timeout=30)

        # Step 1: Start PLAIN uitest first (load agent.so, like Java api/b.class does)
        _hdc_run(["-t", device_id, "shell", "/system/bin/uitest start-daemon singleness &"], timeout=5)
        time.sleep(2.0)

        # Step 2: Start extension uitest (load server .so, like Java HosRemoteDevice does)
        uitest_cmd = (
            f"/system/bin/uitest start-daemon singleness"
            f" --extension-name libscreen_casting.z.so"
            f" -scale 1 -frameRate 120 -bitRate 31457280"
            f" -p {HOSCRCPY_DEVICE_PORT} -iFrameInterval 2000 &"
        )
        _hdc_run(["-t", device_id, "shell", uitest_cmd], timeout=5)
        time.sleep(2.0)

        # Verify uitest is running
        r = _hdc_run(["-t", device_id, "shell", "pgrep", "-f", "uitest"], timeout=3)
        if r.returncode != 0:
            server.logger.info("[screen-mirror] %s: uitest not running after start", so_name)
            return 0

        # Remove old fport rules
        _hdc_run(["-t", device_id, "fport", "rm", f"tcp:{HOSCRCPY_LOCAL_PORT}", f"localabstract:{HOSCRCPY_GRPC_SOCKET}"], timeout=3)
        _hdc_run(["-t", device_id, "fport", "rm", f"tcp:{HOSCRCPY_LOCAL_PORT}", f"tcp:{HOSCRCPY_DEVICE_PORT}"], timeout=3)

        # fport: always try abstract socket first (uitest >= 6.0.2.1 uses abstract socket),
        # fallback to TCP port 5000
        fport_ok = False
        r1 = _hdc_run(["-t", device_id, "fport", f"tcp:{HOSCRCPY_LOCAL_PORT}", f"localabstract:{HOSCRCPY_GRPC_SOCKET}"], timeout=5)
        if r1.returncode == 0:
            server.logger.info("[screen-mirror] %s: fport abstract socket", so_name)
            fport_ok = True
        else:
            r2 = _hdc_run(["-t", device_id, "fport", f"tcp:{HOSCRCPY_LOCAL_PORT}", f"tcp:{HOSCRCPY_DEVICE_PORT}"], timeout=5)
            if r2.returncode == 0:
                server.logger.info("[screen-mirror] %s: fport TCP mode", so_name)
                fport_ok = True
        if not fport_ok:
            server.logger.info("[screen-mirror] %s: fport failed", so_name)
            return 0

        # Try gRPC connection (3 retries)
        channel = None
        stub = None
        for attempt in range(3):
            try:
                channel = _grpc.insecure_channel(
                    f"dns:///127.0.0.1:{HOSCRCPY_LOCAL_PORT}",
                    options=[
                        ("grpc.max_receive_message_length", 100 * 1024 * 1024),
                        ("grpc.keepalive_time_ms", 5000),
                        ("grpc.keepalive_timeout_ms", 3000),
                    ],
                )
                stub = ScrcpyServiceStub(channel)
                _grpc.channel_ready_future(channel).result(timeout=3)
                break
            except Exception:
                if channel:
                    try:
                        channel.close()
                    except Exception:
                        pass
                    channel = None
                    stub = None
                time.sleep(1.0)

        if not stub:
            server.logger.info("[screen-mirror] %s: gRPC channel failed", so_name)
            return 0

        server.logger.info("[screen-mirror] %s: gRPC connected!", so_name)

        # Request stream (no timeout — Java waits indefinitely)
        try:
            stream = stub.onStart(Empty())
        except Exception as e:
            server.logger.info("[screen-mirror] %s: onStart failed: %s", so_name, e)
            channel.close()
            return 0

        server.logger.info("[screen-mirror] %s: stream established, sending wakeup + uinput + IDR", so_name)

        # Match Java: wakeup + uinput AFTER stream start
        _hdc_run(["-t", device_id, "shell", "power-shell", "wakeup"], timeout=3)
        _hdc_run(["-t", device_id, "shell", "uinput", "-M", "-m", "100", "100", "200", "200", "--trace"], timeout=3)

        # Immediately request IDR frame
        try:
            stub.onRequestIDRFrame(Empty(), timeout=5)
            server.logger.info("[screen-mirror] %s: IDR request sent", so_name)
        except Exception as e:
            server.logger.info("[screen-mirror] %s: IDR request failed: %s", so_name, e)

        # Background: periodic IDR request + uinput trace
        _ts = threading.Event()

        def _bg():
            while not _ts.is_set():
                try:
                    stub.onRequestIDRFrame(Empty(), timeout=10)
                except Exception:
                    pass
                try:
                    _hdc_run(["-t", device_id, "shell", "uinput", "-M", "-m", "100", "100", "200", "200", "--trace"], timeout=3)
                except Exception:
                    pass
                _ts.wait(3.0)

        threading.Thread(target=_bg, daemon=True).start()

        # Decode H.264
        import av as _av
        from PIL import Image
        codec_ctx = _av.CodecContext.create("h264", "r")
        frame_count = 0
        msg_count = 0

        for reply in stream:
            if not server.sim_screen_running:
                break
            msg_count += 1

            # Java reads from payload["data"].val_bytes, NOT reply.data (string field)
            frame_bytes = None
            if "data" in reply.payload:
                pv = reply.payload["data"]
                if pv.HasField("val_bytes"):
                    frame_bytes = pv.val_bytes
                elif pv.HasField("val_string"):
                    frame_bytes = pv.val_string.encode("utf-8")
            # fallback: try reply.data (string field) and reply_type
            if not frame_bytes and reply.data:
                frame_bytes = reply.data.encode("utf-8") if isinstance(reply.data, str) else reply.data

            if msg_count <= 3:
                server.logger.info("[screen-mirror] %s: msg #%d, reply_type=%d, data=%d, payload_keys=%s",
                                  so_name, msg_count, reply.reply_type,
                                  len(reply.data) if reply.data else 0,
                                  list(reply.payload.keys()))

            if not frame_bytes:
                continue
            if frame_count == 0:
                server.logger.info("[screen-mirror] %s: FIRST FRAME! %d bytes, type=%d",
                                  so_name, len(frame_bytes), reply.reply_type)
            try:
                if not frame_bytes.startswith(b"\x00\x00\x00\x01"):
                    frame_bytes = b"\x00\x00\x00\x01" + frame_bytes
                for pkt in codec_ctx.parse(frame_bytes):
                    for frame in codec_ctx.decode(pkt):
                        rgb = frame.to_ndarray(format="rgb24")
                        img = Image.fromarray(rgb, "RGB")
                        buf = io.BytesIO()
                        img.save(buf, format="JPEG", quality=80)
                        server.sim_screen_jpeg = buf.getvalue()
                        frame_count += 1
                        if frame_count <= 5 or frame_count % 100 == 0:
                            server.logger.info("[screen-mirror] %s: frame #%d", so_name, frame_count)
                        break
            except Exception as e:
                if frame_count <= 3:
                    server.logger.warning("[screen-mirror] %s: decode: %s", so_name, e)

        _ts.set()
        try:
            codec_ctx.close()
        except Exception:
            pass
        try:
            channel.close()
        except Exception:
            pass
        server.logger.info("[screen-mirror] %s: got %d msgs, %d frames total", so_name, msg_count, frame_count)
        return frame_count

    def _snapshot_stream():
        """Reliable fallback: periodic hdc shell screencap."""
        server.logger.info("[screen-mirror] using hdc snapshot fallback")
        frame_count = 0
        _touch_stop = threading.Event()

        def _touch_loop():
            while not _touch_stop.is_set():
                try:
                    _hdc_run(["-t", device_id, "shell", "power-shell", "wakeup"], timeout=3)
                    _hdc_run(["-t", device_id, "shell", "uitest", "uiInput",
                              "click", "50", "50"], timeout=3)
                except Exception:
                    pass
                _touch_stop.wait(3.0)

        touch_thread = threading.Thread(target=_touch_loop, daemon=True)
        touch_thread.start()

        import tempfile
        remote_snap = "/data/local/tmp/screen.jpeg"
        while server.sim_screen_running:
            try:
                # Capture screenshot with explicit output path (Java uses -f flag)
                r = _hdc_run(["-t", device_id, "shell", "snapshot_display", "-f", remote_snap], timeout=5)
                if r.returncode == 0:
                    tmp = tempfile.NamedTemporaryFile(suffix=".jpeg", delete=False)
                    tmp.close()
                    r2 = _hdc_run(["-t", device_id, "file", "recv", remote_snap, tmp.name], timeout=5)
                    if r2.returncode == 0 and os.path.getsize(tmp.name) > 100:
                        from PIL import Image
                        img = Image.open(tmp.name)
                        buf = io.BytesIO()
                        img.save(buf, format="JPEG", quality=70)
                        server.sim_screen_jpeg = buf.getvalue()
                        frame_count += 1
                        if frame_count <= 3 or frame_count % 30 == 0:
                            server.logger.info("[screen-mirror] snapshot #%d, %d bytes",
                                              frame_count, len(server.sim_screen_jpeg))
                    try:
                        os.unlink(tmp.name)
                    except Exception:
                        pass
                    _hdc_run(["-t", device_id, "shell", "rm", "-f", remote_snap], timeout=2)
            except Exception as e:
                if frame_count <= 3:
                    server.logger.warning("[screen-mirror] snapshot error: %s", e)
            # ~2fps
            for _ in range(20):
                if not server.sim_screen_running:
                    break
                time.sleep(0.1)

        _touch_stop.set()
        return frame_count

    # --- gRPC streaming disabled (kernel compatibility issue), use snapshot ---
    # To re-enable gRPC, set USE_GRPC = True below.
    USE_GRPC = False

    if USE_GRPC:
        # Select .so list based on uitest version (match Java logic)
        uitest_ver = getattr(server, "_uitest_version", "")
        try:
            ver_parts = [int(x) for x in uitest_ver.split(".")]
            if ver_parts >= [6, 0, 2, 2]:
                so_list = _UNIX_SO_FILES
            else:
                so_list = _HONGMENG_SO_FILES
        except (ValueError, IndexError):
            so_list = _UNIX_SO_FILES + _HONGMENG_SO_FILES
        server.logger.info("[screen-mirror] uitest=%s, trying %d .so files: %s",
                          uitest_ver, len(so_list), so_list)

        for so_name in so_list:
            if not server.sim_screen_running:
                return
            try:
                frames = _try_so_grpc(so_name)
                if frames and frames > 0:
                    server.sim_screen_running = False
                    _cleanup_hosscrcpy(server, device_id)
                    server.logger.info("[screen-mirror] stream ended with %s, frames=%d", so_name, frames)
                    return
            except Exception as e:
                server.logger.info("[screen-mirror] %s failed: %s", so_name, e)
                continue

        server.logger.warning("[screen-mirror] no .so produced gRPC frames, using snapshot fallback")

    # Snapshot mode
    try:
        _snapshot_stream()
    finally:
        server.sim_screen_running = False
        _cleanup_hosscrcpy(server, device_id)
        server.logger.info("[screen-mirror] stream stopped")


def _sim_send_input(device_id: str, data: dict[str, Any]) -> bool:
    """Send input event to device. Returns True on success."""
    action = data.get("action", "")
    try:
        if action == "tap":
            x, y = int(data["x"]), int(data["y"])
            r = _hdc_run(["-t", device_id, "shell", "uitest", "uiInput", "click", str(x), str(y)], timeout=5)
            return r.returncode == 0
        elif action == "longpress":
            x, y = int(data["x"]), int(data["y"])
            r = _hdc_run(["-t", device_id, "shell", "uitest", "uiInput", "longClick", str(x), str(y)], timeout=5)
            return r.returncode == 0
        elif action == "swipe":
            x1, y1 = int(data["x"]), int(data["y"])
            x2, y2 = int(data["x2"]), int(data["y2"])
            dur = int(data.get("duration", 300))
            r = _hdc_run(["-t", device_id, "shell", "uitest", "uiInput", "swipe",
                          str(x1), str(y1), str(x2), str(y2), str(dur)], timeout=5)
            return r.returncode == 0
        elif action == "key":
            key = data.get("key", "BACK")
            r = _hdc_run(["-t", device_id, "shell", "uitest", "uiInput", "keyEvent", key], timeout=5)
            return r.returncode == 0
        elif action == "text":
            text = data.get("text", "")
            r = _hdc_run(["-t", device_id, "shell", "uitest", "uiInput", "inputText", text], timeout=5)
            return r.returncode == 0
    except Exception:
        return False
    return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="dev 本地任务控制台")
    parser.add_argument("--config", default="dev/config/pipeline.config.json", help="主配置文件路径")
    parser.add_argument("--selected", default="baseApp", help="默认选中的 pipeline")
    parser.add_argument("--host", default="0.0.0.0", help="Web 服务监听地址")
    parser.add_argument("--port", type=int, default=8765, help="Web 服务监听端口")
    parser.add_argument(
        "--log-file",
        default=None,
        help="将 Web 服务日志写入该文件（子进程/无控制台时便于排错）",
    )
    parser.add_argument("--dry-run", action="store_true", help="巡检使用 dry-run 模式")
    return parser.parse_args()


def load_config(config_path: Path) -> dict[str, Any]:
    return read_json(config_path)


def prepare_web_logger(log_path: Path | None) -> Any:
    if log_path is None:
        return setup_stream_logger("dev-web-console")
    ensure_dir(log_path.parent)
    return setup_logger("dev-web-console", log_path)


def find_available_port(host: str, starting_port: int, attempts: int = 20) -> int:
    for port in range(starting_port, starting_port + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if sock.connect_ex((host, port)) != 0:
                return port
    raise RuntimeError(f"无法找到可用端口，起始端口={starting_port}")


def read_log_content(path: Path) -> str:
    if not path.exists() or not path.is_file():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def get_safe_tmp_name(target_build: str) -> str:
    return target_build.replace("/", "-").replace("\\", "-").strip("-").lower()


def get_workspace_output_dir(target_build: str) -> Path:
    return REPO_ROOT / "tmp" / get_safe_tmp_name(target_build) / "entry" / "build" / "default" / "outputs" / "default"


def resolve_target_build_root(target_build: str) -> Path:
    return resolve_path(REPO_ROOT, target_build)


def list_artifact_candidates(target_build: str) -> list[Path]:
    candidates: list[Path] = []
    workspace_output = get_workspace_output_dir(target_build)
    if workspace_output.exists():
        candidates.extend(sorted(workspace_output.glob("*.hap"), key=lambda item: item.stat().st_mtime, reverse=True))

    source_output = resolve_target_build_root(target_build) / "entry" / "build" / "default" / "outputs" / "default"
    if source_output.exists():
        candidates.extend(sorted(source_output.glob("*.hap"), key=lambda item: item.stat().st_mtime, reverse=True))
    return candidates


def build_artifact_payload(
    target_build: str,
    state: dict[str, Any] | None,
    result_payload: dict[str, Any] | None,
    pipeline_key: str,
) -> dict[str, Any] | None:
    success = False
    if state:
        success = state.get("status") in SUCCESS_STATUSES
    if not success and result_payload:
        success = detect_build_success(result_payload, ["success", "succeeded", "ok", "passed", "true"])
    if not success and pipeline_key != "baseApp":
        return None

    candidates: list[Path] = []
    artifact_path = None if not result_payload else result_payload.get("artifactPath") or result_payload.get("artifact_path")
    if artifact_path:
        candidates.append(resolve_path(REPO_ROOT, str(artifact_path)))
    candidates.extend(list_artifact_candidates(target_build))

    seen: set[str] = set()
    for candidate in candidates:
        if not candidate.exists() or candidate.suffix.lower() != ".hap":
            continue
        key = str(candidate.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        return {
            "path": str(candidate.resolve()),
            "name": candidate.name,
            "sizeBytes": candidate.stat().st_size,
            "downloadUrl": f"/api/pipelines/current/artifact?pipeline={pipeline_key}",
        }
    return None


def extract_session_id_from_agent_log(log_path: str | None) -> str | None:
    if not log_path:
        return None
    path = Path(log_path)
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _, line in zip(range(40), handle):
                match = re.search(r"session id:\s*([A-Za-z0-9-]+)", line, re.IGNORECASE)
                if match:
                    return match.group(1)
    except OSError:
        return None
    return None


def terminate_pid(pid: int) -> bool:
    result = subprocess.run(
        ["taskkill", "/PID", str(pid), "/T", "/F"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        **windows_subprocess_kwargs(),
    )
    return result.returncode == 0


def list_web_console_pids(logger: Any) -> list[int]:
    current_pid = os.getpid()
    process_query = subprocess.run(
        [
            "powershell",
            "-Command",
            (
                "Get-CimInstance Win32_Process | "
                "Where-Object { $_.Name -eq 'python.exe' -or $_.Name -eq 'py.exe' } | "
                "Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"
            ),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        **windows_subprocess_kwargs(),
    )
    if process_query.returncode != 0 or not process_query.stdout.strip():
        return []

    try:
        payload = json.loads(process_query.stdout)
    except json.JSONDecodeError:
        logger.warning("无法解析 Web 控制台进程列表。")
        return []

    if isinstance(payload, dict):
        payload = [payload]

    script_name = str(Path(__file__).resolve()).lower()
    matches: list[int] = []
    for item in payload:
        pid = int(item.get("ProcessId") or 0)
        command_line = str(item.get("CommandLine") or "").lower()
        if not pid or pid == current_pid:
            continue
        if "web_console.py" not in command_line:
            continue
        if script_name not in command_line:
            continue
        matches.append(pid)
    return matches


def stop_pid(pid: int) -> bool:
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    return True


def stop_other_web_consoles(logger: Any) -> list[int]:
    stopped: list[int] = []
    for pid in list_web_console_pids(logger):
        if stop_pid(pid):
            stopped.append(pid)
    if stopped:
        logger.info("已停止历史 Web 控制台进程: %s", ", ".join(str(pid) for pid in stopped))
    return stopped


def compute_progress(state: dict[str, Any] | None, result_exists: bool) -> dict[str, Any]:
    if not state:
        current = 1 if not result_exists else 6
        return {
            "currentStep": current,
            "totalSteps": 6,
            "percent": int(current / 6 * 100),
            "label": "已构建" if result_exists else "未启动流水线",
            "steps": ["任务初始化", "仿真基线准备", "Agent 运行时", "状态巡检", "结果输出", "完成"],
        }

    inspection = state.get("inspection") or {}
    current = 1
    label = "任务初始化"
    status = state.get("status")

    if status in {"git_preparing", "git_ready"}:
        current = 2
        label = "仿真基线准备"
    elif status in {"agent_running"}:
        current = 3
        label = "Agent 运行时"
    elif status in {"inspection_running"} or inspection.get("status") == "running":
        current = 4
        label = "状态巡检"
    elif result_exists:
        current = 5
        label = "结果输出"

    if status in {"dry_run", "pushed", "completed", "build_failed", "agent_exited_without_result", "cancelled", "dry_run_success_detected"}:
        current = 6
        label = "完成"

    return {
        "currentStep": current,
        "totalSteps": 6,
        "percent": int(current / 6 * 100),
        "label": label,
        "steps": ["任务初始化", "仿真基线准备", "Agent 运行时", "状态巡检", "结果输出", "完成"],
    }


def build_agent_runtime_payload(state: dict[str, Any] | None) -> dict[str, Any]:
    runtime = dict((state or {}).get("agent", {}).get("runtime") or {})
    agent_state = (state or {}).get("agent") or {}
    session_id = (
        runtime.get("session_id")
        or runtime.get("sessionId")
        or agent_state.get("session_id")
        or agent_state.get("sessionId")
        or extract_session_id_from_agent_log(agent_state.get("log_path"))
        or os.environ.get("CODEX_SESSION_ID")
        or os.environ.get("OPENAI_SESSION_ID")
        or os.environ.get("OPENCODE_SESSION_ID")
    )
    runtime.setdefault("workspace", str(REPO_ROOT))
    _atype = (agent_state.get("type") or "codex_cli") if (state) else "codex_cli"
    runtime.setdefault("name", str(_atype).replace("_", " ").lower())
    runtime.setdefault("model", os.environ.get("CODEX_MODEL", "gpt-5.4"))
    runtime.setdefault("provider", os.environ.get("CODEX_PROVIDER", "openai"))
    runtime.setdefault("approval_policy", os.environ.get("CODEX_APPROVAL_POLICY", "never"))
    runtime.setdefault("sandbox_mode", os.environ.get("CODEX_SANDBOX_MODE", "danger-full-access"))
    runtime.setdefault("reasoning_effort", os.environ.get("CODEX_REASONING_EFFORT", "medium"))
    runtime.setdefault("reasoning_summary", os.environ.get("CODEX_REASONING_SUMMARY", "none"))
    if session_id:
        runtime["session_id"] = session_id
        runtime["sessionId"] = session_id
    return runtime


def get_pipeline_roots(repo_root: Path, config: dict[str, Any]) -> tuple[Path, Path]:
    baseline_root = ensure_dir(resolve_path(repo_root, config["paths"]["baseline_root"]))
    scenarios_root = ensure_dir(resolve_path(repo_root, config["paths"]["scenarios_root"]))
    return baseline_root, scenarios_root


def scenario_target_build(config: dict[str, Any], scenario_name: str) -> str:
    """config 中 scenarios 根路径的 POSIX 形式，供 targetBuild / build_artifact 使用。
    单独函数是为了避免在 f-string 表达式里写 .replace('\\\\', '/')（部分 Python 版本会 SyntaxError）。"""
    root = str(config["paths"]["scenarios_root"]).replace("\\", "/")
    return f"{root}/{scenario_name}"


def get_state_file_for_pipeline(pipeline_root: Path) -> Path | None:
    state_file = pipeline_root / "state" / "runtime.json"
    return state_file if state_file.exists() else None


def build_base_pipeline_summary(baseline_root_str: str) -> dict[str, Any]:
    return {
        "key": "baseApp",
        "name": "baseApp",
        "type": "baseApp",
        "targetBuild": baseline_root_str,
        "root": baseline_root_str,
        "status": "ready",
        "branchName": None,
        "updatedAt": format_display_time(now_local_iso()),
        "hasState": False,
        "hasArtifact": False,
    }


def list_pipeline_summaries(repo_root: Path, config: dict[str, Any]) -> list[dict[str, Any]]:
    baseline_root, scenarios_root = get_pipeline_roots(repo_root, config)
    baseline_root_str = config["paths"]["baseline_root"]
    items = [build_base_pipeline_summary(baseline_root_str)]
    for app_type_dir in sorted(scenarios_root.iterdir()):
        if not app_type_dir.is_dir():
            continue
        for scenario_root in sorted(app_type_dir.iterdir()):
            if not scenario_root.is_dir():
                continue
            scenario_key = f"{app_type_dir.name}/{scenario_root.name}"
            state_file = get_state_file_for_pipeline(scenario_root)
            state = load_runtime_state(state_file) if state_file else None
            tb = scenario_target_build(config, scenario_key)
            items.append(
                {
                    "key": scenario_key,
                    "name": scenario_key,
                    "type": "scenario",
                    "targetBuild": tb,
                    "root": str(scenario_root),
                    "status": (state or {}).get("status") or "idle",
                    "branchName": (state or {}).get("baseline_dir"),
                    "updatedAt": format_display_time((state or {}).get("updated_at")),
                    "hasState": bool(state),
                    "hasArtifact": bool(build_artifact_payload(tb, state, (state or {}).get("result_payload"), scenario_key)),
                }
            )
    return items


def get_pipeline_context(repo_root: Path, config: dict[str, Any], pipeline_key: str) -> dict[str, Any]:
    baseline_root, scenarios_root = get_pipeline_roots(repo_root, config)
    baseline_root_str = config["paths"]["baseline_root"]
    if pipeline_key == "baseApp":
        return {
            "key": "baseApp",
            "name": "baseApp",
            "type": "baseApp",
            "root": baseline_root_str,
            "target_build": baseline_root_str,
            "state_file": None,
        }

    scenario_root = scenarios_root / pipeline_key
    if not scenario_root.exists():
        raise FileNotFoundError(f"未找到 pipeline: {pipeline_key}")
    return {
        "key": pipeline_key,
        "name": pipeline_key,
        "type": "scenario",
        "root": scenario_root,
        "target_build": scenario_target_build(config, pipeline_key),
        "state_file": get_state_file_for_pipeline(scenario_root),
    }


def build_synthetic_payload(context: dict[str, Any]) -> dict[str, Any]:
    artifact = build_artifact_payload(context["target_build"], None, None, context["key"])
    progress = compute_progress(None, artifact is not None)
    return {
        "pipelineKey": context["key"],
        "pipelineType": context["type"],
        "pipelineName": context["name"],
        "pipelineRoot": str(context["root"]),
        "scenarioId": context["key"],
        "scenarioKey": context["key"],
        "scenarioInput": None,
        "scenarioQuestion": None,
        "appType": None,
        "appDisplayName": None,
        "baselineDir": None,
        "status": "ready" if artifact else "idle",
        "createdAt": None,
        "updatedAt": format_display_time(now_local_iso()),
        "runtimeStartedAt": None,
        "runtimeEndedAt": None,
        "logFile": None,
        "resultJson": None,
        "resultExists": False,
        "resultPayload": None,
        "artifact": artifact,
        "agent": {
            "type": None,
            "pid": None,
            "startedAt": None,
            "running": False,
            "logPath": None,
            "command": None,
            "workspace": str(REPO_ROOT),
            "sessionId": None,
            "runtime": build_agent_runtime_payload(None),
        },
        "inspection": {
            "status": "idle",
            "lastCheckedAt": None,
            "cycleCount": 0,
            "message": "该 pipeline 尚未启动自动化流水线",
        },
        "web": {},
        "progress": progress,
        "targetBuild": context["target_build"],
    }


def build_task_payload(repo_root: Path, config: dict[str, Any], pipeline_key: str) -> dict[str, Any]:
    context = get_pipeline_context(repo_root, config, pipeline_key)
    state_file = context["state_file"]
    if not state_file:
        return build_synthetic_payload(context)

    state = load_runtime_state(state_file)
    if not state:
        return build_synthetic_payload(context)

    result_json = Path(state["result_json"])
    result_payload = state.get("result_payload")
    if result_payload is None and result_json.exists():
        result_payload = read_json(result_json)
    artifact = build_artifact_payload(context["target_build"], state, result_payload, pipeline_key)
    agent_runtime = build_agent_runtime_payload(state)
    runtime_started_at = state.get("runtime_started_at") or state.get("created_at")
    runtime_ended_at = state.get("runtime_ended_at")
    if runtime_ended_at is None and state.get("status") in {
        "cancelled",
        "pushed",
        "completed",
        "build_failed",
        "agent_exited_without_result",
        "dry_run_success_detected",
    }:
        runtime_ended_at = (
            state.get("cancelled_at")
            or state.get("pushed_at")
            or state.get("completed_at")
            or state.get("updated_at")
        )
    return {
        "pipelineKey": state.get("pipeline_key") or pipeline_key,
        "pipelineType": state.get("pipeline_type") or context["type"],
        "pipelineName": state.get("pipeline_name") or pipeline_key,
        "pipelineRoot": state.get("pipeline_root") or str(context["root"]),
        "scenarioId": state.get("scenario_id"),
        "scenarioKey": state.get("scenario_key"),
        "scenarioInput": state.get("scenario_input"),
        "scenarioQuestion": state.get("scenario_question"),
        "appType": state.get("app_type"),
        "appDisplayName": state.get("app_display_name"),
        "baselineDir": state.get("baseline_dir"),
        "status": state.get("status"),
        "createdAt": format_display_time(state.get("created_at")),
        "updatedAt": format_display_time(state.get("updated_at")),
        "runtimeStartedAt": format_display_time(runtime_started_at),
        "runtimeEndedAt": format_display_time(runtime_ended_at),
        "logFile": state.get("log_file"),
        "resultJson": state.get("result_json"),
        "resultExists": result_json.exists(),
        "resultPayload": result_payload,
        "artifact": artifact,
        "agent": {
            "type": state.get("agent", {}).get("type"),
            "pid": state.get("agent", {}).get("pid"),
            "startedAt": format_display_time(state.get("agent", {}).get("started_at")),
            "running": is_process_running(state.get("agent", {}).get("pid")),
            "logPath": state.get("agent", {}).get("log_path"),
            "command": state.get("agent", {}).get("command"),
            "workspace": agent_runtime.get("workspace"),
            "sessionId": agent_runtime.get("session_id"),
            "runtime": agent_runtime,
        },
        "inspection": {
            "status": (state.get("inspection") or {}).get("status"),
            "lastCheckedAt": format_display_time((state.get("inspection") or {}).get("last_checked_at")),
            "cycleCount": (state.get("inspection") or {}).get("cycle_count"),
            "message": (state.get("inspection") or {}).get("message"),
        },
        "web": state.get("web") or {},
        "progress": compute_progress(state, result_json.exists()),
        "targetBuild": context["target_build"],
    }


def get_selected_pipeline(handler: "ConsoleHandler") -> str:
    parsed = urlparse(handler.path)
    query = parse_qs(parsed.query)
    return query.get("pipeline", [handler.server.selected])[0]


def mark_web_state(state_file: Path | None, logger: Any, host: str, port: int) -> None:
    if not state_file:
        return
    state = load_runtime_state(state_file)
    if not state:
        return
    state["web"] = {
        "host": host,
        "port": port,
        "url": f"http://{host}:{port}",
        "started_at": now_local_iso(),
        "pid": os.getpid(),
    }
    update_runtime_state(state_file, state, logger)


def mark_web_stopped(state_file: Path | None, logger: Any) -> None:
    if not state_file:
        return
    state = load_runtime_state(state_file)
    if not state:
        return
    web = state.get("web") or {}
    if web:
        web["stopped_at"] = now_local_iso()
        web["pid"] = None
        state["web"] = web
    state["updated_at"] = now_local_iso()
    update_runtime_state(state_file, state, logger)


def _build_openapi_spec() -> dict:
    return {
        "openapi": "3.0.3",
        "info": {"title": "Pipeline Console API", "version": "2.0.0", "description": "Web Console 后端 API 文档"},
        "servers": [{"url": "http://localhost:{port}", "description": "本地控制台"}],
        "tags": [
            {"name": "流水线", "description": "Pipeline 任务管理"},
            {"name": "异常场景", "description": "异常场景与分类树管理"},
            {"name": "异常表", "description": "多 Sheet 异常表管理"},
            {"name": "大模型", "description": "LLM 配置与调用"},
            {"name": "设备仿真", "description": "HDC 设备操作与屏幕镜像"},
        ],
        "paths": {
            "/api/pipelines": {
                "get": {"tags": ["流水线"], "summary": "列出所有流水线", "responses": {"200": {"description": "流水线列表"}}},
            },
            "/api/pipelines/current": {
                "get": {"tags": ["流水线"], "summary": "获取当前流水线任务详情", "responses": {"200": {"description": "任务详情"}}},
            },
            "/api/pipelines/current/logs": {
                "get": {"tags": ["流水线"], "summary": "获取流水线和 Agent 日志", "responses": {"200": {"description": "日志内容"}}},
            },
            "/api/pipelines/current/artifact": {
                "get": {"tags": ["流水线"], "summary": "下载构建产物", "responses": {"200": {"description": "构建产物文件"}}},
            },
            "/api/pipelines/current/terminate": {
                "post": {"tags": ["流水线"], "summary": "终止当前流水线", "responses": {"200": {"description": "终止结果"}}},
            },
            "/api/sheets": {
                "get": {"tags": ["异常表"], "summary": "列出所有异常表", "responses": {"200": {"description": "异常表列表", "content": {"application/json": {"schema": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "integer"}, "name": {"type": "string"}, "is_base": {"type": "integer"}}}}}}}}},
                "post": {
                    "tags": ["异常表"], "summary": "创建新异常表（复制基础表的应用树和异常分类树）",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string", "description": "异常表名称"}}}}}},
                    "responses": {"200": {"description": "创建成功"}},
                },
            },
            "/api/sheets/{id}": {
                "put": {
                    "tags": ["异常表"], "summary": "重命名异常表",
                    "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}],
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "重命名成功"}},
                },
                "delete": {
                    "tags": ["异常表"], "summary": "删除异常表（不可删除基础表）",
                    "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}],
                    "responses": {"200": {"description": "删除成功"}, "400": {"description": "不能删除基础表"}, "404": {"description": "异常表不存在"}},
                },
            },
            "/api/issues/apps": {
                "get": {
                    "tags": ["异常场景"], "summary": "获取应用/流程列表",
                    "parameters": [{"name": "sheet_id", "in": "query", "schema": {"type": "integer", "default": 1}}],
                    "responses": {"200": {"description": "应用列表"}},
                },
            },
            "/api/issues/apps/edit": {
                "post": {
                    "tags": ["异常场景"], "summary": "编辑应用树（添加/删除/重命名）",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["action"], "properties": {"action": {"type": "string", "enum": ["add", "delete", "rename"]}, "sheet_id": {"type": "integer"}, "category": {"type": "string"}, "flow": {"type": "string"}, "new_category": {"type": "string"}, "new_flow": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "操作结果"}},
                },
            },
            "/api/issues/matrix": {
                "get": {
                    "tags": ["异常场景"], "summary": "获取异常分类矩阵（L1→L2→L3 层级）",
                    "parameters": [{"name": "sheet_id", "in": "query", "schema": {"type": "integer", "default": 1}}],
                    "responses": {"200": {"description": "分类矩阵"}},
                },
            },
            "/api/issues/details": {
                "get": {
                    "tags": ["异常场景"], "summary": "获取所有异常场景详情",
                    "parameters": [{"name": "sheet_id", "in": "query", "schema": {"type": "integer", "default": 1}}],
                    "responses": {"200": {"description": "场景详情列表"}},
                },
            },
            "/api/issues/fault-types/edit": {
                "post": {
                    "tags": ["异常场景"], "summary": "编辑异常分类树（添加/删除/重命名 L1/L2/L3）",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["action", "level", "name"], "properties": {"action": {"type": "string", "enum": ["add", "delete", "rename"]}, "sheet_id": {"type": "integer"}, "level": {"type": "string", "enum": ["L1", "L2", "L3"]}, "name": {"type": "string"}, "parent_id": {"type": "integer"}, "id": {"type": "integer"}}}}}},
                    "responses": {"200": {"description": "操作结果"}},
                },
            },
            "/api/issues/insert": {
                "post": {
                    "tags": ["异常场景"], "summary": "插入新异常场景",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["app", "flow", "l2_name", "l3_name", "description"], "properties": {"app": {"type": "string"}, "flow": {"type": "string"}, "l2_name": {"type": "string"}, "l3_name": {"type": "string"}, "l1_name": {"type": "string"}, "description": {"type": "string"}, "priority": {"type": "string"}, "questions": {"type": "array", "items": {"type": "string"}}, "sheet_id": {"type": "integer"}, "new_app_category": {"type": "string"}, "new_flow": {"type": "string"}, "new_l2": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "插入结果"}},
                },
            },
            "/api/issues/generalize-insert": {
                "post": {
                    "tags": ["异常场景"], "summary": "批量插入泛化结果",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "properties": {"results": {"type": "array", "items": {"type": "object"}}, "sheet_id": {"type": "integer"}}}}}},
                    "responses": {"200": {"description": "插入统计"}},
                },
            },
            "/api/issues/seed": {
                "post": {"tags": ["异常场景"], "summary": "重置数据库（从种子文件恢复）", "responses": {"200": {"description": "重置完成"}}},
            },
            "/api/user/config": {
                "get": {"tags": ["大模型"], "summary": "获取大模型配置", "responses": {"200": {"description": "LLM 配置"}}},
                "post": {
                    "tags": ["大模型"], "summary": "保存大模型配置",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "properties": {"llm_api_url": {"type": "string"}, "llm_api_key": {"type": "string"}, "llm_model": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "保存结果"}},
                },
            },
            "/api/llm/validate": {
                "post": {
                    "tags": ["大模型"], "summary": "验证大模型配置",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "properties": {"api_url": {"type": "string"}, "api_key": {"type": "string"}, "model": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "验证结果"}},
                },
            },
            "/api/llm/classify": {
                "post": {
                    "tags": ["大模型"], "summary": "AI 分类异常描述",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["description"], "properties": {"description": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "分类结果"}},
                },
            },
            "/api/llm/generalize": {
                "post": {
                    "tags": ["大模型"], "summary": "AI 泛化异常场景",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "properties": {"question": {"type": "string"}, "app": {"type": "string"}, "flow": {"type": "string"}, "l3_name": {"type": "string"}, "direction": {"type": "string", "enum": ["row", "col"]}}}}}},
                    "responses": {"200": {"description": "泛化结果"}},
                },
            },
            "/api/sim-build/devices": {
                "get": {"tags": ["设备仿真"], "summary": "列出已连接的 HDC 设备", "responses": {"200": {"description": "设备列表"}}},
            },
            "/api/sim-build/status": {
                "get": {"tags": ["设备仿真"], "summary": "获取仿真构建状态", "responses": {"200": {"description": "状态信息"}}},
            },
            "/api/sim-build/screen": {
                "get": {"tags": ["设备仿真"], "summary": "获取设备屏幕截图（JPEG）", "responses": {"200": {"description": "JPEG 图片", "content": {"image/jpeg": {"schema": {"type": "string", "format": "binary"}}}}}},
            },
            "/api/sim-build/resolution": {
                "get": {"tags": ["设备仿真"], "summary": "获取设备屏幕分辨率", "responses": {"200": {"description": "分辨率信息"}}},
            },
            "/api/sim-build/mirror": {
                "post": {
                    "tags": ["设备仿真"], "summary": "启动屏幕镜像",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["device_id"], "properties": {"device_id": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "启动结果"}},
                },
            },
            "/api/sim-build/run": {
                "post": {
                    "tags": ["设备仿真"], "summary": "执行仿真构建（安装 HAP + 传输文件）",
                    "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "required": ["device_id"], "properties": {"device_id": {"type": "string"}}}}}},
                    "responses": {"200": {"description": "构建启动结果"}},
                },
            },
            "/api/sim-build/input": {
                "post": {"tags": ["设备仿真"], "summary": "发送触摸/按键输入到设备", "responses": {"200": {"description": "发送结果"}}},
            },
            "/api/console/shutdown": {
                "post": {"tags": ["流水线"], "summary": "关闭 Web 控制台", "responses": {"200": {"description": "关闭确认"}}},
            },
        },
    }


def _build_swagger_html() -> str:
    spec_json = json.dumps(_build_openapi_spec(), ensure_ascii=False, indent=2)
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>API 文档 — Pipeline Console</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>
html {{ box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }}
*, *:before, *:after {{ box-sizing: inherit; }}
body {{ margin: 0; background: #fafafa; }}
.swagger-ui .topbar {{ display: none; }}
.swagger-ui .info .title {{ font-size: 28px; }}
</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
SwaggerUIBundle({{
  spec: {spec_json},
  dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
  layout: "BaseLayout",
  docExpansion: "list",
  defaultModelsExpandDepth: 1,
  tryItOutEnabled: true,
}})
</script>
</body>
</html>"""


class ConsoleHandler(BaseHTTPRequestHandler):
    server_version = "DevConsole/2.0"

    def _send_json(self, payload: dict[str, Any] | list[Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path) -> None:
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def _send_download_file(self, path: Path) -> None:
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api-docs":
            html = _build_swagger_html().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return

        pipeline_key = get_selected_pipeline(self)
        if parsed.path == "/api/pipelines":
            payload = {
                "selected": pipeline_key,
                "items": list_pipeline_summaries(self.server.repo_root, self.server.config),
            }
            self._send_json(payload)
            return
        if parsed.path == "/api/pipelines/current":
            self._send_json(build_task_payload(self.server.repo_root, self.server.config, pipeline_key))
            return
        if parsed.path == "/api/pipelines/current/logs":
            context = get_pipeline_context(self.server.repo_root, self.server.config, pipeline_key)
            state = load_runtime_state(context["state_file"]) if context["state_file"] else {}
            payload = {
                "pipelineLog": read_log_content(Path((state or {}).get("log_file", ""))),
                "agentLog": read_log_content(Path(((state or {}).get("agent", {}) or {}).get("log_path", ""))),
            }
            self._send_json(payload)
            return
        if parsed.path == "/api/pipelines/current/artifact":
            task = build_task_payload(self.server.repo_root, self.server.config, pipeline_key)
            artifact = task.get("artifact") or {}
            path_value = artifact.get("path")
            artifact_path = Path(str(path_value)).resolve() if path_value else None
            if artifact_path is None or not artifact_path.exists():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._send_download_file(artifact_path)
            return

        if parsed.path == "/api/issues/apps":
            qs = parse_qs(parsed.query)
            sid = int(qs.get("sheet_id", ["1"])[0])
            rows = self.server.db.execute("SELECT category, flow FROM apps WHERE sheet_id=? ORDER BY id", (sid,)).fetchall()
            self._send_json([{"category": r[0], "flow": r[1]} for r in rows])
            return

        if parsed.path == "/api/sheets":
            rows = self.server.db.execute("SELECT id, name, is_base FROM sheets ORDER BY id").fetchall()
            self._send_json([{"id": r[0], "name": r[1], "is_base": r[2]} for r in rows])
            return

        if parsed.path == "/api/issues/matrix":
            qs = parse_qs(parsed.query)
            sid = int(qs.get("sheet_id", ["1"])[0])
            db = self.server.db
            # L1 domains
            l1_rows = db.execute("SELECT id, name FROM fault_types WHERE level='L1' AND sheet_id=? ORDER BY id", (sid,)).fetchall()
            matrix = []
            for l1_id, l1_name in l1_rows:
                # L2 types under this domain
                l2_rows = db.execute(
                    "SELECT id, name FROM fault_types WHERE level='L2' AND parent_id=? ORDER BY id",
                    (l1_id,)).fetchall()
                types = []
                for l2_id, l2_name in l2_rows:
                    # L3 columns under this L2 (one per CSV column)
                    l3_rows = db.execute(
                        "SELECT id, name, description FROM fault_types WHERE level='L3' AND parent_id=? ORDER BY id",
                        (l2_id,)).fetchall()
                    l3_cols = [{"id": r[0], "name": r[1], "example": r[2] or ""} for r in l3_rows]
                    types.append({"id": l2_id, "name": l2_name, "columns": l3_cols})
                matrix.append({"column": l1_name, "l1_id": l1_id, "types": types})
            self._send_json(matrix)
            return

        if parsed.path == "/api/issues/details":
            qs = parse_qs(parsed.query)
            sid = int(qs.get("sheet_id", ["1"])[0])
            db = self.server.db
            rows = db.execute("""
                SELECT s.app, s.flow, s.priority, s.description, s.questions,
                       l3.name AS l3_name, l2.name AS category, l1.name AS domain
                FROM scenarios s
                JOIN fault_types l3 ON s.fault_type_id = l3.id
                JOIN fault_types l2 ON l3.parent_id = l2.id
                JOIN fault_types l1 ON l2.parent_id = l1.id
                WHERE s.sheet_id=?
                ORDER BY s.id
            """, (sid,)).fetchall()
            result = []
            for app, flow, pri, desc, questions_json, l3_name, category, domain in rows:
                result.append({
                    "app": app, "flow": flow,
                    "exception_column": domain, "exception_type": domain,
                    "exception_category": category, "exception_description": desc,
                    "exception_l3": l3_name,
                    "_priority": pri,
                    "questions": json.loads(questions_json) if questions_json else [],
                })
            self._send_json(result)
            return

        if parsed.path == "/api/user/config":
            rows = self.server.db.execute("SELECT key, value FROM user_config").fetchall()
            config = {}
            for k, v in rows:
                if k == "llm_api_key" and v and len(v) > 8:
                    v = v[:4] + "****" + v[-4:]
                config[k] = v
            self._send_json(config)
            return

        if parsed.path == "/api/sim-build/devices":
            try:
                result = _hdc_run(["list", "targets"], timeout=5)
                lines = [l.strip() for l in result.stdout.splitlines() if l.strip() and l.strip() != "Empty"]
                self._send_json({"devices": lines})
            except Exception:
                self._send_json({"devices": []})
            return

        if parsed.path == "/api/sim-build/status":
            self._send_json({
                "state": self.server.sim_build_state,
                "step": self.server.sim_build_step,
                "logs": self.server.sim_build_logs,
            })
            return

        if parsed.path == "/api/sim-build/screen":
            jpeg = self.server.sim_screen_jpeg
            if not jpeg:
                self.server.logger.debug("[screen] no frame available yet")
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.server.logger.debug("[screen] serving frame, size=%d bytes", len(jpeg))
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(jpeg)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(jpeg)
            return

        if parsed.path == "/api/sim-build/resolution":
            w, h = self.server.sim_screen_resolution
            self.server.logger.debug("[screen] resolution requested: %dx%d", w, h)
            self._send_json({"width": w, "height": h})
            return

        static_path = self.server.static_root / parsed.path.lstrip("/")
        if parsed.path in {"/", ""}:
            static_path = self.server.static_root / "index.html"
        resolved_static = static_path.resolve()
        static_root = self.server.static_root.resolve()
        if resolved_static.is_file() and (resolved_static == static_root or static_root in resolved_static.parents):
            self._send_file(static_path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)

        # ===== Sheet management =====
        if parsed.path == "/api/sheets":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            name = (data.get("name") or "").strip()
            if not name:
                self._send_json({"ok": False, "message": "name required"}, HTTPStatus.BAD_REQUEST)
                return
            db = self.server.db
            # Create sheet
            cur = db.execute("INSERT INTO sheets (name, is_base) VALUES (?, 0)", (name,))
            new_sid = cur.lastrowid
            # Copy apps from base (sheet_id=1)
            base_apps = db.execute("SELECT category, flow FROM apps WHERE sheet_id=1").fetchall()
            for cat, flow in base_apps:
                db.execute("INSERT INTO apps (sheet_id, category, flow) VALUES (?, ?, ?)", (new_sid, cat, flow))
            # Copy fault_types from base, preserving hierarchy
            old_to_new: dict[int, int] = {}
            for level in ("L1", "L2", "L3"):
                rows = db.execute(
                    "SELECT id, parent_id, name, description FROM fault_types WHERE level=? AND sheet_id=1 ORDER BY id",
                    (level,)).fetchall()
                for old_id, old_parent, ft_name, ft_desc in rows:
                    new_parent = old_to_new.get(old_parent) if old_parent else None
                    c = db.execute(
                        "INSERT INTO fault_types (sheet_id, parent_id, level, name, description) VALUES (?, ?, ?, ?, ?)",
                        (new_sid, new_parent, level, ft_name, ft_desc or ""))
                    old_to_new[old_id] = c.lastrowid
            db.commit()
            self._send_json({"ok": True, "sheet_id": new_sid, "name": name})
            return

        # ===== App tree editing =====
        if parsed.path == "/api/issues/apps/edit":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            db = self.server.db
            sid = int(data.get("sheet_id", 1))
            action = data.get("action", "")
            if action == "add":
                cat = (data.get("category") or "").strip()
                flow = (data.get("flow") or "").strip()
                if not cat or not flow:
                    self._send_json({"ok": False, "message": "category and flow required"}, HTTPStatus.BAD_REQUEST)
                    return
                exists = db.execute("SELECT id FROM apps WHERE sheet_id=? AND category=? AND flow=?", (sid, cat, flow)).fetchone()
                if exists:
                    self._send_json({"ok": False, "message": "already exists"}, HTTPStatus.BAD_REQUEST)
                    return
                db.execute("INSERT INTO apps (sheet_id, category, flow) VALUES (?, ?, ?)", (sid, cat, flow))
                db.commit()
                self._send_json({"ok": True})
            elif action == "delete":
                cat = (data.get("category") or "").strip()
                flow = (data.get("flow") or "").strip()
                if not cat or not flow:
                    self._send_json({"ok": False, "message": "category and flow required"}, HTTPStatus.BAD_REQUEST)
                    return
                db.execute("DELETE FROM apps WHERE sheet_id=? AND category=? AND flow=?", (sid, cat, flow))
                db.execute("DELETE FROM scenarios WHERE sheet_id=? AND app=? AND flow=?", (sid, cat, flow))
                db.commit()
                self._send_json({"ok": True})
            elif action == "rename":
                cat = (data.get("category") or "").strip()
                flow = (data.get("flow") or "").strip()
                new_cat = (data.get("new_category") or "").strip()
                new_flow = (data.get("new_flow") or "").strip()
                if not cat or not flow or not new_cat or not new_flow:
                    self._send_json({"ok": False, "message": "all fields required"}, HTTPStatus.BAD_REQUEST)
                    return
                db.execute("UPDATE apps SET category=?, flow=? WHERE sheet_id=? AND category=? AND flow=?",
                           (new_cat, new_flow, sid, cat, flow))
                db.execute("UPDATE scenarios SET app=?, flow=? WHERE sheet_id=? AND app=? AND flow=?",
                           (new_cat, new_flow, sid, cat, flow))
                db.commit()
                self._send_json({"ok": True})
            else:
                self._send_json({"ok": False, "message": "unknown action"}, HTTPStatus.BAD_REQUEST)
            return

        # ===== Fault type tree editing =====
        if parsed.path == "/api/issues/fault-types/edit":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            db = self.server.db
            sid = int(data.get("sheet_id", 1))
            action = data.get("action", "")
            if action == "add":
                level = data.get("level", "")
                name = (data.get("name") or "").strip()
                parent_id = data.get("parent_id")
                if not level or not name:
                    self._send_json({"ok": False, "message": "level and name required"}, HTTPStatus.BAD_REQUEST)
                    return
                if level not in ("L1", "L2", "L3"):
                    self._send_json({"ok": False, "message": "invalid level"}, HTTPStatus.BAD_REQUEST)
                    return
                if level == "L1":
                    parent_id = None
                elif parent_id is None:
                    self._send_json({"ok": False, "message": "parent_id required for L2/L3"}, HTTPStatus.BAD_REQUEST)
                    return
                exists = db.execute("SELECT id FROM fault_types WHERE sheet_id=? AND level=? AND name=? AND (parent_id=? OR (? IS NULL AND parent_id IS NULL))",
                                    (sid, level, name, parent_id, parent_id)).fetchone()
                if exists:
                    self._send_json({"ok": False, "message": "already exists"}, HTTPStatus.BAD_REQUEST)
                    return
                c = db.execute("INSERT INTO fault_types (sheet_id, parent_id, level, name, description) VALUES (?, ?, ?, ?, '')",
                               (sid, parent_id, level, name))
                db.commit()
                self._send_json({"ok": True, "id": c.lastrowid})
            elif action == "delete":
                ft_id = data.get("id")
                if ft_id is None:
                    self._send_json({"ok": False, "message": "id required"}, HTTPStatus.BAD_REQUEST)
                    return
                # Delete children recursively (L2→L3, L1→L2→L3)
                children = db.execute("SELECT id FROM fault_types WHERE parent_id=? AND sheet_id=?", (ft_id, sid)).fetchall()
                for (child_id,) in children:
                    grandkids = db.execute("SELECT id FROM fault_types WHERE parent_id=? AND sheet_id=?", (child_id, sid)).fetchall()
                    for (gk_id,) in grandkids:
                        db.execute("DELETE FROM scenarios WHERE fault_type_id=? AND sheet_id=?", (gk_id, sid))
                    db.execute("DELETE FROM fault_types WHERE parent_id=? AND sheet_id=?", (child_id, sid))
                    db.execute("DELETE FROM scenarios WHERE fault_type_id=? AND sheet_id=?", (child_id, sid))
                db.execute("DELETE FROM fault_types WHERE id=? AND sheet_id=?", (ft_id, sid))
                db.commit()
                self._send_json({"ok": True})
            elif action == "rename":
                ft_id = data.get("id")
                new_name = (data.get("name") or "").strip()
                if ft_id is None or not new_name:
                    self._send_json({"ok": False, "message": "id and name required"}, HTTPStatus.BAD_REQUEST)
                    return
                db.execute("UPDATE fault_types SET name=? WHERE id=? AND sheet_id=?", (new_name, ft_id, sid))
                db.commit()
                self._send_json({"ok": True})
            else:
                self._send_json({"ok": False, "message": "unknown action"}, HTTPStatus.BAD_REQUEST)
            return

        pipeline_key = get_selected_pipeline(self)
        if parsed.path == "/api/pipelines/current/terminate":
            context = get_pipeline_context(self.server.repo_root, self.server.config, pipeline_key)
            state_file = context["state_file"]
            if not state_file:
                self._send_json({"ok": False, "message": "state_not_found"}, status=HTTPStatus.NOT_FOUND)
                return
            state = load_runtime_state(state_file)
            if not state:
                self._send_json({"ok": False, "message": "state_not_found"}, status=HTTPStatus.NOT_FOUND)
                return
            pid = state.get("agent", {}).get("pid")
            running = is_process_running(pid)
            if running:
                terminate_pid(int(pid))
            state["status"] = "cancelled"
            state["cancelled_at"] = now_local_iso()
            state["runtime_ended_at"] = state["cancelled_at"]
            state["cancel_reason"] = "terminated_from_web"
            inspection = state.get("inspection") or {}
            inspection["status"] = "cancelled"
            inspection["message"] = "任务已由控制台终止"
            inspection["last_checked_at"] = inspection.get("last_checked_at") or state["cancelled_at"]
            state["inspection"] = inspection
            state["updated_at"] = state["cancelled_at"]
            update_runtime_state(state_file, state, self.server.logger)
            self._send_json({"ok": True, "terminated": running, "status": state["status"]})
            return

        if parsed.path == "/api/console/shutdown":
            context = get_pipeline_context(self.server.repo_root, self.server.config, self.server.selected)
            mark_web_stopped(context["state_file"], self.server.logger)
            self._send_json({"ok": True, "message": "console_shutting_down"})
            self.server.stop_event.set()
            try:
                self.wfile.flush()
            except OSError:
                pass

            def _exit_after_response() -> None:
                time.sleep(0.25)
                os._exit(0)

            # ThreadingHTTPServer.shutdown()+serve_forever 在部分 Windows 环境无法可靠收束主线程，进程仍挂起
            threading.Thread(target=_exit_after_response, name="dev-web-exit", daemon=True).start()
            return

        if parsed.path == "/api/sim-build/mirror":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}
            device_id = (data.get("device_id") or "").strip()
            if not device_id:
                self._send_json({"ok": False, "message": "device_id required"}, HTTPStatus.BAD_REQUEST)
                return
            self.server.logger.info("[screen-mirror] start request for device=%s (already_running=%s)", device_id, self.server.sim_screen_running)
            # Stop existing screen loop if running
            if self.server.sim_screen_running:
                self.server.sim_screen_running = False
                time.sleep(1.0)
            _cleanup_hosscrcpy(self.server, device_id)
            self.server.sim_screen_jpeg = b""
            self.server.sim_screen_resolution = (0, 0)
            self.server.sim_screen_running = True

            try:
                _deploy_hosscrcpy(self.server, device_id)
                threading.Thread(target=_sim_screen_loop, args=(self.server, device_id), name="sim-screen", daemon=True).start()
                self._send_json({"ok": True, "mode": "hosscrcpy"})
            except Exception as e:
                self.server.sim_screen_running = False
                self.server.logger.error("[screen-mirror] deploy failed: %s", e)
                self._send_json({"ok": False, "message": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if parsed.path == "/api/sim-build/run":
            if self.server.sim_build_state == "running":
                self._send_json({"ok": False, "message": "already_running"}, HTTPStatus.CONFLICT)
                return
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}
            device_id = (data.get("device_id") or "").strip()
            if not device_id:
                self._send_json({"ok": False, "message": "device_id required"}, HTTPStatus.BAD_REQUEST)
                return
            threading.Thread(target=_sim_run, args=(self.server, device_id), name="sim-build", daemon=True).start()
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/sim-build/input":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            # Get device_id from query string
            qs = parse_qs(parsed.query)
            device_id = (qs.get("device_id", [""])[0]).strip()
            if not device_id:
                self._send_json({"ok": False, "message": "device_id required"}, HTTPStatus.BAD_REQUEST)
                return
            ok = _sim_send_input(device_id, data)
            self._send_json({"ok": ok})
            return

        if parsed.path == "/api/user/config":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            for key, value in data.items():
                self.server.db.execute(
                    "INSERT OR REPLACE INTO user_config (key, value) VALUES (?, ?)", (str(key), str(value))
                )
            self.server.db.commit()
            self._send_json({"ok": True})
            return

        if parsed.path == "/api/llm/validate":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            api_url = (data.get("api_url") or "").rstrip("/")
            api_key = data.get("api_key") or ""
            model = data.get("model") or ""
            # If no key provided (masked), use stored key
            if not api_key:
                row = self.server.db.execute("SELECT value FROM user_config WHERE key='llm_api_key'").fetchone()
                if row and row[0] and "****" not in row[0]:
                    api_key = row[0]
            if not api_url:
                self._send_json({"ok": False, "message": "api_url required"}, HTTPStatus.BAD_REQUEST)
                return
            # Validate by calling /v1/models (or /models) endpoint
            import urllib.request
            import urllib.error
            models_url = api_url.rstrip("/") + "/models"
            req = urllib.request.Request(models_url)
            if api_key:
                req.add_header("Authorization", f"Bearer {api_key}")
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    body_data = json.loads(resp.read().decode("utf-8"))
                    if model:
                        # Check if model exists in the list
                        models = [m.get("id", "") for m in body_data.get("data", [])]
                        if model not in models:
                            self._send_json({"ok": False, "message": f"model '{model}' not found. available: {models[:10]}"})
                            return
                    self._send_json({"ok": True, "message": "validated"})
            except urllib.error.HTTPError as e:
                self._send_json({"ok": False, "message": f"HTTP {e.code}: {e.reason}"})
            except Exception as e:
                self._send_json({"ok": False, "message": str(e)})
            return

        if parsed.path == "/api/llm/classify":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            description = (data.get("description") or "").strip()
            if not description:
                self._send_json({"ok": False, "message": "description required"}, HTTPStatus.BAD_REQUEST)
                return
            # Read LLM config
            cfg_rows = self.server.db.execute("SELECT key, value FROM user_config").fetchall()
            cfg = dict(cfg_rows)
            api_url = (cfg.get("llm_api_url") or "").rstrip("/")
            api_key = cfg.get("llm_api_key") or ""
            model = cfg.get("llm_model") or ""
            if not api_url:
                self._send_json({"ok": False, "message": "llm_api_url not configured"})
                return
            # Gather existing context
            apps = [r[0] for r in self.server.db.execute("SELECT DISTINCT category FROM apps ORDER BY id").fetchall()]
            flows_rows = self.server.db.execute("SELECT category, flow FROM apps ORDER BY id").fetchall()
            app_flows = {}
            for cat, fl in flows_rows:
                app_flows.setdefault(cat, []).append(fl)
            l2_rows = self.server.db.execute(
                "SELECT l2.name, l1.name FROM fault_types l2 JOIN fault_types l1 ON l2.parent_id=l1.id WHERE l2.level='L2' ORDER BY l2.id"
            ).fetchall()
            l2_list = [{"name": r[0], "l1": r[1]} for r in l2_rows]
            # Gather L3 names grouped by L2
            l3_rows = self.server.db.execute(
                "SELECT l3.name, l2.name FROM fault_types l3 JOIN fault_types l2 ON l3.parent_id=l2.id WHERE l3.level='L3' ORDER BY l3.id"
            ).fetchall()
            l3_by_l2 = {}
            for l3_name, l2_name in l3_rows:
                l3_by_l2.setdefault(l2_name, []).append(l3_name)
            # Gather existing fault descriptions (up to 50 samples)
            desc_rows = self.server.db.execute(
                "SELECT description FROM scenarios ORDER BY id DESC LIMIT 50"
            ).fetchall()
            existing_descs = [r[0] for r in desc_rows]
            # Build prompt
            prompt = (
                "你是一个异常场景分类助手。根据用户描述的故障场景，判断它属于哪个应用(app)、流程(flow)、故障分类L2(category)、故障类型L3(type)、优先级(priority)。\n\n"
                "现有应用分类: " + json.dumps(apps, ensure_ascii=False) + "\n"
                "现有应用-流程映射: " + json.dumps(app_flows, ensure_ascii=False) + "\n"
                "现有故障分类(L2)及其上级(L1): " + json.dumps(l2_list, ensure_ascii=False) + "\n"
                "现有故障类型(L3)按L2分组: " + json.dumps(l3_by_l2, ensure_ascii=False) + "\n"
                "现有故障描述示例: " + json.dumps(existing_descs[:30], ensure_ascii=False) + "\n\n"
                "用户描述: " + description + "\n\n"
                "请返回纯JSON，格式如下(不要包含markdown代码块标记):\n"
                '{"app":"应用名","flow":"流程名","l2_category":"故障分类名","l1_name":"所属L1域名","l3_name":"故障类型名","description":"完整的故障描述(带[Pn]前缀)","priority":"P0/P1/P2/P3"}\n\n'
                "规则:\n"
                "1. app和flow必须从现有列表中选择。如果没有合适的，选最接近的\n"
                "2. l2_category必须从现有L2列表中选择，l1_name必须是该L2对应的L1。只有完全找不到合适的才新建\n"
                "3. l3_name必须从现有L3列表中选择最匹配的，只有完全找不到合适的才新建\n"
                "4. description是对此类故障的抽象总结，不是某次具体故障的描述。格式: [优先级] 抽象描述。例如用户说'微信打开后白屏'，description应为'[P2] 应用启动后界面渲染异常'，而不是'微信打开后白屏'\n"
                "5. 只返回JSON，不要其他文字"
            )
            # Call LLM
            import urllib.request
            import urllib.error
            chat_url = api_url.rstrip("/") + "/chat/completions"
            payload = json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
            }).encode("utf-8")
            req = urllib.request.Request(
                chat_url, data=payload,
                headers={"Content-Type": "application/json"}
            )
            if api_key:
                req.add_header("Authorization", f"Bearer {api_key}")
            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    resp_data = json.loads(resp.read().decode("utf-8"))
                    content = resp_data["choices"][0]["message"]["content"].strip()
                    # Strip markdown code fences if present
                    if content.startswith("```"):
                        content = content.split("\n", 1)[1]
                    if content.endswith("```"):
                        content = content.rsplit("```", 1)[0]
                    content = content.strip()
                    result = json.loads(content)
                    result["ok"] = True
                    self._send_json(result)
            except urllib.error.HTTPError as e:
                self._send_json({"ok": False, "message": f"LLM HTTP {e.code}: {e.reason}"})
            except Exception as e:
                self._send_json({"ok": False, "message": str(e)})
            return

        if parsed.path == "/api/issues/insert":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            description = data.get("description", "")
            app = data.get("app", "")
            flow = data.get("flow", "")
            l2_name = data.get("l2_name", "")
            l3_name = data.get("l3_name", "")
            l1_name = data.get("l1_name", "")
            priority = data.get("priority", "P3")
            questions = data.get("questions", [])
            new_app_category = data.get("new_app_category")
            new_flow = data.get("new_flow")
            sid = int(data.get("sheet_id", 1))
            if not all([app, flow, l2_name, l3_name, description]):
                self._send_json({"ok": False, "message": "missing required fields"})
                return
            db = self.server.db
            # 1. Insert new app if needed
            if new_app_category:
                existing = db.execute("SELECT id FROM apps WHERE sheet_id=? AND category=? AND flow=?", (sid, app, flow)).fetchone()
                if not existing:
                    db.execute("INSERT INTO apps (sheet_id, category, flow) VALUES (?, ?, ?)", (sid, app, flow))
            # 2. Resolve or create L2
            l2_row = db.execute("SELECT id FROM fault_types WHERE level='L2' AND name=? AND sheet_id=?", (l2_name, sid)).fetchone()
            if l2_row:
                l2_id = l2_row[0]
            else:
                # Need L1
                l1_row = db.execute("SELECT id FROM fault_types WHERE level='L1' AND name=? AND sheet_id=?", (l1_name, sid)).fetchone()
                if not l1_row:
                    self._send_json({"ok": False, "message": f"L1 '{l1_name}' not found"})
                    return
                l1_id = l1_row[0]
                db.execute("INSERT INTO fault_types (sheet_id, parent_id, level, name) VALUES (?, ?, 'L2', ?)", (sid, l1_id, l2_name))
                l2_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            # 3. Resolve or create L3
            l3_row = db.execute("SELECT id FROM fault_types WHERE level='L3' AND name=? AND parent_id=? AND sheet_id=?", (l3_name, l2_id, sid)).fetchone()
            if l3_row:
                l3_id = l3_row[0]
            else:
                db.execute("INSERT INTO fault_types (sheet_id, parent_id, level, name, description) VALUES (?, ?, 'L3', ?, '')", (sid, l2_id, l3_name))
                l3_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            # 4. Insert scenario
            db.execute(
                "INSERT INTO scenarios (sheet_id, app, flow, fault_type_id, priority, description, questions) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, app, flow, l3_id, priority, description, json.dumps(questions, ensure_ascii=False))
            )
            db.commit()
            scenario_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            self._send_json({"ok": True, "scenario_id": scenario_id})
            return

        if parsed.path == "/api/issues/seed":
            self.server.db.executescript("""
                DELETE FROM scenarios;
                DELETE FROM fault_types;
                DELETE FROM apps;
            """)
            self.server.db.commit()
            self.server._seed_from_files()
            self._send_json({"ok": True, "message": "reseeded"})
            return

        if parsed.path == "/api/llm/generalize":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            question = (data.get("question") or "").strip()
            app = (data.get("app") or "").strip()
            flow = (data.get("flow") or "").strip()
            l3_name = (data.get("l3_name") or "").strip()
            direction = (data.get("direction") or "").strip()

            if not all([question, app, flow, l3_name, direction]):
                self._send_json({"ok": False, "message": "missing required fields"})
                return

            # Read LLM config
            cfg_rows = self.server.db.execute("SELECT key, value FROM user_config").fetchall()
            cfg = dict(cfg_rows)
            api_url = (cfg.get("llm_api_url") or "").rstrip("/")
            api_key = cfg.get("llm_api_key") or ""
            model = cfg.get("llm_model") or ""

            if not api_url:
                self._send_json({"ok": False, "message": "llm_api_url not configured"})
                return

            # Get target cells based on direction
            db = self.server.db
            if direction == "row":
                # Same app+flow, all L3 types
                l3_rows = db.execute(
                    "SELECT l3.name FROM fault_types l3 WHERE l3.level='L3' ORDER BY l3.id"
                ).fetchall()
                target_l3s = [r[0] for r in l3_rows]
                target_cells = [{"app": app, "flow": flow, "l3_name": l3} for l3 in target_l3s]
            else:  # col
                # Same L3, all app+flow combinations
                cell_rows = db.execute(
                    "SELECT DISTINCT s.app, s.flow FROM scenarios s JOIN fault_types ft ON s.fault_type_id=ft.id WHERE ft.name=?",
                    (l3_name,)
                ).fetchall()
                target_cells = [{"app": r[0], "flow": r[1], "l3_name": l3_name} for r in cell_rows]
                # Also include app+flow combinations from apps table that don't have this L3 yet
                all_app_flows = db.execute("SELECT category, flow FROM apps ORDER BY id").fetchall()
                existing_keys = {(c["app"], c["flow"]) for c in target_cells}
                for cat, fl in all_app_flows:
                    if (cat, fl) not in existing_keys:
                        target_cells.append({"app": cat, "flow": fl, "l3_name": l3_name})

            # Build prompt for LLM
            prompt = (
                "你是一个故障场景泛化助手。根据给定的示例场景，为每个目标单元格生成一个新的示例场景。\n\n"
                f"示例场景: {question}\n"
                f"来源: app={app}, flow={flow}, L3={l3_name}\n"
                f"泛化方向: {'按行(同app+flow，不同L3)' if direction == 'row' else '按列(同L3，不同app+flow)'}\n\n"
                "目标单元格:\n"
            )
            for i, cell in enumerate(target_cells):
                prompt += f"{i+1}. app={cell['app']}, flow={cell['flow']}, L3={cell['l3_name']}\n"

            prompt += (
                "\n请为每个目标单元格生成一个新的示例场景。规则:\n"
                "1. 生成的场景必须与目标单元格的app、flow、L3类型相关\n"
                "2. 场景要具体、可测试\n"
                "3. 如果某个单元格无法生成合适的场景(如app/flow与L3完全不相关)，标记为skip\n"
                "4. 返回纯JSON数组，格式:\n"
                '[{"app":"xxx","flow":"xxx","l3_name":"xxx","scenario":"生成的场景","skipped":false},...]\n'
                "5. 只返回JSON，不要其他文字"
            )

            # Call LLM
            import urllib.request
            import urllib.error
            chat_url = api_url.rstrip("/") + "/chat/completions"
            payload = json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
            }).encode("utf-8")
            req = urllib.request.Request(
                chat_url, data=payload,
                headers={"Content-Type": "application/json"}
            )
            if api_key:
                req.add_header("Authorization", f"Bearer {api_key}")

            try:
                with urllib.request.urlopen(req, timeout=120) as resp:
                    resp_data = json.loads(resp.read().decode("utf-8"))
                    content = resp_data["choices"][0]["message"]["content"].strip()
                    # Strip markdown code fences if present
                    if content.startswith("```"):
                        content = content.split("\n", 1)[1]
                    if content.endswith("```"):
                        content = content.rsplit("```", 1)[0]
                    content = content.strip()
                    results = json.loads(content)

                    # For each result, check if scenario exists and get/generate description
                    final_results = []
                    for item in results:
                        cell_app = item.get("app", "")
                        cell_flow = item.get("flow", "")
                        cell_l3 = item.get("l3_name", "")
                        scenario = item.get("scenario", "")
                        skipped = item.get("skipped", False)

                        if skipped:
                            final_results.append({
                                "app": cell_app,
                                "flow": cell_flow,
                                "l3_name": cell_l3,
                                "skipped": True,
                                "is_new": False,
                            })
                            continue

                        # Check if scenario already exists in this cell
                        key = f"{cell_app}||{cell_flow}||{cell_l3}"
                        # Check existing scenarios
                        existing = db.execute(
                            "SELECT s.description, s.questions FROM scenarios s "
                            "JOIN fault_types ft ON s.fault_type_id=ft.id "
                            "WHERE s.app=? AND s.flow=? AND ft.name=?",
                            (cell_app, cell_flow, cell_l3)
                        ).fetchone()

                        if existing:
                            # Use existing description
                            existing_desc = existing[0]
                            existing_questions = json.loads(existing[1]) if existing[1] else []
                            if scenario and scenario not in existing_questions:
                                # Add new scenario to existing
                                final_results.append({
                                    "app": cell_app,
                                    "flow": cell_flow,
                                    "l3_name": cell_l3,
                                    "existing_description": existing_desc,
                                    "new_scenario": scenario,
                                    "skipped": False,
                                    "is_new": False,
                                    "add_to_existing": True,
                                })
                            else:
                                # Scenario already exists
                                final_results.append({
                                    "app": cell_app,
                                    "flow": cell_flow,
                                    "l3_name": cell_l3,
                                    "existing_description": existing_desc,
                                    "skipped": False,
                                    "is_new": False,
                                    "add_to_existing": False,
                                })
                        else:
                            # Need new description - call LLM again
                            desc_prompt = (
                                f"为以下故障场景生成一个故障描述:\n"
                                f"App: {cell_app}\n"
                                f"Flow: {cell_flow}\n"
                                f"L3故障类型: {cell_l3}\n"
                                f"示例场景: {scenario}\n\n"
                                "请返回纯JSON:\n"
                                '{"description":"[P2] 故障描述内容"}\n'
                                "只返回JSON，不要其他文字"
                            )
                            try:
                                desc_req = urllib.request.Request(
                                    chat_url,
                                    data=json.dumps({
                                        "model": model,
                                        "messages": [{"role": "user", "content": desc_prompt}],
                                        "temperature": 0.1,
                                    }).encode("utf-8"),
                                    headers={"Content-Type": "application/json"}
                                )
                                if api_key:
                                    desc_req.add_header("Authorization", f"Bearer {api_key}")
                                with urllib.request.urlopen(desc_req, timeout=60) as desc_resp:
                                    desc_resp_data = json.loads(desc_resp.read().decode("utf-8"))
                                    desc_content = desc_resp_data["choices"][0]["message"]["content"].strip()
                                    if desc_content.startswith("```"):
                                        desc_content = desc_content.split("\n", 1)[1]
                                    if desc_content.endswith("```"):
                                        desc_content = desc_content.rsplit("```", 1)[0]
                                    desc_result = json.loads(desc_content.strip())
                                    new_desc = desc_result.get("description", "")
                            except Exception:
                                new_desc = f"[P2] {cell_app}在{cell_flow}流程中{cell_l3}故障"

                            final_results.append({
                                "app": cell_app,
                                "flow": cell_flow,
                                "l3_name": cell_l3,
                                "new_description": new_desc,
                                "new_scenario": scenario,
                                "skipped": False,
                                "is_new": True,
                            })

                    self._send_json({"ok": True, "results": final_results})
            except urllib.error.HTTPError as e:
                self._send_json({"ok": False, "message": f"LLM HTTP {e.code}: {e.reason}"})
            except Exception as e:
                self._send_json({"ok": False, "message": str(e)})
            return

        if parsed.path == "/api/issues/generalize-insert":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            results = data.get("results", [])
            sid = int(data.get("sheet_id", 1))
            if not results:
                self._send_json({"ok": False, "message": "no results to insert"})
                return

            db = self.server.db
            inserted = 0
            updated = 0

            for item in results:
                if item.get("skipped"):
                    continue

                cell_app = item.get("app", "")
                cell_flow = item.get("flow", "")
                cell_l3 = item.get("l3_name", "")
                new_desc = item.get("new_description", "")
                existing_desc = item.get("existing_description", "")
                new_scenario = item.get("new_scenario", "")
                add_to_existing = item.get("add_to_existing", False)
                is_new = item.get("is_new", False)

                if not cell_app or not cell_flow or not cell_l3:
                    continue

                # Get or create L3 fault type within sheet
                l3_row = db.execute(
                    "SELECT id FROM fault_types WHERE level='L3' AND name=? AND sheet_id=?", (cell_l3, sid)
                ).fetchone()
                if l3_row:
                    l3_id = l3_row[0]
                else:
                    l2_row = db.execute("SELECT id FROM fault_types WHERE level='L2' AND sheet_id=? LIMIT 1", (sid,)).fetchone()
                    if not l2_row:
                        continue
                    db.execute(
                        "INSERT INTO fault_types (sheet_id, parent_id, level, name, description) VALUES (?, ?, 'L3', ?, '')",
                        (sid, l2_row[0], cell_l3)
                    )
                    l3_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]

                if add_to_existing and existing_desc and new_scenario:
                    existing = db.execute(
                        "SELECT s.id, s.questions FROM scenarios s "
                        "JOIN fault_types ft ON s.fault_type_id=ft.id "
                        "WHERE s.sheet_id=? AND s.app=? AND s.flow=? AND ft.name=? AND s.description=?",
                        (sid, cell_app, cell_flow, cell_l3, existing_desc)
                    ).fetchone()
                    if existing:
                        scenario_id = existing[0]
                        questions = json.loads(existing[1]) if existing[1] else []
                        if new_scenario not in questions:
                            questions.append(new_scenario)
                            db.execute(
                                "UPDATE scenarios SET questions=? WHERE id=?",
                                (json.dumps(questions, ensure_ascii=False), scenario_id)
                            )
                            updated += 1
                elif is_new and new_desc and new_scenario:
                    app_row = db.execute(
                        "SELECT id FROM apps WHERE category=? AND flow=? AND sheet_id=?",
                        (cell_app, cell_flow, sid)
                    ).fetchone()
                    if not app_row:
                        db.execute(
                            "INSERT INTO apps (sheet_id, category, flow) VALUES (?, ?, ?)",
                            (sid, cell_app, cell_flow)
                        )

                    db.execute(
                        "INSERT INTO scenarios (sheet_id, app, flow, fault_type_id, priority, description, questions) "
                        "VALUES (?, ?, ?, ?, 'P2', ?, ?)",
                        (sid, cell_app, cell_flow, l3_id, new_desc, json.dumps([new_scenario], ensure_ascii=False))
                    )
                    inserted += 1

            db.commit()
            self._send_json({"ok": True, "inserted": inserted, "updated": updated})
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        # DELETE /api/sheets/{id}
        m = re.match(r"^/api/sheets/(\d+)$", parsed.path)
        if m:
            sid = int(m.group(1))
            db = self.server.db
            sheet = db.execute("SELECT is_base FROM sheets WHERE id=?", (sid,)).fetchone()
            if not sheet:
                self._send_json({"ok": False, "message": "sheet not found"}, HTTPStatus.NOT_FOUND)
                return
            if sheet[0]:
                self._send_json({"ok": False, "message": "cannot delete base sheet"}, HTTPStatus.BAD_REQUEST)
                return
            db.execute("DELETE FROM scenarios WHERE sheet_id=?", (sid,))
            db.execute("DELETE FROM fault_types WHERE sheet_id=?", (sid,))
            db.execute("DELETE FROM apps WHERE sheet_id=?", (sid,))
            db.execute("DELETE FROM sheets WHERE id=?", (sid,))
            db.commit()
            self._send_json({"ok": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        parsed = urlparse(self.path)
        # PUT /api/sheets/{id} — rename
        m = re.match(r"^/api/sheets/(\d+)$", parsed.path)
        if m:
            sid = int(m.group(1))
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len) if content_len else b"{}"
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._send_json({"ok": False, "message": "invalid json"}, HTTPStatus.BAD_REQUEST)
                return
            name = (data.get("name") or "").strip()
            if not name:
                self._send_json({"ok": False, "message": "name required"}, HTTPStatus.BAD_REQUEST)
                return
            db = self.server.db
            sheet = db.execute("SELECT id FROM sheets WHERE id=?", (sid,)).fetchone()
            if not sheet:
                self._send_json({"ok": False, "message": "sheet not found"}, HTTPStatus.NOT_FOUND)
                return
            db.execute("UPDATE sheets SET name=? WHERE id=?", (name, sid))
            db.commit()
            self._send_json({"ok": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        self.server.logger.debug("web %s - %s", self.address_string(), format % args)


class ConsoleServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        *,
        repo_root: Path,
        config: dict[str, Any],
        selected: str,
        static_root: Path,
        logger: Any,
        stop_event: threading.Event,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.repo_root = repo_root
        self.config = config
        self.selected = selected
        self.static_root = static_root.resolve()
        self.logger = logger
        self.stop_event = stop_event
        # sim-build state
        self.sim_build_state = "idle"  # idle | running | done | error
        self.sim_build_logs: list[str] = []
        self.sim_build_step = -1  # current step index, -1 = not started
        # screen mirror state
        self.sim_screen_jpeg: bytes = b""
        self.sim_screen_resolution: tuple[int, int] = (0, 0)
        self.sim_screen_running = False
        self._hosscrcpy_device_id: str | None = None
        # SQLite database
        self.db_path = repo_root / "dev" / "console.db"
        self._init_db()

    def _init_db(self) -> None:
        self.db = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS sheets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                is_base INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS apps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL DEFAULT 1,
                category TEXT NOT NULL,
                flow TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fault_types (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL DEFAULT 1,
                parent_id INTEGER REFERENCES fault_types(id),
                level TEXT NOT NULL CHECK(level IN ('L1','L2','L3','L4')),
                name TEXT NOT NULL,
                description TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS scenarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sheet_id INTEGER NOT NULL DEFAULT 1,
                app TEXT NOT NULL,
                flow TEXT NOT NULL,
                fault_type_id INTEGER NOT NULL REFERENCES fault_types(id),
                priority TEXT DEFAULT 'P3',
                description TEXT DEFAULT '',
                questions TEXT DEFAULT '[]'
            );
            CREATE TABLE IF NOT EXISTS user_config (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        """)
        self.db.commit()
        # Ensure base sheet exists
        base = self.db.execute("SELECT id FROM sheets WHERE is_base=1").fetchone()
        if not base:
            self.db.execute("INSERT INTO sheets (name, is_base) VALUES ('基础异常', 1)")
            self.db.commit()
        # Migrate: add sheet_id column if missing (existing dbs)
        for table in ("apps", "fault_types", "scenarios"):
            try:
                self.db.execute(f"SELECT sheet_id FROM {table} LIMIT 1")
            except sqlite3.OperationalError:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN sheet_id INTEGER NOT NULL DEFAULT 1")
                self.db.commit()
        # Seed from files if tables are empty
        count = self.db.execute("SELECT COUNT(*) FROM apps WHERE sheet_id=1").fetchone()[0]
        if count == 0:
            self._seed_from_files()

    def _seed_from_files(self) -> None:
        issues_dir = self.repo_root / "dev" / "issues"
        # Seed apps from app.csv
        apps_path = issues_dir / "app.csv"
        if apps_path.exists():
            with apps_path.open("r", encoding="utf-8") as f:
                reader = csv.reader(f)
                rows = list(reader)
            current_cat = ""
            for row in rows:
                val0 = row[0].strip() if row and row[0].strip() else ""
                if val0:
                    current_cat = val0
                if len(row) > 1 and row[1].strip():
                    self.db.execute("INSERT INTO apps (sheet_id, category, flow) VALUES (1, ?, ?)", (current_cat, row[1].strip()))
        # Seed fault_types hierarchy from issues.csv
        # CSV structure: row0=L1 domains, row1=L2 types, row2=L3 names, row3=L4 examples
        # L2 types may span multiple columns (empty adjacent cells = colspan)
        matrix_path = issues_dir / "issues.csv"
        # col_info[i] = {"l1": domain, "l2": type_name, "l3": l3_name, "l4": example}
        col_info: list[dict] = []
        if matrix_path.exists():
            with matrix_path.open("r", encoding="utf-8") as f:
                reader = csv.reader(f)
                rows = list(reader)
            if rows:
                header = rows[0]
                sub = rows[1] if len(rows) > 1 else []
                desc_row = rows[2] if len(rows) > 2 else []
                examples_row = rows[3] if len(rows) > 3 else []
                ncols = max(len(header), len(sub), len(desc_row), len(examples_row))
                # Resolve L1 domain per column
                current_l1 = ""
                for i in range(ncols):
                    h = header[i].strip() if i < len(header) else ""
                    if h:
                        current_l1 = h
                    col_info.append({"l1": current_l1, "l2": "", "l3": "", "l4": ""})
                # Resolve L2 type per column (colspan: empty cell inherits previous L2)
                current_l2 = ""
                for i in range(ncols):
                    s = sub[i].strip() if i < len(sub) else ""
                    if s:
                        current_l2 = s
                    col_info[i]["l2"] = current_l2
                # L3 and L4 are per-column (no colspan)
                for i in range(ncols):
                    col_info[i]["l3"] = desc_row[i].strip() if i < len(desc_row) else ""
                    col_info[i]["l4"] = examples_row[i].strip() if i < len(examples_row) else ""
                # L1: domains (unique)
                domain_ids: dict[str, int] = {}
                for c in col_info:
                    d = c["l1"]
                    if d and d not in domain_ids:
                        cur = self.db.execute(
                            "INSERT INTO fault_types (sheet_id, level, name) VALUES (1, 'L1', ?)", (d,))
                        domain_ids[d] = cur.lastrowid
                # L2: types (unique per name)
                l2_ids: dict[str, int] = {}
                for c in col_info:
                    name = c["l2"]
                    if name and name not in l2_ids:
                        cur = self.db.execute(
                            "INSERT INTO fault_types (sheet_id, parent_id, level, name, description) VALUES (1, ?, 'L2', ?, ?)",
                            (domain_ids.get(c["l1"]), name, ""))
                        l2_ids[name] = cur.lastrowid
                # L3: one per CSV column
                # col_l3_ids[i] = L3 fault_type id for column i
                col_l3_ids: list[int] = []
                for i, c in enumerate(col_info):
                    l2_name = c["l2"]
                    l3_name = c["l3"] or l2_name
                    l4_desc = c["l4"]
                    l2_id = l2_ids.get(l2_name)
                    if l2_id:
                        cur = self.db.execute(
                            "INSERT INTO fault_types (sheet_id, parent_id, level, name, description) VALUES (1, ?, 'L3', ?, ?)",
                            (l2_id, l3_name, l4_desc))
                        col_l3_ids.append(cur.lastrowid)
                    else:
                        col_l3_ids.append(0)
        # Seed scenarios from issues.json
        # Map each scenario to the L3 column matching its exception_l3 or exception_category
        details_path = issues_dir / "issues.json"
        if details_path.exists():
            details = json.loads(details_path.read_text(encoding="utf-8"))
            # Build L3 name → column id mapping
            l3_name_to_id: dict[str, int] = {}
            # Also build L2 name → first L3 column id as fallback
            l2_first_l3: dict[str, int] = {}
            for i, c in enumerate(col_info):
                if i < len(col_l3_ids) and col_l3_ids[i]:
                    l3_name_to_id[c["l3"]] = col_l3_ids[i]
                if c["l2"] and c["l2"] not in l2_first_l3 and i < len(col_l3_ids) and col_l3_ids[i]:
                    l2_first_l3[c["l2"]] = col_l3_ids[i]
            for entry in details:
                category = entry.get("exception_category", "")
                exception_l3 = entry.get("exception_l3", "")
                description = entry.get("exception_description", "")
                app = entry.get("app", "")
                flow = entry.get("flow", "")
                questions = entry.get("questions", [])
                # Find L3 id: prefer exception_l3, fall back to first L3 under L2
                l3_id = l3_name_to_id.get(exception_l3) if exception_l3 else None
                if not l3_id:
                    l3_id = l2_first_l3.get(category)
                if not l3_id:
                    continue
                # Extract priority
                pri_match = re.match(r"\[(P\d+)\]", description)
                priority = pri_match.group(1) if pri_match else "P3"
                # Insert scenario
                self.db.execute(
                    "INSERT INTO scenarios (sheet_id, app, flow, fault_type_id, priority, description, questions) VALUES (1, ?, ?, ?, ?, ?, ?)",
                    (app, flow, l3_id, priority, description,
                     json.dumps(questions, ensure_ascii=False)))
        self.db.commit()
        self.logger.info("[db] Seeded database from files: %s", self.db_path)


def start_inspection_thread(
    repo_root: Path,
    config: dict[str, Any],
    logger: Any,
    dry_run: bool,
    stop_event: threading.Event,
) -> threading.Thread:
    thread = threading.Thread(
        target=run_loop,
        kwargs={
            "repo_root": repo_root,
            "config": config,
            "state_arg": None,
            "logger": logger,
            "dry_run": dry_run,
            "stop_event": stop_event,
        },
        daemon=True,
        name="inspection-loop",
    )
    thread.start()
    return thread


def main() -> int:
    configure_stdio()
    args = parse_args()
    config_path = Path(args.config).resolve()
    config = load_config(config_path)
    repo_root = resolve_path(config_path.parent.parent.parent, config["paths"]["repo_root"])
    log_path: Path | None = Path(args.log_file).resolve() if args.log_file else None
    logger = prepare_web_logger(log_path)
    host = args.host
    port = find_available_port(host, args.port)
    static_root = ensure_dir(repo_root / "dev" / "frontend")
    stop_event = threading.Event()

    stop_other_web_consoles(logger)

    for state_file in collect_state_files(repo_root, config, None):
        handle_state_file(repo_root, config, state_file, logger, args.dry_run)

    start_inspection_thread(repo_root, config, logger, args.dry_run, stop_event)
    server = ConsoleServer(
        (host, port),
        ConsoleHandler,
        repo_root=repo_root,
        config=config,
        selected=args.selected,
        static_root=static_root,
        logger=logger,
        stop_event=stop_event,
    )
    selected_context = get_pipeline_context(repo_root, config, args.selected)
    mark_web_state(selected_context["state_file"], logger, host, port)
    logger.info("Web 控制台已启动: http://%s:%s", host, port)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        logger.info("收到中断信号，准备关闭 Web 控制台。")
    finally:
        stop_event.set()
        mark_web_stopped(selected_context["state_file"], logger)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
