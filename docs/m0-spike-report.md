# M0 技术闸门报告

| 项 | 内容 |
|---|---|
| 日期 | 2026-11-03 |
| 目的 | 闭合三个假设，决定 P0 走哪条路线（Go/No-Go） |
| 环境 | Windows 11 x64 · Node 22.22.2（无 Rust/Go 工具链）· 系统代理 `HTTP_PROXY=127.0.0.1:27137` |
| 结论 | **H1 通过 · H2 链路通但无成功文本（额度阻断）· H3 通道可达但增量未验证。建议按"通道型 + 诚实降级"继续，但 P0-4 的验收口径必须改。** |

---

## 1. 假设与结论一览

| 假设 | 判据 | 实测结果 | 判定 |
|---|---|---|---|
| **H1** 服务面可程序化取得（确定性端口 + 可用凭据） | ≥2 条路径成立，且"端口由我们指定"必须成立 | `serve --hostname 127.0.0.1 --port 18787` 直接打印 `server listening on http://127.0.0.1:18787` 与 `server password <43 字符>`；端口确由我们指定 | ✅ **通过** |
| **H2** 数据面可达（一次真实文本返回） | 30s 内拿到非空 `text` | GUI agent 侧：请求抵达上游但返回 429/502/400，无文本；**本地推理服务侧：已取得真实文本**（见 §9） | ✅ **对 L1 上游闭合；对 GUI agent 仍未闭合** |
| **H3** 增量流可达 | 单次请求 ≥3 个增量事件 | GUI agent 事件通道可连但无生成事件；**本地推理服务：真实 SSE 22 帧、首块 89ms、含 `[DONE]`**（见 §9） | ✅ **对 L1 上游闭合；对 GUI agent 未验证** |

---

## 2. H1：服务面可程序化取得（通过）

```bash
# 端口由我们指定，凭据从 stdout 抓
opencode-cli serve --hostname 127.0.0.1 --port 18787 --print-logs
# → server listening on http://127.0.0.1:18787
# → server password U3H4iN4l7QhC_Gh-OGm2LUa7fy_Rf9-AbB444XZ5-ro   (43 字符)
```

| 观察 | 数据 | 意义 |
|---|---|---|
| 端口 | 我们指定的 18787 生效 | 可以"自起实例 + 自定端口"，无需从配置猜 |
| 凭据 | stdout 一行正则即可拿到 | 不需要读配置文件、不需要逆向 |
| 鉴权方式 | `Basic base64("opencode:<pw>")` → 200；`Bearer` → 401 | **常见假设（Bearer）是错的**，必须按适配器声明 |
| 契约可得 | 有凭据后 `/openapi.json` → 200，350,880 字节 | 可生成 translator 与单测夹具 |
| 无鉴权 | `/openapi.json` → 401 application/json | 可作"凭证是否有效"的健康探针 |

**重要副作用（必须写进就绪判定）**：新起的实例约 **15–20 秒**才完成插件激活，期间契约端点返回：

```json
{"_tag":"ServiceUnavailableError","message":"Location plugins did not finish activating","service":"plugin"}
```

→ `readyProbe` 不能是"TCP 可连"，也不能是"根路径 200"（根路径一开始就是 200 的 HTML）。必须是**契约端点返回 200**。

---

## 3. H2：数据面可达，但拿不到成功文本

### 3.1 请求确实穿到了上游

```bash
curl -u "opencode:<pw>" -H "Content-Type: application/json" \
  -d '{"prompt":"Reply with exactly: OK-PROXY","model":{"id":"pulse-alpha-free","providerID":"opencode"}}' \
  http://127.0.0.1:18787/api/experimental/generate/text
```

```json
{"_tag":"ProviderRequestError","providerID":"opencode","reason":"rate_limit",
 "message":"Free usage limit reached...","status":429,"retryAfterMs":31556000}
```

→ **协议、鉴权、请求体、模型引用全部正确**，否则不会走到 provider 层并返回 `rate_limit`。

### 3.2 三个 provider 全部失败，但失败类型不同（对错误映射极有价值）

