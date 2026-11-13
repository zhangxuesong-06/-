# 05 · v2 交付记录

> 日期：2026-11-06
> 范围：按 magpie 思路整体重写本地网关，**完全不使用 magpie**（无 3425、无 plugin-auth.json、不改宿主配置）。

---

## 1. 交付了什么

`v2/` 是一个独立的 Go module（`apx2`），单二进制、零第三方依赖：

```
v2/
├─ go.mod
├─ run.ps1                    自动构建并启动
├─ README.md                  用户手册（快速开始/registry/协议/CLI/安全）
├─ cmd/apx/main.go            CLI
└─ internal/
   ├─ config/                 config.json + providers.json
   ├─ auth/                   env/文件/JSONPath/OAuth 凭据解析
   ├─ harness/                本机 harness 扫描 + 生成 registry
   ├─ router/                 provider/model、group/model、order/rotate/usage、健康
   ├─ upstream/               URL 归一化、请求、模型发现
   ├─ protocol/               Chat ↔ Responses ↔ Anthropic + SSE
   ├─ budget/                 上下文预算与工具裁剪
   └─ gateway/                HTTP 端点、并发、诊断、Web 控制台
```

核心能力：

- 多 provider registry：`~/.apx2/providers.json`
- 模型地址：`provider/model`、`group/model`、唯一裸名
- 路由：`order` / `rotate` / `usage` + 自动 failover + 15s 冷却
- 下游：OpenAI Chat Completions、OpenAI Responses（均支持流式）
- 上游：OpenAI Chat、OpenAI Responses、Anthropic Messages
- 凭据每请求现取：Codex OAuth 文件、WorkBuddy API key、Zcode key、环境变量
- `text_to_tool` 兼容层（Coopanion 桌宠）
- 上下文预算：system 必留、工具优先级、最近消息、孤立 tool 清理
- Web 控制台：provider 健康、模型、路由组、最近 60 条请求、harness 扫描
- 诊断：`X-Apx-Provider` / `X-Apx-Group`、`/api/status`、`/api/scan`、`/api/reload`
- 安全：仅本地监听、apx 自己的 `sk-local-…`、拒绝跨站、0600 权限

---

## 2. 如何运行

```powershell
cd v2
.\run.ps1 init --force
.\run.ps1 serve
```

或手动：

```powershell
go build -o bin/apx2.exe ./cmd/apx
.\bin\apx2.exe init --force
.\bin\apx2.exe serve
```

启动后：

```
端点   http://127.0.0.1:8787/v1
Key    sk-local-...
控制台 http://127.0.0.1:8787/
```

桌面一键启动（独立窗口）：

- 快捷方式：`C:\Users\HUAWEI\Desktop\apx2 模型网关.lnk`
- 目标：`v2\bin\apx2w.exe app`（Windows GUI 子系统，不弹控制台）
- 行为：在进程内启动网关 → 等待 `/health` → 用 Chrome/Edge 的 `--app` 模式打开独立窗口；
  关闭窗口时网关一起退出
- 窗口配置：`--user-data-dir=%USERPROFILE%\.apx2\browser`，不影响日常浏览器
- 已在运行：只开窗口，不重复起网关
- 日志：`%USERPROFILE%\.apx2\app.log`

下游（Coopanion）配置：

```json
{
  "baseUrl": "http://127.0.0.1:8787/v1",
  "apiKey": "<~/.apx2/token 的内容>",
  "model": "qwen2.5:0.5b"
}
```

模型也可以写 `auto/deepseek-v4.1-flash`；等 WorkBuddy key 就位后自动改走云端。

---

## 3. 验证

### 构建 / 静态检查

```text
go build ./...    通过
go vet ./...      通过
go test ./...     全部通过（auth / gateway / protocol / router）
```

测试覆盖：

- 协议：Chat→Anthropic、Anthropic→Chat、Responses→Chat、Chat→Responses、双向流式事件
- 路由：provider/model、group/model、裸名、alias、rotate、usage、健康降级
- 认证：env、文件、Codex OAuth、WorkBuddy 三件套头、Zcode Anthropic、凭据写入/读取
- 网关：鉴权、上游鉴权透传、模型重写、失败切换、`text_to_tool`、Responses 输出、
  Chat/Responses 流式、Anthropic 上游、错误原样返回、队列超时

