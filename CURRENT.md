# apx 当前基线（唯一入口）

> 更新：2026-11-17  
> **v2 是主线；`prototype/` 是 v1 归档，只用于回滚与历史证据，不再新增功能。**

## 1. 先看哪里

| 你要做的事 | 看这里 |
|---|---|
| 启动、配置、使用 v2 | `v2/README.md` |
| 理解 v2 架构与模块边界 | `docs/04-v2-architecture.md` |
| 看 v2 已完成能力和验收记录 | `docs/05-v2-delivery.md` |
| 看早期可行性、识别与安全分析 | `本地代理启动器-可行性分析与项目规划报告.md` |
| 回滚到 v1 原型 | `prototype/README.md`（只读归档） |

## 2. 当前结论

| 项 | 状态 |
|---|---|
| 主线 | **v2**（Go 单二进制网关 `apx2`） |
| 版本 | `2.0.0-dev` |
| 目标平台 | **Windows 优先**；Linux/macOS 后续扩展，不进入当前 P0 |
| 核心路径 | 外部 API Key provider → `~/.apx2` 配置 → `http://127.0.0.1:8787/v1` 统一端点 |
| v1 | 归档，不再接需求；回归仍可运行，作为回滚参考 |
| WorkBuddy 登录 | 暂不作为 P0；可通过 API Key 或后续 OAuth 增量接入 |

## 3. 可复现的验证命令

### v2（主线）

```powershell
# Go 1.24+；本机验证过 1.27.3
cd v2
powershell -ExecutionPolicy Bypass -File .\check.ps1
go build -o bin/apx2.exe ./cmd/apx
.\bin\apx2.exe doctor
.\bin\apx2.exe serve
```

当前基线证据（2026-11-17）：

- `go test ./...`：**63 个测试通过**
- `go vet ./...`：通过
- `apx2 doctor`：4 providers / 78 models；Ollama、Codex、Zcode 凭据通过；**WorkBuddy 缺少 `~/.apx2/auth/workbuddy.json`**
- 启动后 `GET /health`：`status=ok`（注意：这还没有反映 WorkBuddy 缺凭据，属于待修 P0）

如果 `go` 不在 PATH，本机可用：

```powershell
$env:PATH = "$env:LOCALAPPDATA\Programs\Go\go\bin;$env:PATH"
```

### v1（归档参考）

```powershell
cd prototype
npm run test:all
node src/cli.mjs ui
```

v1 文档记录的回归套件为 342 项、0 失败；当前 `npm run test:all` 退出码 0。它不再是需求入口。

## 4. 当前 P0（下一轮先做）

1. **安全边界**：`/api/status`、`/api/scan` 加鉴权；status 不再返回明文 `token`；页面改用控制台会话/令牌。
2. **真实可用性**：缺凭据的 provider 不再以“完全可用”暴露；`/health` 与 `/v1/models` 必须反映 `credentialReady`。
3. **外部 API Key provider**：添加 provider、保存 Key、测试模型、统一从 `/v1` 暴露；Key 不写 `providers.json`。
4. **凭据存储**：Windows ACL/DPAPI 方案；文档中的 `0600` 必须与真实权限一致。
5. **v2 黑盒验收**：覆盖鉴权、Key 保存、模型发现、流式、断连、并发、停止回收。

## 5. 仓库约定

- `v2/bin/`、日志、`.tmp/`、`.apx2/`、凭据文件不提交；见根目录 `.gitignore`。
- 新增 provider 或协议：先改 `v2/`，同步 `v2/README.md` 与 `docs/04-v2-architecture.md`。
- 不在 v1 里修新功能；v1 只接受回滚所需的安全补丁（如有）。
- 不把真实 Key、OAuth token、账号标识写入文档、测试或提交。
