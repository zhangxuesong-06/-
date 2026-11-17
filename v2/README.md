# apx2 · 本地多 provider 模型网关

> 当前主线：**v2**。v1 原型在 `../prototype/`，只用于回滚参考。
> 目标平台：**Windows 优先**；Linux/macOS 后续扩展。
> 当前状态与优先级见仓库根目录 `../CURRENT.md`。

apx2 是一个 Go 单二进制本地网关，**按 magpie 的思路重写，但不使用、不依赖、不修改 magpie**，也不碰它的 `3425` 端口和 `plugin-auth.json`。

它把本机已有软件（Ollama、WorkBuddy、Codex、Zcode…）的模型通道收进来，在 `127.0.0.1:8787/v1` 暴露成 OpenAI 兼容端点，用一个 apx 自己的本地 key 给下游（比如 Coopanion 桌宠）使用。

```
Coopanion / 任意 OpenAI 客户端
        │  Bearer sk-local-...
        ▼
apx2 :8787  ── /v1/chat/completions, /v1/responses, /v1/models
        │
        ├─ router：provider/model、group/model、order/rotate/usage、健康熔断、failover
        ├─ protocol：OpenAI Chat ↔ OpenAI Responses ↔ Anthropic Messages
        └─ providers
             ├─ Ollama          http://127.0.0.1:11434
             ├─ WorkBuddy       https://copilot.tencent.com/v2   (X-API-Key)
             ├─ Codex           https://chatgpt.com/backend-api/codex (OAuth)
             └─ Zcode           https://.../v1                  (API key)
```

---

## 快速开始

```powershell
cd v2
go build -o bin/apx2.exe ./cmd/apx

# 扫描本机，生成 ~/.apx2/providers.json
.\bin\apx2.exe init --force

# 启动网关
.\bin\apx2.exe serve
```

基线检查（Go 1.24+，测试 + vet）：

```powershell
powershell -ExecutionPolicy Bypass -File .\check.ps1
```

`bin/`、日志、`.apx2/` 与凭据文件已在根目录 `.gitignore` 中排除，不会被误提交。

桌面上还有一个一键启动快捷方式 **「apx2 模型网关」**：

- 双击 = `apx2w.exe app`，以**独立窗口**打开控制台（Chrome/Edge 的 app 模式，没有地址栏和标签页）
- 网关在后台随窗口一起启动；**关闭窗口即停止网关**
- 不会弹黑色控制台窗口
- 如果网关已经在运行，双击只打开窗口，不会起第二个进程
- 窗口使用独立浏览器配置 `~/.apx2/browser`，不影响你日常的浏览器

等价命令：

```powershell
.\bin\apx2.exe app            # 前台运行 + 独立窗口
.\run.ps1 desktop             # 无控制台，直接开窗口
```

启动后终端会打印：

```
端点   http://127.0.0.1:8787/v1
Key    sk-local-...
控制台 http://127.0.0.1:8787/
```

下游只要填 baseURL + Key。模型名可以写：

| 写法 | 含义 |
|---|---|
| `qwen2.5:0.5b` | 全库唯一的裸模型名 |
| `ollama/qwen2.5:0.5b` | 直连指定 provider |
| `auto/deepseek-v4.1-flash` | 走 `auto` 路由组，按策略选 provider |

---

## 接 WorkBuddy

### 浏览器登录（推荐，照 magpie 已验证的流程）

控制台里 WorkBuddy 卡片点「登录」：

1. apx 调 WorkBuddy 自己的 `/v2/plugin/auth/state` 拿登录地址；
2. 打开 `workbuddy.cn` 登录页，你在浏览器里完成授权；
3. apx 每秒轮询 `/v2/plugin/auth/token`，成功后再读 `/v2/plugin/login/account`；
4. token 保存到 `~/.apx2/auth/workbuddy.json`，过期前自动用
   `/v2/plugin/auth/token/refresh` 刷新；
5. 自动从 `/v3/config` 发现 cli 模型并写回 registry。

apx 不读 magpie 的 `plugin-auth.json`，也不调用 magpie 的网关；登录和刷新都是 apx 自己的进程完成的。

### API Key（可选）

也可以在 WorkBuddy 的 keys 页面生成 API key：

```powershell
.\bin\apx2.exe auth set workbuddy --key <你的key>
```

apx 会按 WorkBuddy CLI 的方式发送 `X-API-Key`、`Authorization`、`X-User-Id: anonymous_<key 后 8 位>`，
并带上 WorkBuddy 客户端身份头。

### 协议细节

