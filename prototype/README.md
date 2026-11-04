# apx — Agent Proxy Launcher（可运行原型）

把本机某个 agent 的模型能力，变成 `http://127.0.0.1:<port>/v1` 这样一个标准 OpenAI 端点，供本机任何需要模型的程序使用。

这是 M0 闸门阶段的**可运行原型**：零依赖（Node 18+ 标准库），Windows 已实测；它不是最终形态（最终形态是 Tauri 2 + Rust core，见 `../docs/03-architecture.md`）。

---

## 快速开始

```bash
cd prototype

node src/cli.mjs scan              # 扫描本机候选软件（注册表 + 进程 + 目录 + 适配器路径）
node src/cli.mjs list              # 用适配器把候选收敛成"可代理的软件"
node src/cli.mjs probe --port 3082 # 对某个端口做 L0–L3 分级（含假绿判定）
node src/cli.mjs adapters          # 查看适配器目录、状态目录、本地令牌

node src/cli.mjs ui                # 打开 Web 控制台（http://127.0.0.1:8799/）

node src/cli.mjs serve --adapter local-openai-service   # 自动发现本机推理服务并接上
node src/cli.mjs serve --adapter opencode-v2            # 自起上游服务面（约 15–20s）
# 输出会给你 baseURL / apiKey / model 三行，直接粘到下游程序
```

停止：`Ctrl+C`，或另开一个终端 `node src/cli.mjs stop`。
`stop` 不会拿着状态文件里的裸 pid 直接 `taskkill`——它会先验证「pid 存在 + 可执行路径一致 + 启动时间不早于记录时间」，
三条不全满足就只清状态、不动进程（pid 会被系统回收，直接杀等于随机杀别人的程序）。

### 控制台里的三个词

| 界面词 | 意思 |
|---|---|
| 左侧「本机软件」 | 这是**提供方候选**：本机真实装着/在跑的软件。点它会自动切到下方对应的适配器 |
| 右下「提供方软件」 | 真正出模型回答的一端。端口扫描型不绑定单一软件，启动时会显示实际命中的进程名（例如 `ollama`） |
| 「适配器」 | 连接这个提供方的说明书；没有适配器不代表软件不能用，只是 apx 还不知道它的专用协议 |

> 兼容性：下游 baseURL 填 `http://127.0.0.1:<port>/v1` 或 `http://127.0.0.1:<port>` 都可以；`/models`、`/chat/completions`、`/responses` 都接受带或不带 `/v1` 的形式，`GET /v1/models/{id}` 也已支持。`usage` 始终是对象，`/v1/responses` 返回标准 `object=response` 与非空 `output_text`。OpenAI 兼容上游的 `tool_calls` 在非流式、真流式、伪流式三条路径上都会保留（见下方“工具调用”）。

> **升级提示**：老版本启动的实例，状态文件里没有进程身份信息（`proxyProc`），新版 `stop` 会判"无法确认身份"而跳过——这是**安全默认，不是坏了**。升级前遗留的进程需要手动关一次（任务管理器，或 `taskkill /PID <pid> /T /F`）。之后新起的实例都能被正常回收。

自检：

```bash
curl -s http://127.0.0.1:8791/v1/models -H "Authorization: Bearer <token>"
curl -s http://127.0.0.1:8791/health   -H "Authorization: Bearer <token>"
```

---

## 它到底做了什么

```
发现：注册表 / 进程 / 目录约定 / 适配器声明的路径
  ↓  去重（按 exe 绝对路径）+ 置信度（取单源最大值）
候选列表（不是白名单）
  ↓  manifest 匹配 + 端口探测
分级：L0 不可代理 / L1 直通 / L2 需适配 / L3 仅 CLI
  ↓  自起隔离实例（自定端口）→ stdout 抓凭据 → 等契约端点 200
上游服务面
  ↓  协议适配（声明式映射或直通）
/v1/models · /v1/chat/completions · /v1/responses（SSE 透传或伪流式）
  ↓  强制 Bearer + CORS 全拒绝
下游程序
```

### 四个不能省的判定

