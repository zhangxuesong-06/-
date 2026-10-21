#!/usr/bin/env python3
"""Start only the real Livox driver, collect data, and check graceful shutdown."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain-id', type=int, default=174)
    parser.add_argument('--namespace', default='/gmk_lidar_verification')
    parser.add_argument('--report', type=Path, default=root/'runtime/lidar-verification/results.json')
    args = parser.parse_args()
    if not 0 <= args.domain_id <= 232:
        parser.error('domain-id must be between 0 and 232')
    processes = subprocess.check_output(['ps', '-eo', 'args'], text=True)
    for line in processes.splitlines():
        words = line.split()
        if words and Path(words[0]).name == 'livox_ros_driver2_node':
            parser.error('A Livox driver is already running; stop it before this test')
    os.environ['ROS_DOMAIN_ID'] = str(args.domain_id)
    import rclpy
    import yaml
    from ament_index_python.packages import get_package_prefix, get_package_share_directory
    from rclpy.node import Node
    from rclpy.qos import qos_profile_sensor_data
    from livox_ros_driver2.msg import CustomMsg
    from sensor_msgs.msg import Imu

    prefix = Path(get_package_prefix('livox_ros_driver2'))
    share = Path(get_package_share_directory('pb2025_nav_bringup'))
    driver = prefix/'lib/livox_ros_driver2/livox_ros_driver2_node'
    gate = share/'launch/gmk_lidar_network_gate.py'
    params = yaml.safe_load((share/'config/reality/nav2_params.yaml').read_text())[
        'livox_ros_driver2']['ros__parameters']
    if params['xfer_format'] != 1:
        parser.error('This test expects the repository CustomMsg configuration (xfer_format=1)')
    params['user_config_path'] = params['user_config_path'].replace(
        '$(find-pkg-share pb2025_nav_bringup)', str(share))
    namespace = '/'+args.namespace.strip('/')
    args.report.parent.mkdir(parents=True, exist_ok=True)
    rclpy.init()
    results = []
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix='lidar-shutdown-') as directory:
            config = Path(directory)/'params.yaml'
            config.write_text(yaml.safe_dump({namespace+'/livox_ros_driver2':
                                             {'ros__parameters': params}}))
            command = [sys.executable, str(gate), '--', str(driver), '--ros-args',
                       '-r', '__node:=livox_ros_driver2', '-r', '__ns:='+namespace,
                       '--params-file', str(config)]
            for case, sig, seconds in (
                ('sigint', signal.SIGINT, 7), ('sigterm', signal.SIGTERM, 7),
                ('early_sigint', signal.SIGINT, 0.25), ('restart_sigint', signal.SIGINT, 7),
            ):
                node = Node('lidar_shutdown_verification')
                stats = {name: {'count': 0, 'backwards': 0} for name in ('cloud', 'imu')}

                def callback(name):
                    def receive(message):
                        row = stats[name]
                        stamp = message.header.stamp.sec+message.header.stamp.nanosec*1e-9
                        if row['count'] and stamp < row['last_stamp']:
                            row['backwards'] += 1
                        row.setdefault('first_stamp', stamp)
                        row['last_stamp'] = stamp
                        row['count'] += 1
                        row['frame'] = message.header.frame_id
                    return receive

                subscriptions = [node.create_subscription(cls, namespace+topic,
                                 callback(name), qos_profile_sensor_data)
                                 for name, cls, topic in (
                                     ('cloud', CustomMsg, '/livox/lidar'),
                                     ('imu', Imu, '/livox/imu'))]
                try:
                    with (args.report.parent/(case+'.log')).open('w') as log:
                        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
                        until = time.monotonic()+seconds
                        while time.monotonic() < until and process.poll() is None:
                            rclpy.spin_once(node, timeout_sec=0.05)
                        started = time.monotonic()
                        if process.poll() is None:
                            process.send_signal(sig)
                        forced_kill = False
                        try:
                            process.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            forced_kill = True
                            process.kill()
                            process.wait(timeout=3)
                        passed = process.returncode == 0 and not forced_kill
                        if seconds > 1:
                            passed = passed and all(row['count'] >= 5 and not row['backwards']
                                                    for row in stats.values())
                        result = {'case': case, 'passed': passed, 'exit_code': process.returncode,
                                  'stop_s': round(time.monotonic()-started, 3),
                                  'forced_kill': forced_kill, 'messages': stats}
                        results.append(result)
                        print(json.dumps(result), flush=True)
                finally:
                    if process is not None and process.poll() is None:
                        process.kill()
                        process.wait(timeout=3)
                    node.destroy_node()
                if not passed:
                    break
    finally:
        rclpy.shutdown()
        args.report.write_text(json.dumps({'driver': str(driver), 'domain_id': args.domain_id,
                                          'results': results}, indent=2)+'\n')
    return 0 if len(results) == 4 and all(row['passed'] for row in results) else 1


if __name__ == '__main__':
    sys.exit(main())
