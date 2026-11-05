// Translator：把上游形态翻译成 OpenAI 语义。
// 两条硬规则（来自实战教训）：
//  1) 凭证每请求现取，401 时强制重读一次再重放（仅非流式）；
//  2) 流式绝不"先读完再转发"，必须边读边写、逐块 flush。
import { createHash, randomUUID } from 'node:crypto';
import { authHeaders, SESSION_UUID } from '../security/credentials.mjs';

/** 取 JSON 路径，支持 $.a.b、$.a[].b、$.a[0].b。 */
export function getPath(obj, expr) {
  if (!expr || expr === '$') return obj;
  const parts = String(expr).replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    const arr = part.match(/^(\w+)\[\]$/);
    if (arr) {
      cur = cur[arr[1]];
      if (!Array.isArray(cur)) return undefined;
      continue;
    }
    const idx = part.match(/^(\w+)\[(\d+)\]$/);
    if (idx) {
      cur = cur[idx[1]];
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[2])];
      continue;
    }
    cur = cur[part];
  }
  return cur;
}

/** 把 messages 压平成单个 prompt（stateless 策略：不污染用户正在用的会话）。 */
export function flattenMessages(messages = []) {
  const lines = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;
    else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((part) => (part?.type === 'text' ? part.text : part?.type === 'image_url' ? '[image omitted]' : ''))
        .filter(Boolean)
        .join('\n');
    }
    if (text) lines.push(`[${role}] ${text} [/${role}]`);
  }
  return lines.join('\n\n');
}

function detectUnsupported(body, caps = {}) {
  const bad = [];
  if (body.tools?.length && !caps.tools) bad.push('tools');
  if (body.tool_choice && !caps.tools) bad.push('tool_choice');
  if (body.response_format && body.response_format.type !== 'text' && !caps.responseFormat) bad.push('response_format');
  if (body.n && body.n > 1) bad.push('n');
  if (body.logprobs && !caps.logprobs) bad.push('logprobs');
  return bad;
}

function estimateTokens(text) {
  return Math.max(1, Math.round(String(text || '').length / 2.2));
}

/**
 * 解析 Retry-After 响应头（RFC 7231 允许两种形式：纯秒数 / HTTP-date）。
 * 统一折算成毫秒；解析不了返回 null（不猜）。
 */
export function parseRetryAfter(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, ts - Date.now());
}

function interpolate(str, vars) {
  return String(str).replace(/\$\{([\w.]+)\}/g, (_, name) => {
    const got = name.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
    return got == null ? '' : String(got);
  });
}