- 普通模型：`POST https://copilot.tencent.com/v2/chat/completions`，**只接受流式**；apx 对非流式下游会缓冲 SSE。
- Claude 模型：`POST https://copilot.tencent.com/v1/messages`（Anthropic Messages），同样只流式；
  模型级 `protocol: anthropic` 让同一个 WorkBuddy provider 自动分流。
- 请求头照 WorkBuddy 自己的客户端：`X-Product: SaaS`、`X-IDE-Type/Name/Version`、
  `X-Agent-Purpose/Intent/Type/Runtime`、`X-Conversation-*`、`X-Request-ID`、
  `User-Agent: WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0`。

实测（2026-11-08，个人免费账号）：

```text
workbuddy/deepseek-v4.1-flash  Chat 非流式  200  1.8s   WB-OK
workbuddy/deepseek-v4.1-flash  流式        200  首字 1.4s
GET /v3/config                            23 个 cli 模型
workbuddy/claude-opus-5.5                 400  11158: not allowed for personal_free_user
```

Claude 的 400 是账号权益限制，不是连接问题；有 Claude 权益的账号会走
`/v1/messages`。图标使用 WorkBuddy 自己的 exe 图标（`/assets/workbuddy.png`）。

### 多账号

WorkBuddy 卡片 →「账号」可以加多个账号（Key 存在
`~/.apx2/credentials.json` 的 `workbuddy#<账号>.key`）。路由组会按
order / rotate / usage 在账号之间选择，流量图会显示命中的账号。

---

## 接 Codex

Codex 的 ChatGPT OAuth token 在 `~/.codex/auth.json`，apx 每请求现取，不需要复制或改写。

`chatgpt.com` 在本机直连不通，需要本地代理：

- `apx init` 会写成 `"proxy": "http://127.0.0.1:7901"`（本机 Clash 的混合端口）；
- 端口变了就改 `~/.apx2/providers.json`，或 `set APX_PROXY=http://127.0.0.1:<port>` 后重新 `apx init`。

Codex 后端不是普通 OpenAI Responses：它要求客户端识别头（`originator`、`version`、
`session-id`、`thread-id`、`x-codex-routing-hint` 等），并且只接受流式。apx 已经内置这些头；
下游要 JSON 时，apx 会把 Codex 的 SSE 缓冲成完整 response。

已验证（2026-11-06）：

```text
codex/gpt-6.1-sol  Chat 非流式        200  3.9s   内容 APX-CODEX-OK，28 tokens
codex/gpt-6.1-sol  Responses 非流式   200  3.3s   output_text APX-CODEX-OK
codex/gpt-6.1-sol  Responses 流式     200  首字 1.4s  10 个事件，文本 "1, 2, 3"
```

---

## 接 Zcode 中转站

Zcode 的 `~/.zcode/v2/provider_config.json` 里有一条非 magpie 的 provider 规则，
apx 用 `auth.type = "zcode-config"` **每请求直接读取**它的 key，不复制、不落盘。

本机实测有两个坑：

1. 该中转站对 **Go 的 TLS 1.3 握手会超时**，TLS 1.2 正常。provider 里设置
   `"tlsMax": "1.2"`；apx 也会在 TLS handshake timeout 时自动降级重试一次。
2. key 是给中转站的，不是给 `open.bigmodel.cn` / `api.z.ai` 的。不要拿它去试官方端点。

当前中转站模型（`GET /models` 实测）：

```text
codex-auto-review, gpt-5.5, gpt-5.6, gpt-5.6-sol, gpt-5.6-terra,
gpt-6-astra, gpt-6-sol, gpt-6.1-sol, gpt-6.1-terra,
gpt-image-2, gpt-image-2.5, gpt-image-2.5-flare, gpt-image-2.5-sunburst, gpt-image-2.6
```

实测：

```text
zcode/gpt-6.1-sol  Chat 非流式        200  5.2s   ZCODE-APX-OK
zcode/gpt-6.1-sol  Responses 非流式   200  3.0s   output_text ZCODE-APX-OK
zcode/gpt-6.1-sol  Responses 流式     200  5.9s   9 个事件，文本 "1, 2, 3"
```

---

## 支持的协议

### 下游（apx 对外）

- `POST /v1/chat/completions`：流式 + 非流式
- `POST /v1/responses`：流式 + 非流式，含 `function_call` 输出
- `GET /v1/models`：`provider/model`、`group/model` 和唯一裸模型名

### 上游（apx 对 provider）

