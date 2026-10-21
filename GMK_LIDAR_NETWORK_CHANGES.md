# 雷达驱动退出与 GMK 网络启动修复

本次以远端 `main` 的 `605009cdb81f2c9705179fa11423574b7b7c4ded` 为基础，
保留该版本的雷达倒装适配、实机参数和决策节点；不从旧 GMK 工作区覆盖整个驱动或导航目录。

## 修改后的行为

- SDK 保持仓库固定的 **1.4.3**，驱动保持 **1.2.7**。Linux 共享 SDK 只导出公共头文件声明的
  62 个 C 接口，隐藏 spdlog/fmt 等实现符号，避免与 ROS 日志库混用导致停止时崩溃。
- 实机 launch 使用网口助手，确认 enp3s0 链路和雷达 JSON 中的电脑接收 IP 就绪后再执行驱动；
  默认最多等待 30 秒。雷达地址保留主分支已有的 `.121`，接收电脑为 `.50`。
- 补入并跟踪 ROS 2 `package.xml`。上游忽略规则原本排除了它，导致普通克隆缺少实际构建清单；
  文件内容与仓库已有的 `package_ROS2.xml` 一致，原 ROS1/ROS2 CMake 分支保留。
- `scripts/gmk_network/` 保存已部署 GMK 的无线开机增量修复。它独立于 ROS 构建，需按其说明
  在符合前提的 GMK 上运行，不能将这些设置直接套用到所有机器。
- 增加公共接口验证脚本、只运行雷达的接收/退出脚本，以及网口和 watchdog 回归测试。

没有引入 SDK 1.2.5 的 vendor 副本，没有修改本分支的 Point-LIO、地图、机器人安装姿态或导航控制参数。

## 版本与验证环境

| 项目 | 验证值 |
| --- | --- |
| SDK 源码基准 | `08f523c930b2f0ba1e98a6afaa8d7476bf479908`，运行时版本 1.4.3 |
| 驱动版本 | 1.2.7 |
| 环境 | GMK x86_64、Ubuntu 22.04、ROS 2 Humble、单 MID360 |
| 设备网络 | 接收 IP 192.168.1.50，雷达 192.168.1.121 |
| 独立验证目录 | `/home/rm/gmk-repo-validation-20261021` |
| ROS 验证域 | 174 |

SDK 静态库和共享库成功构建并安装到验证目录内的 `deps`，随后成功构建
`livox_ros_driver2` 和 `pb2025_nav_bringup`。没有安装到系统 `/usr/local`，
也没有替换 GMK 正式工作区中的驱动或 SDK。

SDK 导出检查通过：运行时版本 1.4.3，导出表与公共 C API 的 62 个函数完全一致，无额外 C++ 实现符号。
动态依赖检查确认验证驱动加载的是独立目录中的 SDK，而不是正式工作区或旧系统 SDK。

## 真实雷达验证结果

使用仓库参数的 `xfer_format=1`，只启动 Livox 驱动和订阅器；没有启动仿真、Point-LIO、导航、决策节点或底盘控制。

| 场景 | 退出码 | 停止耗时 | 接收情况 |
| --- | --- | --- | --- |
| 采集后 SIGINT | 0 | 1.718 秒 | CustomMsg 79 条、IMU 81 条 |
| 采集后 SIGTERM | 0 | 0.715 秒 | CustomMsg 81 条、IMU 83 条 |
| 启动约 0.25 秒后 SIGINT | 0 | 4.475 秒 | 只验证退出 |
| 再次启动、采集后 SIGINT | 0 | 0.665 秒 | CustomMsg 81 条、IMU 82 条 |

所有场景没有强杀；正常采集场景的时间戳倒退计数为 0。
另从实际实机 launch 中仅提取 Livox Node 执行集成检查，验证参数替换、命名空间和 prefix 网口检查：
收到 CustomMsg 183 条、IMU 187 条，驱动正常退出 0。

10 项单元测试通过，覆盖网口接收 IP、链路就绪、失败时不启动驱动、参数覆盖、执行参数保留，
以及 Wi-Fi watchdog 在慢启动、已有连接、人工关闭和接入锁下的行为。
现有 GMK 已部署的网络修复此前完成接雷达重启验证，约 19 秒联网；本次未再次执行系统配置安装脚本。

这次没有全量重建其他 28 个 ROS 包，也没有验证 ROS1、其他硬件平台、长期丢包、IMU 频率/标定或整车定位导航精度。
先前 GMK 1.2.5 的测试不作为本仓库 1.4.3 的验证替代。

## 复现检查

按 README 构建并安装 SDK 和 ROS 包后，在已 source 当前仓库环境的终端执行：

```bash
python3 scripts/verify_livox_sdk_exports.py /usr/local/lib/liblivox_lidar_sdk_shared.so
python3 -m unittest discover -s tests
python3 scripts/verify_lidar_shutdown.py
```

最后一条会操作真实雷达驱动；已有雷达驱动运行时会拒绝启动，需先停止原驱动。输出报告和日志在
`runtime/lidar-verification/`，不提交 Git。结束后不保留测试驱动进程。

若仅更新 SDK 修复，仍需重新构建并安装 SDK、运行 `sudo ldconfig`，再构建驱动并重新启动其进程，
不能继续使用旧进程中已经加载的 SDK。若需回退，恢复修改前源码后重建 SDK 和驱动。
