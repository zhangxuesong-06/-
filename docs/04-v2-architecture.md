# 04 · v2 架构（已实现）

> 结论先说：v2 不是 v1 的增量，而是按 magpie 的骨架重写的 Go 单二进制网关。
> 它**不读取、不调用、不依赖 magpie**：没有 `3425`，没有 `plugin-auth.json`，
> 也不改写任何宿主应用的配置。

---

## 1. 一句话

**扫描本机 harness 的模型通道 → 注册成 provider → 用统一模型地址做路由/failover →
在 `127.0.0.1:8787/v1` 以 OpenAI Chat + Responses 协议暴露给下游。**

下游只需要一个 baseURL 和一个 apx 自己的 `sk-local-…`，不关心上游是 Ollama、
WorkBuddy、Codex 还是 Zcode。

---

## 2. 分层

```
cmd/apx                     CLI：serve / init / scan / auth / doctor
internal/config             config.json、providers.json、凭据路径、token
internal/auth               每请求解析凭据（env / 文件 / JSONPath / OAuth 文件）
internal/harness            扫描本机 harness，产出 provider 建议
internal/router             provider/model、group/model、order/rotate/usage、健康
internal/upstream           URL 归一化、请求发送、模型发现、错误归一化
internal/protocol           Chat ↔ Responses ↔ Anthropic 转换 + SSE 翻译
internal/budget             字符预算 + 工具优先级 + 孤立 tool 消息清理
internal/gateway            HTTP 端点、并发/排队、诊断、最近请求、Web 控制台
```

依赖方向是单向的：`gateway → router/upstream/protocol/budget → config/auth`。
协议层不碰 HTTP，router 不碰协议，auth 不碰路由。

---

## 3. Provider registry

`~/.apx2/providers.json` 是唯一的上游目录：

```json
{
  "providers": [
    {
      "id": "workbuddy",
      "protocol": "openai-chat",
      "baseUrl": "https://copilot.tencent.com/v2",
      "auth": { "type": "workbuddy-key", "env": "APX_WORKBUDDY_KEY" },
      "paths": { "chat": "/chat/completions", "models": "/models" },
      "models": [{ "id": "deepseek-v4.1-flash" }],
      "discover": true
    }
  ],
  "groups": [
    { "id": "auto", "strategy": "order", "providers": ["workbuddy", "zcode", "ollama"] }
  ]
}
```

关键点：

1. **`protocol` 是上游协议**，与下游协议解耦；转换发生在 `internal/protocol`。
2. **`paths` 覆盖默认 URL**。默认规则只在 base 末尾补 `/v1`，但 Codex 的
   `/backend-api/codex`、WorkBuddy 的 `/v2` 不是 OpenAI 根路径，所以显式给出
   `responses` / `chat` / `models`。
3. **`discover`**：启动时和 `/api/reload` 时调用上游 `/models` 合并模型；
   失败只记录，不清空静态模型。
4. **`auth` 每请求解析**，宿主刷新 token 后 apx 不需要重启。

---

## 4. 模型地址与路由

| 写法 | 解析 |
|---|---|
| `provider/model` | 直连该 provider |
| `group/model` | 在该组内按策略取 provider 列表 |
| `model` | 全库唯一匹配；也可在 config 里配 alias |

组内会跳过“声明了模型清单但不含该模型”的 provider；`discover=true` 或模型清单为空的
provider 视为“未知，值得一试”。这避免了 `auto/qwen…` 被发到 WorkBuddy 这种必然 404 的组合。

策略：

- `order`：固定顺序。
- `rotate`：组内轮转起点。
- `usage`：累计 token 少的优先。

健康：同一 provider 连续失败 3 次进入冷却（15s × 失败次数）；冷却中的 provider 排到最后，
仍保留为最后手段。可重试状态：`401/403/404/408/409/425/429/5xx` 和网络错误；
`400` 等请求错误不换 provider，避免把参数问题放大成多次计费。

---

## 5. 协议层

### 下游

- `POST /v1/chat/completions`：流式 / 非流式
- `POST /v1/responses`：流式 / 非流式
- `GET /v1/models`

### 上游

- `openai-chat`：Ollama、WorkBuddy、通用 OpenAI 兼容
- `openai-responses`：Codex
- `anthropic`：GLM Coding Plan / Anthropic Messages