| provider / model | 上游响应 | 归因 | 对代理的含义 |
|---|---|---|---|
| `opencode` / `pulse-alpha-free` | 429 `rate_limit`，`retryAfterMs≈8.7h` | 免费额度用尽 | 必须把 429 与 `Retry-After` 透传给下游，并做额度可见 |
| `openai` / `gpt-6.1-terra` | 502 `ERR_PROXY_TUNNEL: Proxy refused to open a tunnel` | **上游继承了系统 `HTTP_PROXY`** | 代理软件必须能显式控制上游是否继承系统代理，否则在"有系统代理的机器"上必然失败 |
| `opencode-go` / `iceman-contributor-free` | 400 `invalid_request`（隐私策略：该模型会用请求数据训练，需在工作区显式允许） | 策略阻断 | 错误必须透出"可操作的下一步"，而不是笼统"上游错误" |

### 3.3 判定

H2 的**通道成立**，但**没有成功样本**。因此：

- 不能声称"P0-4 已跑通"；
- 能证明的是"机制可用性"：端口、凭据、契约、鉴权、请求体映射、错误归一，五段全部通；
- 要真正跑通，需要用户侧二选一：**恢复免费额度** 或 **使用有额度的付费 provider**。这不是代码问题。

---

## 4. H3：事件通道可达，增量未验证

```bash
curl -N -u "opencode:<pw>" -H "Accept: text/event-stream" http://127.0.0.1:18787/api/event
# data: {"id":"evt_...","type":"server.connected","data":{}}
# : heartbeat
```

通道是标准 SSE（含 `: heartbeat` 注释行）。但**没有生成事件**，因为生成请求在额度处被拦。因此"事件 → 增量文本 → OpenAI chunk"这条映射链仍未验证。

**降级方案已在原型实现**：`capabilities.streaming=false` 时，代理取完整文本后按 24 字符/30ms 分块回放，并在响应头标注 `x-apx-degraded: pseudo-stream`，`/health` 里 `streaming: "pseudo"`。**不假装是真流式。**

---

## 5. 真实软件端到端（原型验证）

用原型 `apx serve --adapter opencode-v2` 跑通：

```
▶ 启动上游服务面：opencode-cli.exe --port 8787
  │ server listening on http://127.0.0.1:8787
  │ server password jyz20dDjSh6Nr1iYmeI8Mzt2-LK6L9Vojd59Xqwl9GQ
  │ [apx] 已从 stdout 取得凭据（43 字符）
✓ 上游就绪：http://127.0.0.1:8787
✓ 模型清单 148 个
  本地代理已就绪  http://127.0.0.1:8791/v1
```

| 验证项 | 结果 |
|---|---|
| 自起实例 + 自定端口 | ✅ 8787 |
| stdout 抓凭据 → Basic 鉴权 | ✅ |
| 模型清单透传 | ✅ 148 个，别名形如 `opencode/pulse-alpha-free` |
| `/health` | ✅ `upstreamReachable:true`、`credential.hasToken:true`、`streaming:"pseudo"` |
| 真实调用 | ✅ 返回 429 `apx_upstream_rate_limited`（错误映射正确，非 500） |
| 停止即回收 | ✅ 两端口均拒绝连接（`000`），无残留进程 |

---

## 6. 来自另一位实践者的两条经验，以及本原型如何落地

> 「这类代理的难点从来不是转发，而是**凭证生命周期**和**流式语义**——前者决定它能不能长期活着，后者决定用户觉不觉得快。」

### 6.1 凭证生命周期

| 教训 | 原型落地 |
|---|---|
| 上游 OAuth token 由宿主应用刷新（约 30 天），代理启动读一次就会静默失效 | `credentials.mjs` **不缓存**，每次请求现取；`get()` 每次重新读文件/SQLite |
| 只读打开，别和宿主的 WAL 写入互相阻塞 | SQLite 用 `readOnly: true` + `PRAGMA busy_timeout=5000`；读完即关，不建连接池 |
| 401 应触发"重读凭证 + 重放一次" | `request()` 捕获 401 → `invalidate()` → 重放一次（**仅非流式**，流式重放会重复输出） |
| 健康检查应报"凭证是否可读"，而不是"进程活着" | `/healthz` 返回 `credential.{kind,ok,hasToken,lastReadAt,expiresAt}` |
| 日志绝不打印 token | 只输出长度与 `st_bbe9…5242` 形式的掩码 |

**已由测试证明**：轮换 token 文件后，**不重启代理**，下一次请求自动使用新 token（上游收到的 header 变为 `Bearer T2`）；上游故意返回一次 401 后，代理重读并重放，最终 200，且上游被请求 2 次。

### 6.2 流式语义

