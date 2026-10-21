# 已部署 GMK 的无线开机修复

这组脚本用于已有 GMK 无线套件的增量维护，不是新机器的网络初始化程序。
适用环境：Ubuntu 22.04，NetworkManager 管理 `wlp1s0`，systemd-networkd/Netplan 管理 `enp3s0`，
且已有 `/usr/local/bin/gmk_ap.sh` 和 `gmk_ap_watch.sh`。更换网卡名称或网络管理方式时先调整方案。

出现过的问题：systemd-networkd-wait-online 等待 120 秒，cloud-init 的启动依赖又阻塞
NetworkManager；原 watchdog 按系统运行时间计算宽限，可能在 Wi-Fi 刚启动时抢先打开热点。

在仓库根目录依次执行，遇到预检查失败先查看原因：

```bash
sudo python3 scripts/gmk_network/apply_wifi_boot_fix.py
sudo python3 scripts/gmk_network/fast_wifi_boot.py --apply
sudo python3 scripts/gmk_network/fix_network_boot_order.py
```

- watchdog 改为从 NetworkManager 就绪后计算 120 秒宽限；已有客户端连接或兜底热点时不抢占。
- Netplan 只给 enp3s0 设置 optional，不改变原来的 IP、网关、DNS，原网口仍工作。
- 屏蔽 networkd 的全局开机等待，保留 NetworkManager-wait-online。仅 disable 不够，
  因为 Netplan 会通过 systemd generator 再次拉起该等待服务。
- 实机雷达启动在 ROS launch 内单独检查网口与接收 IP，避免依赖全局开机等待。

脚本会备份到 `/var/backups/gmk-network/`，不重启网络、不切换当前 Wi-Fi、不自动重启机器。
正常关闭仿真、导航和雷达驱动后，再由使用者安排重启。恢复屏蔽设置可用对应
`boot-order-*/restore.sh`，执行后下次启动可能再次等待 120 秒。

已有 GMK 先前验证：接雷达网线重启约 19 秒自动连上保存的 Wi-Fi，有线 IP 和雷达通信保持。
这些系统配置不随 ROS 编译自动生效；部署到另一台机器需先确认其网口用途与启动依赖。
不需要复制系统 Wi-Fi 密码文件，也不应将这些文件提交仓库。
