// OpenAI 兼容端点 + 流式透传。
// 安全默认：强制 Bearer + CORS 全拒绝 + 拒绝跨站来源。
// 流式默认：上游支持真流式就边读边写逐块 flush；不支持才降级为伪流式，并显式告知。
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { errorEnvelope, newCompletionId } from '../adapters/translator.mjs';
import { tokenMatches } from '../security/token.mjs';
import { createLimiter } from '../runtime/limiter.mjs';

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
/**
 * 本地小模型不会调用工具时的兼容层（manifest 显式开启）。
 *
 * Coopanion 的桌宠只有在 bot 调用 `pet_say({script})` 时才会显示气泡；
 * qwen2.5:0.5b 这类模型只会回纯文本。开启 textToTool 后，如果请求里确实提供了
 * 这个工具，且模型没有返回 tool_calls，就把文本包成一次工具调用。
 *
 * 防循环：如果最后一条消息已经是该工具的返回结果，就不再包装——说明这一轮
 * 只是模型在消化工具回执。
 */
function lastToolResultName(body) {
  if (Array.isArray(body?.messages)) {
    const last = body.messages.at(-1);
    if (last?.role !== 'tool') return null;
    for (let i = body.messages.length - 2; i >= 0; i--) {
      const m = body.messages[i];
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
        const hit = m.tool_calls.find((c) => c.id === last.tool_call_id);
        if (hit) return hit.function?.name || null;
      }
    }
    return null;
  }
  if (Array.isArray(body?.input)) {
    const last = body.input.at(-1);
    if (last?.type !== 'function_call_output') return null;
    for (let i = body.input.length - 2; i >= 0; i--) {
      const it = body.input[i];
      if (it?.type === 'function_call' && (it.call_id || it.id) === last.call_id) return it.name || null;
    }
    return null;
  }
  return null;
}

function maybeSynthesizeTextToolCall(adapter, body, result) {
  const cfg = adapter.limits?.textToTool;
  if (!cfg?.tool) return result;
  if (result.message?.tool_calls?.length || result.message?.function_call) return result;
  const text = String(result.text || '').trim();
  if (!text) return result;

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const offered = tools.some((t) => (t?.function?.name || t?.name) === cfg.tool);
  if (!offered) return result;
  if (lastToolResultName(body) === cfg.tool) return result;

  const max = Number.isInteger(cfg.maxChars) && cfg.maxChars > 0 ? cfg.maxChars : 400;
  const script = text.length > max ? text.slice(0, max) + '…' : text;
  const args = { [cfg.argument || 'script']: script };
  const call = {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: cfg.tool, arguments: JSON.stringify(args) },
  };
  return {
    ...result,
    text: '',
    message: { role: 'assistant', content: null, tool_calls: [call] },
    finishReason: 'tool_calls',
    apxDegraded: [...(result.apxDegraded || []), `text_to_tool:${cfg.tool}`],
  };
}

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
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 伪流式：上游只能一次性返回时，按自然吐字节奏回放，并在响应头标注降级。 */
async function pseudoStream(res, { text, message, finishReason = 'stop', model, degraded = [], chunkSize = 24, delayMs = 30 }) {
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-apx-degraded': 'pseudo-stream',
    ...(degraded.length ? { 'x-apx-trimmed': degraded.join(',') } : {}),
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

/** 有界背压：客户端读得慢时等 drain，避免把整条流堆进内存。 */
function waitForDrain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/**
 * 真流式透传：二进制安全、逐块写出、不缓冲。
 * 客户端断开 → 立刻取消上游读取（不然上游继续生成，继续烧额度）。
 */
async function pipeUpstreamStream(res, { stream, abort, touch, pause, resume, timedOut, degraded = [], stats }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-apx-stream': 'passthrough',
    ...(degraded.length ? { 'x-apx-trimmed': degraded.join(',') } : {}),
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
      touch?.();
      if (firstChunkAt === null) firstChunkAt = Date.now();
      const buf = Buffer.from(value);
      tail = (tail + buf.toString('latin1')).slice(-80);
      if (tail.includes('[DONE]')) sawDone = true;
      const ok = res.write(buf); // Node 的 write 会立即 flush 到 socket
      if (!ok) {
        // 客户端慢：先暂停「上游空闲超时」，等 drain 再恢复——
        // 否则会把「下游读得慢」误判成「上游不吐数据」并取消一个健康的上游。
        pause?.();
        await waitForDrain(res);
        resume?.();
      }
    }
    if (!closed) {
      // 有的上游结尾不发 [DONE]，客户端会一直等
      if (!sawDone) res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    if (!closed) {
      const timeout = timedOut?.() || null;
      const code = timeout ? 'apx_upstream_timeout' : 'apx_stream_error';
      res.write(`data: ${JSON.stringify({ error: { message: String(err.message || err), type: 'apx_error', code } })}\n\n`);
      res.end();
    }
  } finally {
    abort?.();
    stats.streams++;
    if (firstChunkAt) stats.ttfts.push(firstChunkAt - stats.lastStreamStart);
    if (stats.ttfts.length > 200) stats.ttfts.shift();
  }
}

