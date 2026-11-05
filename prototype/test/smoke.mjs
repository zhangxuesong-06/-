// 端到端冒烟测试：假上游 + 真代理进程。
// 重点验证两件"决定生死"的事：
//   1) 流式是否真的逐块到达（首块延迟 vs 总时长），而不是先读完再吐；
//   2) 凭证是否每请求现取（轮换后无需重启），以及 401 是否触发重读重放。
import './_isolate-state.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/security/token.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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

const state = { token: 'T1', failOnce: false, hits: [], authSeen: [], lastBody: null, hangStarted: 0, hangClosed: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakeUpstream() {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    state.hits.push(req.url);
    state.authSeen.push(auth);

    const ok = auth === `Bearer ${state.token}`;
    if (!ok) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid token' } }));
    }
    if (state.failOnce && req.url === '/v1/chat/completions') {
      state.failOnce = false;
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'token rotated' } }));
    }

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1' }, { id: 'fake-2' }] }));
    }

    if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const body = JSON.parse(raw || '{}');
        state.lastBody = body;
        const lastMsg = body.messages?.at(-1)?.content || '';
        // 退避信号测试用的两个开关（只在本测试里出现，不影响正常分支）
        if (lastMsg.includes('__429_HEADER__')) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
          return res.end(JSON.stringify({ error: { message: 'rate limited' }, reason: 'rate_limit' }));
        }
        if (lastMsg.includes('__429_BODY_ONLY__')) {
          res.writeHead(429, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'quota exhausted' }, reason: 'rate_limit', retryAfterMs: 31556000 }));
        }
        if (lastMsg.includes('__503_HEADER__')) {
          res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3' });
          return res.end(JSON.stringify({ error: { message: 'service temporarily unavailable' } }));
        }
        if (lastMsg.includes('__502__')) {
          res.writeHead(502, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad gateway' } }));
        }
        if (lastMsg.includes('__CLOSE__')) {
          // 模拟"连响应都没有"：直接掐断连接（超时/连接失败的等价情形）
          req.socket.destroy();
          return;
        }
        if (lastMsg.includes('__HANG__')) {
          // 上游收到后一直不返回：用来验证“客户端断开 → 上游请求被取消”。
          state.hangStarted++;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.on('close', () => {
            state.hangClosed++;
          });
          return;
        }
        if (lastMsg.includes('__TOOL__')) {
          // 工具调用：content 合法地为 null，工具信息全在 tool_calls 里。
          const call = { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } };
          if (!body.stream) {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(
              JSON.stringify({
                id: 'x-tool',
                object: 'chat.completion',
                model: body.model,
                choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
              }),
            );
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write(
            `data: ${JSON.stringify({ id: 'x-tool', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'x-tool', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city"' } }] }, finish_reason: null }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'x-tool', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"Shanghai"}' } }] }, finish_reason: null }] })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({ id: 'x-tool', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        const text = `echo:${body.messages?.at(-1)?.content || ''}`;
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({
              id: 'x',
              object: 'chat.completion',
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
          );
        }
        // 慢速流：10 块 × 60ms ≈ 600ms，用来区分"逐块"与"缓冲后一次性吐出"
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const pieces = text.match(/.{1,4}/gu) || [text];
        for (let i = 0; i < pieces.length; i++) {
          const frame = {
            id: 'x',
            object: 'chat.completion.chunk',
            model: body.model,
            choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: pieces[i] } : { content: pieces[i] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(frame)}\n\n`);
          await new Promise((r) => setTimeout(r, 60));
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end('nope');
  });
  return server;
}

