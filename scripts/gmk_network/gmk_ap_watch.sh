#!/bin/bash
# Wi-Fi watchdog, client-first:
#   - If any Wi-Fi connection is active on wlp1s0 (client network or fallback AP),
#     leave it alone.
#   - If none is active and NetworkManager has been ready > 120 s, bring up
#     the fallback AP GMK-SIM. Slow boot must not consume NM's grace period.
#   - Respect "off" mode (manual down) and the gmk_ap.sh busy lock.
set -u
IF=wlp1s0
MODE=$(cat /run/gmk-net-mode 2>/dev/null || echo "")
[ "$MODE" = off ] && exit 0

# Skip while gmk_ap.sh is deliberately reconfiguring (lock younger than 90 s).
if [ -f /run/gmk-ap-busy ]; then
  B=$(cat /run/gmk-ap-busy 2>/dev/null || echo 0)
  NOW=$(date +%s)
  [ $((NOW - B)) -lt 90 ] && exit 0
fi

# GMK_NM_READY_GRACE: kernel uptime alone is insufficient on a slow boot.
# In the observed failure NM started at 125 s; the old uptime guard therefore
# opened the AP immediately, preempting the saved client connection.
NM_READY_US=$(systemctl show NetworkManager.service --property=ActiveEnterTimestampMonotonic --value 2>/dev/null || true)
case "$NM_READY_US" in ''|*[!0-9]*) exit 0 ;; esac
[ "$NM_READY_US" -gt 0 ] || exit 0
UP=$(cut -d. -f1 /proc/uptime)
NM_READY=$(((NM_READY_US + 999999) / 1000000))
[ $((UP - NM_READY)) -lt 120 ] && exit 0

# Any connection (client or AP) active on this interface?
# NB: "nmcli con" reports type 802-11-wireless, not "wifi"; use the device state.
if nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -q "^${IF}:connected"; then
  exit 0
fi

logger -t gmk-ap-watch "no active Wi-Fi on $IF; starting fallback AP"
/usr/local/bin/gmk_ap.sh up >>/tmp/gmk_ap_watch.log 2>&1
