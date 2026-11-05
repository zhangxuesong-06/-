// translator 单元测试：能力声明必须在流式路径同样生效，直通响应不得丢字段。
//
// 这里不启动代理进程，只测 translator 本身：
//   1) 声明 tools:false 的适配器，流式请求带 tools 必须在**触达上游之前** 400；
//   2) 声明 tools:true 时 tools 原样到达上游；
//   3) 直通型上游返回 content:null + tool_calls 时，message 与 finish_reason 原样返回；
//   4) 200 但既没文本也没工具调用 → 502 形状错误（而不是回一个空回答）。
import './_isolate-state.mjs';
import http from 'node:http';
import { createTranslator } from '../src/adapters/translator.mjs';
import { createCredentialProvider } from '../src/security/credentials.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const seen = [];
const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } };

function startFakeUpstream() {
  return http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push(body);
        if (body.reasoning_effort) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: '"fake-1" does not support thinking' } }));
        }
        const mode = body.messages?.at(-1)?.content || '';
        if (mode === 'slow') {
          setTimeout(() => {
            if (res.writableEnded || res.destroyed) return;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }] }));
          }, 300);
          return;
        }
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        if (mode === 'empty') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }] }));
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [TOOL_CALL], reasoning_content: 'think' }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
}

function makeTranslator(baseUrl, { tools, streaming = true, limits }) {
  const adapter = {
    id: 'unit-adapter',
    serviceFace: { type: 'openai-passthrough' },
    ...(limits ? { limits } : {}),
    upstream: {
      auth: { kind: 'none' },
      listModels: { path: '/v1/models', items: '$.data' },
      generate: { path: '/v1/chat/completions', textPath: '$.choices[0].message.content' },
      requestHooks: [],
    },
    capabilities: { streaming, tools },
    sessionPolicy: 'stateless',
  };
  return createTranslator({
    adapter,
    ctx: {
      baseUrl,
      credentials: createCredentialProvider({ kind: 'none' }),
      resolveModel: () => ({ alias: 'fake-1', upstreamId: 'fake-1', provider: null }),
    },
  });
}

async function main() {
  console.log('== translator：能力校验 / tool_calls 保真 ==');
  const upstream = startFakeUpstream();
  const port = await listen(upstream);
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log('\n[1] 流式路径必须执行能力校验');
  {
    const t = makeTranslator(baseUrl, { tools: false, streaming: true });
    const before = seen.length;
    const r = await t.openStream({
      model: 'fake-1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      stream: true,
    });
    check('返回 400 apx_unsupported_field', r.error?.status === 400 && r.error?.code === 'apx_unsupported_field', JSON.stringify(r.error));
    check('param 指向 tools', r.error?.param === 'tools', String(r.error?.param));
    check('没有触达上游（不把不支持的字段塞过去）', seen.length === before, `上游请求数 ${seen.length - before}`);
  }

  console.log('\n[2] 声明支持时 tools 原样到达上游');
  {
    const t = makeTranslator(baseUrl, { tools: true, streaming: true });
    const r = await t.openStream({
      model: 'fake-1',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      stream: true,
    });
    check('返回流', Boolean(r.stream), JSON.stringify(r).slice(0, 160));
    check('上游收到 tools', Array.isArray(seen.at(-1)?.tools) && seen.at(-1).tools.length === 1, JSON.stringify(seen.at(-1)?.tools));
    check('上游收到 stream:true', seen.at(-1)?.stream === true, String(seen.at(-1)?.stream));
    if (r.stream) {
      const reader = r.stream.getReader();
      await reader.cancel();
    }
  }

  console.log('\n[3] 非流式直通保留 message 全字段');
  {
    const t = makeTranslator(baseUrl, { tools: true });
    const r = await t.chat({ model: 'fake-1', messages: [{ role: 'user', content: 'hi' }] });
    check('text 为空字符串（content:null）', r.text === '', JSON.stringify(r.text));
    check('finishReason = tool_calls', r.finishReason === 'tool_calls', String(r.finishReason));
    check('tool_calls 原样保留', r.message?.tool_calls?.[0]?.id === 'call_1' && r.message?.tool_calls?.[0]?.function?.name === 'get_weather', JSON.stringify(r.message));
    check('未识别的非标字段也不丢', r.message?.reasoning_content === 'think', JSON.stringify(r.message));
  }

  console.log('\n[4] 200 但既无文本也无工具 → 形状错误');
  {
    const t = makeTranslator(baseUrl, { tools: true });
    const r = await t.chat({ model: 'fake-1', messages: [{ role: 'user', content: 'empty' }] });
    check('返回 502 apx_upstream_shape_mismatch', r.error?.status === 502 && r.error?.code === 'apx_upstream_shape_mismatch', JSON.stringify(r.error));
  }

  console.log('\n[5] 非流式硬超时 → 504 apx_upstream_timeout');
  {
    const t = makeTranslator(baseUrl, { tools: true, limits: { requestTimeoutMs: 60 } });
    const r = await t.chat({ model: 'fake-1', messages: [{ role: 'user', content: 'slow' }] });
    check('超时状态是 504（不是 500/502）', r.error?.status === 504, JSON.stringify(r.error));
    check('code=apx_upstream_timeout', r.error?.code === 'apx_upstream_timeout', JSON.stringify(r.error));
  }

  console.log('\n[6] 流式首字节超时 → 504 apx_upstream_timeout');
  {
    const t = makeTranslator(baseUrl, { tools: true, limits: { streamFirstByteTimeoutMs: 60 } });
    const r = await t.openStream({ model: 'fake-1', messages: [{ role: 'user', content: 'slow' }], stream: true });
    check('首字节超时返回 504', r.error?.status === 504, JSON.stringify(r.error));
    check('code=apx_upstream_timeout', r.error?.code === 'apx_upstream_timeout', JSON.stringify(r.error));
  }

  console.log('\n[7] 非推理模型拒绝 reasoning_effort → 去掉字段重试一次');
  {
    const t = makeTranslator(baseUrl, { tools: true });
    const before = seen.length;
    const r = await t.chat({ model: 'fake-1', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'medium' });
    check('重试后成功返回', Boolean(r.message), JSON.stringify(r).slice(0, 200));
    check('上游被请求两次', seen.length - before === 2, `实际 ${seen.length - before}`);
    check('第二次请求不再带 reasoning_effort', !('reasoning_effort' in (seen.at(-1) || {})), JSON.stringify(seen.at(-1)));
    check('如实标注降级 reasoning_effort', (r.apxDegraded || []).includes('reasoning_effort'), JSON.stringify(r.apxDegraded));
  }

  upstream.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
