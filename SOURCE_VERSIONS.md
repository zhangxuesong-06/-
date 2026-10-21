# 上游固定版本

以下为导入时的上游提交；仓库还包含 README 列出的项目适配。原始 ZIP 不上传。

| 目录 | 上游提交 |
| --- | --- |
| `src/livox_ros_driver2` | `4a1def929e5b59c7a8122d19fce6efba581ce9f7` |
| `src/pb2025_robot_description` | `a0541dddcbfe376f369a6345b532a10923ad9149` |
| `src/pb2025_sentry_nav` | `837f4bd3e783a9b423cea18a76397ba803e010a4` |
| `src/pb_nav2_plugins` | `0d4b49b0a44a2266a6b695eb2f0538a3326432df` |
| `src/pb_omni_pid_pursuit_controller` | `b542c5794b91fba2bb3fe2cbdc72fcf854fedb1a` |
| `src/pb_teleop_twist_joy` | `14529bcc31696659b394a4114bb23da161c2e12a` |
| `src/point_lio` | `e85e79558cf746f6699888a54285fe48b3b0ac71` |
| `src/pointcloud_to_laserscan` | `59bf996fb3ee7db0026a5cd3ce0d2a39d2e602ea` |
| `src/rmoss_core` | `8209ec517dfbb7ecac613cf0c9534d67ff918b7d` |
| `src/rmoss_gazebo` | `7443ff06c345752d0e23172c479d99b27207e2c7` |
| `src/rmoss_gz_resources` | `b5c759f08844dfda19c79aa870866ace8d4c7b3a` |
| `src/rmoss_interfaces` | `424f50c831b3e74fa72446969362cdabb2e22cd1` |
| `src/rmu_gazebo_simulator` | `dfc42a41eb2a88ce4c6fee054dbf47defcf6b3b7` |
| `src/sdformat_tools` | `47c2d1a37372281e5627d444f7537efc0bba11df` |
| `src/small_gicp_relocalization` | `1df063ee6f67b592e1da47e2a21ded00321c0906` |
| `third_party/Livox-SDK2` | `08f523c930b2f0ba1e98a6afaa8d7476bf479908` |
| `third_party/small_gicp` | `2c6c7831bc1f5ada2ee5300027fe7d7aee66827d` |

SDK 仍以上表的 1.4.3 源码为基准，Linux 共享库新增公共 C API 导出表，隔离内部日志符号；
未降级或引入另一份 SDK。增量改动与验证范围见 `GMK_LIDAR_NETWORK_CHANGES.md`。