| 教训 | 原型落地 |
|---|---|
| **绝不"先读完再转发"**——首字延迟会从 0.5s 变 8s | `pipeUpstreamStream()` 用 `reader.read()` 循环逐块 `res.write()`，不缓冲 |
| SSE 必须逐块 flush | Node 的 `write` 直写 socket，测试实测首块到达 265ms（上游每块 60ms） |
| 二进制安全，不要按行读 | 用 `Uint8Array` → `Buffer` 直传，不 `readline`，避免卡在半个 UTF-8 字符 |
| 有的上游不发 `[DONE]`，客户端会一直等 | 透传结束后检查尾部，缺失则补 `data: [DONE]` |
| 客户端断开必须取消上游，否则继续烧额度 | `res.on('close')` → `reader.cancel()` + `AbortController.abort()` |
| 上游只支持一次性返回时，要诚实降级 | 伪流式 + `x-apx-degraded` 响应头 + `/health` 标注，不冒充真流式 |

**已由测试证明**：假上游每 60ms 吐一块，代理侧首块 <400ms、帧数 ≥3、含 `[DONE]`，且"首块到结束"存在 >100ms 的间隔（即不是一次性到达）。

---

## 7. 对项目计划的影响（需要改的地方）

| 项 | 原计划 | 依据 | 调整建议 |
|---|---|---|---|
| P0-4 验收 | "1 个真实 agent 端到端跑通" | H2 无成功样本（额度） | 改为**两段式**：① 机制可用性（已达成）② 真实文本（需用户提供有额度的上游） |
| 就绪判定 | 端口可连 | 15–20s 插件激活期 + 根路径一开始就 200 HTML | 必须"契约端点 200" |
| 上游网络 | 未考虑 | 上游继承系统代理导致 502 | 增加"代理环境变量策略"配置（清除/继承/指定） |
| 流式 | P0 要 SSE | 上游 stateless 端点无流 | P0 交付伪流式并标注；真流式排 M2 stretch |
| 鉴权 | 按 Bearer 实现 | 实测是 Basic（Bearer 401） | 鉴权方案由 manifest 声明，不许假设 |

---

## 8. 仍未闭合的事项

1. **H2 的成功样本**：需要用户侧恢复额度或指定有额度的 provider。
2. **H3 增量映射**：需要在有额度的前提下验证"事件 → chunk"的过滤与拼接。
3. **`tool_calls`**：上游契约中不存在 OpenAI tool 形态，P0 继续显式 400。
4. **macOS / Linux**：本机无环境，发现层只写了 Windows 实现（POSIX 分支为占位）。


---

## 9. 补充：真实模型上游验证（2026-11-04）

GUI agent 的额度阻断无法在代码侧解决，因此并行验证了一条**真实可用**的上游：本机已装的本地推理服务（OpenAI 兼容，端口 11434，模型 `qwen2.5:0.5b`，397MB）。

### 9.1 非流式

```bash
curl -s http://127.0.0.1:11434/v1/models
# {"object":"list","data":[{"id":"qwen2.5:0.5b","object":"model",...}]}

curl -s -m 90 http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:0.5b","messages":[{"role":"user","content":"Reply with exactly: OK-PROXY"}]}'
# 200, 1.28s → content = "OK-PROXY", usage.total_tokens = 42
```

### 9.2 流式（真 SSE）

```
status 200  content-type text/event-stream
首块 89ms   总 319ms   帧数 22   含 [DONE] true
片段样例 "content":"一" | "content":"、" | "content":"二" | "content":"、" | "content":"三"
```

→ **逐 token 到达**，不是缓冲后一次性返回。这条同时证伪了"伪流式是唯一选择"的担心：只要上游支持 SSE，代理就能真透传。

### 9.3 口径说明（重要，不要含混）

| 断言 | 是否成立 |
|---|---|
| "本地推理服务类上游可以端到端跑通" | ✅ 成立，有真实文本与真实流式 |
| "GUI agent 可以端到端跑通" | ❌ 仍不成立（额度/策略阻断，非协议问题） |
| "P0-4 已由真实 agent 证明" | ❌ **不成立**。本地推理服务只能作 L1 冒烟与"管道正确性"证明，不能冒充 agent 适配 |

### 9.4 对"可用性"的意义

`qwen2.5:0.5b` 这类本地模型的价值不是能力，而是**让整条链路有一个随时可复现的成功样本**：不依赖额度、不依赖网络、不依赖登录。它把"代理是否真的能转发并逐块返回"从"待验证"变成"可回归测试"。
