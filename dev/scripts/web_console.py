from __future__ import annotations

import argparse
import csv
import io
import json
import mimetypes
import os
import re
import signal
import socket
import sqlite3
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
            server.sim_screen_running = True
            threading.Thread(target=_sim_screen_loop, args=(server, device_id), name="sim-screen", daemon=True).start()

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


# ===== Screen mirror helpers =====

REMOTE_SCREENSHOT = "/data/local/tmp/sim_screen.png"


def _sim_screen_loop(server: Any, device_id: str) -> None:
    """Background loop: capture device screen at ~300ms intervals."""
    while server.sim_screen_running:
        try:
            png = _sim_capture_screen(device_id)
            if png:
                server.sim_screen_png = png
                # Extract resolution from PNG IHDR chunk (bytes 16-23)
                if len(png) > 24 and png[12:16] == b'IHDR':
                    w = int.from_bytes(png[16:20], 'big')
                    h = int.from_bytes(png[20:24], 'big')
                    if w > 0 and h > 0:
                        server.sim_screen_resolution = (w, h)
        except Exception:
            pass
        time.sleep(0.3)


def _sim_capture_screen(device_id: str) -> bytes | None:
    """Capture device screen, return PNG bytes or None."""
    try:
        r = _hdc_run(["-t", device_id, "shell", "snapshot_display", "-f", REMOTE_SCREENSHOT], timeout=5)
        if r.returncode != 0:
            return None
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            r2 = _hdc_run(["-t", device_id, "file", "recv", REMOTE_SCREENSHOT, tmp_path], timeout=5)
            if r2.returncode != 0:
                return None
            with open(tmp_path, "rb") as f:
                return f.read()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception:
        return None


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
    parser.add_argument("--host", default="127.0.0.1", help="Web 服务监听地址")
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
            rows = self.server.db.execute("SELECT category, flow FROM apps ORDER BY id").fetchall()
            self._send_json([{"category": r[0], "flow": r[1]} for r in rows])
            return

        if parsed.path == "/api/issues/matrix":
            db = self.server.db
            # L1 domains
            l1_rows = db.execute("SELECT id, name FROM fault_types WHERE level='L1' ORDER BY id").fetchall()
            matrix = []
            for l1_id, l1_name in l1_rows:
                # L2 types under this domain
                l2_rows = db.execute(
                    "SELECT id, name, description FROM fault_types WHERE level='L2' AND parent_id=? ORDER BY id",
                    (l1_id,)).fetchall()
                types = []
                for l2_id, l2_name, l2_meta in l2_rows:
                    try:
                        meta = json.loads(l2_meta) if l2_meta else {}
                    except (json.JSONDecodeError, TypeError):
                        meta = {"description": l2_meta or "", "example": ""}
                    types.append({"id": l2_id, "name": l2_name,
                                  "description": meta.get("description", ""),
                                  "example": meta.get("example", "")})
                matrix.append({"column": l1_name, "types": types})
            self._send_json(matrix)
            return

        if parsed.path == "/api/issues/details":
            db = self.server.db
            rows = db.execute("""
                SELECT s.app, s.flow, s.priority, s.description, s.questions,
                       l2.name AS category, l1.name AS domain
                FROM scenarios s
                JOIN fault_types l3 ON s.fault_type_id = l3.id
                JOIN fault_types l2 ON l3.parent_id = l2.id
                JOIN fault_types l1 ON l2.parent_id = l1.id
                ORDER BY s.id
            """).fetchall()
            result = []
            for app, flow, pri, desc, questions_json, category, domain in rows:
                result.append({
                    "app": app, "flow": flow,
                    "exception_column": domain, "exception_type": domain,
                    "exception_category": category, "exception_description": desc,
                    "_priority": pri,
                    "questions": json.loads(questions_json) if questions_json else [],
                })
            self._send_json(result)
            return

        if parsed.path == "/api/user/config":
            rows = self.server.db.execute("SELECT key, value FROM user_config").fetchall()
            self._send_json(dict(rows))
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
            png = self.server.sim_screen_png
            if not png:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(png)
            return

        if parsed.path == "/api/sim-build/resolution":
            w, h = self.server.sim_screen_resolution
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
            # Stop existing screen loop if running for a different device
            if self.server.sim_screen_running:
                self.server.sim_screen_running = False
                time.sleep(0.4)
            self.server.sim_screen_running = True
            threading.Thread(target=_sim_screen_loop, args=(self.server, device_id), name="sim-screen", daemon=True).start()
            self._send_json({"ok": True})
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

        self.send_error(HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args: Any) -> None:
        self.server.logger.info("web %s - %s", self.address_string(), format % args)


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
        self.sim_screen_png: bytes = b""
        self.sim_screen_resolution: tuple[int, int] = (0, 0)
        self.sim_screen_running = False
        # SQLite database
        self.db_path = repo_root / "dev" / "console.db"
        self._init_db()

    def _init_db(self) -> None:
        self.db = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS apps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                flow TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS fault_types (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER REFERENCES fault_types(id),
                level TEXT NOT NULL CHECK(level IN ('L1','L2','L3','L4')),
                name TEXT NOT NULL,
                description TEXT DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS scenarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        # Seed from files if tables are empty
        count = self.db.execute("SELECT COUNT(*) FROM apps").fetchone()[0]
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
                    self.db.execute("INSERT INTO apps (category, flow) VALUES (?, ?)", (current_cat, row[1].strip()))
        # Seed fault_types hierarchy from issues.csv (L1 domain, L2 type)
        csv_l2_types: dict[str, str] = {}  # type_name -> domain
        matrix_path = issues_dir / "issues.csv"
        if matrix_path.exists():
            with matrix_path.open("r", encoding="utf-8") as f:
                reader = csv.reader(f)
                rows = list(reader)
            if rows:
                header = rows[0]
                sub = rows[1] if len(rows) > 1 else []
                desc_row = rows[2] if len(rows) > 2 else []
                examples_row = rows[3] if len(rows) > 3 else []
                # L1: domains
                domain_ids: dict[str, int] = {}
                current_col = ""
                for i, h in enumerate(header):
                    h_stripped = h.strip()
                    if h_stripped:
                        current_col = h_stripped
                    if current_col and current_col not in domain_ids:
                        cur = self.db.execute(
                            "INSERT INTO fault_types (level, name) VALUES ('L1', ?)", (current_col,))
                        domain_ids[current_col] = cur.lastrowid
                # L2: types (store description + example as JSON in description field)
                current_col = ""
                for i, h in enumerate(header):
                    h_stripped = h.strip()
                    if h_stripped:
                        current_col = h_stripped
                    if i < len(sub) and sub[i].strip():
                        type_name = sub[i].strip()
                        desc = desc_row[i].strip() if i < len(desc_row) else ""
                        example = examples_row[i].strip() if i < len(examples_row) else ""
                        meta = json.dumps({"description": desc, "example": example}, ensure_ascii=False)
                        self.db.execute(
                            "INSERT INTO fault_types (parent_id, level, name, description) VALUES (?, 'L2', ?, ?)",
                            (domain_ids.get(current_col), type_name, meta))
                        csv_l2_types[type_name] = current_col
        # Seed L3 fault descriptions and scenarios from issues.json
        details_path = issues_dir / "issues.json"
        if details_path.exists():
            details = json.loads(details_path.read_text(encoding="utf-8"))
            # Build L3 cache: (parent_l2_id, description) -> l3_id
            l3_cache: dict[tuple[int, str], int] = {}
            for entry in details:
                category = entry.get("exception_category", "")
                description = entry.get("exception_description", "")
                app = entry.get("app", "")
                flow = entry.get("flow", "")
                questions = entry.get("questions", [])
                # Find L2 parent
                l2_row = self.db.execute(
                    "SELECT id FROM fault_types WHERE level='L2' AND name=?", (category,)).fetchone()
                if not l2_row:
                    continue
                l2_id = l2_row[0]
                # Create or reuse L3
                l3_key = (l2_id, description)
                if l3_key not in l3_cache:
                    cur = self.db.execute(
                        "INSERT INTO fault_types (parent_id, level, name, description) VALUES (?, 'L3', ?, ?)",
                        (l2_id, category, description))
                    l3_cache[l3_key] = cur.lastrowid
                l3_id = l3_cache[l3_key]
                # Extract priority
                pri_match = re.match(r"\[(P\d+)\]", description)
                priority = pri_match.group(1) if pri_match else "P3"
                # Insert scenario
                self.db.execute(
                    "INSERT INTO scenarios (app, flow, fault_type_id, priority, description, questions) VALUES (?, ?, ?, ?, ?, ?)",
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
