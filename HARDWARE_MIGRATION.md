# 单 MID360 实机迁移

仿真和导航已由用户验证可启动并运行。实机按下列顺序推进，硬件配置尚未确认，不直接套用示例参数启动自主导航。

## 1. 确认目标环境

需要确认计算机（当前机器或另一台、CPU 架构、Ubuntu/ROS 版本）、电脑有线 IP、雷达 IP、雷达相对底盘的安装位置与方向，以及底盘通信节点。

当前机器已构建，可直接使用。另一台机器应迁移项目源码、地图和配置，按 INSTALL_DEPENDENCIES.md 安装系统依赖并重新构建；不要直接复用带当前机器绝对路径的 build/install 或跨架构库。

## 2. 仅验证雷达和 IMU

结束 Gazebo 与仿真导航，避免同名话题和 TF 混用。雷达网络配置文件：

`src/pb2025_sentry_nav/pb2025_nav_bringup/config/reality/mid360_user_config.json`

当前文件对应 GMK 测试连接：电脑接收 IP `192.168.1.50`，雷达 IP `192.168.1.121`。换设备必须根据实际地址更新所有非空 host IP 和 lidar_configs.ip。电脑网卡静态 IP 配置属于系统设置，不能只修改 JSON。

实机 launch 会等待 enp3s0 链路及 JSON 中的接收 IP 就绪，最多 30 秒，再执行雷达驱动；SDK 保持仓库的 1.4.3，日志内部符号与 ROS 隔离。更换有线网卡时同步调整网口助手的 interface 设置。

在当前机器上，完成网络配置后可单独启动驱动，不启动导航或底盘控制：

```bash
cd ~/beijixiong  # 替换成实际仓库目录
source scripts/env.sh
source install/setup.bash
python3 "$PB_ROOT/src/pb2025_sentry_nav/pb2025_nav_bringup/launch/gmk_lidar_network_gate.py" -- \
ros2 run livox_ros_driver2 livox_ros_driver2_node --ros-args \
  -r __ns:=/red_standard_robot1 \
  -p xfer_format:=1 -p multi_topic:=0 -p data_src:=0 \
  -p publish_freq:=20.0 -p output_data_type:=0 \
  -p frame_id:=front_mid360 \
  -p user_config_path:="$PB_ROOT/src/pb2025_sentry_nav/pb2025_nav_bringup/config/reality/mid360_user_config.json"
```

另一个已加载相同环境的终端依次检查（频率检查用 Ctrl+C 结束）：

```bash
ros2 topic type /red_standard_robot1/livox/lidar
ros2 topic hz /red_standard_robot1/livox/lidar
ros2 topic hz /red_standard_robot1/livox/imu
ros2 topic echo /red_standard_robot1/livox/imu --once
```

点云类型应为 livox_ros_driver2/msg/CustomMsg，频率接近设置的 20 Hz；IMU 应持续更新且时间戳递增。记录静止状态下的加速度方向和量级。当前驱动 IMU header.frame_id 写死为 livox_frame，点云使用 front_mid360，后续核对 TF 时需要考虑此差异。

也可先停止上面的独立驱动，再运行只启动雷达的接收/退出检查：

```bash
python3 scripts/verify_lidar_shutdown.py
```

该脚本使用独立 ROS 域 174，检查 CustomMsg/IMU 接收与四种停止情形，结束后停止驱动；不会启动导航或底盘控制。
报告和日志位于仓库 `runtime/lidar-verification/`，不提交 Git。短时接收成功不等于标定、频率或定位精度验收。

## 3. 定位、TF 与实地地图

实机参数位于 config/reality/nav2_params.yaml，已设置 xfer_format=1、lidar_type=1、scan_line=4。重力方向是原机器人示例值，不能当成本机测量值；雷达到机器人底盘的 TF 必须按实际安装尺寸/朝向填写。Point-LIO 的 extrinsic_T/R 是雷达到 IMU 的变换，不能混作雷达到底盘的安装变换。

原模型含云台帧 gimbal_yaw、gimbal_yaw_fake，速度转换和 Nav2 都引用它们。若实车是无云台底盘，需要统一修改模型、TF、定位和控制帧，不能只改一个 frame_id。

先验证静止和手动移动时 Point-LIO 点云与里程计稳定，再建实际场地的 PCD 与二维地图。现有仿真 rmuc_2025 地图不自动适用于办公室、走廊或其他实地。SLAM 模式前仍须处理 pointcloud_to_laserscan 缺少配置所要求的 intensity 过滤功能。

实机 launch 为 rm_navigation_reality_launch.py；其 namespace 默认空、use_sim_time 默认 False，默认 world=rmul_2024。正式使用时明确指定 namespace 和实际地图。use_robot_state_pub=True 只用于经过适配的独立测试模型；已有机器人 TF 发布节点时不重复启动它。

## 4. 底盘接口与导航

当前实机配置最终输出相对话题 cmd_vel，消息为 geometry_msgs/msg/Twist；使用 red_standard_robot1 命名空间后为 /red_standard_robot1/cmd_vel。速度转换使用 gimbal_yaw 坐标系，需确认底盘实际接收坐标系和 vx/vy/wz 含义。

需要匹配底盘通信协议、速度单位、全向/差速运动能力和反馈话题。先验证低速直行、横移（若支持）、旋转和停止；确认定位与地图重合，再发送短距离导航目标。硬件未接入前不发送运动指令。

所有项目修改限定在 beijixiong 内。网络设置、系统安装和设备访问权限调整由用户执行。
