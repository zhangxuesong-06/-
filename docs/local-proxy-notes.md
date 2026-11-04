# 本地 LLM 代理：一次实战复盘

> 场景：把一个需要「OAuth token + 自定义请求头」的上游（OpenCode Go），包装成标准 OpenAI 兼容接口，
> 供任意 OpenAI SDK / 应用使用。
> 交付物：`D:\Vtube\Open-LLM-VTuber\tools\opencode_go_proxy.py`（170 行，纯标准库，无依赖）
> 面向读者：正在做一个通用本地代理的 agent。

---

## 1. 要解决的问题

上游 `https://opencode.ai/inference/go/openai/v1` 是 OpenAI 兼容的，但直接接 SDK 会失败，原因有三层：

| 层 | 问题 | 现象 |
|---|---|---|
| 鉴权 | 客户端里存的是 **OAuth access token**（`st_...`，约 30 天过期，由宿主应用刷新），不是长效 API Key | 用旧 token 或空 key → 401 |
| 协议 | 必须带 `x-opencode-session: <稳定会话 ID>` | 不带 → `400 MissingSessionID`，提示去读文档 |
| 语义 | DeepSeek V4.1 Flash 默认输出大段 `reasoning_content`，短对话场景纯属浪费 | 延迟 + token 翻倍 |

应用侧（Open-LLM-VTuber）只支持：`base_url` + `api_key` + `model`，**没有自定义 header 的口子**。
所以要么改应用源码，要么在中间加一层。

**选择加代理的理由**：不动上游应用、可复用到任何客户端、可以把「登录态」和「业务配置」解耦。

---

## 2. 架构

```
应用 (OpenAI SDK)
   │  POST http://127.0.0.1:8788/v1/chat/completions
   ▼
本地代理 (stdlib ThreadingHTTPServer)
   │  1. 读 OAuth token（每次请求从 sqlite 读）
   │  2. 注入 Authorization / x-opencode-session / User-Agent
   │  3. 可选 JSON body 变换（关闭思考）
   │  4. 流式透传上游响应（保持 chunked）
   ▼
https://opencode.ai/inference/go/openai/v1/chat/completions
```

关键点：**代理不缓存 token**。宿主应用刷新 token 后，下一次请求自动用新的，不需要重启代理。

---

## 3. 核心实现

### 3.1 每次请求读取凭证（而不是启动时读一次）

```python
def read_token() -> str:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    try:
        row = con.execute(
            "select value from credential where integration_id='opencode' and active=1"
        ).fetchone()
    finally:
        con.close()
    cred = json.loads(row[0])
    return cred["access"]
```

经验：

- `mode=ro` + `uri=True`：宿主在写 WAL 时也不会互相阻塞
- `timeout=5`：拿到锁冲突时短暂等待
- 只读、不开连接池：QPS 低，开销可忽略
- **凭证格式先探测再写死**：我们最后是 `{"type":"oauth","access":"st_...","refresh":"rt_...","expires":...}`
- token 过期（30 天）时不会自动刷新——刷新是宿主应用的职责。代理只负责「每次拿最新的」。
  如果要做无人值守，额外实现 refresh flow 或后台巡检，失败时返回 401 并打日志。

### 3.2 头处理：只转发 end-to-end 头

```python
HOP_BY_HOP = {"connection","keep-alive","proxy-authenticate","proxy-authorization",
              "te","trailers","transfer-encoding","upgrade","host","content-length"}
```

- `Host` 必须重写（http.client 会按目标域名生成）
- `Content-Length` 在 body 被改写后必须重算，否则上游会截断/挂住
- `Accept-Encoding: identity`：主动要求不压缩，省掉解压逻辑，也让 chunk 边界简单
- `User-Agent` 自定义：上游会按 UA 判客户端类型（也用于风控），别用 `Python-urllib/x.y`
- `x-opencode-session`：**进程启动时生成一个 UUID 并固定**，不要每请求换。上游用它做路由和 prompt cache

