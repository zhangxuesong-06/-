#!/usr/bin/env python3
"""Make the wired link optional for global boot; preserve its configuration."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import yaml

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--apply', action='store_true')
a = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit('需要 root 读取和验证系统网络配置')
netplan = '/usr/sbin/netplan'
name = '90-gmk-wired-optional.yaml'
target = Path('/etc/netplan')/name
marker = '# GMK_WIRED_OPTIONAL_BOOT'
content = marker+'\nnetwork:\n  version: 2\n  ethernets:\n    enp3s0:\n      optional: true\n'

def get(root=None):
    args = [netplan, 'get']
    if root is not None:
        args += ['--root-dir', str(root)]
    args += ['network.ethernets']
    return yaml.safe_load(subprocess.check_output(args, text=True))

before = get()
if not isinstance(before, dict) or 'enp3s0' not in before:
    raise SystemExit('有线接口配置与本机不符，未修改')
old = target.read_bytes() if target.exists() else None
if old is not None and marker.encode() not in old:
    raise SystemExit('目标文件已存在且不属于套件，未覆盖')
with tempfile.TemporaryDirectory(prefix='gmk-netplan-check-') as directory:
    stage = Path(directory)
    shutil.copytree('/etc/netplan', stage/'etc/netplan', symlinks=True)
    staged_file = stage/'etc/netplan'/name
    staged_file.write_text(content)
    staged_file.chmod(0o600)
    after = get(stage)
    wanted = {k: dict(v) for k,v in before.items()}
    wanted['enp3s0']['optional'] = True
    if after != wanted:
        raise SystemExit('合并结果改变了其他有线设置，未修改')
    subprocess.run([netplan,'generate','--root-dir',str(stage)],check=True)
    generated = stage/'run/systemd/network/10-netplan-enp3s0.network'
    if not generated.is_file() or 'RequiredForOnline=no' not in generated.read_text():
        raise SystemExit('未生成正确的可选网口设置，未修改')
    print('预检查通过：仅 enp3s0.optional=true；原 IP、网关、DNS 及其他网口配置保持一致。')
if not a.apply:
    raise SystemExit(0)
if old == content.encode():
    print('优化已经安装。')
    raise SystemExit(0)
backup = Path('/var/backups/gmk-network')/('fast-wifi-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True,mode=0o700)
if old is None:
    (backup/(name+'.was-absent')).touch()
else:
    shutil.copy2(target,backup/name)
(backup/'wired-before.json').write_text(json.dumps(before,ensure_ascii=False,indent=2))
fd, temporary = tempfile.mkstemp(prefix='.gmk-netplan-', dir=target.parent)
try:
    with os.fdopen(fd,'w') as stream:
        stream.write(content)
    os.chmod(temporary,0o600)
    os.replace(temporary,target)
    subprocess.run([netplan,'generate'],check=True)
except Exception:
    if old is None:
        target.unlink(missing_ok=True)
    else:
        target.write_bytes(old)
        target.chmod(0o600)
    subprocess.run([netplan,'generate'],check=False)
    raise
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('已安装：'+str(target))
print('备份：'+str(backup))
print('未执行 netplan apply、未重启网络；当前连接保持，重启后验证开机速度。')
