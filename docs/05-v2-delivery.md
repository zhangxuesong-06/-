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

---

## 4. 本机 harness 现状（诚实版）

| harness | 读取到什么 | 直连结论 |
|---|---|---|
| Ollama | `11434` 在线，`qwen2.5:0.5b` | ✅ 已接通 |
| WorkBuddy | `models.json` 只写 magpie；桌面登录文件 `workbuddy-desktop.info` 确认 `wbEncrypted` | ⏳ 需要 API key；`copilot.tencent.com` 网络可达（404 路由，非网络故障） |
| Codex | `~/.codex/auth.json` 明文 OAuth token + account_id | ⚠️ token 可读，但本机 `chatgpt.com` **fetch failed** |
| Zcode | `provider_config.json` 明文 key + `sekirocloud.shop/v1` | ⚠️ key 已过期；`sekirocloud.shop` **不可达**；官方 `open.bigmodel.cn`/`api.z.ai` 可达但拒绝旧 key |
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

1. **WorkBuddy 需要一把 API key**。这是唯一干净、不碰加密存储、不借 magpie 的直连方式。
   写入：`apx auth set workbuddy --key ...`。
2. **Codex 卡在网络**。代码与 token 都就绪，`chatgpt.com` 可达后即可用。
3. **Zcode 需要新 key**。当前明文 key 已过期；换 key 后 `apx auth set zcode --key ...`。
4. 还没做 Anthropic/Gemini 下游端点、OAuth 浏览器登录、精确 token 裁剪、cost/quota、
   隐私 masking、OpenCode/DSH 直连。
5. 现在是前台进程；后续可加 Windows 服务/托盘/开机自启。