| 判定 | 为什么 |
|---|---|
| **假绿三级否决** | Electron 应用的 SPA 兜底会让任意路径返回 200 + 同一份 HTML（实测 9,571B 且字节数完全相同）。只看状态码会把每个 GUI 应用误判为可直连 |
| **L1 只认 OpenAI 形状** | 只回 `models[]`（原生形状）、`models[]`+`data[]` 混合、或 `data[0].id` 是文件路径时，形状看着合规但一调用就 500（实测 llama.cpp：`invalid string: forbidden character after backslash`）→ 只能判 L2。判据只有一份实现（`probe.mjs` 的 `looksLikeModelList`），probe 与 port-scan 共用 |
| **就绪 = 契约端点 200** | 自起实例约 15–20s 才完成插件激活，期间返回 503；根路径从一开始就是 200 的 HTML |
| **凭证每请求现取** | 上游 token 由宿主应用刷新，启动读一次会静默失效 |

---

## 目录结构

```
prototype/
├─ src/
│  ├─ cli.mjs                  # scan / list / probe / serve / ui / status / stop / adapters
│  ├─ discovery/
│  │   ├─ win.mjs              # 注册表、进程、端口、目录、适配器 glob
│  │   └─ index.mjs            # 合并、规范化、去重、置信度、挂进程与端口
│  ├─ probe.mjs                # L0–L3 分级 + 假绿三级否决 + CLI 无头探测
│  ├─ console/
│  │   ├─ server.mjs           # 控制台 HTTP 服务：8 个接口 + 独立令牌 + 跨站拒绝
│  │   └─ ui.html              # 单文件页面（原生 JS，无构建，深色主题）
│  ├─ adapters/
│  │   ├─ loader.mjs           # 加载、校验、故障隔离、用户目录覆盖
│  │   └─ translator.mjs       # openai-passthrough / 声明式 http-openapi
│  ├─ runtime/
│  │   ├─ controller.mjs       # 编排：起上游 → 建 translator → 起代理 → 写状态
│  │   ├─ supervisor.mjs       # 起进程、抓凭据、等就绪、杀进程树、选空闲端口
│  │   ├─ portscan.mjs         # port-scan 策略：复用 L1 判据的端口命中判定
│  │   ├─ proxyenv.mjs         # 上游代理变量策略 clear / inherit / custom
│  │   ├─ procinfo.mjs         # 进程取证：exe 路径 + 启动时刻（供 stop 验身份）
│  │   └─ stopguard.mjs        # apx stop 的安全回收：三条件不全满足就只清状态
│  ├─ proxy/server.mjs         # OpenAI 端点（含 /v1/responses）、SSE 透传、伪流式、鉴权、CORS
│  └─ security/
│      ├─ token.mjs            # 下游令牌（sk-local-）
│      └─ credentials.mjs      # 上游凭证：static / env / file-json / regex-file / sqlite-json
├─ adapters/
│  ├─ opencode-v2.json         # 真实适配器（自起 serve + Basic + 声明式映射）
│  ├─ local-openai-service.json# 端口扫描型：自动发现本机已运行的 OpenAI 兼容服务
│  ├─ deepseek-harness.json    # 远端型（experimental）：借 agent 凭据直连其中转
│  └─ openai-passthrough.json  # 任意 OpenAI 兼容服务（L1 直通 / 冒烟夹具）
├─ test/
│  ├─ smoke.mjs                # 70 项端到端断言（假上游 + 真代理进程 + 退避信号 + 5xx 保真 + Responses + 无 /v1 兼容 + tool_calls 三条路径 + 模型详情）
│  ├─ probe.test.mjs           # 23–25 项分级断言（L1 判据收紧 + port-scan 共用同一判据）
│  ├─ token.test.mjs           # 17 项令牌稳定性断言（原子写 / 损坏不覆盖 / rotate / 并发）
│  ├─ translator.test.mjs      # 11 项适配层断言（流式能力校验 + tool_calls 保真 + 形状错误）
│  ├─ health.test.mjs          # 8 项上游健康断言（启动检查 / 连续失败判红 / 恢复清零）
│  ├─ console.test.mjs         # 54 项控制台断言（鉴权 / 跨站 / 起停 / 真模型 / 无明文 / 过滤契约）
│  ├─ stop-safety.mjs          # 17 项回收安全断言（pid 复用不得误杀）
│  ├─ adapters.test.mjs        # 49 项 manifest 断言（策略声明 + 凭据机制 + 探活 + 噪声 exe）
│  └─ e2e-real.mjs             # 17 项真实链路断言（真模型文本 + 首块延迟 + Responses + 提供方识别）
└─ ...
```

---

## 适配器（manifest）