### 转换覆盖

- system / developer → Anthropic `system`、Responses `instructions`
- `tool` 消息 → Anthropic `tool_result`（连续合并进同一条 user）
- `tool_calls` ↔ Anthropic `tool_use` ↔ Responses `function_call`
- Responses 的 `function_call_output` ←→ Chat `role=tool`
- `max_tokens` / `max_output_tokens` / Anthropic 必填 `max_tokens`
- `finish_reason`：`tool_use → tool_calls`、`max_tokens → length`
- usage：`input_tokens/output_tokens` ↔ `prompt/completion/total`
- 错误：上游原状态码 + 归一化 message 返回给下游

### 流式

- Chat → Chat：SSE 透传，但逐条改写 `model`。
- Chat → Responses：逐事件翻译成 `response.created` / `output_item.added` /
  `output_text.delta` / `function_call_arguments.delta` / `response.completed`。
- Anthropic → Chat：`message_start` / `content_block_delta` /
  `input_json_delta` / `message_delta` / `message_stop` 翻译成 Chat chunk。
- 需要兼容层时（`textToTool`）强制上游非流式，再一次性发出完整 SSE，
  保证工具参数完整且不会出现“文本已经流出去、最后才想改成工具调用”的矛盾。

---

## 6. 兼容层：text_to_tool

Coopanion 桌宠只对 `pet_say({script})` 的反应显示气泡，而小模型不会主动调工具。

apx 的规则：

1. 请求里确实提供了该工具；
2. 上一轮不是该工具的结果（避免循环）；
3. 模型返回了文本且没有工具调用；

满足时把文本包成一次工具调用，并在 `apx.degraded` 里记 `text_to_tool:pet_say`。
这是显式降级，不是静默伪装。

---

## 7. 预算

`internal/budget` 保留 v1 踩坑后的规则：

- system 永远保留；
- 工具按 `priorityTools` → 被历史引用 → 原始顺序取前 N 个；
- 非 system 消息从最新往回保留，最后一条即使超预算也保留；
- 清理被截断后孤立的 `tool` 消息和空 `tool_calls`；
- 降级写进 `apx.degraded` 和最近请求。

---

## 8. 诊断与 UI

- `GET /`：provider 卡片、健康、模型、路由组、最近请求、harness 扫描。
- `GET /api/status`：完整 JSON（token、模型、健康、最近 60 条请求）。
- `GET /api/scan`：实时扫描本机 harness。
- `POST /api/reload`：重读 config/providers。
- 响应头 `X-Apx-Provider` / `X-Apx-Group`：一眼看出实际命中。

---

## 9. 与 magpie 的对照

| 能力 | magpie | apx2 |
|---|---|---|
| 多 provider registry | ✅ | ✅ |
| `provider/model` | ✅ | ✅ |
| `group/model` | ✅ | ✅ |
| order / rotate / usage | ✅ | ✅ |
| 429/5xx failover + 冷却 | ✅ | ✅ |
| OpenAI Chat 下游 | ✅ | ✅ |
| OpenAI Responses 下游 | ✅ | ✅ |
| Anthropic 上游 | ✅ | ✅ |
| 真流式翻译 | ✅ | ✅（Chat↔Responses、Anthropic→Chat） |
| Web 控制台 | ✅ | ✅（内置单页） |
| 单二进制 | ✅ | ✅ |
| Anthropic/Gemini 下游 | ✅ | ⏳ |
| OAuth 浏览器登录 | ✅ | ⏳（当前 API key / 宿主明文 token） |
| 插件市场 / 隐私 masking | ✅ | ⏳ |

apx2 不追求“复刻代码”，只复刻**对外能力**；内部实现、配置格式、凭据来源都是独立的。

---

## 10. 下一步

1. Anthropic `/v1/messages` 下游，方便 Claude Code 类客户端。
2. `apx auth login <provider>`：自己做 WorkBuddy / Zcode 的 OAuth 登录，写入
   `~/.apx2/auth/`，仍然不碰 magpie。
3. OpenCode、DSH 的 v2 直连 provider。
4. token-aware 裁剪（按模型 context window，而不是字符数）。
5. 事件级中间件：脱敏、system 注入、模型映射。
6. 打包/开机自启/托盘。