### 真实 Ollama 冒烟

| 请求 | 结果 |
|---|---|
| `GET /health` | 200，4 providers / 22 模型 |
| `GET /v1/models` | 200，含 `ollama/qwen2.5:0.5b`、`auto/...`、裸名 |
| `POST /v1/chat/completions`（带 `pet_say`） | 200，**1683ms**，返回 `pet_say({"script":"你好！"})`，`apx.degraded=["text_to_tool:pet_say"]` |
| `POST /v1/responses`（带 `pet_say`） | 200，**394ms**，`output[].function_call` |
| Chat 流式 | 200，首字 **118ms**，总 570ms |
| Responses 流式 | 200，首字 **40ms**，9 类事件：`response.created` → `response.in_progress` → `output_item.added` → `content_part.added` → `output_text.delta` → `output_text.done` → `content_part.done` → `output_item.done` → `response.completed` |

### Codex 真实直连（2026-11-06）

chatgpt.com 直连失败是 DNS/网络问题（解析到不可达地址、443 超时），不是 token 问题。
经本机 Clash 混合端口 `127.0.0.1:7901` 后完全可用。

抓包确认 Codex 后端要求：

- `originator` / `version` / `session-id` / `thread-id` / `x-client-request-id` / `x-codex-window-id`
- `x-codex-beta-features` / `x-codex-routing-hint`
- 只接受 `stream: true`；请求体需要 `store:false`、`include:["reasoning.encrypted_content"]`、`reasoning`

apx 已经把这些头内置到 `codex-oauth`，并给 provider 加了 `proxy` 字段。实测：

```text
codex/gpt-6.1-sol  Chat 非流式        200  3.9s   APX-CODEX-OK，28 tokens
codex/gpt-6.1-sol  Responses 非流式   200  3.3s   output_text APX-CODEX-OK
codex/gpt-6.1-sol  Responses 流式     200  首字 1.4s  10 个事件，文本 "1, 2, 3"
```

---

## 4. 本机 harness 现状（诚实版）

## 3.5 管理与可视化（2026-11-08）

控制台从只读面板升级为可管理：

- 添加/编辑/删除供应商；API Key 写入 `~/.apx2/credentials.json`，不写进 `providers.json`
- 每个供应商可「停止供应/恢复供应」；停止后立即从 `/v1/models` 与路由中消失
- 模型级开关：`Model.Disabled` 持久化，router 只暴露启用的模型
- 账号池：每个账号可独立启停、独立 Key、独立模型白名单；Key 存 `<provider>#<account>.key`
- 同模型自动组：≥2 provider 供应同一模型时生成 `same-<model>`（order），裸模型名自动走组；
  自动组不写盘、不可编辑，随 provider/模型变化重算
- 发现模型：调用上游 `/models` 合并，保留已有勾选状态
- 测试供应商：显示 `/models` 延迟与模型数
- 路由组可视化：group → provider 链，order/rotate/usage，成员可增删、上下排序
- 实时动画：下游客户端（名称 + 图标）→ apx2 → 命中 provider（名称 + 图标 + 账号）；
  路由组里命中节点标「命中」，组头显示 `→ provider · account`；拓扑线流动、卡片脉冲
- 请求记录带 `client` / `provider` / `account` / `group`；响应头 `X-Apx-Account`
  返回实际账号；客户端可用 `X-Client-Name` 指定显示名
- 新增管理 API（需要 apx token）：`/api/providers`、`/api/providers/{id}`、
  `/key`、`/discover`、`/test`、`/api/groups`

UI 实测（浏览器内操作）：添加 `uitest` 供应商 → 模型 44→46 → 停止供应 46→44 →
恢复 → 模型勾选只留 alpha（45）→ 新建 `uitestgrp`（rotate，ollama+uitest）→
删除。全部通过，无控制台报错。

