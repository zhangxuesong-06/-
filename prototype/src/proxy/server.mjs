// OpenAI 兼容端点 + 流式透传。
// 安全默认：强制 Bearer + CORS 全拒绝 + 拒绝跨站来源。
// 流式默认：上游支持真流式就边读边写逐块 flush；不支持才降级为伪流式，并显式告知。
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { errorEnvelope, newCompletionId } from '../adapters/translator.mjs';
import { tokenMatches } from '../security/token.mjs';

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * 错误出口统一走这里：把上游的退避信号透传给下游。
 *
 * 为什么必须带 `retry-after`：下游 SDK 拿到 429 但看不到退避时间会立刻重试，
 * 于是继续烧上游额度 —— 产品承诺"别白烧额度"，那这条头就不能只躺在 body 里。
 * 优先用 upstream.retryAfter（整秒），没有就按 retryAfterMs 折算。
 */
function sendError(res, status, err) {
  const up = err?.upstream || {};
  const seconds =
    Number.isFinite(up.retryAfter) && up.retryAfter > 0
      ? Math.ceil(up.retryAfter)
      : Number.isFinite(up.retryAfterMs) && up.retryAfterMs > 0
        ? Math.max(1, Math.ceil(up.retryAfterMs / 1000))
        : null;
  const headers = seconds ? { 'retry-after': String(seconds) } : {};
  return sendJson(res, status, errorEnvelope(err), headers);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 统一 assistant message 形状。
 * 直通型上游可能带 tool_calls / reasoning_content / refusal，必须原样交给下游；
 * 声明式映射型只有 text，就按标准 message 组装。
 */
function assistantMessage(result) {
  const message =
    result.message && typeof result.message === 'object'
      ? { ...result.message }
      : { role: 'assistant', content: result.text };
  if (!message.role) message.role = 'assistant';
  if (!('content' in message)) message.content = result.text ?? null;
  return message;
}

function chunkFrame({ id, created, model, delta, finish = null }) {
  const payload = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 伪流式：上游只能一次性返回时，按自然吐字节奏回放，并在响应头标注降级。 */
async function pseudoStream(res, { text, message, finishReason = 'stop', model, chunkSize = 24, delayMs = 30 }) {
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-apx-degraded': 'pseudo-stream',
  });
  res.write(chunkFrame({ id, created, model, delta: { role: 'assistant', content: '' } }));
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  for (let i = 0; i < text.length; i += chunkSize) {
    if (closed) return;
    res.write(chunkFrame({ id, created, model, delta: { content: text.slice(i, i + chunkSize) } }));
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // 非流式上游返回的 tool_calls，按 OpenAI 流式约定整块回放（index + id + 完整参数）。
  for (let i = 0; i < toolCalls.length; i++) {
    if (closed) return;
    const call = toolCalls[i] || {};
    res.write(
      chunkFrame({
        id,
        created,
        model,
        delta: {
          tool_calls: [
            {
              index: i,
              id: call.id || null,
              type: call.type || 'function',
              function: { name: call.function?.name || '', arguments: call.function?.arguments || '' },
            },
          ],
        },
      }),
    );
  }
  if (closed) return;
  res.write(chunkFrame({ id, created, model, delta: {}, finish: finishReason }));
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * 真流式透传：二进制安全、逐块写出、不缓冲。
 * 客户端断开 → 立刻取消上游读取（不然上游继续生成，继续烧额度）。
 */
async function pipeUpstreamStream(res, { stream, abort, stats }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-apx-stream': 'passthrough',
  });
  const reader = stream.getReader();
  let closed = false;
  let sawDone = false;
  let tail = '';
  let firstChunkAt = null;
  res.on('close', () => {
    closed = true;
    try {
      reader.cancel();
    } catch {
      /* ignore */
    }
    if (abort) abort();
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (firstChunkAt === null) firstChunkAt = Date.now();
      const buf = Buffer.from(value);
      tail = (tail + buf.toString('latin1')).slice(-80);
      if (tail.includes('[DONE]')) sawDone = true;
      res.write(buf); // Node 的 write 会立即 flush 到 socket
    }
    if (!closed) {
      // 有的上游结尾不发 [DONE]，客户端会一直等
      if (!sawDone) res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    if (!closed) {
      res.write(`data: ${JSON.stringify({ error: { message: String(err.message || err), type: 'apx_error' } })}\n\n`);
      res.end();
    }
  } finally {
    stats.streams++;
    if (firstChunkAt) stats.ttfts.push(firstChunkAt - stats.lastStreamStart);
    if (stats.ttfts.length > 200) stats.ttfts.shift();
  }
}

/** Responses API 的 input → chat messages。只做 P0 需要的那几种形态。 */
function responsesToMessages(body) {
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      // function_call / function_call_output 这类工具项：P0 不支持，跳过而不是崩掉
      if (item.type && item.type !== 'message' && !item.role) continue;
      const role = item.role || 'user';
      let content = item.content;
      if (Array.isArray(content)) {
        content = content.map((p) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).join('');
      } else if (typeof content !== 'string') {
        content = '';
      }
      if (content) messages.push({ role, content });
    }
  }
  return messages;
}

