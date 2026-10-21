#!/usr/bin/env python3
"""Remove networkd's global boot wait; keep NetworkManager's own online wait."""
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


if os.geteuid() != 0:
    raise SystemExit('需要 root 调整服务开机依赖')
unit = 'systemd-networkd-wait-online.service'
before = subprocess.run(['systemctl', 'is-enabled', unit], capture_output=True,
                        text=True, check=False).stdout.strip()
if before == 'masked':
    print('networkd 全局等待已屏蔽，无需重复修改。')
    raise SystemExit(0)
if run('systemctl', 'is-enabled', 'NetworkManager-wait-online.service') != 'enabled':
    raise SystemExit('NetworkManager 的在线等待未启用，未修改')
for name in ('NetworkManager.service', 'systemd-networkd.service'):
    if run('systemctl', 'is-active', name) != 'active':
        raise SystemExit(name+' 未运行，未修改')
required = run('systemctl', 'show', unit, '--property=RequiredBy', '--value')
wanted = run('systemctl', 'show', unit, '--property=WantedBy', '--value')
if required or any(name != 'network-online.target' for name in wanted.split()):
    raise SystemExit('等待服务存在额外依赖，未修改')
backup = Path('/var/backups/gmk-network')/('boot-order-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True, mode=0o700)
(backup/'before.json').write_text(json.dumps({'unit':unit,'enabled':before,'wanted_by':wanted},indent=2))
restore = backup/'restore.sh'
restore.write_text('#!/bin/bash\nset -e\nsystemctl unmask systemd-networkd-wait-online.service\nsystemctl enable systemd-networkd-wait-online.service\nsystemctl daemon-reload\n')
restore.chmod(0o700)
subprocess.run(['systemctl', 'mask', unit], check=True)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
assert subprocess.run(['systemctl', 'is-enabled', unit], capture_output=True,
                      text=True, check=False).stdout.strip() == 'masked'
assert run('systemctl', 'is-enabled', 'NetworkManager-wait-online.service') == 'enabled'
print('已屏蔽 networkd 全局开机等待（阻止 Netplan 自动重新启用）；网口和 Wi-Fi 服务继续运行。')
print('保留 NetworkManager-wait-online；未重启网络，未修改 IP、路由或雷达参数。')
print('回退脚本：'+str(restore))