async function waitFor(fn, { timeout = 25000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-test-'));
  const tokenFile = path.join(tmp, 'token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: state.token, expires_at: null }));

  const adapterDir = path.join(tmp, 'adapters');
  fs.mkdirSync(adapterDir);
  fs.writeFileSync(
    path.join(adapterDir, 'fake-upstream.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: 'fake-upstream',
        name: '假上游（测试用）',
        version: '1.0.0',
        match: { exeNames: [], pathGlobs: [] },
        serviceFace: { type: 'openai-passthrough', portDiscovery: { strategy: 'listen-scan' } },
        upstream: {
          auth: { kind: 'file-json', path: tokenFile, field: 'token', scheme: 'bearer' },
          headers: { 'x-apx-session': '${sessionUuid}' },
          listModels: { path: '/v1/models', items: '$.data' },
          generate: { path: '/v1/chat/completions', textPath: '$.choices[0].message.content' },
          requestHooks: [],
        },
        capabilities: { streaming: true, tools: true },
        sessionPolicy: 'stateless',
      },
      null,
      2,
    ),
  );

  // 同一个假上游，但适配器声明“不支持真流式”：
  // 用来验证伪流式回放不会把非流式上游的 tool_calls 丢掉。
  fs.writeFileSync(
    path.join(adapterDir, 'fake-nostream.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: 'fake-nostream',
        name: '假上游（伪流式）',
        version: '1.0.0',
        match: { exeNames: [], pathGlobs: [] },
        serviceFace: { type: 'openai-passthrough', portDiscovery: { strategy: 'listen-scan' } },
        upstream: {
          auth: { kind: 'file-json', path: tokenFile, field: 'token', scheme: 'bearer' },
          listModels: { path: '/v1/models', items: '$.data' },
          generate: { path: '/v1/chat/completions', textPath: '$.choices[0].message.content' },
          requestHooks: [],
        },
        capabilities: { streaming: false, tools: true },
        sessionPolicy: 'stateless',
      },
      null,
      2,
    ),
  );

  const upstream = startFakeUpstream();
  const upstreamPort = await listen(upstream);
  console.log(`假上游就绪 127.0.0.1:${upstreamPort}`);

  const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.mjs'), 'serve', '--adapter', 'fake-upstream', '--upstream-port', String(upstreamPort)], {
    cwd: ROOT,
    env: { ...process.env, APX_ADAPTER_DIRS: adapterDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => (out += b.toString()));
  child.stderr.on('data', (b) => (out += b.toString()));

  const stateFile = path.join(stateDir(), 'state.json');
  const ready = await waitFor(() => {
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return st.proxyPort && st.adapterId === 'fake-upstream' ? st : null;
    } catch {
      return null;
    }
  });
  if (!ready) {
    console.log('代理未就绪，子进程输出：\n' + out);
    child.kill();
    upstream.close();
    process.exit(1);
  }
  const base = `http://127.0.0.1:${ready.proxyPort}`;
  const token = JSON.parse(fs.readFileSync(stateFile, 'utf8')).token;
  console.log(`代理就绪 ${base}（adapter=fake-upstream）\n`);

  // 等 /health 通过（模型清单可能还在首次拉取）
  await waitFor(async () => {
    const r = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
    return r.status === 200;
  });

  console.log('[1] 鉴权');
  {
    const r = await fetch(`${base}/v1/models`);
    check('无 token 返回 401', r.status === 401, `实际 ${r.status}`);
  }
  {
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local-wrong' } });
    check('错误 token 返回 401', r.status === 401, `实际 ${r.status}`);
  }

  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  console.log('[2] 模型清单');
  {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    const j = await r.json();
    check('返回 200', r.status === 200, `实际 ${r.status}`);
    check('含 fake-1', j.data?.some((m) => m.id === 'fake-1'), JSON.stringify(j).slice(0, 120));
  }

  console.log('[3] 非流式');
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const j = await r.json();
    check('返回 200', r.status === 200, `实际 ${r.status}`);
    check('内容正确', j.choices?.[0]?.message?.content === 'echo:hi', JSON.stringify(j).slice(0, 160));
    check('usage 透传', Boolean(j.usage?.total_tokens), JSON.stringify(j.usage));
    check('choices[0].logprobs 存在且为 null（官方 schema 必填可空）', j.choices?.[0]?.logprobs === null, JSON.stringify(j.choices?.[0]));
    check('message.refusal 存在且为 null', j.choices?.[0]?.message?.refusal === null, JSON.stringify(j.choices?.[0]?.message));
  }

  console.log('[3b] 工具调用：非流式直通不能丢 tool_calls');
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'fake-1',
        messages: [{ role: 'user', content: '__TOOL__' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      }),
    });
    const j = await r.json().catch(() => null);
    const call = j?.choices?.[0]?.message?.tool_calls?.[0];
    check('返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    check('content 合法地为 null', j?.choices?.[0]?.message?.content === null, JSON.stringify(j?.choices?.[0]?.message));
    check('tool_calls 被保留', Array.isArray(j?.choices?.[0]?.message?.tool_calls) && j.choices[0].message.tool_calls.length === 1, JSON.stringify(j?.choices?.[0]?.message));
    check('函数名与参数原样透传', call?.id === 'call_1' && call?.function?.name === 'get_weather' && call?.function?.arguments === '{"city":"Shanghai"}', JSON.stringify(call));
    check('finish_reason = tool_calls', j?.choices?.[0]?.finish_reason === 'tool_calls', String(j?.choices?.[0]?.finish_reason));
  }

  console.log('[3c] 工具调用：流式直通保留 tool_calls 增量');
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'fake-1',
        messages: [{ role: 'user', content: '__TOOL__' }],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        stream: true,
      }),
    });
    const text = await r.text();
    check('响应头标注 passthrough', r.headers.get('x-apx-stream') === 'passthrough', String(r.headers.get('x-apx-stream')));
    check('tool_calls 增量到达', text.includes('"tool_calls"') && text.includes('get_weather'), text.slice(0, 200));
    check('参数片段可拼接', text.includes('\\"city\\"') && text.includes('Shanghai'), text.slice(-300));
    check('finish_reason = tool_calls', text.includes('"finish_reason":"tool_calls"'), text.slice(-300));
  }

  console.log('[3d] 伪流式：非流式上游的 tool_calls 也不能丢');
  {
    // 同一个假上游 + 一个声明 streaming:false 的适配器，走 _chat() → pseudoStream 回放。
    const stateDir2 = path.join(tmp, 'state2');
    const child2 = spawn(
      process.execPath,
      [path.join(ROOT, 'src/cli.mjs'), 'serve', '--adapter', 'fake-nostream', '--upstream-port', String(upstreamPort), '--port', '8786'],
      {
        cwd: ROOT,
        env: { ...process.env, APX_ADAPTER_DIRS: adapterDir, APX_STATE_DIR: stateDir2 },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      const stateFile2 = path.join(stateDir2, 'state.json');
      const ready2 = await waitFor(() => {
        try {
          const st = JSON.parse(fs.readFileSync(stateFile2, 'utf8'));
          return st.proxyPort && st.adapterId === 'fake-nostream' ? st : null;
        } catch {
          return null;
        }
      });
      check('伪流式实例已就绪', Boolean(ready2), '未写入状态文件');
      if (ready2) {
        const auth2 = { authorization: `Bearer ${ready2.token}`, 'content-type': 'application/json' };
        const r = await fetch(`http://127.0.0.1:${ready2.proxyPort}/v1/chat/completions`, {
          method: 'POST',
          headers: auth2,
          body: JSON.stringify({
            model: 'fake-1',
            messages: [{ role: 'user', content: '__TOOL__' }],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
            stream: true,
          }),
        });
        const text = await r.text();
        check('标注 pseudo-stream', r.headers.get('x-apx-degraded') === 'pseudo-stream', String(r.headers.get('x-apx-degraded')));
        check('tool_calls 在伪流式里仍存在', text.includes('"tool_calls"') && text.includes('get_weather'), text.slice(0, 300));
        check('函数参数完整回放', text.includes('{\\"city\\":\\"Shanghai\\"}'), text.slice(-400));
        check('finish_reason = tool_calls', text.includes('"finish_reason":"tool_calls"'), text.slice(-300));
        check('伪流式 chunk 也带 logprobs:null', text.includes('"logprobs":null'), text.slice(0, 300));
        check('以 [DONE] 收尾', text.includes('data: [DONE]'));
      }
    } finally {
      child2.kill();
      await new Promise((r) => setTimeout(r, 300));
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('taskkill', ['/PID', String(child2.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* 已退出 */
      }
      fs.rmSync(stateDir2, { recursive: true, force: true });
    }
  }

  console.log('[4] 流式：逐块到达（不是缓冲）');
  {
    const t0 = Date.now();
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'stream test' }], stream: true }),
    });
    check('响应头标注 passthrough', r.headers.get('x-apx-stream') === 'passthrough', String(r.headers.get('x-apx-stream')));
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    let firstChunkMs = null;
    let frames = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
      text += dec.decode(value, { stream: true });
      frames += (dec.decode().match(/data:/g) || []).length;
    }
    const totalMs = Date.now() - t0;
    const dataFrames = (text.match(/data:/g) || []).length;
    check('首块 < 400ms（未被缓冲）', firstChunkMs !== null && firstChunkMs < 400, `首块 ${firstChunkMs}ms`);
    check('接收被拉长（首块与结束相差 >100ms，说明是逐块而非一次性）', totalMs - firstChunkMs > 100, `首块 ${firstChunkMs}ms / 总 ${totalMs}ms`);
    check('帧数 ≥ 3', dataFrames >= 3, `帧数 ${dataFrames}`);
    check('含 [DONE]', text.includes('[DONE]'));
  }

  console.log('[5] CORS / 跨站');
  {
    const r = await fetch(`${base}/v1/models`, { method: 'OPTIONS' });
    check('OPTIONS 返回 403', r.status === 403, `实际 ${r.status}`);
    check('不返回 ACAO', r.headers.get('access-control-allow-origin') === null);
  }
  {
    const r = await fetch(`${base}/v1/models`, { headers: { ...auth, origin: 'http://evil.com' } });
    const acao = r.headers.get('access-control-allow-origin');
    check('恶意 Origin 不获得 ACAO', acao === null, String(acao));
  }

  console.log('[6] 凭证生命周期：轮换 token 后无需重启');
  {
    state.token = 'T2';
    fs.writeFileSync(tokenFile, JSON.stringify({ token: 'T2' }));
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'after rotate' }] }),
    });
    const j = await r.json();
    check('轮换后仍 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    check('上游收到的是新 token', state.authSeen.at(-1) === 'Bearer T2', String(state.authSeen.at(-1)));
  }

  console.log('[7] 401 重放：上游拒绝一次后重读凭证并重试');
  {
    state.failOnce = true;
    const before = state.hits.length;
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'retry' }] }),
    });
    const j = await r.json();
    check('最终 200（重放成功）', r.status === 200 && j.choices?.[0]?.message?.content === 'echo:retry', `实际 ${r.status}`);
    check('上游被请求了 2 次', state.hits.length - before === 2, `实际 ${state.hits.length - before}`);
  }

  console.log('[8] 健康检查报告凭证状态');
  {
    const r = await fetch(`${base}/health`, { headers: auth });
    const j = await r.json();
    check('streaming=passthrough', j.streaming === 'passthrough', String(j.streaming));
    check('credential.hasToken=true', j.credential?.hasToken === true, JSON.stringify(j.credential));
    check('models 数量 > 0', j.models > 0, String(j.models));
  }

  console.log('[9] 退避信号：上游 Retry-After 必须透传到下游');
  {
    // 上游给响应头
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: '__429_HEADER__' }] }),
    });
    const j = await r.json().catch(() => null);
    check('上游 429 → 下游 429', r.status === 429, `实际 ${r.status}`);
    check('响应头 retry-after: 7', r.headers.get('retry-after') === '7', String(r.headers.get('retry-after')));
    check('body 里 upstream.retryAfter = 7 秒', j?.error?.upstream?.retryAfter === 7, JSON.stringify(j?.error?.upstream));
  }
  {
    // 上游只给 body 的 retryAfterMs（无响应头）→ 仍需算成秒
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: '__429_BODY_ONLY__' }] }),
    });
    const j = await r.json().catch(() => null);
    check('body-only 场景下游 429', r.status === 429, `实际 ${r.status}`);
    check('retry-after 由 retryAfterMs 折算为 31556', r.headers.get('retry-after') === '31556', String(r.headers.get('retry-after')));
    check('body 保留 retryAfterMs 原值', j?.error?.upstream?.retryAfterMs === 31556000, JSON.stringify(j?.error?.upstream));
  }
  {
    // 503 与 429 共用 sendError 分支，但"共用"不等于"被覆盖"——单独断言
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: '__503_HEADER__' }] }),
    });
    const j = await r.json().catch(() => null);
    check('上游 503 → 下游 503（不收敛成 502）', r.status === 503, `实际 ${r.status}`);
    check('503 也带 retry-after: 3', r.headers.get('retry-after') === '3', String(r.headers.get('retry-after')));
    check('503 body 里 upstream.retryAfter = 3 秒', j?.error?.upstream?.retryAfter === 3, JSON.stringify(j?.error?.upstream));
  }

  console.log('[10] 状态码保真：5xx 不归一，只有"没响应"才 502');
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: '__502__' }] }),
    });
    check('上游 502 → 下游 502（原样透传）', r.status === 502, `实际 ${r.status}`);
  }
  {
    let status = null;
    let code = null;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: '__CLOSE__' }] }),
      });
      status = r.status;
      const j = await r.json().catch(() => null);
      code = j?.error?.code;
    } catch (e) {
      status = `fetch-threw:${e.message}`;
    }
    check('上游掐断连接 → 下游 502', status === 502, String(status));
    check('code 标明是不可达而非上游业务错误', code === 'apx_upstream_unreachable', String(code));
  }
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: 'null',
    });
    const j = await r.json().catch(() => null);
    check('body=null 返回 400 而不是 500', r.status === 400 && j?.error?.code === 'apx_bad_request', `实际 ${r.status} ${JSON.stringify(j)}`);
  }

  console.log('[10b] 客户端断开会取消非流式上游（避免占住唯一上游槽位）');
  {
    const ac = new AbortController();
    const p = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: auth,
      signal: ac.signal,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: '__HANG__' }] }),
    }).catch((e) => e);
    await sleep(150);
    check('上游已收到挂起请求', state.hangStarted >= 1, String(state.hangStarted));
    ac.abort();
    const closed = await waitFor(() => state.hangClosed >= 1, { timeout: 2000, interval: 50 });
    check('客户端断开后上游连接被取消', Boolean(closed), String(state.hangClosed));
    await p;
  }

  console.log('[11] Responses API：/v1/responses 必须可用而不是 501');
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'fake-1',
        instructions: 'be brief',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      }),
    });
    const j = await r.json().catch(() => null);
    check('返回 200（不是 501）', r.status === 200, `实际 ${r.status}`);
    check('object=response', j?.object === 'response', JSON.stringify(j).slice(0, 120));
    check('output_text 透传上游内容', j?.output_text === 'echo:hi', JSON.stringify(j?.output_text));
    check('usage 用 Responses 字段名', j?.usage?.input_tokens === 1 && j?.usage?.output_tokens === 2, JSON.stringify(j?.usage));
    check('instructions 回显在 response 里', j?.instructions === 'be brief', JSON.stringify(j?.instructions));
  }
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', input: 'stream test', stream: true }),
    });
    check('流式返回 event-stream', r.headers.get('content-type').includes('text/event-stream'), String(r.headers.get('content-type')));
    check('显式标注 pseudo-stream（上游没有 Responses SSE）', r.headers.get('x-apx-degraded') === 'pseudo-stream', String(r.headers.get('x-apx-degraded')));
    const text = await r.text();
    check('有 output_text.delta 事件', text.includes('event: response.output_text.delta'));
    check('有 response.completed 事件', text.includes('event: response.completed'));
    {
      const createdLine = text.split('\n').find((l) => l.includes('"type":"response.created"'));
      check('response.created 的 response 带 output 数组（严格客户端要求）', Boolean(createdLine && createdLine.includes('"output":[]')), createdLine || 'missing');
    }
    check('无 [DONE]（Responses 用事件收尾，不用 Chat 的 [DONE]）', !text.includes('data: [DONE]'));
  }
  console.log('[11b] Responses API 工具调用：tools / function_call / function_call_output');
  const toolDef = {
    type: 'function',
    name: 'get_weather',
    description: 'get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    strict: true,
  };
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', input: '__TOOL__', tools: [toolDef], tool_choice: 'auto', parallel_tool_calls: true }),
    });
    const j = await r.json().catch(() => null);
    const fc = j?.output?.find((x) => x.type === 'function_call');
    check('返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    check('output 含 function_call', Boolean(fc), JSON.stringify(j?.output));
    check('函数名与参数沿用上游', fc?.name === 'get_weather' && fc?.arguments === '{"city":"Shanghai"}', JSON.stringify(fc));
    check('call_id 沿用上游（下一轮靠它配对）', fc?.call_id === 'call_1', String(fc?.call_id));
    check('纯工具调用时 output_text 为空', j?.output_text === '', JSON.stringify(j?.output_text));
    check('回显 tools / tool_choice', j?.tools?.[0]?.name === 'get_weather' && j?.tool_choice === 'auto', `${JSON.stringify(j?.tools)} ${JSON.stringify(j?.tool_choice)}`);
    check('上游收到 Chat 形状 tools', state.lastBody?.tools?.[0]?.function?.name === 'get_weather', JSON.stringify(state.lastBody?.tools));
    check('strict 一并透传', state.lastBody?.tools?.[0]?.function?.strict === true, JSON.stringify(state.lastBody?.tools?.[0]));
  }
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'fake-1',
        input: [
          { role: 'user', content: 'weather?' },
          { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"Paris"}' },
          { type: 'function_call_output', call_id: 'call_9', output: '{"temp":20}' },
        ],
        tools: [toolDef],
        tool_choice: { type: 'function', name: 'get_weather' },
      }),
    });
    const j = await r.json().catch(() => null);
    const msgs = state.lastBody?.messages || [];
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    const toolMsg = msgs.find((m) => m.role === 'tool');
    check('历史工具项请求返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 160)}`);
    check('assistant.tool_calls 被还原', assistant?.tool_calls?.[0]?.id === 'call_9' && assistant?.tool_calls?.[0]?.function?.name === 'get_weather', JSON.stringify(assistant));
    check('工具结果按 call_id 配对', toolMsg?.tool_call_id === 'call_9' && toolMsg?.content === '{"temp":20}', JSON.stringify(toolMsg));
    check('tool_choice 转成 Chat 形状', state.lastBody?.tool_choice?.function?.name === 'get_weather', JSON.stringify(state.lastBody?.tool_choice));
  }
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', input: '__TOOL__', stream: true, tools: [toolDef] }),
    });
    const text = await r.text();
    check('流式含 function_call_arguments.done', text.includes('event: response.function_call_arguments.done'), text.slice(0, 200));
    check('流里能看到函数名', text.includes('"name":"get_weather"'), text.slice(0, 300));
    check('流里参数完整', text.includes('{\\"city\\":\\"Shanghai\\"}'), text.slice(-400));
    check('completed 事件里也有 function_call', text.includes('event: response.completed') && text.includes('"type":"function_call"'), text.slice(-400));
    check('纯工具调用不伪造 output_text.delta', !text.includes('event: response.output_text.delta'));
    {
      const events = text
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)));
      const done = events.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call');
      const completed = events.find((e) => e.type === 'response.completed');
      const fc = completed?.response?.output?.find((x) => x.type === 'function_call');
      check('流事件与 completed 的 item id 一致', Boolean(done && fc) && done.item.id === fc.id, `${done?.item?.id} vs ${fc?.id}`);
      check('两处 call_id 一致', Boolean(done && fc) && done.item.call_id === fc.call_id, `${done?.item?.call_id} vs ${fc?.call_id}`);
      const seqs = events.map((e) => e.sequence_number);
      check('sequence_number 严格递增（严格客户端会校验）', seqs.every((n, i) => Number.isInteger(n) && (i === 0 ? n >= 0 : n > seqs[i - 1])), seqs.join(','));
    }
  }
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', input: 'hi', tools: [{ type: 'web_search_preview' }] }),
    });
    const j = await r.json().catch(() => null);
    check('不支持的内置工具类型显式 400', r.status === 400 && j?.error?.code === 'apx_unsupported_field', `实际 ${r.status} ${JSON.stringify(j)}`);
  }
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', input: [{ type: 'reasoning', summary: [] }] }),
    });
    const j = await r.json().catch(() => null);
    check('不支持的 input item 显式 400', r.status === 400 && j?.error?.code === 'apx_unsupported_field', `实际 ${r.status} ${JSON.stringify(j)}`);
  }
  {
    const r = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', input: 'hi', previous_response_id: 'resp_old' }),
    });
    const j = await r.json().catch(() => null);
    check('previous_response_id 仍显式 400', r.status === 400 && j?.error?.param === 'previous_response_id', `实际 ${r.status} ${JSON.stringify(j)}`);
  }
  {
    const r = await fetch(`${base}/v1/nope`, { method: 'POST', headers: auth, body: '{}' });
    const j = await r.json().catch(() => null);
    check('未实现端点是明确 501', r.status === 501, `实际 ${r.status}`);
    check('501 说明已支持端点', String(j?.error?.message || '').includes('/v1/responses'), JSON.stringify(j?.error?.message));
  }

  console.log('[12] 下游兼容性：不带 /v1 也能调 Chat，模型清单字段严格可用');
  {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'fake-1', messages: [{ role: 'user', content: 'no-prefix' }] }),
    });
    const j = await r.json().catch(() => null);
    check('POST /chat/completions 也返回 200', r.status === 200, `实际 ${r.status}`);
    check('内容正确', j?.choices?.[0]?.message?.content === 'echo:no-prefix', JSON.stringify(j).slice(0, 140));
    check('usage 是对象（缺上游也不缺失）', j?.usage && typeof j.usage === 'object', JSON.stringify(j?.usage));
  }
  {
    const r = await fetch(`${base}/v1/models`, { headers: auth });
    const j = await r.json().catch(() => null);
    check('model.created > 0', Number.isInteger(j?.data?.[0]?.created) && j.data[0].created > 0, JSON.stringify(j?.data?.[0]));
    check('model.owned_by 是字符串', typeof j?.data?.[0]?.owned_by === 'string', JSON.stringify(j?.data?.[0]));
  }
  {
    // OpenAI SDK 的 client.models.retrieve(id)
    const r = await fetch(`${base}/v1/models/fake-1`, { headers: auth });
    const j = await r.json().catch(() => null);
    check('GET /v1/models/{id} 返回 200', r.status === 200, `实际 ${r.status}`);
    check('单个模型 object=model', j?.object === 'model' && j?.id === 'fake-1', JSON.stringify(j).slice(0, 160));
  }
  {
    const r = await fetch(`${base}/v1/models/not-exist`, { headers: auth });
    const j = await r.json().catch(() => null);
    check('未知模型返回 404 且 code 明确', r.status === 404 && j?.error?.code === 'apx_model_not_found', `${r.status} ${JSON.stringify(j)}`);
  }

  // 清理
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* 已退出 */
  }
  upstream.close();
  fs.rmSync(tmp, { recursive: true, force: true });

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