function responsesUsage(usage) {
  // 很多客户端会把 usage 当必填对象解析；缺字段比 0 更容易触发"响应格式不兼容"。
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
  };
}

function buildResponsesPayload({
  id,
  created,
  model,
  text,
  usage,
  adapterId,
  estimated,
  instructions = null,
  temperature = null,
  topP = null,
}) {
  return {
    id,
    object: 'response',
    created_at: created,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions,
    metadata: {},
    model,
    output: [
      {
        type: 'message',
        id: `msg_${id.slice(5, 29)}`,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    output_text: text,
    parallel_tool_calls: true,
    temperature,
    tool_choice: 'auto',
    tools: [],
    top_p: topP,
    usage: responsesUsage(usage),
    apx: { adapter: adapterId, usage_estimated: Boolean(estimated) },
  };
}

/**
 * Responses API 的流式事件。
 * 上游若只有非流式端点，这里按事件序列回放并标注 pseudo-stream——
 * 不假装上游原生支持增量，但保证客户端能拿到 output_text.delta。
 */
async function responsesPseudoStream(res, { model, text, usage, adapterId, instructions = null, temperature = null, topP = null, chunkSize = 24, delayMs = 30 }) {
  const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-apx-degraded': 'pseudo-stream',
  });
  let seq = 0;
  const emit = (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: seq++ })}\n\n`);
  };
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  emit({ type: 'response.created', response: { id, object: 'response', created_at: created, status: 'in_progress', model } });
  emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: msgId, status: 'in_progress', role: 'assistant', content: [] } });
  emit({ type: 'response.content_part.added', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });

  for (let i = 0; i < text.length; i += chunkSize) {
    if (closed) return;
    emit({ type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: text.slice(i, i + chunkSize) });
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (closed) return;

  emit({ type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text });
  emit({ type: 'response.content_part.done', item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } });
  emit({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: msgId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
  emit({
    type: 'response.completed',
    response: buildResponsesPayload({ id, created, model, text, usage, adapterId, estimated: true, instructions, temperature, topP }),
  });
  res.end();
}

export function createProxyServer({ host = '127.0.0.1', token, translator, adapter, getCatalog, credentials, authEnabled = true }) {
  const stats = {
    startedAt: Date.now(),
    requests: 0,
    errors: 0,
    streams: 0,
    latencies: [],
    ttfts: [],
    lastStreamStart: 0,
    byCode: {},
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);

    // 1) CORS：一律不返回 Access-Control-Allow-*，预检直接 403。
    const origin = req.headers.origin;
    const secFetchSite = req.headers['sec-fetch-site'];
    if (req.method === 'OPTIONS') {
      return sendJson(res, 403, { error: { message: 'CORS preflight denied', type: 'apx_error', code: 'apx_cors_denied' } });
    }
    if (secFetchSite === 'cross-site' || origin === 'null') {
      return sendJson(res, 403, { error: { message: 'cross-site request denied', type: 'apx_error', code: 'apx_cross_site_denied' } });
    }

    // 2) 鉴权
    if (authEnabled) {
      const auth = req.headers.authorization || '';
      const given = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (!tokenMatches(given, token)) {
        stats.errors++;
        return sendJson(
          res,
          401,
          { error: { message: '缺少或错误的本地令牌；可用 `apx token show` 查看当前值', type: 'apx_error', code: 'apx_unauthorized' } },
          { 'www-authenticate': 'Bearer' },
        );
      }
    }

    const t0 = Date.now();
    const done = (status) => {
      stats.requests++;
      if (status >= 400) stats.errors++;
      stats.byCode[status] = (stats.byCode[status] || 0) + 1;
      stats.latencies.push(Date.now() - t0);
      if (stats.latencies.length > 500) stats.latencies.shift();
    };

    try {
      // 3) 健康检查：报告"凭证是否可读"比"进程活着"更有意义
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
        const catalog = await getCatalog();
        const cred = credentials?.describe?.() || { kind: 'none', ok: true };
        done(200);
        return sendJson(res, 200, {
          status: 'ok',
          adapter: adapter.id,
          adapterVersion: adapter.version || null,
          models: catalog.models.length,
          upstreamReachable: !catalog.error,
          credential: { kind: cred.kind, ok: cred.ok, hasToken: cred.hasToken, lastReadAt: cred.lastReadAt, expiresAt: cred.expiresAt },
          streaming: adapter.capabilities?.streaming ? 'passthrough' : 'pseudo',
          authEnabled,
          stats: {
            requests: stats.requests,
            errors: stats.errors,
            streams: stats.streams,
            p50Ms: percentile(stats.latencies, 0.5),
            p95Ms: percentile(stats.latencies, 0.95),
            uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
          },
        });
      }

      // 4) 模型清单
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        const catalog = await getCatalog();
        const created = Math.floor(Date.now() / 1000);
        done(200);
        return sendJson(res, 200, {
          object: 'list',
          data: catalog.models.map((m) => ({
            id: m.alias,
            object: 'model',
            created,
            owned_by: adapter.id,
            apx: { upstream_id: m.upstreamId, provider: m.provider, source: m.source },
          })),
        });
      }

      // 4b) 单个模型详情：OpenAI SDK 的 client.models.retrieve(id) 会打这个端点。
      {
        const m = url.pathname.match(/^\/(?:v1\/)?models\/([^/]+)$/);
        if (req.method === 'GET' && m) {
          let wanted = m[1];
          try {
            wanted = decodeURIComponent(wanted);
          } catch {
            /* 保留原样，下面按未找到处理 */
          }
          const catalog = await getCatalog();
          const found = catalog.models.find((x) => x.alias === wanted || x.upstreamId === wanted);
          const created = Math.floor(Date.now() / 1000);
          if (!found) {
            done(404);
            return sendError(res, 404, {
              code: 'apx_model_not_found',
              param: 'model',
              message: `模型 ${wanted} 不在清单中。先 GET /v1/models 查看可用模型。`,
            });
          }
          done(200);
          return sendJson(res, 200, {
            id: found.alias,
            object: 'model',
            created,
            owned_by: adapter.id,
            apx: { upstream_id: found.upstreamId, provider: found.provider, source: found.source },
          });
        }
      }

      // 5) 对话。兼容两种 baseURL 习惯：客户端可能填 .../v1，也可能填根地址。
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          done(400);
          return sendError(res, 400, { code: 'apx_bad_json', message: '请求体不是合法 JSON' });
        }
        if (!Array.isArray(body.messages) || !body.messages.length) {
          done(400);
          return sendError(res, 400, { code: 'apx_bad_request', message: 'messages 不能为空', param: 'messages' });
        }

        if (body.stream) {
          stats.lastStreamStart = Date.now();
          const s = await translator.openStream(body);
          if (s.error) {
            done(s.error.status);
            return sendError(res, s.error.status, s.error);
          }
          if (s.stream) {
            done(200);
            return pipeUpstreamStream(res, { stream: s.stream, abort: s.abort, stats });
          }
          // 上游不支持真流式 → 先取完整结果，再伪流式回放
        }

        const result = await translator.chat(body);
        if (result.error) {
          done(result.error.status);
          return sendError(res, result.error.status, result.error);
        }

        if (body.stream) {
          done(200);
          return pseudoStream(res, {
            text: result.text,
            message: result.message,
            finishReason: result.finishReason || 'stop',
            model: body.model,
          });
        }

        done(200);
        return sendJson(res, 200, {
          id: newCompletionId(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: assistantMessage(result), finish_reason: result.finishReason || 'stop' }],
          // 有些客户端严格解析 usage 对象；上游没给就给 0，而不是让字段消失。
          usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          system_fingerprint: null,
          apx: {
            usage_estimated: Boolean(result.usageEstimated),
            degraded: result.apxDegraded || [],
            adapter: adapter.id,
          },
        });
      }

      // 5b) Responses API：把 /v1/responses 映射到内部 chat 链路
      //     新版 OpenAI SDK / Codex 类客户端默认走这个端点，未实现会直接 404/501。
      if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          done(400);
          return sendError(res, 400, { code: 'apx_bad_json', message: '请求体不是合法 JSON' });
        }
        const messages = responsesToMessages(body);
        if (!messages.length) {
          done(400);
          return sendError(res, 400, {
            code: 'apx_bad_request',
            param: 'input',
            message: 'input 不能为空（支持字符串，或 [{role, content}] 数组）',
          });
        }
        // Responses 的工具/多轮状态字段不是 Chat Completions 的同构字段；
        // 静默丢掉会让 agent 拿残缺上下文，所以这里显式拒绝。
        const unsupported = [];
        if (body.tools?.length) unsupported.push('tools');
        if (body.tool_choice !== undefined) unsupported.push('tool_choice');
        if (body.previous_response_id) unsupported.push('previous_response_id');
        if (Array.isArray(body.input) && body.input.some((x) => x?.type === 'function_call' || x?.type === 'function_call_output')) {
          unsupported.push('input[*].function_call/function_call_output');
        }
        if (unsupported.length) {
          done(400);
          return sendError(res, 400, {
            code: 'apx_unsupported_field',
            param: unsupported[0],
            message: `Responses API 暂不支持字段：${unsupported.join(', ')}。这是显式拒绝，不是静默忽略。`,
          });
        }

        const chatBody = { model: body.model, messages, stream: false, max_tokens: body.max_output_tokens };
        for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'user']) {
          if (body[k] !== undefined) chatBody[k] = body[k];
        }

        const result = await translator.chat(chatBody);
        if (result.error) {
          done(result.error.status);
          return sendError(res, result.error.status, result.error);
        }

        const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream) {
          done(200);
          return responsesPseudoStream(res, {
            model: body.model,
            text: result.text,
            usage: result.usage,
            adapterId: adapter.id,
            instructions: typeof body.instructions === 'string' ? body.instructions : null,
            temperature: body.temperature ?? null,
            topP: body.top_p ?? null,
          });
        }

        done(200);
        return sendJson(
          res,
          200,
          buildResponsesPayload({
            id,
            created,
            model: body.model,
            text: result.text,
            usage: result.usage,
            adapterId: adapter.id,
            estimated: result.usageEstimated,
            instructions: typeof body.instructions === 'string' ? body.instructions : null,
            temperature: body.temperature ?? null,
            topP: body.top_p ?? null,
          }),
        );
      }

      if (url.pathname.startsWith('/v1/')) {
        done(501);
        return sendError(res, 501, {
          code: 'apx_unsupported_endpoint',
          message: `未实现该端点：${url.pathname}。当前支持 GET /v1/models、POST /v1/chat/completions、POST /v1/responses、GET /health。`,
        });
      }

      done(404);
      return sendError(res, 404, { code: 'apx_not_found', message: '未找到该路径' });
    } catch (err) {
      // 客户端主动断开（语音打断 / Ctrl+C）会在这里冒出来，不算服务端错误
      if (res.destroyed || /aborted|ECONNRESET/i.test(String(err.message))) return;
      done(500);
      return sendError(res, 500, { code: 'apx_internal_error', message: String(err.message || err) });
    }
  });

  server.stats = stats;
  return server;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
