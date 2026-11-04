# 交付状态（可发布）

| 项 | 内容 |
|---|---|
| 日期 | 2026-11-04（13:55 二次增量后复验） |
| 结论 | **可发布**。最新增量（提供方软件识别 + 响应格式兼容加固）后：QA 验收 **15/15 全过**；`npm run test:all` **229 项 / 0 失败** |
| 被测快照 | `prototype/` 下 `src` + `test` + `adapters` + `package.json` + `README.md` 共 33 个跟踪文件；本轮增量改 `src/proxy/server.mjs`、`src/runtime/controller.mjs`、`src/console/ui.html`、`test/smoke.mjs`、`test/e2e-real.mjs`、`README.md` |
| 复现 | `cd prototype && node test/qa-acceptance.mjs`（exit 0 = 全过） |
| 自有回归 | `npm run test:all` → **229 项 / 0 失败**（smoke 52 / probe 23 / token 17 / console 54 / stop-safety 17 / adapters 49 / e2e-real 17） |

> QA 结论已对**当前最新代码**复跑通过；不是只对改动前快照有效。`58241` 仍因本机无监听按假上游等价覆盖。

---

## 1. 它现在能做什么

把本机某个 agent / 本地推理服务的模型能力，变成 `http://127.0.0.1:<port>/v1` 这个标准 OpenAI 端点，给本机另一个需要模型的程序用。

```bash
cd prototype
node src/cli.mjs ui            # 打开控制台 http://127.0.0.1:8799/
# 控制台顶部会显示：上游（提供方）→ 本机代理（apx）→ 下游（你的程序）
# 点左侧「本机软件」会自动切到对应适配器；运行横幅会显示“提供方：实际软件名”。
# 例如 port-scan 命中 11434 时，运行态显示“提供方：ollama”。
```

下游可调用：

- `GET /v1/models` 或 `GET /models`
- `POST /v1/chat/completions` 或 `POST /chat/completions`
- `POST /v1/responses` 或 `POST /responses`（兼容层；流式按 Responses 事件回放，并显式标注 `x-apx-degraded: pseudo-stream`）
- `GET /health`

响应格式加固：

- `usage` 始终是对象（上游没给就是 0），不让字段消失。
- Chat 返回标准 `object=chat.completion`、`created`、`choices`、`usage`、`system_fingerprint`。
- Responses 返回标准 `object=response`、`output`、`output_text`、`usage`、`instructions` 等字段。
- `/v1/models` 的 `model.created > 0`，`owned_by` 是字符串。
- 未实现的路径返回 **501**，并在错误信息中列出当前支持端点；不会用 404 或静默忽略伪装成支持。

无控制台时：

```bash
node src/cli.mjs scan                      # 扫本机候选
node src/cli.mjs list                      # 用适配器收敛出"可代理的软件"
node src/cli.mjs probe --port 11434        # 可代理性分级（L0–L3 + 假绿判定）
node src/cli.mjs serve --adapter opencode-v2
node src/cli.mjs status | stop
node src/cli.mjs token show | rotate
```

已验证可用的上游（本机实测）：
- **本地推理服务（L1 直通）**：`local-openai-service` 适配器自动探到 11434，`qwen2.5:0.5b` 非流式与真流式均通。
- **CLI 型 agent（L2 协议适配）**：`opencode-v2`，自起 `serve` 实例、stdout 抓凭据、150 个模型清单全通；真实文本受**上游额度/地区限制**阻断（非代理问题）。
- **GUI 型 agent（凭据型，实验性）**：`deepseek-harness`，`/v1/models` 200（2 个模型），`chat/completions` 上游 502，`knownIssues` 已注明"机制就绪、当前不可用"。

---

## 2. 验收覆盖（QA 独立执行，不复用工程师断言）

| 项 | 结果 | 关键证据 |
|---|---|---|
| 发现层 | PASS | 候选 448；按 exe 绝对路径去重 388 条、重复组 0；多开合并 19 例 |
| 可代理性分级 | PASS | 11434→L1；SPA 兜底→L2；混合方言+路径 id→L2；标准 OpenAI→L1 |
| 控制台鉴权 | PASS | 无/错令牌 401；页面 meta 取令牌 200；`/api/status` 无令牌子串 |
| 令牌不静默轮换 | PASS | 损坏 state → 三条命令均非 0 退出、**不重建令牌**、原文件不被覆盖 |
| 真模型端到端 | PASS | 自动命中 11434；非流式 0.07s；流式 8 帧 / `[DONE]` / 首块 52ms |
| 断连取消 | PASS | 客户端 abort 后 **2ms** 上游记录到断开 |
| 安全边界 | PASS | OPTIONS 403 且 0 个 `access-control-*`；`Sec-Fetch-Site: cross-site` 403 |
| 停止与回收 | PASS | 端口 ECONNREFUSED；state 四字段 null；无残留；未误杀 11434 |
| stop 防误杀 | PASS | 伪造路径/未来时间均不杀；记录完全匹配才真回收（正反对照） |
| 错误语义 | PASS | `429+RA→429+retry-after`；`503→503`；`502→502`；`500→500`；`401→401` |
| rotate 守卫 | PASS | 运行中退出码 3 + 文案含"运行"与"apx stop/停止"；停后成功且换值 |
| `/api/scan` 契约 | PASS | `?matched=1` 条数 === `matchedTotal` === `matchedBy` 非空条数；`?matched=0` 等价全量 |
| launch-assigned 进程树回收 | PASS | 假上游 Basic 鉴权生效（无凭据 401）；`apx stop` 后子进程消失 + 端口拒绝 |
| UI 提供方语义 | PASS | 截图验证：顶部「上游 → 本机代理 → 下游」、运行横幅三件套、空态解释“为什么已适配少”均正常渲染 |
| 提供方软件识别 | PASS | port-scan 命中 11434 时，controller 返回 `providerName=ollama`；运行横幅显示“提供方：ollama” |
| 左侧候选交互 | 改进 | 点 DeepSeek/OpenCode 候选会自动切换到对应适配器；详情显示“可代理方式”，不再让人误以为“候选不能代理” |
| Responses API | PASS | smoke 14 项 + 真模型 e2e 4 项；`/v1/responses` 返回 `object=response` 与非空 `output_text`；未实现端点明确 501 |
| 响应格式兼容 | PASS | `/chat/completions` 无 `/v1` 也 200；`usage` 恒为对象；`model.created > 0`；Responses 返回标准字段与 `instructions` |

