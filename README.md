# 北极熊哨兵仿真与导航

本仓库包含单 MID360 仿真导航源码：Ubuntu 22.04、ROS 2 Humble、Gazebo Fortress，15 个上游 ROS 仓库和一个简易决策树包，共 30 个 ROS 包，以及 Livox-SDK2 和 small_gicp 源码。仿真导航和决策节点已运行验证；实机雷达收发与驱动退出已在 GMK 做短时验证，整车定位导航仍需验收。

**新机器不能只 `git clone` 就启动：需要安装系统依赖、编译，并单独提供 PCD。** 以下教程从 Ubuntu 22.04 x86_64 桌面环境开始，不依赖原作者的用户名或绝对路径。建议内存至少 16 GB、有可用 OpenGL 图形环境和足够磁盘空间，首次编译并行度设为 2。

## 1. 安装 ROS 2 Humble

打开 Bash 终端，退出 Conda/其他 Python 虚拟环境。已有 `/opt/ros/humble/setup.bash` 的机器可跳过 ROS 软件源配置，但仍需安装后续依赖。以下 sudo 命令修改系统，由使用者执行。

```bash
sudo apt update
sudo apt install -y locales software-properties-common curl gnupg git ca-certificates
sudo locale-gen en_US en_US.UTF-8
sudo update-locale LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
export LANG=en_US.UTF-8
sudo add-apt-repository -y universe
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key -o /tmp/beijixiong-ros.key
sudo install -m 0644 /tmp/beijixiong-ros.key /usr/share/keyrings/ros-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu jammy main\n' "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/ros2.list >/dev/null
sudo apt update
sudo apt install -y ros-humble-desktop python3-rosdep python3-colcon-common-extensions python3-vcstool
source /opt/ros/humble/setup.bash
```

如果已有 ROS 软件源，不要再建立重复条目。ROS 官方安装说明：<https://docs.ros.org/en/humble/Installation/Ubuntu-Install-Debs.html>。

## 2. 安装编译、仿真和导航依赖

```bash
sudo apt install -y \
  build-essential cmake pkg-config python3-dev python3-pip python3-yaml \
  python3-numpy python3-opencv libeigen3-dev libpcl-dev libopencv-dev \
  libgoogle-glog-dev libunwind-dev libomp-dev libapr1-dev \
  ros-humble-navigation2 ros-humble-nav2-bringup ros-humble-slam-toolbox \
  ros-humble-pcl-ros ros-humble-pcl-conversions ros-humble-joy \
  ros-humble-cv-bridge ros-humble-camera-info-manager ros-humble-image-transport \
  ros-humble-eigen3-cmake-module ros-humble-joint-state-publisher \
  ros-humble-robot-state-publisher ros-humble-xacro \
  ros-humble-ament-cmake-auto ros-humble-ros-gz-sim ros-humble-ros-gz-bridge \
  ignition-fortress libignition-gazebo6-dev libignition-msgs8-dev libignition-transport11-dev
/usr/bin/python3 -m pip install --user 'xmacro==1.2.1'
/usr/bin/python3 -c 'from xmacro.xmacro4sdf import XMLMacro4sdf; print("xmacro OK")'
```

若 apt 找不到 Fortress 包，配置 OSRF 软件源后重新执行上述 apt 安装命令：

```bash
curl -fsSL https://packages.osrfoundation.org/gazebo.gpg -o /tmp/beijixiong-gazebo.gpg
sudo install -m 0644 /tmp/beijixiong-gazebo.gpg /usr/share/keyrings/pkgs-osrf-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/pkgs-osrf-archive-keyring.gpg] https://packages.osrfoundation.org/gazebo/ubuntu-stable jammy main\n' "$(dpkg --print-architecture)" | sudo tee /etc/apt/sources.list.d/gazebo-stable.list >/dev/null
sudo apt update
```

可选网页控制依赖（基础导航不需要）：

```bash
/usr/bin/python3 -m pip install --user \
  'Flask==3.1.3' 'Flask-SocketIO==5.6.1' \
  'Flask-Cors==6.0.5' 'python-engineio==4.14.0'
```

## 3. 克隆源码与检查依赖

```bash
cd ~
git clone https://github.com/zhangxuesong-06/-.git beijixiong
cd beijixiong
source scripts/env.sh
```

若 `~/beijixiong` 已存在，换一个空目录名即可。`env.sh` 自动计算仓库根目录为 `$PB_ROOT`，并创建项目内 runtime 目录。以后每个新终端先 source 该文件。

所有 17 份源码已在仓库内，**无需下载原 ZIP、导入 dependencies.repos 或初始化上游子模块**。`src/` 下各仓库并列；`third_party/` 下的两个库单独构建。

初始化 rosdep（已初始化的机器跳过 `sudo rosdep init`）：

```bash
sudo rosdep init
rosdep update
rosdep install --from-paths "$PB_ROOT/src" --ignore-src --rosdistro humble -y
```

rosdep 会安装 manifest 声明的依赖；第 2 节还补充了上游 manifest 未声明的依赖。遇到网络/软件源错误应先解决，不要把失败当作安装完成。