/** Responses 的 content 数组 → 文本。无法映射的类型显式记入 unsupported，不静默丢。 */
function responsesContentToText(content, where, unsupported) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  content.forEach((p, i) => {
    if (typeof p === 'string') {
      parts.push(p);
      return;
    }
    const type = p?.type;
    if (type === 'input_text' || type === 'output_text' || type === 'text' || typeof p?.text === 'string') {
      parts.push(p.text ?? '');
      return;
    }
    unsupported.push(`${where}.content[${i}].type=${type || 'unknown'}`);
  });
  return parts.join('');
}

/**
 * Responses API 的 input → Chat messages。
 *
 * 工具项必须还原成 Chat 的 assistant.tool_calls / role=tool，否则多轮工具调用会断链：
 * 下游把 function_call_output 发回来，上游却看不到之前那次调用，模型就会重复调工具。
 */
function responsesToMessages(body, unsupported = []) {
  const messages = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    input.forEach((item, i) => {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
        return;
      }
      if (!item || typeof item !== 'object') {
        unsupported.push(`input[${i}]`);
        return;
      }

      const type = item.type || (item.role ? 'message' : null);
      if (type === 'function_call') {
        const call = {
          id: item.call_id || item.id || `call_${i}`,
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        };
        const last = messages.at(-1);
        if (last?.role === 'assistant') {
          last.tool_calls ||= [];
          last.tool_calls.push(call);
          if (last.content === undefined) last.content = null;
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        }
        return;
      }
      if (type === 'function_call_output') {
        const callId = item.call_id || item.id || '';
        if (!callId) {
          unsupported.push(`input[${i}].call_id`);
          return;
        }
        let output = item.output;
        if (Array.isArray(output)) output = responsesContentToText(output, `input[${i}].output`, unsupported);
        else if (typeof output !== 'string') output = output == null ? '' : JSON.stringify(output);
        messages.push({ role: 'tool', tool_call_id: callId, content: output });
        return;
      }
      if (type === 'message' || item.role) {
        // Chat 的 developer 角色在部分上游不存在；developer 的语义就是 system。
        const role = item.role === 'developer' ? 'system' : item.role || 'user';
        const content = responsesContentToText(item.content, `input[${i}]`, unsupported);
        if (content) messages.push({ role, content });
        return;
      }
      // reasoning / item_reference / computer_call 等：没有 Chat 同构字段，显式拒绝。
      unsupported.push(`input[${i}].type=${type || 'unknown'}`);
    });
  } else if (input !== undefined) {
    unsupported.push('input');
  }
  return messages;
}