### 3.3 流式透传：保持 chunked，不做解包

```python
resp = conn.getresponse()
self.send_response(resp.status)
for k, v in resp.getheaders():
    if k.lower() not in HOP_BY_HOP:
        self.send_header(k, v)
chunked = resp.getheader("Transfer-Encoding", "").lower() == "chunked"
if chunked: self.send_header("Transfer-Encoding", "chunked")
else:       self.send_header("Content-Length", resp.getheader("Content-Length"))
self.end_headers()

while True:
    data = resp.read(8192)
    if not data: break
    if chunked:
        self.wfile.write(f"{len(data):X}\r\n".encode()); self.wfile.write(data); self.wfile.write(b"\r\n")
    else:
        self.wfile.write(data)
    self.wfile.flush()          # 关键：SSE 必须逐块 flush
if chunked: self.wfile.write(b"0\r\n\r\n")
```

坑点：

1. **不要**「先读完整再转发」——SSE 会退化成一次性返回，首字延迟从 0.5s 变成 8s
2. `protocol_version = "HTTP/1.1"` 时，响应必须有 `Content-Length` 或 `Transfer-Encoding: chunked`，否则客户端会一直等
3. 如果自己重新分包，**必须重新生成 chunk 长度行**（原样转发上游 chunk 也行，但解析成本高、易错）
4. 用 `resp.read(8192)`，不要 `respread()`/`readline()`——二进制安全，且不会卡在半个 UTF-8 字符上

### 3.4 body 变换：按模型前缀，`setdefault` 不覆盖调用方

```python
if body:
    payload = json.loads(body)
    if str(payload.get("model", "")).startswith("deepseek"):
        payload.setdefault("reasoning_effort", reasoning)   # 调用方显式传了就别动
        body = json.dumps(payload).encode()
    headers["Content-Length"] = str(len(body))
```

实测有效的关闭思考参数（OpenCode Go + DeepSeek V4.1 Flash）：

| 参数 | 效果 |
|---|---|
| `reasoning_effort: "none"` | ✅ reasoning_tokens=0，无 reasoning_content |
| `thinking: {"type":"disabled"}` | ✅ 同样有效 |
| `thinking: "disabled"` | ✅ |
| `reasoning_effort: "minimal"` | ❌ 仍思考 |
| `enable_thinking: false` | ❌ 无效 |
| `reasoning: {"enabled": false}` | ❌ 无效 |
| `chat_template_kwargs.enable_thinking=false` | ❌ 无效 |

结论：**参数名必须实测**，别按「大家一般都叫 enable_thinking」去猜。

### 3.5 错误处理：把异常翻译成 OpenAI 形状

```python
{"error": {"message": "...", "type": "proxy_error"}}   # 502
```

- SDK 会按这个结构抛 `APIError`，用户能看到原因
- 客户端主动断开（语音打断、Ctrl+C）会触发 `BrokenPipeError`——**必须吞掉**，否则日志刷屏、连接泄漏
- 上游超时设长（300s），LLM 长回复很常见

### 3.6 并发模型

`ThreadingHTTPServer` 足够：一个 SSE 长连接 + 若干短请求，互不阻塞。
不要用单线程 `HTTPServer`：一个流式请求会把整站卡死。

**只监听 `127.0.0.1`**，不要 `0.0.0.0`——这类代理持有你的凭证。

---

## 4. 调试方法（按顺序）

1. **先读错误信息**：`400 MissingSessionID` 的 body 里直接给了文档链接，按文档补齐头即可
2. **最小化验证**：用 curl 打一次非流式，确认 200 + 正常 content
3. **再验流式**：`curl -N`，看首块到达时间（TTFT）和 `data:` 行是否逐块出现
4. **验计费/归属**：响应 `usage` 里有 `opencode.billing_source: "go"`，确认走的是订阅而不是余额
5. **验 body 变换**：对比 `reasoning_tokens` 是否归零
6. **最后接应用**：改 `base_url` 指向代理，观察应用日志