## 4. 构建并安装两个基础库

源码、构建文件在仓库内，最终头文件和库安装到系统 `/usr/local`。不能跳过编译直接执行安装：克隆仓库不包含构建产物。

```bash
cmake -S "$PB_ROOT/third_party/Livox-SDK2" \
  -B "$PB_ROOT/build-deps/Livox-SDK2" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local
cmake --build "$PB_ROOT/build-deps/Livox-SDK2" --parallel 2
sudo cmake --install "$PB_ROOT/build-deps/Livox-SDK2"

cmake -S "$PB_ROOT/third_party/small_gicp" \
  -B "$PB_ROOT/build-deps/small_gicp" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF \
  -DBUILD_BENCHMARKS=OFF -DBUILD_PYTHON_BINDINGS=OFF
cmake --build "$PB_ROOT/build-deps/small_gicp" --parallel 2
sudo cmake --install "$PB_ROOT/build-deps/small_gicp"
sudo ldconfig
```

每步成功后再进行下一步。检查依赖，`ldd` 不应出现 `not found`：

```bash
pkg-config --modversion ignition-gazebo6 ignition-msgs8 ignition-transport11 apr-1
ls /usr/local/include/livox_lidar_api.h \
   /usr/local/lib/liblivox_lidar_sdk_shared.so \
   /usr/local/lib/cmake/small_gicp/small_gicp-config.cmake
ldd /usr/local/lib/liblivox_lidar_sdk_shared.so
ldd /usr/local/lib/libsmall_gicp.so
```

Livox-SDK2 固定提交为 `08f523c930b2f0ba1e98a6afaa8d7476bf479908`，CHANGELOG 标为 1.4.3，但没有同名正式 tag；不要替换成此前不匹配的 v1.2.5。完整固定版本见 [SOURCE_VERSIONS.md](SOURCE_VERSIONS.md)。

Linux 共享 SDK 只导出公共 C API，内部 spdlog/fmt 符号保持私有，避免与 ROS 日志库混用而在退出时崩溃。
更新此修复后应重新构建并安装 SDK，再构建 ROS 驱动，不能只复制 launch 文件。安装后检查版本和导出接口：

```bash
python3 scripts/verify_livox_sdk_exports.py /usr/local/lib/liblivox_lidar_sdk_shared.so
```

## 5. 放入 PCD，再编译 ROS 工作区

按仓库拥有者要求，`.gitignore` 排除了所有 PCD，**本仓库不分发点云地图，也没有自动下载地址**。向项目拥有者取得已验证的 `rmuc_2025.pcd`，在构建前放到：

```text
src/pb2025_sentry_nav/pb2025_nav_bringup/pcd/simulation/rmuc_2025.pcd
```

原验证文件 SHA256 为 `5e1bda92eacc6bc338b278a7032dfa49cc1a8eb1d1fee83d09d1d726750d717d`。可用 `sha256sum` 核对。运行 rmul_2025 则需相应的 rmul_2025.pcd。二维栅格地图已随源码收录。

缺少 PCD 仍可构建和启动 Gazebo，但无法直接进行该地图的重定位导航。构建后才添加 PCD 时，可以在导航命令中用 `prior_pcd_file:=/绝对路径/rmuc_2025.pcd` 显式指定，或重新构建 pb2025_nav_bringup。

```bash
cd "$PB_ROOT"
colcon list --base-paths src
colcon --log-base "$PB_ROOT/log" build \
  --base-paths "$PB_ROOT/src" \
  --build-base "$PB_ROOT/build" \
  --install-base "$PB_ROOT/install" \
  --symlink-install --parallel-workers 2 \
  --cmake-args -DCMAKE_BUILD_TYPE=Release \
  -DROS_EDITION=ROS2 -DDISTRO_ROS=humble \
  -DPython3_EXECUTABLE=/usr/bin/python3 \
  -DPYTHON_EXECUTABLE=/usr/bin/python3 -DBUILD_TESTING=OFF
source "$PB_ROOT/install/setup.bash"
```

应识别并完成 30 个 ROS 包。部分包提示未使用 `ROS_EDITION`、`DISTRO_ROS` 等 CMake 参数属于警告；以是否有 Failed/Aborted 包判断构建是否成功。不要运行 Livox 原始 `build.sh`，以免清空工作区构建目录。

## 6. 启动仿真与导航

下面假设克隆到 `~/beijixiong`；若使用其他路径，替换第一行的目录。终端 A：

```bash
cd ~/beijixiong
source scripts/env.sh
source install/setup.bash
ros2 launch rmu_gazebo_simulator bringup_sim.launch.py
```

保持 Gazebo 播放，等待机器人生成。终端 B：

```bash
cd ~/beijixiong
source scripts/env.sh
source install/setup.bash
ros2 launch pb2025_nav_bringup rm_navigation_simulation_launch.py
```