/** Responses 的 tools（扁平 {type,name,...}）→ Chat 的 tools（{type,function:{...}}）。 */
function responsesToolsToChat(tools, unsupported) {
  const out = [];
  tools.forEach((t, i) => {
    if (!t || t.type !== 'function' || !t.name) {
      unsupported.push(`tools[${i}].type=${t?.type || 'unknown'}`);
      return;
    }
    const fn = { name: t.name };
    if (t.description !== undefined) fn.description = t.description;
    if (t.parameters !== undefined) fn.parameters = t.parameters;
    if (t.strict !== undefined) fn.strict = t.strict;
    out.push({ type: 'function', function: fn });
  });
  return out;
}

function responsesToolChoiceToChat(choice, unsupported) {
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    unsupported.push(`tool_choice=${choice}`);
    return undefined;
  }
  if (choice && typeof choice === 'object' && choice.type === 'function' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  unsupported.push('tool_choice');
  return undefined;
}

function responsesUsage(usage) {
  // 很多客户端会把 usage 当必填对象解析；缺字段比 0 更容易触发"响应格式不兼容"。
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
  };
}

/** 把上游 assistant message 拆成 Responses 的 output items（message / function_call）。 */
function responsesOutputItems({ id, message, text }) {
  const items = [];
  const contentText =
    typeof message?.content === 'string'
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
        : typeof text === 'string'
          ? text
          : '';
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  // 纯工具调用时 Responses 只回 function_call；普通回答保持至少一个 message item。
  if (contentText || toolCalls.length === 0) {
    items.push({
      type: 'message',
      id: `msg_${id.slice(5, 29)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: contentText, annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    items.push({
      type: 'function_call',
      id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      // call_id 必须沿用上游给的值：下一轮 function_call_output 靠它配对。
      call_id: call.id || `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: call.function?.name || '',
      arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
      status: 'completed',
    });
  }
  return { items, outputText: responsesOutputText(items) };
}

function responsesOutputText(items) {
  return items
    .filter((it) => it.type === 'message')
    .map((it) => it.content.map((c) => c.text).join(''))
    .join('');
}

function buildResponsesPayload({
  id,
  created,
  model,
  message,
  text,
  usage,
  adapterId,
  estimated,
  instructions = null,
  temperature = null,
  topP = null,
  tools = [],
  toolChoice = 'auto',
  parallelToolCalls = true,
  degraded = [],
  // 流式回放时传入同一份 items，保证 response.completed 里的 item id
  // 与前面 output_item.added / done 事件完全一致（客户端靠 id 配对）。
  outputItems = null,
}) {
  const { items, outputText } = Array.isArray(outputItems)
    ? { items: outputItems, outputText: responsesOutputText(outputItems) }
    : responsesOutputItems({ id, message, text });
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
    output: items,
    output_text: outputText,
    parallel_tool_calls: parallelToolCalls,
    temperature,
    tool_choice: toolChoice,
    tools,
    top_p: topP,
    usage: responsesUsage(usage),
    apx: { adapter: adapterId, usage_estimated: Boolean(estimated), degraded },
  };
}

/**
 * Responses API 的流式事件。
 * 上游若只有非流式端点，这里按事件序列回放并标注 pseudo-stream——
 * 不假装上游原生支持增量，但保证客户端能拿到 output_text.delta / function_call_arguments.delta。
 */