manifest 只描述「是什么、怎么找、怎么连」，**不描述「怎么翻译」**——翻译是代码，塞进 YAML 会长成没人维护的 DSL。

```json
{
  "schemaVersion": 1,
  "id": "your-agent",
  "name": "显示名",
  "match": { "exeNames": ["x.exe"], "pathGlobs": ["%APPDATA%/vendor/cli/*/x.exe"] },
  "serviceFace": {
    "type": "http-openapi",
    "portDiscovery": {
      "strategy": "launch-assigned",
      "argv": ["{exe}", "serve", "--hostname", "{host}", "--port", "{port}"]
    },
    "readyProbe": { "path": "/api/model" },
    "auth": { "type": "basic", "username": "user",
              "secretFrom": { "kind": "stdout", "pattern": "password (\\S+)" } }
  },
  "upstream": {
    "listModels": { "path": "/api/model", "items": "$.data",
                    "fields": { "id": "id", "provider": "providerID" } },
    "generate": { "path": "/api/generate",
                  "body": { "prompt": "${prompt}", "model": "${model.upstreamId}" },
                  "textPath": "$.data.text" }
  },
  "capabilities": { "streaming": false, "tools": false },
  "sessionPolicy": "stateless"
}
```

字段含义与完整 schema 见 `../docs/03-architecture.md` §D.4。

存放位置：

- 内置：`prototype/adapters/*.json`（随包，只读）
- 用户：`%APPDATA%\apx\adapters\*.json`（可覆盖内置同 id）
- 额外：环境变量 `APX_ADAPTER_DIRS`（多目录用系统路径分隔符）

**新增一款软件 = 加一份 JSON + 验证，不改主程序。**

匹配层有一条硬规则：候选 exe 的基名命中「卸载器/安装器/更新器」噪声词（`unins*/setup*/installer*/crash*/update*`）时**不计分**，避免首屏出现「Uninstall xxx」这种点下去是卸载的条目。规则只有一份实现（`src/lib/exec-noise.mjs`），发现层与匹配层共用；若某软件主程序真叫 `update.exe`，在 manifest 的 `match.exeNames` 里显式写出该基名即可豁免。

---

## 凭证型适配器（借 agent 的凭据）

有些 agent 不给本地端点，只在自家客户端里配好了一个远端中转 + 一串 API key。
这类适配器用的是两个新机制，都不需要改主程序：

```json
{
  "serviceFace": {
    "type": "openai-passthrough",
    "baseUrl": "https://<中转域名>/v1",
    "portDiscovery": { "strategy": "remote" },      // 不起进程、不扫端口
    "proxyEnv": "clear"
  },
  "upstream": {
    "baseUrl": "https://<中转域名>/v1",
    "auth": {
      "kind": "regex-file",                          // 从任意文本文件按正则取一组
      "path": "~/.dsh/.credentials.yaml",
      "pattern": "DSH_API_KEY:\\s*[\"']?([^\\s\"']+)",
      "group": 1,
      "scheme": "bearer"
    },
    "listModels": { "path": "/v1/models", "items": "$.data" },
    "generate": { "path": "/v1/chat/completions", "textPath": "$.choices[0].message.content" }
  },
  "level": "experimental"
}
```

**复用什么**：该 agent 已经付过费/已经登录的那条**通道**——中转地址 + 凭据。凭据按 manifest 声明的位置每请求现取，所以宿主刷新 token 后本端点自动跟上，不用重启。

**不复用什么**：它的**编排**（agent loop、任务规划）、**工具调用**（`tool_calls` 会被显式 400 拒绝，不静默降级）、**会话状态**（`sessionPolicy: stateless`，请求之间互不影响）。也就是说：你能拿到"模型"这一层，拿不到"agent"这一层。

**合规**：把该 agent 的订阅额度开放给任意本机程序，很可能触及它的服务条款（例如"仅限本客户端内使用"）。**这个判断必须由使用者自己做**，工具不代为背书——所以这类适配器一律标 `level: "experimental"`，并在 `quirks.knownIssues` 里如实写明当前能不能用（`deepseek-harness` 截至 2026-11-04：`/v1/models` 可 200，`/v1/chat/completions` 返回 502/503，**机制就绪 ≠ 可用**）。

`remote` 型必须遵守一个规范化约定：`serviceFace.baseUrl` / `upstream.baseUrl` **只写 origin**（`协议://host[:port]`，不带路径、不带尾斜杠），路径一律写在各 endpoint 的 `path` 里。loader 会校验这一点，写错直接加载失败并提示"路径请写在各 endpoint 里"——主程序不做任何"猜着拼"的改写。

