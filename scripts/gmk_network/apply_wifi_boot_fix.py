#!/usr/bin/env python3
"""Root installer for the single watchdog timing fix; does not restart networking."""
from datetime import datetime
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

if os.geteuid() != 0:
    raise SystemExit('必须以 root 安装守护脚本')
source = Path(__file__).with_name('gmk_ap_watch.sh')
data = source.read_bytes()
if b'GMK_NM_READY_GRACE' not in data or len(data) > 12000:
    raise SystemExit('待安装的守护脚本不符')
subprocess.run(['bash', '-n', str(source)], check=True)
target = Path('/usr/local/bin/gmk_ap_watch.sh')
old = target.read_bytes()
if b'/usr/local/bin/gmk_ap.sh up' not in old or b'/run/gmk-net-mode' not in old:
    raise SystemExit('原脚本结构不符，停止以保留当前配置')
if old == data:
    print('该修正已安装，无需重复写入')
    sys.exit(0)
backup = Path('/var/backups/gmk-network') / ('wifi-boot-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
backup.mkdir(parents=True, mode=0o700)
shutil.copy2(target, backup/target.name)
fd, name = tempfile.mkstemp(prefix='.gmk-ap-watch-', dir=target.parent)
try:
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
    os.chmod(name, 0o755)
    os.chown(name, 0, 0)
    os.replace(name, target)
finally:
    if os.path.exists(name):
        os.unlink(name)
print('已安装：'+str(target))
print('备份：'+str(backup))
print('SHA256：'+hashlib.sha256(data).hexdigest())
print('未修改 Wi-Fi 档案、密码或当前连接；下一次 watchdog 调用即生效。')