/** 声明式请求体构造：{"prompt":"${prompt}","model.id":"${model.upstreamId}"} */
function buildBody(spec, vars) {
  const out = {};
  for (const [k, v] of Object.entries(spec || {})) {
    const value = typeof v === 'string' ? interpolate(v, vars) : v;
    const segs = k.split('.');
    let cur = out;
    for (let i = 0; i < segs.length - 1; i++) {
      cur[segs[i]] ||= {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }
  return out;
}

/** request_hooks：只补默认值，绝不覆盖调用方显式传入的参数。 */
function applyHooks(body, hooks = []) {
  let changed = false;
  for (const hook of hooks) {
    const set = hook.json_set;
    if (!set) continue;
    if (set.if_model_prefix && !String(body.model || '').startsWith(set.if_model_prefix)) continue;
    if (set.only_if_absent && body[set.key] !== undefined) continue;
    body[set.key] = set.value;
    changed = true;
  }
  return changed;
}

export function createTranslator({ adapter, ctx, onEvent = () => {} }) {
  const face = adapter.serviceFace || {};
  const upstream = adapter.upstream || {};
  const caps = adapter.capabilities || {};
  const hooks = upstream.requestHooks || [];
  const limits = adapter.limits || {};
  const positive = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const requestTimeoutMs = positive(limits.requestTimeoutMs, 120000);
  const firstByteTimeoutMs = positive(limits.streamFirstByteTimeoutMs, 60000);
  const streamIdleTimeoutMs = positive(limits.streamIdleTimeoutMs, 120000);

  async function buildHeaders(extra = {}) {
    const cred = await ctx.credentials.get();
    const tmpl = upstream.headers || {};
    const rendered = {};
    for (const [k, v] of Object.entries(tmpl)) rendered[k] = interpolate(v, { sessionUuid: SESSION_UUID });
    return {
      'content-type': 'application/json',
      // 主动要求不压缩：省掉解压逻辑，也让 chunk 边界简单
      'accept-encoding': 'identity',
      ...rendered,
      ...authHeaders(cred),
      ...extra,
    };
  }

  async function requestOnce(pathname, { method = 'GET', body, timeout = requestTimeoutMs, signal } = {}) {
    const ctrl = new AbortController();
    let timedOut = false;
    let clientAborted = Boolean(signal?.aborted);
    const onClientAbort = () => {
      clientAborted = true;
      ctrl.abort();
    };
    if (signal && !signal.aborted) signal.addEventListener('abort', onClientAbort, { once: true });
    if (clientAborted) ctrl.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeout);
    try {
      const res = await fetch(`${ctx.baseUrl}${pathname}`, {
        method,
        headers: await buildHeaders(),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* 上游可能返回非 JSON */
      }
      return { status: res.status, json, text, contentType: res.headers.get('content-type') || '', retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
    } catch (e) {
      // 超时和「连接被拒」要分开：前者 504，后者 502。
      return {
        status: 0,
        json: null,
        text: timedOut ? `上游超时（>${timeout}ms）` : String(e.message || e),
        contentType: '',
        retryAfterMs: null,
        transportError: true,
        timeout: timedOut,
        clientAborted,
      };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onClientAbort);
    }
  }

  /** 401 → 让凭证提供者强制重读 → 重放一次。这是"凭证被宿主刷新"场景的关键。 */
  async function request(pathname, opts = {}) {
    let r;
    try {
      r = await requestOnce(pathname, opts);
    } catch (e) {
      // 连响应都没有（超时 / 连接被拒 / 连接被重置）：交给 upstreamError 归一到 502
      return { status: 0, json: null, text: String(e.message || e), contentType: '', retryAfterMs: null, transportError: true, clientAborted: Boolean(opts.signal?.aborted) };
    }
    if (r.status === 401 && ctx.credentials.kind !== 'none') {
      onEvent('[apx] 上游 401，重读凭证后重放一次');
      ctx.credentials.invalidate();
      try {
        r = await requestOnce(pathname, opts);
      } catch (e) {
        return { status: 0, json: null, text: String(e.message || e), contentType: '', retryAfterMs: null, transportError: true, clientAborted: Boolean(opts.signal?.aborted) };
      }
    }
    return r;
  }

  async function listModels() {
    const spec = upstream.listModels || { path: '/v1/models', items: '$.data' };
    const r = await request(spec.path);
    if (r.status !== 200 || !r.json) return { models: [], error: upstreamError(r) };
    const items = getPath(r.json, spec.items || '$.data') || [];
    const f = spec.fields || { id: 'id', provider: 'providerID', displayName: 'name' };
    const models = items
      .map((m) => {
        const id = spec.fields ? getPath(m, `$.${f.id}`) : m.id;
        if (!id) return null;
        const provider = f.provider ? getPath(m, `$.${f.provider}`) : null;
        return {
          alias: provider ? `${provider}/${id}` : id,
          upstreamId: id,
          provider,
          displayName: (f.displayName && getPath(m, `$.${f.displayName}`)) || id,
          capabilities: m.capabilities || null,
          source: 'upstream',
        };
      })
      .filter(Boolean);
    return { models };
  }

  async function chat(body, { signal } = {}) {
    const unsupported = detectUnsupported(body, caps);
    if (unsupported.length) {
      return {
        error: {
          status: 400,
          code: 'apx_unsupported_field',
          param: unsupported[0],
          message: `适配器 ${adapter.id} 不支持字段：${unsupported.join(', ')}。这是显式拒绝，不是静默忽略。`,
        },
      };
    }

    const resolved = ctx.resolveModel(body.model);
    if (!resolved) {
      return {
        error: {
          status: 404,
          code: 'apx_model_not_found',
          param: 'model',
          message: `模型 ${body.model} 不在清单中。下游配置里的 model 必须与 GET /v1/models 返回的 id 完全一致。`,
        },
      };
    }

    const prompt = flattenMessages(body.messages);
    const spec = upstream.generate || {};

    // 直通型：上游本身就是 OpenAI 形状，原样转发（保留 tools/temperature 等全部参数）
    if (face.type === 'openai-passthrough') {
      const passthroughBody = { ...body, model: resolved.upstreamId, stream: false };
      applyHooks(passthroughBody, hooks);
      let r = await request(spec.path || '/v1/chat/completions', { method: 'POST', body: passthroughBody, signal });
      let strippedReasoning = false;
      // 非推理模型（如 qwen2.5:0.5b）看到 reasoning_effort 会直接 400。
      // 只在这种明确的“不支持思考”错误上退一步：去掉该字段重试一次，并如实标注降级。
      if (
        r.status === 400 &&
        Object.prototype.hasOwnProperty.call(passthroughBody, 'reasoning_effort') &&
        /thinking|reasoning/i.test(String(r.text || ''))
      ) {
        const retryBody = { ...passthroughBody };
        delete retryBody.reasoning_effort;
        r = await request(spec.path || '/v1/chat/completions', { method: 'POST', body: retryBody, signal });
        strippedReasoning = true;
      }
      if (r.clientAborted) return { error: { status: 499, code: 'apx_client_aborted', message: '客户端已断开，已取消上游请求', clientAborted: true } };
      if (r.status !== 200 || !r.json) return { error: upstreamError(r) };
      const choice = r.json.choices?.[0];
      const upstreamMessage = choice?.message;
      const text = getPath(r.json, spec.textPath || '$.choices[0].message.content');
      const toolCalls = Array.isArray(upstreamMessage?.tool_calls) ? upstreamMessage.tool_calls : [];
      const legacyCall = upstreamMessage?.function_call && typeof upstreamMessage.function_call === 'object';
      // 工具调用时 content 合法地为 null；视觉响应可能是 content 数组。
      // 只认字符串会把整条 tool_calls / 多模态消息静默丢掉——下游会以为模型"什么都没说"。
      const contentShaped = typeof text === 'string' || Array.isArray(upstreamMessage?.content);
      if (!contentShaped && toolCalls.length === 0 && !legacyCall) {
        return { error: { status: 502, code: 'apx_upstream_shape_mismatch', message: '上游 200 但未找到文本字段，适配器可能过期' } };
      }
      return {
        text: typeof text === 'string' ? text : '',
        // 原样保留上游 message（content / tool_calls / reasoning_content / refusal …），
        // 中间层不认识的字段也不该被吞掉。
        message: upstreamMessage && typeof upstreamMessage === 'object' ? upstreamMessage : null,
        finishReason: choice?.finish_reason || (toolCalls.length ? 'tool_calls' : legacyCall ? 'function_call' : 'stop'),
        usage: r.json.usage,
        usageEstimated: false,
        apxDegraded: strippedReasoning ? ['reasoning_effort'] : [],
      };
    }

    // 声明式映射型
    const vars = { prompt, model: resolved };
    const reqBody = spec.body ? buildBody(spec.body, vars) : { prompt };
    applyHooks(reqBody, hooks);
    const r = await request(spec.path, { method: 'POST', body: reqBody, signal });
    if (r.clientAborted) return { error: { status: 499, code: 'apx_client_aborted', message: '客户端已断开，已取消上游请求', clientAborted: true } };
    if (r.status !== 200 || !r.json) return { error: upstreamError(r) };

    const text = getPath(r.json, spec.textPath || '$.data.text');
    if (typeof text !== 'string') {
      return {
        error: {
          status: 502,
          code: 'apx_upstream_shape_mismatch',
          message: `上游返回 200 但未找到文本字段 ${spec.textPath}。适配器可能已过期。`,
        },
      };
    }
    return {
      text,
      usage: {
        prompt_tokens: estimateTokens(prompt),
        completion_tokens: estimateTokens(text),
        total_tokens: estimateTokens(prompt) + estimateTokens(text),
      },
      usageEstimated: true,
      apxDegraded: ['usage_estimated'],
    };
  }

  /**
   * 原生流式：返回上游原始 Response（web stream），由 server 边读边写。
   * 只在适配器声明 streaming 能力时可用——否则宁可诚实降级为伪流式。
   */
  async function openStream(body, { signal } = {}) {
    if (!caps.streaming) return { unsupported: true };
    // 流式路径不能绕过能力校验：否则声明 tools:false 的适配器会把 tools 原样塞给上游，
    // 上游要么忽略（下游拿到残缺结果），要么报一个与真实原因无关的错。
    const unsupported = detectUnsupported(body, caps);
    if (unsupported.length) {
      return {
        error: {
          status: 400,
          code: 'apx_unsupported_field',
          param: unsupported[0],
          message: `适配器 ${adapter.id} 不支持字段：${unsupported.join(', ')}。这是显式拒绝，不是静默忽略。`,
        },
      };
    }
    const resolved = ctx.resolveModel(body.model);
    if (!resolved) {
      return {
        error: {
          status: 404,
          code: 'apx_model_not_found',
          param: 'model',
          message: `模型 ${body.model} 不在清单中。下游配置里的 model 必须与 GET /v1/models 返回的 id 完全一致。`,
        },
      };
    }
    const spec = upstream.generate || {};
    let payload;
    if (face.type === 'openai-passthrough') {
      payload = { ...body, model: resolved.upstreamId, stream: true };
    } else {
      payload = spec.body ? buildBody(spec.body, { prompt: flattenMessages(body.messages), model: resolved }) : { prompt: flattenMessages(body.messages) };
      payload.stream = true;
    }
    applyHooks(payload, hooks);

    const ctrl = new AbortController();
    let abortReason = null;
    let clientAborted = Boolean(signal?.aborted);
    const onClientAbort = () => {
      clientAborted = true;
      ctrl.abort();
    };
    if (signal && !signal.aborted) signal.addEventListener('abort', onClientAbort, { once: true });
    if (clientAborted) ctrl.abort();
    const headerTimer = setTimeout(() => {
      abortReason = 'timeout';
      ctrl.abort();
    }, firstByteTimeoutMs);
    let res;
    try {
      res = await fetch(`${ctx.baseUrl}${spec.path || '/v1/chat/completions'}`, {
        method: 'POST',
        headers: await buildHeaders({ accept: 'text/event-stream' }),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(headerTimer);
      if (signal) signal.removeEventListener('abort', onClientAbort);
      return {
        error: clientAborted
          ? { status: 499, code: 'apx_client_aborted', message: '客户端已断开，已取消上游请求', clientAborted: true }
          : upstreamError({
              status: 0,
              json: null,
              text: abortReason === 'timeout' ? `上游首字节超时（>${firstByteTimeoutMs}ms）` : String(e.message || e),
              transportError: true,
              timeout: abortReason === 'timeout',
            }),
      };
    }
    clearTimeout(headerTimer);

    if (!res.ok) {
      if (signal) signal.removeEventListener('abort', onClientAbort);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* ignore */
      }
      return { error: upstreamError({ status: res.status, json, text, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) }) };
    }

    // 首字节之后按「空闲超时」计时：上游长时间不吐新块就取消，避免连接挂死。
    // 下游背压时用 pause/resume 暂停计时，别把「客户端读得慢」误判成上游故障。
    let idleTimer = null;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortReason = 'idle-timeout';
        ctrl.abort();
      }, streamIdleTimeoutMs);
      idleTimer.unref?.();
    };
    const pause = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const resume = () => touch();
    touch();
    const abort = () => {
      clearTimeout(headerTimer);
      pause();
      if (signal) signal.removeEventListener('abort', onClientAbort);
      ctrl.abort();
    };
    return {
      stream: res.body,
      status: res.status,
      contentType: res.headers.get('content-type'),
      abort,
      touch,
      pause,
      resume,
      timedOut: () => abortReason,
    };
  }

  return { listModels, chat, openStream, request };
}