---

## 工具调用（tool_calls）

只对**本身就说 OpenAI 协议**的上游成立（`openai-passthrough` 型：Ollama、任意 OpenAI 兼容服务、经验证的中转）。声明式映射型（如 `opencode-v2`）没有工具调用这个上游概念，仍然显式 `400 apx_unsupported_field`。

| 下游请求 | 上游能力 | 行为 |
|---|---|---|
| 非流式 + `tools` | `capabilities.tools: true` | 原样转发；响应里的 `message`（含 `content:null`、`tool_calls`、`reasoning_content` 等）与 `finish_reason` 原样透传，不重建 |
| 流式 + `tools` | `capabilities.streaming: true` | SSE 逐块透传，`tool_calls` 增量与 `index` 保持上游原样 |
| 流式 + `tools` | `capabilities.streaming: false` | 先取完整结果，再按 OpenAI 流式约定回放：`tool_calls` 整块发出，`finish_reason: "tool_calls"`，响应头 `x-apx-degraded: pseudo-stream` |
| 任意 | `capabilities.tools: false` | **400 `apx_unsupported_field`**，在触达上游之前拒绝（流式路径同样校验，不会偷偷塞给上游） |

> Responses API 的 `tools` / `tool_choice` / `previous_response_id` 仍属未实现：显式 400，不静默丢字段。Chat Completions 的工具调用不受影响。

## 上游健康（不是“进程活着就绿”）

代理进程活着、上游已经挂了，是最容易被误判成正常的状态。现在启动后每 20 秒探测一次上游 `listModels` 端点（自起型同时检查子进程退出码）：

| 状态 | 触发条件 | UI 表现 |
|---|---|---|
| `ok` | 最近一次探测成功 | 绿灯「运行中」 |
| `degraded` | 连续失败 1 次 | 红灯「上游抖动」，保留上次成功清单 |
| `down` | 连续失败 ≥ 2 次，或自起型子进程已退出 | 红灯「上游异常」，横幅显示失败原因 |

`/api/status` 返回 `upstreamHealth: {state, lastCheckAt, lastOkAt, consecutiveFailures, checks, lastError}`。恢复成功后状态自动回到 `ok` 且失败计数清零——不需要重启代理。测试可用环境变量缩短周期：`APX_HEALTH_INTERVAL_MS=200`。

## 令牌管理

```bash
node src/cli.mjs token show     # 查看（掩码）
node src/cli.mjs token rotate   # 更换（唯一入口，旧值立即失效）
```

**令牌不会自动变化。** 如果你没有运行过 `rotate`，而下游突然开始 401，那是 bug，不是行为。

这条之所以要写进文档，是因为踩过：状态文件被并发写坏后，旧实现会"当作没有令牌 → 生成一个新的"，用户的客户端配置就静默失效了，而报错只显示 401。现在的实现：

| 机制 | 为什么 |
|---|---|
| 写入走 `tmp` + `rename`（同目录原子替换） | 不会出现半截 JSON，读取方永远看到完整文件 |
| 读不动 → `{__corrupt:true}` 而**不是** `{}` | `{}` 会被当成"没有令牌"，进而生成新的；`__corrupt` 会让写入失败并报错 |
| `getToken()` 见到损坏直接抛错 | 错误信息给出出路（删文件或 `rotate`），而不是替用户做决定 |
| 首次生成在排他锁内二次确认 | 多进程同时首启只会有一个令牌胜出（实测 8 进程并发 → 1 个值） |


---

## 已验证 / 未验证

