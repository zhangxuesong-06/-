#!/usr/bin/env python3
"""Wait for the Livox receiver addresses before executing its driver."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import yaml


def receiver_ips(command):
    """Read evaluated ROS parameter files in command-line override order."""
    config_path = None

    def paths(value):
        if not isinstance(value, dict):
            return []
        params = value.get('ros__parameters', {})
        result = [params['user_config_path']] if 'user_config_path' in params else []
        for key, item in value.items():
            if key != 'ros__parameters':
                result.extend(paths(item))
        return result

    i = 0
    while i < len(command):
        if command[i] == '--params-file' and i + 1 < len(command):
            found = paths(yaml.safe_load(Path(command[i + 1]).read_text()))
            if len(set(found)) > 1:
                raise ValueError('参数文件含多个不同的雷达配置路径')
            if found:
                config_path = found[-1]
            i += 2
        elif command[i] in ('-p', '--param') and i + 1 < len(command):
            key, separator, value = command[i + 1].partition(':=')
            if separator and key == 'user_config_path':
                config_path = value
            i += 2
        else:
            i += 1
    if not config_path:
        raise ValueError('未找到驱动的 user_config_path，未启动驱动')
    config = json.loads(Path(config_path).read_text())
    addresses = set()
    for sensor in config.values():
        if not isinstance(sensor, dict):
            continue
        host = sensor.get('host_net_info', {})
        for key, value in host.items():
            if key.endswith('_ip') and value:
                addresses.add(str(ipaddress.IPv4Address(value)))
    if not addresses:
        raise ValueError('雷达配置缺少电脑接收 IP，未启动驱动')
    return addresses


def interface_ready(interface, addresses):
    result = subprocess.run(
        ['ip', '-j', '-4', 'address', 'show', 'dev', interface],
        capture_output=True, text=True, timeout=2, check=False,
    )
    if result.returncode:
        return False
    for link in json.loads(result.stdout):
        assigned = {item['local'] for item in link.get('addr_info', [])
                    if item.get('family') == 'inet' and not item.get('tentative')}
        if 'LOWER_UP' in link.get('flags', []) and addresses <= assigned:
            return True
    return False


def wait_for_network(interface, addresses, timeout):
    deadline = time.monotonic() + timeout
    print('[gmk-lidar] 等待网口 '+interface+' 与接收 IP '+', '.join(sorted(addresses)), flush=True)
    while True:
        if interface_ready(interface, addresses):
            print('[gmk-lidar] 网口与接收 IP 已就绪，启动雷达驱动。', flush=True)
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('网口或接收 IP 未就绪，未启动雷达驱动')
        time.sleep(min(0.25, remaining))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--interface', default='enp3s0')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or args.timeout < 0:
        parser.error('需要驱动命令且 timeout 不能为负数')
    try:
        addresses = receiver_ips(command)
        wait_for_network(args.interface, addresses, args.timeout)
    except (OSError, ValueError, KeyError, TypeError, TimeoutError,
            yaml.YAMLError, subprocess.SubprocessError) as error:
        print('[gmk-lidar] '+str(error), file=sys.stderr, flush=True)
        return 2
    os.execvp(command[0], command)


if __name__ == '__main__':
    sys.exit(main())