## 4. 本机 harness 现状（诚实版）

| harness | 读取到什么 | 直连结论 |
|---|---|---|
| Ollama | `11434` 在线，`qwen2.5:0.5b` | ✅ 已接通 |
| WorkBuddy | `models.json` 只写 magpie；桌面登录文件确认 `wbEncrypted` | ✅ **已接通**：magpie 同款浏览器登录（state → token → account → refresh），账号「孤星（校园卡保研留学咨询）」；`/v3/config` 发现 23 个模型；Chat 1.8s、流式首字 1.4s；Claude 需账号有相应权益（免费账号返回 11158） |
| Codex | `~/.codex/auth.json` 明文 OAuth token + account_id | ✅ **已接通**：需经本地代理 `127.0.0.1:7901`；Chat / Responses / 流式都验证通过 |
| Zcode | `provider_config.json` 明文 key + `sekirocloud.shop/v1` | ✅ **已接通**：中转站可达；Go TLS 1.3 握手超时，固定 TLS 1.2 后正常；提供 14 个 GPT 模型 |
| OpenCode | `opencode.db` | 已发现，v2 暂未接 |
| DSH | `~/.dsh/.credentials.yaml` | 已发现，v2 暂未接 |

apx 不会把这些标成“可用”。请求失败时会返回真实上游错误，并在最近请求里记录。

---

## 5. Coopanion

- provider `baseUrl` 已指向 `http://127.0.0.1:8787/v1`：
  `D:\Coopanion\data\home\providers\magpie\config.json`
- 模型：`qwen2.5:0.5b`（contextWindow 32768）
- Key：`D:\Coopanion\data\home\providers\magpie\.env` 的 `CORTICO_KEY_TEST`
  已换成 `~/.apx2/token` 的内容
- 备份：`config.json.bak-magpie`、`.env.bak-magpie`（覆盖前的 magpie 版本），
  另有更早的 `config.json.bak-apx`、`config.json.bak-apx2`
- 桌宠只认 `pet_say({script})`，v2 的 `text_to_tool` 已验证能触发气泡。

> 注意：Coopanion 曾在 2026-11-06 08:43 把自己的 provider 写回 magpie 的 3425。
> 如果它再次改写，重新把 baseUrl 指回 8787 即可；apx 不会主动改它的配置。

---

## 6. 回滚

v1 原型仍在 `prototype/`，互不依赖：

```powershell
cd prototype
node src/cli.mjs ui
```

v2 只用 `~/.apx2/`，删除该目录即可恢复干净状态（不会影响 v1，也不会影响 magpie）。

---

## 7. 已知限制 / 下一步

1. **WorkBuddy 走浏览器登录，已接通**。apx 照 magpie 验证过的
   `/v2/plugin/auth/state` → 轮询 token → `/login/account` → refresh 流程，
   token 存在 `~/.apx2/auth/workbuddy.json`；也支持 API key。
   聊天只接受流式，apx 对非流式下游缓冲 SSE；Claude 走 `/v1/messages`。
   实测：`deepseek-v4.1-flash` 非流式 1.8s、流式首字 1.4s，`/v3/config` 23 个模型。
   免费账号调用 Claude 会返回 `11158 not allowed for personal_free_user`，
   这是账号权益，不是连接问题。
2. **Codex 可用，但依赖本地代理**。`chatgpt.com` 直连不通，provider 的 `proxy` 默认
   `http://127.0.0.1:7901`；Clash 端口变化时改配置或用 `APX_PROXY` 覆盖。
3. **Zcode 已可用，但中转站对 TLS 1.3 不友好**。provider 固定 `tlsMax: "1.2"`；
   如换中转站/端点，改 `baseUrl` 或用控制台的「编辑供应商」。key 每请求从
   `~/.zcode/v2/provider_config.json` 读取，不需要复制到 apx。
4. 还没做 Anthropic/Gemini 下游端点、OAuth 浏览器登录、精确 token 裁剪、cost/quota、
   隐私 masking、OpenCode/DSH 直连。
5. 现在是前台进程；后续可加 Windows 服务/托盘/开机自启。
