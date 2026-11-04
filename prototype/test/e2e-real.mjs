// 真实链路端到端测试：controller 起「本机 OpenAI 兼容服务」适配器 → 打到真模型。
//
// 这一步证明的是「一键可用」真的成立，而不是链路"看起来通了"：
//   - 真实模型返回非空文本；
//   - 真流式首块在 3s 内到达（不是先读完再吐）。
//
// 若本机没有可用的 OpenAI 兼容服务 → 整组 skip（打印原因，不 fail）。
// 端口候选从 manifest 读，测试里不硬编码任何端口。
import './_isolate-state.mjs';
import net from 'node:net';
import { createController } from '../src/runtime/controller.mjs';
import { probeModelEndpoint } from '../src/runtime/portscan.mjs';
import { findAdapter } from '../src/adapters/loader.mjs';

const ADAPTER_ID = 'local-openai-service';
const FIRST_CHUNK_BUDGET_MS = 3000;

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

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/** 从 manifest 取候选端口，找第一个真的能当模型接口用的。 */
async function findLocalService() {
  const adapter = findAdapter(ADAPTER_ID);
  if (!adapter) return { ok: false, reason: `找不到适配器 ${ADAPTER_ID}` };
  const candidates = adapter.serviceFace?.portDiscovery?.candidates || [];
  const modelsPath = adapter.serviceFace?.portDiscovery?.modelsPath || '/v1/models';
  const attempts = [];
  for (const port of candidates) {
    const r = await probeModelEndpoint({ port: Number(port), modelsPath });
    attempts.push(`端口 ${port}：${r.reason}`);
    if (r.ok) return { ok: true, port: Number(port), models: r.models || [], attempts };
  }
  return { ok: false, reason: `候选端口全部未命中：\n    ` + attempts.join('\n    ') };
}

async function readSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let frames = 0;
  let firstChunkMs = null;
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
    const piece = dec.decode(value, { stream: true });
    text += piece;
    frames += (piece.match(/data:/g) || []).length;
  }
  return { text, frames, firstChunkMs, totalMs: Date.now() - t0 };
}

async function main() {
  console.log('== e2e-real：真实模型链路 ==');
  const found = await findLocalService();
  if (!found.ok) {
    console.log(`SKIP：本机没有可用的 OpenAI 兼容服务。\n    ${found.reason}`);
    console.log('\n结果：0 通过 / 0 失败（skip）');
    process.exit(0);
  }
  console.log(`本机服务命中 127.0.0.1:${found.port}，模型 ${found.models.slice(0, 3).join(', ')}`);
  if (!found.models.length) {
    console.log('SKIP：该服务没有返回任何模型，无法验证文本生成。');
    process.exit(0);
  }

  const controller = createController({ log: (l) => console.log(l) });
  let info = null;
  try {
    info = await controller.start({ adapterId: ADAPTER_ID });
    check('controller 启动成功', Boolean(info.port), JSON.stringify(info).slice(0, 200));
    check('模型清单非空', info.models.length > 0, `实际 ${info.models.length}`);
    check('streaming 标注为 passthrough', info.streaming === 'passthrough', String(info.streaming));
    check('upstreamPort 与命中端口一致', info.upstreamPort === found.port, `${info.upstreamPort} vs ${found.port}`);
    check('能识别真正的提供方软件名', typeof info.providerName === 'string' && info.providerName.trim().length > 0, String(info.providerName));

    const model = info.models[0].alias;
    const auth = { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' };

    console.log('\n[1] 非流式：真实模型文本');
    {
      const r = await fetch(`${info.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '用一句简短中文回答：1+1 等于几？' }] }),
      });
      const j = await r.json().catch(() => null);
      const content = j?.choices?.[0]?.message?.content;
      check('返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      check('content 为非空字符串', typeof content === 'string' && content.trim().length > 0, JSON.stringify(content).slice(0, 120));
      if (typeof content === 'string' && content.trim()) console.log(`      模型输出：${content.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
    }

    console.log('\n[2] 流式：首块延迟与帧数');
    {
      const r = await fetch(`${info.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: '数到五，用中文，只输出数字。' }] }),
      });
      check('返回 200', r.status === 200, `实际 ${r.status}`);
      check('响应头标注 passthrough', r.headers.get('x-apx-stream') === 'passthrough', String(r.headers.get('x-apx-stream')));
      const sse = await readSse(r);
      check(`首块 < ${FIRST_CHUNK_BUDGET_MS}ms`, sse.firstChunkMs !== null && sse.firstChunkMs < FIRST_CHUNK_BUDGET_MS, `首块 ${sse.firstChunkMs}ms`);
      check('帧数 ≥ 3', sse.frames >= 3, `帧数 ${sse.frames}`);
      check('含 [DONE]', sse.text.includes('[DONE]'));
      console.log(`      首块 ${sse.firstChunkMs}ms / 总 ${sse.totalMs}ms / ${sse.frames} 帧`);
    }
    console.log('\n[3] Responses API：真实模型也要能走 /v1/responses');
    {
      const r = await fetch(`${info.baseUrl}/responses`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model, input: '用一句简短中文回答：天空通常是什么颜色？' }),
      });
      const j = await r.json().catch(() => null);
      const text = j?.output_text;
      check('返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      check('object=response', j?.object === 'response', JSON.stringify(j).slice(0, 120));
      check('output_text 为非空字符串', typeof text === 'string' && text.trim().length > 0, JSON.stringify(text).slice(0, 120));
      if (typeof text === 'string' && text.trim()) console.log(`      模型输出：${text.trim().replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  } finally {
    console.log('\n[4] 回收');
    const stopped = await controller.stop();
    check('stop 报告已回收', stopped.stopped === true, JSON.stringify(stopped));
    if (info?.port) {
      // Windows 上端口释放有几十毫秒延迟，重试几次再判定
      let closed = false;
      for (let i = 0; i < 10 && !closed; i++) {
        closed = !(await portOpen(info.port));
        if (!closed) await new Promise((r) => setTimeout(r, 120));
      }
      check('代理端口拒绝连接', closed, `端口 ${info.port} 仍在监听`);
    }
  }

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