| 能力 | 状态 |
|---|---|
| Windows 发现（注册表/进程/端口/目录/适配器路径） | ✅ 实测 453 候选、3.4s |
| 假绿三级否决 | ✅ 实测：GUI 的 3082 判为"纯 Web UI"；`/v1/models` 返回同尺寸 HTML 时被否决 |
| **L1 判据只认 OpenAI 形状** | ✅ 25 项断言：11434 仍判 L1；只回 `models[]`、`models[]`+`data[]` 混合、或 `data[].id` 是文件路径（llama.cpp）一律降 L2 |
| 自起实例 + 自定端口 + stdout 抓凭据 | ✅ 实测（opencode 150 模型清单） |
| 模型清单透传 | ✅ 实测 150 个 |
| **Web 控制台（8 个接口 + 独立令牌 + 跨站拒绝）** | ✅ 36 项断言（含真模型） |
| **端口扫描策略（port-scan）** | ✅ 实测命中本机推理服务，非命中端口逐个给出失败原因 |
| **真实模型文本返回 + 真流式** | ✅ 实测（`local-openai-service`：非空文本、首块 1ms、15 帧、含 `[DONE]`） |
| **上游代理变量策略（clear/inherit/custom）** | ✅ 实测：本机代理会对回环请求回 502 `Proxy refused to open a tunnel`，clear 后不再走代理 |
| 下游鉴权 / CORS 拒绝 / 跨站拒绝 | ✅ 测试覆盖 |
| 真流式透传（逐块、补 `[DONE]`、断连取消） | ✅ 测试覆盖（假上游 + 真上游） |
| 凭证轮换免重启 / 401 重读重放 | ✅ 测试覆盖 |
| 停止即回收（进程树 + 端口） | ✅ 实测三个端口拒绝连接 |
| **上游健康监控（N5）** | ✅ 8 项断言：启动即检查；连续 2 次失败判 `down`；恢复后回 `ok` 且计数清零；自起型子进程退出直接判 `down` |
| **`apx stop` 不误杀**（pid 复用防护） | ✅ 17 项断言：exe 路径不符 / 启动时间不符一律跳过，只清状态 |
| **凭证型适配器（regex-file + remote）** | ✅ 38 项断言：凭据能读到（不打印明文）、`/v1/models` 实测 200；`chat` 仍 502，已在 manifest 如实标注 |
| `opencode-v2` 真实模型文本 | ⚠️ 未达成：上游 provider 回 `This model is not available in your country`（地区限制）/ 曾出现免费额度 429 |
| 增量事件 → OpenAI chunk 映射 | ⚠️ 未验证（受上一条阻断） |
| macOS / Linux 发现层 | ❌ 未实现（POSIX 分支为占位） |
| **`tool_calls`（OpenAI 兼容上游）** | ✅ P1 直通：非流式保留 `message`（`content:null` + `tool_calls` + 非标字段）与 `finish_reason`；真流式增量透传；伪流式整块回放并标 `x-apx-degraded: pseudo-stream`。声明 `tools:false` 的适配器仍在流式/非流式两条路径显式 400 |
| **`GET /v1/models/{id}`** | ✅ 支持（OpenAI SDK 的 `client.models.retrieve()`）；未知模型 404 `apx_model_not_found` |
| Responses API 的 `tools` / `function_call` | ⚠️ 未实现：显式 400，不静默丢字段（Chat Completions 的工具调用不受影响） |
| **`/v1/responses` 兼容层** | ✅ 字符串 / 数组 `input`、`instructions`、非流式与流式均有断言；流式按 Responses 事件回放并标注 `x-apx-degraded: pseudo-stream`。未实现端点返回 501 且列出已支持端点，不静默 404 |

---

## 已知限制

1. **只绑 `127.0.0.1`**，不做局域网共享。
2. **上游继承系统代理**：本机 `HTTP_PROXY` 指向本地代理时，上游会把去 `127.0.0.1` 的请求也交给它，得到 `502 ERR_PROXY_TUNNEL: Proxy refused to open a tunnel`。已由 manifest 的 `serviceFace.proxyEnv` 解决：默认 `clear`（清代理变量 + `NO_PROXY=127.0.0.1,localhost,::1`），需要走代理时改 `inherit`——`inherit` 也**会**把 `127.0.0.1,localhost,::1` 追加进 `NO_PROXY`（回环永远不走代理）。**注意**：默认值对自起型上游（如 `opencode-v2`）同样生效，该适配器已显式写明 `"proxyEnv": "clear"`（让行为被声明，而不是依赖默认值）。
3. **伪流式不是真流式**：`x-apx-degraded: pseudo-stream` 会明确标注。
4. **`usage` 是估算值**（声明式映射型），响应里带 `usage_estimated: true`。
5. **合规**：把某些上游的订阅额度开放给任意本机程序，可能触及该服务的条款（例如"仅供 coding agent 使用"）。这类判断要在 UI 上说清楚，不能只报"能跑"。

---

## Web 控制台（`apx ui`）