/**
 * 把上游错误翻成可区分的人话，绝不回显凭据。
 *
 * 两条规则：
 *  1) **状态码保真**：上游给的是合法 HTTP 状态（4xx/5xx）就原样透传给下游。
 *     503 是"稍后再试"、502 是"网关错了"、500 是"上游内部错"——下游 SDK 对这三者的
 *     退避策略不同，一律归一成 502 等于逼它盲猜。只有"连响应都没有"才归一到 502。
 *  2) **退避信号一起带下去**：响应头 Retry-After > 响应体 retryAfterMs > 没有。
 *     否则 SDK 拿到 429 立刻重试，继续烧上游额度。
 */
export function upstreamError(r) {
  const tag = r.json?._tag || '';
  const reason = r.json?.reason || '';
  const msg = r.json?.message || r.json?.error?.message || r.text?.slice(0, 200) || '上游无响应';
  const map = {
    rate_limit: { code: 'apx_upstream_rate_limited', hint: '上游额度或速率受限' },
    invalid_request: { code: 'apx_upstream_invalid_request', hint: '上游拒绝该请求参数' },
    provider: { code: 'apx_upstream_provider_error', hint: '上游 provider 层失败（常见于网络或代理）' },
  };

  // 有没有拿到 HTTP 响应：拿不到（超时/连接失败/连接被重置，status=0）才是"无响应"；
  // 200 但 body 不是 JSON 属于"形状不对"，不是不可达，两者不能混为一谈。
  const rawStatus = Number.isInteger(r.status) ? r.status : 0;
  const transport = Boolean(r.transportError) || rawStatus === 0;
  const timedOut = Boolean(r.timeout);
  const httpStatus = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : null;

  const hit =
    (timedOut
      ? { code: 'apx_upstream_timeout', hint: '上游超时' }
      : transport
        ? { code: 'apx_upstream_unreachable', hint: '上游不可达（连接失败或被重置）' }
        : null) ||
    map[reason] ||
    (httpStatus === 401
      ? { code: 'apx_upstream_unauthorized', hint: '上游拒绝凭证（可能已过期或被撤销）' }
      : { code: 'apx_upstream_error', hint: '上游返回错误' });

  const headerMs = Number.isFinite(r.retryAfterMs) ? Number(r.retryAfterMs) : null;
  const bodyMs = Number.isFinite(Number(r.json?.retryAfterMs)) ? Number(r.json.retryAfterMs) : null;
  const retryAfterMs = headerMs ?? bodyMs ?? null;
  // 给下游的是整秒（向上取整）：不足 1 秒也给 1，避免客户端算出 0 后立刻重试
  const retryAfter = retryAfterMs == null ? null : Math.max(1, Math.ceil(retryAfterMs / 1000));

  return {
    status: timedOut ? 504 : transport ? 502 : (httpStatus ?? 502),
    code: hit.code,
    message: `${hit.hint}：${msg}`,
    upstream: { status: rawStatus, tag, reason, retryAfterMs, retryAfter },
  };
}

export function errorEnvelope(err) {
  return {
    error: {
      message: err.message,
      type: 'apx_error',
      code: err.code,
      param: err.param ?? null,
      upstream: err.upstream ?? undefined,
    },
  };
}

export function newCompletionId() {
  return `chatcmpl-${createHash('sha1').update(randomUUID()).digest('hex').slice(0, 24)}`;
}