async function responsesPseudoStream(res, {
  model,
  message,
  text,
  usage,
  adapterId,
  instructions = null,
  temperature = null,
  topP = null,
  tools = [],
  toolChoice = 'auto',
  parallelToolCalls = true,
  degraded = [],
  chunkSize = 24,
  delayMs = 30,
}) {
  const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-apx-degraded': 'pseudo-stream',
    ...(degraded.length ? { 'x-apx-trimmed': degraded.join(',') } : {}),
  });
  let seq = 0;
  const emit = (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: seq++ })}\n\n`);
  };
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  // 严格客户端（Coopanion 的 NativeResponseAssembly）要求**每个带 response 的事件**
  // 都有 output 数组，包括 response.created。少了它会在第一个事件就抛
  // "Invalid native Responses resource"——即使后续事件完全正确。
  emit({
    type: 'response.created',
    response: { id, object: 'response', created_at: created, status: 'in_progress', model, output: [] },
  });

  const { items } = responsesOutputItems({ id, message, text });
  for (let outputIndex = 0; outputIndex < items.length; outputIndex++) {
    const item = items[outputIndex];
    if (closed) return;

    if (item.type === 'message') {
      const msgId = item.id;
      const full = item.content[0]?.text || '';
      emit({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
      emit({ type: 'response.content_part.added', item_id: msgId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      for (let i = 0; i < full.length; i += chunkSize) {
        if (closed) return;
        emit({ type: 'response.output_text.delta', item_id: msgId, output_index: outputIndex, content_index: 0, delta: full.slice(i, i + chunkSize) });
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (closed) return;
      emit({ type: 'response.output_text.done', item_id: msgId, output_index: outputIndex, content_index: 0, text: full });
      emit({ type: 'response.content_part.done', item_id: msgId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: full, annotations: [] } });
      emit({ type: 'response.output_item.done', output_index: outputIndex, item });
      continue;
    }

    if (item.type === 'function_call') {
      const args = item.arguments || '';
      emit({ type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress', arguments: '' } });
      for (let i = 0; i < args.length; i += chunkSize) {
        if (closed) return;
        emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: args.slice(i, i + chunkSize) });
        await new Promise((r) => setTimeout(r, delayMs));
      }
      if (closed) return;
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: args });
      emit({ type: 'response.output_item.done', output_index: outputIndex, item });
    }
  }
  if (closed) return;

  emit({
    type: 'response.completed',
    response: buildResponsesPayload({
      id,
      created,
      model,
      message,
      text,
      usage,
      adapterId,
      estimated: true,
      instructions,
      temperature,
      topP,
      tools,
      toolChoice,
      parallelToolCalls,
      degraded,
      outputItems: items,
    }),
  });
  res.end();
}

export function createProxyServer({ host = '127.0.0.1', token, translator, adapter, getCatalog, credentials, authEnabled = true, limiter = createLimiter() }) {
  const stats = {
    startedAt: Date.now(),
    requests: 0,
    errors: 0,
    streams: 0,
    latencies: [],
    ttfts: [],
    lastStreamStart: 0,
    byCode: {},
    // 最近请求环形缓冲：给控制台定位「下游说格式不兼容」这类问题用。
    recent: [],
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
      const ms = Date.now() - t0;
      stats.latencies.push(ms);
      if (stats.latencies.length > 500) stats.latencies.shift();
      stats.recent.push({
        at: new Date().toISOString(),
        method: req.method,
        path: url.pathname,
        status,
        ms,
        model: req.apx?.model ?? null,
        stream: Boolean(req.apx?.stream),
        inputChars: req.apx?.inputChars ?? null,
        messages: req.apx?.messages ?? null,
        tools: req.apx?.tools ?? null,
        code: req.apx?.code ?? null,
      });
      if (stats.recent.length > 50) stats.recent.shift();
    };

    // 客户端断开（Coopanion 的“抢占/取消”、用户关客户端）必须传到上游：
    // 否则非流式请求会继续占着 Ollama 的唯一槽位，下一轮看起来像“没输出”。
    const clientAbort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) clientAbort.abort();
    });

    let slot = null;
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
          concurrency: limiter.stats(),
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
          req.apx = { code: 'apx_bad_json' };
          done(400);
          return sendError(res, 400, { code: 'apx_bad_json', message: '请求体不是合法 JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          req.apx = { code: 'apx_bad_request' };
          done(400);
          return sendError(res, 400, { code: 'apx_bad_request', message: '请求体必须是 JSON 对象', param: 'body' });
        }
        req.apx = {
          model: body.model ?? null,
          stream: Boolean(body.stream),
          inputChars: raw.length,
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
        };
        if (!Array.isArray(body.messages) || !body.messages.length) {
          req.apx.code = 'apx_bad_request';
          done(400);
          return sendError(res, 400, { code: 'apx_bad_request', message: 'messages 不能为空', param: 'messages' });
        }

        // 只有真正会打上游的请求才占并发槽；校验失败不排队。
        slot = await limiter.acquire();

        if (body.stream) {
          stats.lastStreamStart = Date.now();
          const s = await translator.openStream(body, { signal: clientAbort.signal });
          if (s.error) {
            req.apx.code = s.error.code || null;
            done(s.error.status);
            if (s.error.clientAborted) return;
            return sendError(res, s.error.status, s.error);
          }
          if (s.stream) {
            done(200);
            return await pipeUpstreamStream(res, {
              stream: s.stream,
              abort: s.abort,
              touch: s.touch,
              pause: s.pause,
              resume: s.resume,
              timedOut: s.timedOut,
              degraded: s.degraded || [],
              stats,
            });
          }
          // 上游不支持真流式 → 先取完整结果，再伪流式回放
        }

        let result = await translator.chat(body, { signal: clientAbort.signal });
        if (result.error) {
          req.apx.code = result.error.code || null;
          done(result.error.status);
          if (result.error.clientAborted) return;
          return sendError(res, result.error.status, result.error);
        }
        result = maybeSynthesizeTextToolCall(adapter, body, result);

        if (body.stream) {
          done(200);
          // 上游已经返回完整结果，伪流式只是在本地回放；提前还槽，
          // 避免慢客户端占着上游并发名额。
          if (slot) {
            slot.release();
            slot = null;
          }
          return await pseudoStream(res, {
            text: result.text,
            message: result.message,
            finishReason: result.finishReason || 'stop',
            model: body.model,
            degraded: result.apxDegraded || [],
          });
        }

        done(200);
        const message = assistantMessage(result);
        // OpenAI 的 ChatCompletionMessage 带 refusal（可为 null），部分严格客户端会按 schema 校验。
        if (!('refusal' in message)) message.refusal = null;
        return sendJson(res, 200, {
          id: newCompletionId(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          // logprobs 是官方 schema 里的必填可空字段；缺了它，严格解析器会判"格式不兼容"。
          choices: [{ index: 0, message, logprobs: null, finish_reason: result.finishReason || 'stop' }],
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
          req.apx = { code: 'apx_bad_json' };
          done(400);
          return sendError(res, 400, { code: 'apx_bad_json', message: '请求体不是合法 JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          req.apx = { code: 'apx_bad_request' };
          done(400);
          return sendError(res, 400, { code: 'apx_bad_request', message: '请求体必须是 JSON 对象', param: 'body' });
        }
        req.apx = {
          model: body.model ?? null,
          stream: Boolean(body.stream),
          inputChars: raw.length,
          messages: Array.isArray(body.input) ? body.input.length : 1,
          tools: Array.isArray(body.tools) ? body.tools.length : 0,
        };
        // 先做完整校验再发上游：静默丢掉工具字段会让 agent 拿残缺上下文，
        // 比直接 400 更难排查。
        const unsupported = [];
        const messages = responsesToMessages(body, unsupported);
        if (body.previous_response_id) unsupported.push('previous_response_id');

        let chatTools;
        if (body.tools !== undefined) {
          if (Array.isArray(body.tools)) chatTools = responsesToolsToChat(body.tools, unsupported);
          else unsupported.push('tools');
        }
        let chatToolChoice;
        if (body.tool_choice !== undefined) chatToolChoice = responsesToolChoiceToChat(body.tool_choice, unsupported);

        if (unsupported.length) {
          req.apx.code = 'apx_unsupported_field';
          done(400);
          return sendError(res, 400, {
            code: 'apx_unsupported_field',
            param: unsupported[0],
            message: `Responses API 暂不支持：${unsupported.join(', ')}。这是显式拒绝，不是静默忽略。`,
          });
        }
        if (!messages.length) {
          req.apx.code = 'apx_bad_request';
          done(400);
          return sendError(res, 400, {
            code: 'apx_bad_request',
            param: 'input',
            message: 'input 不能为空（支持字符串，或 message / function_call / function_call_output 数组）',
          });
        }

        slot = await limiter.acquire();

        const chatBody = { model: body.model, messages, stream: false, max_tokens: body.max_output_tokens };
        for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'user']) {
          if (body[k] !== undefined) chatBody[k] = body[k];
        }
        if (chatTools?.length) chatBody.tools = chatTools;
        if (chatToolChoice !== undefined) chatBody.tool_choice = chatToolChoice;
        if (body.parallel_tool_calls !== undefined) chatBody.parallel_tool_calls = body.parallel_tool_calls;
        // effort=none 等同于“不思考”，没必要给上游塞 reasoning_effort：
        // 有些模型（如 qwen2.5:0.5b）看到这个字段会直接 400 does not support thinking。
        if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort && body.reasoning.effort !== 'none') {
          chatBody.reasoning_effort = body.reasoning.effort;
        }

        let result = await translator.chat(chatBody, { signal: clientAbort.signal });
        if (result.error) {
          req.apx.code = result.error.code || null;
          done(result.error.status);
          if (result.error.clientAborted) return;
          return sendError(res, result.error.status, result.error);
        }
        result = maybeSynthesizeTextToolCall(adapter, body, result);

        const id = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const created = Math.floor(Date.now() / 1000);
        const responseTools = Array.isArray(body.tools) ? body.tools : [];
        const responseToolChoice = body.tool_choice ?? 'auto';
        const parallelToolCalls = body.parallel_tool_calls ?? true;
        const common = {
          model: body.model,
          message: result.message,
          text: result.text,
          usage: result.usage,
          adapterId: adapter.id,
          instructions: typeof body.instructions === 'string' ? body.instructions : null,
          temperature: body.temperature ?? null,
          topP: body.top_p ?? null,
          tools: responseTools,
          toolChoice: responseToolChoice,
          parallelToolCalls,
          degraded: result.apxDegraded || [],
        };

        if (body.stream) {
          done(200);
          if (slot) {
            slot.release();
            slot = null;
          }
          return await responsesPseudoStream(res, common);
        }

        done(200);
        return sendJson(res, 200, buildResponsesPayload({ id, created, estimated: result.usageEstimated, ...common }));
      }

      if (url.pathname.startsWith('/v1/')) {
        req.apx = { ...(req.apx || {}), code: 'apx_unsupported_endpoint' };
        done(501);
        return sendError(res, 501, {
          code: 'apx_unsupported_endpoint',
          message: `未实现该端点：${url.pathname}。当前支持 GET /v1/models、POST /v1/chat/completions、POST /v1/responses、GET /health。`,
        });
      }

      done(404);
      return sendError(res, 404, { code: 'apx_not_found', message: '未找到该路径' });
    } catch (err) {
      // 队列满/排队超时：快速失败，让客户端退避，而不是让它等一个必然超时的请求。
      if (err?.code === 'apx_queue_full' || err?.code === 'apx_queue_timeout') {
        req.apx = { ...(req.apx || {}), code: err.code };
        done(err.status || 503);
        return sendError(res, err.status || 503, err);
      }
      // 客户端主动断开（语音打断 / Ctrl+C）会在这里冒出来，不算服务端错误
      if (res.destroyed || /aborted|ECONNRESET/i.test(String(err.message))) return;
      done(500);
      return sendError(res, 500, { code: 'apx_internal_error', message: String(err.message || err) });
    } finally {
      // 流式路径已 return await，槽位会一直占到流结束/断开。
      if (slot) slot.release();
    }
  });

  server.stats = stats;
  server.limiter = limiter;
  return server;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