```
GET  /                 同源页面（内嵌控制台令牌）
GET  /api/scan         候选列表（走适配器 glob；8s 内缓存，?refresh=1 强刷）
GET  /api/adapters     适配器清单 + 每个适配器的匹配结果
GET  /api/probe?port=N L0–L3 分级 + 假绿证据
POST /api/start        {adapterId, upstreamPort?} → controller.start
POST /api/stop         controller.stop
GET  /api/status       运行态：端口、模型、凭证、上游健康（upstreamHealth）、请求数/P95/streaming
GET  /api/snippet      {baseURL, apiKey, models[]} 供复制
```

安全边界（四条，缺一不可）：

| 措施 | 为什么 |
|---|---|
| 控制台令牌独立于下游 `sk-local-` 令牌 | 页面泄漏不等于下游端点泄漏 |
| 令牌注入同源页面 `<meta>`，请求带 `x-apx-console-token` | 令牌不出现在 URL / 日志 / 历史记录里 |
| 所有 `/api/*` 校验该头，缺失或错误 → 401 | 端口只对本机，但本机其他进程也能发请求 |
| `Sec-Fetch-Site: cross-site` / `Origin: null` / 非同源 Origin → 403，且永不返回 `Access-Control-Allow-*` | 浏览器里第三方页面连响应体都读不到 |

终端只打印令牌掩码（如 `apx-console-…1DF3`），不打印明文。

首屏默认只显示「被某个适配器命中」的软件（`/api/scan` 返回的 `matchedBy` 字段），因为一次全盘扫描通常有 400+ 候选、其中绝大多数是系统进程（conhost/Explorer…）。关掉开关可看全部候选，空态里会直接给出这个动作。

脚本与验收用稳定契约：`GET /api/scan?matched=1` 只返回被适配器命中的候选（条数 === `matchedTotal`），`?matched=0` 与不带参数等价（全量）。

默认视图为空**不影响启动**：`port-scan` 与 `remote` 型适配器不需要选中任何软件，直接从下方「用适配器启动」即可（`POST /api/start {adapterId}`）。只有 `launch-assigned` 型（需要 exe 路径）才依赖候选命中。

---

## 测试

```bash
cd prototype
node test/smoke.mjs        # 70/70：假上游 + 真代理进程（鉴权/流式/凭证/重放/健康检查/429·503 Retry-After/5xx 保真/Responses/无 /v1 兼容/tool_calls 直通与伪流式/模型详情）
node test/probe.test.mjs   # 23–25/25：L0–L3 分级 + port-scan 命中判据（含两个假阳回归）
node test/token.test.mjs   # 17/17：令牌不得被意外轮换（原子写/损坏抛错/rotate/8 进程并发）
node test/translator.test.mjs # 11/11：流式路径也必须执行能力校验；tool_calls / reasoning_content 不得丢
node test/health.test.mjs  # 8/8：上游健康（启动检查 / 连续 2 次失败判红 / 恢复后清零）
node test/console.test.mjs # 54/54：控制台（401/403/起停/真模型/无明文/令牌稳定/默认视图一致/空候选可启动）；无本机上游则 skip
node test/stop-safety.mjs  # 17/17：apx stop 的 pid 复用防护（无关进程不得被杀）
node test/adapters.test.mjs# 49/49：manifest 加载/策略声明/regex-file 凭据/远端探活/噪声 exe 排除（不可用则 skip）
node test/e2e-real.mjs     # 17/17：controller 直连本机推理服务（真文本 + 首块 < 3s + Responses + 提供方识别）；无上游则 skip
```

一条命令跑全部：`npm run test:all`（等价于上面九条按顺序执行，共 266 项）。

每个套件都会把状态目录隔离到自己的临时目录（`APX_STATE_DIR`），跑完自动清理——所以并行验收不会互相踩 `~/.apx/state.json`。要指定目录（例如排查问题时保留现场）：`APX_STATE_DIR=/path/to/dir npm run test:all`。

覆盖要点：鉴权 401×2、模型清单、非流式、流式逐块（首块延迟/帧数/`[DONE]`）、CORS 预检、恶意 Origin、
凭证轮换、401 重放、健康检查；L1 判据（只认 `data[]` + 字符串 `id`，`models[]` 变体与文件路径 id 降 L2）；
控制台的令牌/跨站/起停/端口回收/状态接口不含 `sk-local-`；`apx stop` 的三条件身份校验；
manifest 的策略声明（`port-scan` / `remote` / `proxyEnv`）与 `regex-file` 凭据读取；以及真实模型的非空文本与首块延迟。