---

## 3. 已知偏差与限制（不算缺陷，但要知道）

| 项 | 说明 |
|---|---|
| **5xx 全量原样透传** | `429/400/401/500/502/503` 均透传；只有"拿不到响应"（超时/连接拒绝/重置）归 `502 apx_upstream_unreachable`。**注意：早前文档里"500→502"的说法作废**，实现更忠实 |
| `200` 但 body 非 JSON | 归 `502 apx_upstream_error`（不算 unreachable），避免把 HTML 兜底页误报成网络问题 |
| `isNoiseExe` 含 `install*` | 可能命中 `InstallShield.exe`；逃生口 = manifest 的 `exeNames` 显式列名 |
| 伪流式 | 上游不支持真流式时降级，响应头 `x-apx-degraded: pseudo-stream`，不冒充真流式 |
| `/v1/responses` 范围 | 已覆盖字符串 / 数组 `input`、`instructions`、非流式与流式事件；`tools` / `tool_choice` / `previous_response_id` / function-call 输入项显式 400 拒绝，不静默丢字段 |
| `usage` 估算 | 声明式映射型上游的 usage 为估算值，响应带 `usage_estimated: true` |
| 系统代理 | 上游默认 `proxyEnv: clear`（实测继承系统代理会导致 502 隧道失败）；`remote` 型不支持 `inherit`，加载时直接报错 |
| 只服务本机 | 只绑 `127.0.0.1`，不做局域网/公网共享 |

---

## 4. 仍未验证（如实挂着）

1. **58241 判非 L1**：该端口本机始终无监听，语义由人造"混合方言+路径 id"假上游等价覆盖（判 L2），但未验真机服务。
2. **多进程首次启动只产生一个令牌**：只有工程师的自有测试覆盖，QA 未独立复现。
3. **长时间稳定性 / 多机 / 其他 Node 版本**：未覆盖（本机 Node 22.22.2）。
4. **remote 型真实调用**：`deepseek-harness` 只验了加载与 `/v1/models`，chat 因上游 502 未验。
5. **macOS / Linux 发现层**：未实现（POSIX 分支为占位）。
6. **120s 真超时**：未单独跑——QA 实测的是"连接被拒"，两者在 `requestOnce` 抛错后走同一分支（`status:0` → 502 `apx_upstream_unreachable`），代码路径相同。

> 版本事实：QA 两次报告的 33 文件快照逐字节相同（`diff` 为空）。此前"195→207"指的是测试套件断言条数增加，**不是 `src` 变更**，因此不存在"在旧快照上验收"的情况。

---

## 5. 清理

```bash
node src/cli.mjs stop          # 停代理并回收进程树
node src/cli.mjs ui            # 控制台按 Ctrl+C
# 彻底清理：删 ~/.apx（令牌与状态）、删 %APPDATA%\apx\adapters（用户适配器）
```

---

## 6. 工程侧增量（2026-11-04 晚，**待 QA 复验**）

> 本节不是 QA 结论：下面只跑了工程自有回归，尚未由 QA 独立复跑 `qa-acceptance.mjs`。

| 项 | 内容 |
|---|---|
| 变更 | ① OpenAI 兼容上游的非流式 `tool_calls` 不再被吞（保留 `message` 全字段 + `finish_reason`）；② 真流式 `tool_calls` 增量透传（原有行为，新增断言）；③ 伪流式把非流式上游的 `tool_calls` 整块回放并标 `x-apx-degraded`；④ 流式路径补上能力校验，`tools:false` 的适配器不再把 `tools` 偷偷塞给上游；⑤ 新增 `GET /v1/models/{id}`；⑥ 新增上游健康监控：启动即检查、20s 周期探测、连续 2 次失败判 `down`、恢复自动回 `ok`，自起型子进程退出直接判红 |
| 改动文件 | `src/adapters/translator.mjs`、`src/proxy/server.mjs`、`src/runtime/controller.mjs`、`src/console/ui.html`、`test/smoke.mjs`、`test/translator.test.mjs`（新增）、`test/health.test.mjs`（新增）、`package.json`、`README.md` |
| 回归 | `node test/smoke.mjs` 70/70；`node test/translator.test.mjs` 11/11；`node test/health.test.mjs` 8/8；其余套件不变（probe 23、token 17、console 54、stop 17、adapters 49、e2e-real 17），合计 **266 / 0 失败** |
| 显式未做 | Responses API 的 `tools` / `tool_choice` / `previous_response_id` / `function_call` 仍是 400；声明式映射型适配器（如 `opencode-v2`）没有工具调用概念，也仍显式 400 |
| 复现 | `cd prototype && node test/smoke.mjs && node test/translator.test.mjs` |
