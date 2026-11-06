# apx2 · 本地多 provider 模型网关

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

## 给 WorkBuddy 配 Key

WorkBuddy 桌面登录文件是加密的，apx **不解密**。用 WorkBuddy 自己的 API key：

1. 在 WorkBuddy 里生成 API key（中国版 `workbuddy.cn`，国际版 `workbuddy.ai`）。
2. 写入 apx 自己的凭据文件（不会出现在命令行历史里）：

```powershell
.\bin\apx2.exe auth set workbuddy --key <你的key>
# 或者从 stdin 读：
Get-Content key.txt | .\bin\apx2.exe auth set workbuddy
```

3. 重启 `apx serve`（或点控制台的“重载配置”）。

apx 会按 WorkBuddy 客户端的方式发送：

```
X-API-Key: <key>
Authorization: Bearer <key>
X-User-Id: anonymous_<key 后 8 位>
```

企业账号可再设 `APX_WORKBUDDY_ENTERPRISE_ID` / `APX_WORKBUDDY_TENANT_ID`。

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

## CLI

```
apx                       启动网关
apx serve --listen ADDR
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
| **Codex** | `~/.codex/auth.json` 明文 OAuth | ⚠️ token 可读，本机 `chatgpt.com` 网络不可达 |
| **Zcode** | `provider_config.json` 明文 key | ⚠️ key 已过期；`sekirocloud.shop` 不可达 |
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
