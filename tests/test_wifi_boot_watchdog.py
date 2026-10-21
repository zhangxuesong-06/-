"""Exercise slow boot and fallback behavior using fake external commands."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class WatchdogTest(unittest.TestCase):
    def run_case(self, uptime, ready, connected=False, mode='', busy_age=None):
        with tempfile.TemporaryDirectory(prefix='gmk-wifi-test-') as directory:
            root = Path(directory)
            commands = root/'bin'
            commands.mkdir()
            calls = root/'calls'
            def command(name, body):
                p = commands/name
                p.write_text('#!/bin/bash\n'+body+'\n')
                p.chmod(0o755)
            command('systemctl', 'printf "%s\\n" "$FAKE_READY"')
            command('nmcli', 'printf "wlp1s0:%s\\n" "$FAKE_STATE"')
            command('logger', ':')
            command('date', 'echo 1000')
            command('ap', 'echo AP >> "$FAKE_CALLS"')
            (root/'uptime').write_text(str(uptime)+'.00 0.00\n')
            (root/'mode').write_text(mode)
            if busy_age is not None:
                (root/'busy').write_text(str(1000-busy_age))
            script = (ROOT/'scripts/gmk_network/gmk_ap_watch.sh').read_text()
            for old,new in [('/proc/uptime',root/'uptime'),('/run/gmk-net-mode',root/'mode'),
                            ('/run/gmk-ap-busy',root/'busy'),('/tmp/gmk_ap_watch.log',root/'log'),
                            ('/usr/local/bin/gmk_ap.sh',commands/'ap')]:
                script = script.replace(old,str(new))
            env = dict(os.environ, PATH=str(commands)+':/usr/bin:/bin',
                       FAKE_READY=str(ready), FAKE_STATE='connected' if connected else 'disconnected',
                       FAKE_CALLS=str(calls))
            r = subprocess.run(['bash','-s'],input=script,text=True,env=env,capture_output=True)
            self.assertEqual(r.returncode,0,r.stderr)
            return calls.exists()

    def test_slow_boot_does_not_preempt_networkmanager(self):
        self.assertFalse(self.run_case(126,125740760))

    def test_networkmanager_grace_period(self):
        self.assertFalse(self.run_case(244,125740760))
        self.assertFalse(self.run_case(245,125740760))
        self.assertTrue(self.run_case(246,125740760))

    def test_existing_client_or_ap_is_preserved(self):
        self.assertFalse(self.run_case(600,125740760,connected=True))

    def test_manual_off_and_provisioning_lock_are_respected(self):
        self.assertFalse(self.run_case(600,125740760,mode='off'))
        self.assertFalse(self.run_case(600,125740760,busy_age=20))

    def test_unknown_or_not_ready_manager_is_not_preempted(self):
        for value in ('', '0', 'bad'):
            self.assertFalse(self.run_case(600,value))


if __name__ == '__main__':
    unittest.main()