默认是 `world:=rmuc_2025`、`namespace:=red_standard_robot1`、`slam:=False`、`use_sim_time:=True`。确认 RViz 点云与地图对齐，必要时用 2D Pose Estimate 设置初始位姿，再用 Nav2 Goal 选择附近空旷位置。停止时在相应终端按 Ctrl+C。

没有先验地图、需要现场在线建图时，启动 SLAM 模式。该模式由 `slam_toolbox` 在线生成地图，并关闭依赖先验点云的 small_gicp 重定位：

```bash
cd ~/beijixiong
source scripts/env.sh
source install/setup.bash
ros2 launch pb2025_nav_bringup rm_navigation_simulation_launch.py slam:=True
```

建图后可将当前二维地图保存到运行目录（不进入 Git）：

```bash
mkdir -p "$PB_ROOT/runtime/maps"
ros2 run nav2_map_server map_saver_cli -t /red_standard_robot1/map \
  -f "$PB_ROOT/runtime/maps/site"
```

### 简易决策树

决策包根据裁判血量选择两个 `map` 坐标目标：`remain_hp > 50` 前往点一，`remain_hp <= 50` 前往点二。Nav2 仍负责路径规划、避障和执行。

先在 RViz 中记录两个目标点。以下命令清空旧记录并启动记录模式：

```bash
cd ~/beijixiong
bash scripts/start_sim_decision.sh mode:=record reset:=true
```

在 RViz 工具栏额外添加标准 `rviz_default_plugins/SetGoal` 工具，将其 Topic 设为 `/red_standard_robot1/decision/record_goal`，依次拖出点一和点二的朝向。这个工具只向记录节点发布位姿；现有 Nav2 Goal 工具和 RViz 配置均不需要修改，也不要用现有 Nav2 Goal 工具做点位记录。记录文件位于 `$PB_ROOT/runtime/decision_goals.json`。

记录完成后，在另一个终端用测试血量启动决策：

```bash
cd ~/beijixiong
bash scripts/start_sim_decision.sh mode:=decision hp_source:=test
```

测试节点默认发布 `100/100`，因此机器人前往点一。可在第三个终端切换为 `40/100` 验证点二：

```bash
cd ~/beijixiong
source scripts/env.sh
source install/setup.bash
ros2 param set /red_standard_robot1/mock_robot_status remain_hp 40
```

验证真实仿真裁判血量时，先退出测试决策进程，再运行：

```bash
bash scripts/start_sim_decision.sh mode:=decision hp_source:=referee
```

决策状态可通过 `ros2 topic echo /red_standard_robot1/decision/state` 查看。记录模式和决策模式不要同时运行。

## 7. 已有适配与排错

- 单 MID360 仿真：移除 RPLIDAR 实例及对应桥接，保留点云和 IMU。
- 雷达倒装适配：仿真 MID360 安装在 `gimbal_yaw` 上，姿态绕 X 轴旋转 180 度；定位与点云转换参数使用对应的云台参考系。
- 点云强度过滤：`pointcloud_to_laserscan` 支持 `min_intensity`/`max_intensity`，仿真配置用高度强度阈值过滤地面点。
- Livox：包含并跟踪 ROS2 package.xml；实机 xfer_format=1；保留 SDK 1.4.3，隔离共享库内部日志符号。
- 重定位：使用 C++17 和安装的 small_gicp::small_gicp，不再在线拉取 master。
- 模型：移除 stock joint_state_publisher 不支持的零值 offset_timestamp。
- 找不到 ROS 包：每个新终端都要 source scripts/env.sh 和 install/setup.bash。
- Python 导入异常：退出 Conda，使用 `/usr/bin/python3`；不要混用 ROS1 环境。
- 无点云/仿真不前进：确认 Gazebo 已播放，检查 `/clock` 和 `/red_standard_robot1/livox/lidar`。
- 地图加载失败：检查 PCD 文件、地图名称和启动参数；PCD 不在 Git 仓库中。
- 内存不足：将两个库的 `--parallel`、ROS 的 `--parallel-workers` 和 `CMAKE_BUILD_PARALLEL_LEVEL` 都改为 1。
- 无先验地图测试使用 `slam:=True` 在线建图；地图仅保存在本地 `runtime/maps`，PCD 和运行地图均不进入仓库。

## 实机范围与许可

实机目标为 NUC13、Ubuntu 22.04 x86、单 MID360；网络、雷达安装外参、底盘 ROS1 到 ROS2 接口与实地地图尚需配置，详见 [HARDWARE_MIGRATION.md](HARDWARE_MIGRATION.md)。实机配置中的 IP 和机器人几何是示例，不能把仿真成功当作实机验收。

GMK 增量部署的无线开机修复单独见 [scripts/gmk_network/README.md](scripts/gmk_network/README.md)，
不会随 ROS 编译自动应用。迁移范围与验证记录见 [GMK_LIDAR_NETWORK_CHANGES.md](GMK_LIDAR_NETWORK_CHANGES.md)。

各上游项目许可保留在各目录的 LICENSE/NOTICE 中。本仓库不为所有第三方代码重新指定统一许可。构建产物、日志、原 ZIP、PCD 和部署私钥不上传。