建议在代理里记录：`method path status duration upstream_ms`，**不要记录 Authorization 和 body**（可能含隐私对话）。

---

## 5. 如果要做成通用代理（给下一个 agent 的设计建议）

### 5.1 配置驱动，而不是为每个上游写一个脚本

```yaml
listen: 127.0.0.1:8788
routes:
  - name: opencode-go
    match: { path_prefix: /v1 }
    upstream: https://opencode.ai/inference/go/openai
    auth:
      type: sqlite_json          # env | file | sqlite_json | keychain | exec | oauth_refresh
      path: ~/.local/share/opencode/opencode.db
      sql: "select value from credential where integration_id='opencode' and active=1"
      field: access
    headers:
      x-opencode-session: ${session_uuid}
      User-Agent: my-agent/1.0
    request_hooks:
      - json_set: { if_model_prefix: deepseek, key: reasoning_effort, value: none, only_if_absent: true }
    timeouts: { connect: 15, read: 300 }
    retry: { on: [401, 429, 502, 503], attempts: 2, reread_auth: true, streams: false }
```

### 5.2 值得抽出来的插件点

| 插件点 | 用途 |
|---|---|
| `auth` 适配器 | env / 文件 / sqlite / keychain / 命令行取 / OAuth 刷新 |
| `headers` 模板 | 注入会话 ID、UA、组织标识 |
| `request_hooks` | 改 model 别名、关思考、限 max_tokens、补 system prompt |
| `response_hooks` | 统一 usage、错误码映射、剥离敏感字段 |
| `retry` | 401 时**重新读凭证**再试一次（token 轮换场景最有用），流式请求默认不重试 |
| `health` | `/healthz` 返回「凭证是否可读、剩余有效期」，比进程活着更有意义 |
| `metrics` | TTFT、总耗时、tokens、上游状态码分布 |

### 5.3 认证适配器的关键设计

- 统一返回 `(scheme, token, expires_at)`
- 失效判定靠 `expires_at`，不靠「试一次失败再说」
- 401 时**让 auth 适配器强制刷新一次**再重放请求（仅非流式）
- 绝不在 stdout / 日志里打印 token；需要标识时打印 `st_bbe90...5242`

### 5.4 协议兼容性坑（通用）

- 上游可能是 `/v1/responses` 风格（OpenAI Responses API）而非 `/v1/chat/completions`，要做路径映射
- 有的上游只接受 `stream_options.include_usage`，否则最后一块没有 usage
- 有的上游 SSE 结尾不发 `[DONE]`，客户端可能一直等，需要在代理里补
- 压缩：统一 `identity` 最省事；要支持 gzip 就按 `Content-Encoding` 解，且注意流式解压的切块
- 取消传播：客户端断开后，最好显式 `conn.close()`，让上游停止生成（省钱）

---

## 6. 这个方案不适合什么

- **需要高并发/多用户**：stdlib server 能跑，但没有连接池、限流、熔断
- **需要 TLS 终结**：建议前面放 Nginx/Caddy
- **上游明确禁止第三方客户端**：OpenCode Go 的条款写的是「给 coding agent 用，会监控滥用」。
  技术上能通，但拿它跑 VTuber 属于越界使用，有被限流/封号风险——**这类判断要提前告诉用户**，别只报「能跑」。

---

## 7. 交付物

- 代码：`D:\Vtube\Open-LLM-VTuber\tools\opencode_go_proxy.py`
- 启动：`python tools/opencode_go_proxy.py`（可设 `VTUBER_PROXY_PORT`、`VTUBER_REASONING=default` 关闭注入）
- 应用侧接法：`base_url = http://127.0.0.1:8788/v1`，`api_key` 随便填非空，`model = deepseek-v4.1-flash`

若对方要在别的机器复用，改三个常量即可：`UPSTREAM_HOST`、`UPSTREAM_PREFIX`、`DB_PATH`。
