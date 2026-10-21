import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'gate', Path(__file__).resolve().parents[1]/'src/pb2025_sentry_nav/pb2025_nav_bringup/launch/gmk_lidar_network_gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class LidarNetworkGateTests(unittest.TestCase):
    def test_evaluated_namespaced_parameter_files_and_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = root/'old.json'
            new = root/'new.json'
            old.write_text(json.dumps({'MID360': {'host_net_info': {'point_data_ip': '192.168.1.5'}}}))
            new.write_text(json.dumps({'MID360': {'host_net_info': {
                'point_data_ip': '192.168.1.50', 'imu_data_ip': '192.168.1.50', 'log_data_ip': ''}}}))
            params = root/'params.yaml'
            params.write_text('red_standard_robot1:\n  livox_ros_driver2:\n    ros__parameters:\n      user_config_path: '+str(old)+'\n')
            self.assertEqual(gate.receiver_ips(['driver', '--ros-args', '--params-file', str(params),
                                               '-p', 'user_config_path:='+str(new)]), {'192.168.1.50'})

    def test_requires_carrier_and_all_receiver_addresses(self):
        from types import SimpleNamespace
        link = {'flags': ['UP'], 'addr_info': [{'family': 'inet', 'local': '192.168.1.50'}]}
        def response(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout=json.dumps([link]))
        with patch.object(gate.subprocess, 'run', side_effect=response):
            self.assertFalse(gate.interface_ready('enp3s0', {'192.168.1.50'}))
            link['flags'].append('LOWER_UP')
            self.assertTrue(gate.interface_ready('enp3s0', {'192.168.1.50'}))
            self.assertFalse(gate.interface_ready('enp3s0', {'192.168.1.5'}))

    def test_waits_until_interface_becomes_ready(self):
        with patch.object(gate, 'interface_ready', side_effect=[False, True]) as ready, \
                patch.object(gate.time, 'sleep'):
            gate.wait_for_network('enp3s0', {'192.168.1.50'}, 2)
        self.assertEqual(ready.call_count, 2)

    def test_missing_network_prevents_driver_execution(self):
        with patch.object(gate, 'receiver_ips', return_value={'192.168.1.50'}), \
                patch.object(gate, 'interface_ready', return_value=False), \
                patch.object(gate.os, 'execvp') as execute:
            self.assertEqual(gate.main(['--timeout', '0', '--', '/bin/driver']), 2)
        execute.assert_not_called()

    def test_ready_network_preserves_exact_driver_arguments(self):
        command = ['/path with spaces/driver', '--ros-args', '-r', '__ns:=/robot']
        with patch.object(gate, 'receiver_ips', return_value={'192.168.1.50'}), \
                patch.object(gate, 'interface_ready', return_value=True), \
                patch.object(gate.os, 'execvp') as execute:
            gate.main(['--', *command])
        execute.assert_called_once_with(command[0], command)


if __name__ == '__main__':
    unittest.main()