| protocol | 说明 | 认证 |
|---|---|---|
| `openai-chat` | Ollama、WorkBuddy、任何 OpenAI 兼容服务 | `bearer` / `header` / `workbuddy-key` |
| `openai-responses` | Codex | `codex-oauth` |
| `anthropic` | GLM Coding Plan / Anthropic Messages | `zcode-key` |

跨协议转换覆盖：system、多轮、工具定义、`tool_calls` / `tool_use`、工具结果、`usage`、错误语义、SSE 流式。Responses 和 Chat 之间是真翻译，不是只包一层。

---

## 路由

`~/.apx2/providers.json`：

```json
{
  "providers": [
    {
      "id": "ollama",
      "protocol": "openai-chat",
      "baseUrl": "http://127.0.0.1:11434",
      "auth": { "type": "none" },
      "discover": true,
      "models": [{ "id": "qwen2.5:0.5b" }]
    },
    {
      "id": "workbuddy",
      "protocol": "openai-chat",
      "baseUrl": "https://copilot.tencent.com/v2",
      "auth": { "type": "workbuddy-key", "env": "APX_WORKBUDDY_KEY" },
      "paths": { "chat": "/chat/completions", "models": "/models" },
      "discover": true,
      "models": [{ "id": "deepseek-v4.1-flash" }, { "id": "glm-5.3" }]
    },
    {
      "id": "codex",
      "protocol": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "proxy": "http://127.0.0.1:7901",
      "auth": { "type": "codex-oauth", "file": "~/.codex/auth.json" },
      "paths": { "responses": "/responses", "models": "/models" },
      "models": [{ "id": "gpt-6.1-sol" }]
    }
  ],
  "groups": [
    {
      "id": "auto",
      "strategy": "order",
      "providers": ["workbuddy", "zcode", "ollama"]
    }
  ]
}
```

路由策略：

- `order`：按 `providers` 顺序。
- `rotate`：每次请求把起点往后移一位。
- `usage`：累计 token 少的优先。

**同模型自动组**：如果 `kimi-k3` 同时出现在 codex、zcode、workbuddy，apx 会生成
`same-kimi-k3` 组，成员按 registry 顺序；直接请求裸模型 `kimi-k3` 就会走这个组，
失败自动换下一个供应商。自动组只存在内存/状态里，不写 `providers.json`。

failover：`401/403/404/408/409/425/429/5xx` 和网络错误会自动换下一个 target；同一 provider 连续失败 3 次进入 15s 冷却，冷却中的排到最后但仍可作为最后手段。下游响应头带 `X-Apx-Provider` / `X-Apx-Group`，最近请求里也能看到实际命中。

---

## 认证类型

| type | 行为 |
|---|---|
| `none` | 不加头 |
| `bearer` | `Authorization: Bearer <secret>` |
| `header` | 自定义头（`header` + `prefix`） |
| `workbuddy-key` | WorkBuddy 三件套头 |
| `codex-oauth` | 每请求读 `~/.codex/auth.json`，带 `chatgpt-account-id` |
| `zcode-key` | Anthropic 时用 `x-api-key`，否则 Bearer |
| `workbuddy-oauth` / `zcode-oauth` | 读 `~/.apx2/auth/<id>.json`（apx 自己的登录文件，不复用 magpie） |

密钥解析顺序：环境变量 → 显式 `file`+`jsonPath` → `~/.apx2/credentials.json` 的 `<provider>.key`。全部每请求现取，宿主刷新 token 后 apx 不用重启。

---

## 管理控制台

`http://127.0.0.1:8787/`（或桌面快捷方式的独立窗口）现在可以直接管理：

- **添加供应商**：填名称、协议、Base URL、认证方式、API Key、模型列表、代理、TLS 上限。
  Key 写入 `~/.apx2/credentials.json`，不会出现在 `providers.json`。
- **停止/恢复供应**：每个 provider 卡片右上角开关；停止后立即从 `/v1/models` 和路由里消失。
- **账号池**：一个 provider 可挂多个账号；每个账号可单独启停、单独设置 Key、单独限制可用模型。
  Key 存在 `~/.apx2/credentials.json` 的 `<provider>#<account>.key`。
- **选择供应模型**：点「模型」勾选要暴露的模型；未勾选的模型保留在配置里但不再对外。
- **同模型自动组**：同一模型被两个及以上 provider 供应时，自动生成
  `same-<model>` 路由组（order）；裸模型名会直接走这个组，自动 failover。
  自动组不可编辑，会随 provider/模型变化重新计算。
