#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
安装应用到设备并传输output目录中的文件
"""

import os
import subprocess
import sys
import time


def check_hdc_command():
    """检查hdc命令是否可用"""
    try:
        result = subprocess.run(['hdc', '--version'], capture_output=True, text=True, timeout=5)
        return True
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.CalledProcessError):
        return False


def check_device_connection(device_id):
    """检查设备是否连接"""
    try:
        result = subprocess.run(
            ['hdc', '-t', device_id, 'shell', 'echo', 'test'],
            capture_output=True,
            text=True,
            timeout=10
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.CalledProcessError):
        return False


def check_device_in_list(device_id):
    """检查设备是否在设备列表中"""
    try:
        result = subprocess.run(['hdc', 'list', 'targets'], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            devices = result.stdout.strip().split('\n')
            return device_id in devices
        return False
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.CalledProcessError):
        return False


def connect_device(device_id):
    """尝试连接设备"""
    print(f"尝试连接设备: {device_id}")
    try:
        result = subprocess.run(
            ['hdc', 'tconn', device_id],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print(f"设备连接成功: {device_id}")
            time.sleep(2)
            return True
        else:
            print(f"设备连接失败: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print("设备连接超时")
        return False
    except Exception as e:
        print(f"设备连接出错: {e}")
        return False
def install_hap(device_id, hap_path):
    """安装HAP应用到设备"""
    print(f"正在安装应用: {hap_path}")
    try:
        result = subprocess.run(
            ['hdc', '-t', device_id, 'install', '-r', hap_path],
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode == 0:
            print("应用安装成功")
            print("等待应用安装完成...")
            time.sleep(3)
            return True
        else:
            print(f"应用安装失败: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print("应用安装超时")
        return False
    except Exception as e:
        print(f"应用安装出错: {e}")
        return False


def uninstall_app(device_id, bundle_name):
    """卸载应用"""
    print(f"正在卸载应用: {bundle_name}")
    try:
        result = subprocess.run(
            ['hdc', '-t', device_id, 'uninstall', bundle_name],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode == 0:
            print("应用卸载成功（或应用不存在）")
            return True
        else:
            print(f"应用卸载失败: {result.stderr}")
            return True
    except subprocess.TimeoutExpired:
        print("应用卸载超时")
        return True
    except Exception as e:
        print(f"应用卸载出错: {e}")
        return True


def start_app(device_id, bundle_name):
    """启动应用"""
    print(f"正在启动应用: {bundle_name}")
    try:
        result = subprocess.run(
            ['hdc', '-t', device_id, 'shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle_name],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print("应用启动成功")
            time.sleep(2)
            return True
        else:
            print(f"应用启动失败: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print("应用启动超时")
        return False
    except Exception as e:
        print(f"应用启动出错: {e}")
        return False


def stop_app(device_id, bundle_name):
    """关闭应用"""
    print(f"正在关闭应用: {bundle_name}")
    try:
        result = subprocess.run(
            ['hdc', '-t', device_id, 'shell', 'aa', 'force-stop', bundle_name],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            print("应用关闭成功")
            return True
        else:
            print(f"应用关闭失败: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print("应用关闭超时")
        return False
    except Exception as e:
        print(f"应用关闭出错: {e}")
        return False

def send_files_to_device(device_id, output_folder):
    """将输出文件夹中的图片和input.json发送到设备"""
    print(f"正在传输文件到设备...")
    print(f"源目录: {output_folder}")

    try:
        original_dir = os.getcwd()
        os.chdir(output_folder)

        files = os.listdir('.')
        print(f"待传输文件数: {len(files)}")

        cmd = [r'D:\WeLink_data_files\l30020995\ReceiveFiles\tempfiles\hdc.exe', '-t', device_id, 'file', 'send', '-b', 'com.example.hmdemo', '.', './data/storage/el2/base/flight']
        print(f"执行命令: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120
        )

        os.chdir(original_dir)

        if result.returncode == 0:
            print("文件传输成功")
            if result.stdout:
                print(f"传输详情: {result.stdout}")
            return True
        else:
            print(f"文件传输失败")
            print(f"返回码: {result.returncode}")
            if result.stderr:
                print(f"错误信息: {result.stderr}")
            if result.stdout:
                print(f"输出信息: {result.stdout}")
            return False
    except subprocess.TimeoutExpired:
        print("文件传输超时")
        return False
    except Exception as e:
        print(f"文件传输出错: {e}")
        return False


def install_and_send(device_id, output_folder):
    """安装应用并发送文件"""
    bundle_name = "com.example.hmdemo"
    # HAP文件路径相对于脚本文件所在目录
    script_dir = os.path.dirname(os.path.abspath(__file__))
    hap_path = os.path.join(script_dir, "entry-default-signed.hap")

    # 卸载旧应用
    uninstall_app(device_id, bundle_name)

    # 安装应用
    if not os.path.exists(hap_path):
        print(f"错误: HAP文件不存在 - {hap_path}")
        return False

    if not install_hap(device_id, hap_path):
        print("应用安装失败")
        return False

    # 启动应用
    if not start_app(device_id, bundle_name):
        print("应用启动失败")
        return False

    # 传输文件
    if not send_files_to_device(device_id, output_folder):
        print("文件传输失败")
        return False

    # 关闭应用
    stop_app(device_id, bundle_name)
    return True

def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("用法: python install_to_device.py <设备标识符> [output目录]")
        print("参数说明:")
        print("  设备标识符: HDC设备标识符")
        print("  output目录: 可选，默认为脚本所在目录下的output文件夹")
        print("示例:")
        print("  python install_to_device.py 192.168.1.100:5555")
        print("  python install_to_device.py 192.168.1.100:5555 D:\\path\\to\\output")
        sys.exit(1)

    device_id = sys.argv[1]
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_folder = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(script_dir, "output")

    # 检查hdc命令
    print("检查hdc命令...")
    if not check_hdc_command():
        print("错误: hdc命令不可用")
        sys.exit(1)
    print("hdc命令可用")

    # 检查设备连接
    print(f"检查设备连接: {device_id}")
    if not check_device_connection(device_id):
        print(f"错误: 无法连接到设备 {device_id}")
        sys.exit(1)
    print(f"设备 {device_id} 已连接")

    # 检查output目录
    if not os.path.exists(output_folder):
        print(f"错误: output目录不存在 - {output_folder}")
        sys.exit(1)

    # 新的文件夹命名规则：{UUID}，直接使用传入的output_folder
    # 不再查找子文件夹，因为UUID文件夹下直接就是文件
    output_folders = [f for f in os.listdir(output_folder) if os.path.isdir(os.path.join(output_folder, f))]
    if output_folders:
        # 如果有子文件夹（兼容旧格式），使用第一个子文件夹
        output_folder = os.path.join(output_folder, output_folders[0])
        print(f"输出文件夹（旧格式）: {output_folder}")
    else:
        # 新格式：直接使用output_folder（UUID文件夹）
        print(f"输出文件夹（新格式）: {output_folder}")

    print("=" * 60)
    print("安装应用并传输文件")
    print("=" * 60)
    print(f"设备标识: {device_id}")
    print(f"输出文件夹: {output_folder}")
    print("=" * 60)
    print()

    # 检查设备是否在列表中
    print("检查设备是否在设备列表中...")
    if check_device_in_list(device_id):
        print(f"设备 {device_id} 在设备列表中")
        install_and_send(device_id, output_folder)
    else:
        print(f"设备 {device_id} 不在设备列表中，尝试连接...")
        if connect_device(device_id):
            if check_device_in_list(device_id):
                print(f"设备 {device_id} 已在设备列表中")
                install_and_send(device_id, output_folder)
            else:
                print(f"错误: 连接成功但设备 {device_id} 仍不在设备列表中")
                sys.exit(1)
        else:
            print(f"错误: 无法连接到设备 {device_id}")
            sys.exit(1)

    print()
    print("=" * 60)
    print("处理完成!")
    print("=" * 60)


if __name__ == '__main__':
    main()