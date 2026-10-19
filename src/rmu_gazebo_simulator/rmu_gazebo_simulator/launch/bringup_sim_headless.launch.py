# Copyright 2025 Lihan Chen
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# 本文件由 NUC13 调优时新增（非上游文件）：无 GUI 版 bringup。
# 原因（本机实测）：Gazebo GUI 视口与 gpu_lidar 传感器抢同一块核显，
#   GUI 开着时点云只有 ~5.7Hz；关 GUI 后 ~9.5Hz。
# 想看画面用 Foxglove/RViz，不需要 Gazebo 3D 窗口。

"""Headless simulation bringup: Gazebo server only (no GUI window).

与 bringup_sim.launch.py 等价，但 Gazebo 以 `-r -s` 启动（直接运行、无 GUI）。
用法: ros2 launch rmu_gazebo_simulator bringup_sim_headless.launch.py
"""

import os

import yaml
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import ExecuteProcess, IncludeLaunchDescription, TimerAction
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch_ros.actions import Node


def generate_launch_description():
    pkg_simulator = get_package_share_directory("rmu_gazebo_simulator")

    gz_world_path = os.path.join(pkg_simulator, "config", "gz_world.yaml")
    with open(gz_world_path) as file:
        selected_world = yaml.safe_load(file).get("world")

    world_sdf_path = os.path.join(
        pkg_simulator, "resource", "worlds", f"{selected_world}_world.sdf"
    )

    # server-only（-s 无 GUI 窗口）。
    # 注意：不能直接 -r 运行中 spawn——实测运行态 spawn 机器人会触发
    # 渲染线程竞态段错误（armor light_bar_visual 重复名）。
    # 配方：暂停态启动 → spawn → 服务解暂停（下方 unpause）。
    gazebo = ExecuteProcess(
        cmd=["ign", "gazebo", "-s", "--headless-rendering", world_sdf_path, "--force-version", "6"],
        output="screen",
    )

    clock_bridge = Node(
        package="ros_gz_bridge",
        executable="parameter_bridge",
        arguments=["/clock@rosgraph_msgs/msg/Clock[gz.msgs.Clock"],
    )

    spawn_robots_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_simulator, "launch", "spawn_robots.launch.py")
        ),
    )

    referee_system_launch = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(
            os.path.join(pkg_simulator, "launch", "referee_system.launch.py")
        ),
    )

    # 等 server 就绪再 spawn（create 服务要活着）
    spawn_after_server = TimerAction(
        period=6.0,
        actions=[spawn_robots_launch, referee_system_launch],
    )

    # spawn 完再解暂停（顺序不能反）
    unpause = TimerAction(
        period=12.0,
        actions=[
            ExecuteProcess(
                cmd=[
                    "ign", "service", "-s", "/world/default/control",
                    "--reqtype", "ignition.msgs.WorldControl",
                    "--reptype", "ignition.msgs.Boolean",
                    "--timeout", "5000",
                    "--req", "pause: false",
                ],
                output="screen",
            ),
        ],
    )

    ld = LaunchDescription()
    ld.add_action(gazebo)
    ld.add_action(clock_bridge)
    ld.add_action(spawn_after_server)
    ld.add_action(unpause)
    return ld