- **发现模型**：调用上游 `/models` 或 WorkBuddy `/v3/config` 并合并，保留已有勾选状态。
- **测试**：显示上游 `/models` 的延迟与模型数。
- **路由组**：可视化拓扑 + 编辑成员顺序，支持 order / rotate / usage。
- **实时流量**：显示下游客户端（名称 + 图标）→ apx2 → 命中的 provider（名称 + 图标 + 账号）；
  路由拓扑里命中节点会出现「命中」标记，组头显示 `→ provider · account`
- **请求记录**：最近请求带上下游、实际账号、路由组、耗时、tokens
- **动画**：请求命中时拓扑线流动、卡片脉冲；最近请求逐条进入

下游可以在请求头里用 `X-Client-Name: Coopanion` 指定显示名；不传则从 `User-Agent` 推断。
响应头 `X-Apx-Account` 会返回本次实际使用的账号标签。

账号标签的来源：

| 认证 | 显示 |
|---|---|
| `none` | 本地 |
| `codex-oauth` | id_token 里的邮箱，取不到则 `account <account_id 后 8 位>` |
| `workbuddy-key` | `anonymous_<key 后 8 位>` |
| `zcode-config` / `bearer` | `key ····<key 后 4 位>` |

管理接口（需要 apx token）：

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/providers` | 新增/更新 provider |
| PATCH | `/api/providers/{id}` | 停止供应、设置启用模型 |
| DELETE | `/api/providers/{id}` | 删除 provider |
| POST | `/api/providers/{id}/key` | 写入 API Key |
| POST | `/api/providers/{id}/discover` | 发现模型 |
| POST | `/api/providers/{id}/test` | 测试上游 |
| POST | `/api/groups` | 新增/更新路由组 |
| DELETE | `/api/groups/{id}` | 删除路由组 |

---

## CLI

```
apx                       启动网关
apx serve --listen ADDR [--open]
apx app [--listen ADDR] [--window-size W,H]   独立窗口模式
apx init [--force]        扫描本机并生成 providers.json
apx scan                  只扫描
apx providers             列出 provider
apx models                列出模型地址
apx auth set <id> --key K 写凭据
apx auth list
apx token
apx doctor                自检配置/凭据/模型解析
apx version
```

控制台/诊断接口：

- `GET /`：provider、路由组、最近请求、harness 扫描
- `GET /health`
- `GET /api/status`
- `GET /api/scan`
- `POST /api/reload`

---

## 本机现状（诚实版）

| harness | 凭据 | 直连状态 |
|---|---|---|
| **Ollama** | 无 | ✅ `11434` 已验证 |
| **WorkBuddy** | 桌面登录加密；`models.json` 只指向 magpie | ⏳ 需要 API key（`copilot.tencent.com` 网络可达） |
| **Codex** | `~/.codex/auth.json` 明文 OAuth | ✅ 已验证（需经本地代理 `127.0.0.1:7901`） |
| **Zcode** | `provider_config.json` 明文 key | ✅ **已接通**：中转站 `sekirocloud.shop` 可用，提供 14 个 GPT 模型（需强制 TLS 1.2） |
| **OpenCode** | SQLite 明文 | 已发现，v2 暂未接 |
| **DeepSeek Harness** | YAML 明文 | 已发现，v2 暂未接 |

apx 不会假装这些通道可用：缺凭据或网络不可达时，请求会返回真实的上游错误，并在控制台/最近请求里标出来。

---

## 安全边界

- 只监听 `127.0.0.1`。
- `/v1/*` 必须带 apx 自己的 `sk-local-…`。
- 拒绝跨站请求（`Sec-Fetch-Site: cross-site` / `Origin: null`）。
- 不读取、不解密 WorkBuddy 的 `security/.../entries.json.enc`。
- 不读取 magpie 的 `plugin-auth.json` / `logins.json`，不调用 `3425`。
- apx 自己的凭据只写 `~/.apx2/`，权限 0600。

---

## 与 magpie 的差别

已经对齐的：多 provider registry、`provider/model` 与 `group/model`、order/rotate/usage 路由、failover、协议翻译、真流式、Web 控制台、单二进制、CLI。

还没做的：

- Anthropic / Gemini 下游端点（当前下游是 OpenAI Chat + Responses）。
- OAuth 浏览器登录流程（当前用 API key / 读取宿主明文 token）。
- token-aware 精确裁剪（现在是字符预算 + 工具优先级）。
- cost/quota 面板、隐私 masking、插件市场。
- OpenCode / DSH 的 v2 直连 provider。

这些是后续增量，不影响当前“不用 magpie 也能把模型借给下游”的目标。
