// 控制台端到端测试：真控制台 + 真 controller + 真本机上游。
//
// 覆盖的是控制台的三条硬约束：
//   1) 没有控制台令牌 → 401（不能裸奔）；有令牌 → 200；
//   2) 跨站请求 → 403，且永不返回 Access-Control-Allow-*；
//   3) 通过控制台起停代理后，端点真的可用 / 真的关闭。
//
// 本机没有可用的 OpenAI 兼容服务时整组 skip（打印原因，不 fail）。
import './_isolate-state.mjs';
import net from 'node:net';
import { createConsoleServer } from '../src/console/server.mjs';
import { createController } from '../src/runtime/controller.mjs';
import { probeModelEndpoint } from '../src/runtime/portscan.mjs';
import { findAdapter } from '../src/adapters/loader.mjs';

const ADAPTER_ID = 'local-openai-service';

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

async function findLocalService() {
  const adapter = findAdapter(ADAPTER_ID);
  if (!adapter) return { ok: false, reason: `找不到适配器 ${ADAPTER_ID}` };
  const candidates = adapter.serviceFace?.portDiscovery?.candidates || [];
  const modelsPath = adapter.serviceFace?.portDiscovery?.modelsPath || '/v1/models';
  const attempts = [];
  for (const port of candidates) {
    const r = await probeModelEndpoint({ port: Number(port), modelsPath });
    attempts.push(`端口 ${port}：${r.reason}`);
    if (r.ok) return { ok: true, port: Number(port), models: r.models || [] };
  }
  return { ok: false, reason: '候选端口全部未命中：\n    ' + attempts.join('\n    ') };
}

async function readSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let frames = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = dec.decode(value, { stream: true });
    text += piece;
    frames += (piece.match(/data:/g) || []).length;
  }
  return { text, frames };
}

async function main() {
  console.log('== console：Web 控制台 ==');
  const found = await findLocalService();
  if (!found.ok) {
    console.log(`SKIP：本机没有可用的 OpenAI 兼容服务，跳过控制台整组测试。\n    ${found.reason}`);
    console.log('\n结果：0 通过 / 0 失败（skip）');
    process.exit(0);
  }
  console.log(`本机服务命中 127.0.0.1:${found.port}，模型 ${found.models.slice(0, 3).join(', ')}`);

  const controller = createController({ log: (l) => console.log('  [controller] ' + l) });
  const consoleSrv = await createConsoleServer({ port: 8799, controller, log: (l) => console.log('  [console] ' + l) });
  const base = consoleSrv.url.replace(/\/$/, '');
  const auth = { 'x-apx-console-token': consoleSrv.token };
  let proxyInfo = null;

  try {
    console.log('\n[1] 页面与鉴权');
    {
      const r = await fetch(base + '/');
      const html = await r.text();
      check('GET / 返回 200', r.status === 200, `实际 ${r.status}`);
      check('页面内嵌控制台令牌', html.includes(consoleSrv.token), '未找到 meta 令牌');
      check('页面声明 apx-console-token', html.includes('name="apx-console-token"'));
    }
    {
      const r = await fetch(base + '/api/scan');
      check('无令牌 /api/scan 返回 401', r.status === 401, `实际 ${r.status}`);
    }
    {
      const r = await fetch(base + '/api/status', { headers: { 'x-apx-console-token': 'apx-console-wrong' } });
      check('错误令牌 /api/status 返回 401', r.status === 401, `实际 ${r.status}`);
    }

    console.log('\n[2] 跨站防护');
    {
      const r = await fetch(base + '/api/scan', { headers: { ...auth, 'sec-fetch-site': 'cross-site' } });
      check('Sec-Fetch-Site: cross-site → 403', r.status === 403, `实际 ${r.status}`);
    }
    {
      const r = await fetch(base + '/api/scan', { headers: { ...auth, origin: 'null' } });
      check('Origin: null → 403', r.status === 403, `实际 ${r.status}`);
    }
    {
      const r = await fetch(base + '/api/status', { headers: { ...auth, origin: 'http://evil.example' } });
      check('恶意 Origin → 403', r.status === 403, `实际 ${r.status}`);
    }
    {
      const r = await fetch(base + '/api/status', { method: 'OPTIONS' });
      check('OPTIONS 预检 → 403', r.status === 403, `实际 ${r.status}`);
      check('不返回 ACAO', r.headers.get('access-control-allow-origin') === null);
    }
    {
      const r = await fetch(base + '/api/status', { headers: auth });
      check('同源带令牌 → 200', r.status === 200, `实际 ${r.status}`);
      check('不返回 ACAO（带令牌也一样）', r.headers.get('access-control-allow-origin') === null);
    }

    console.log('\n[3] 扫描与适配器');
    {
      const r = await fetch(base + '/api/scan', { headers: auth });
      const j = await r.json();
      check('/api/scan 返回 200', r.status === 200, `实际 ${r.status}`);
      check('候选数 > 0', Array.isArray(j.candidates) && j.candidates.length > 0, `实际 ${j.candidates?.length}`);
      // 首屏默认视图（只看已适配）的条数必须等于后端算的 matchedTotal，否则 UI 会显示错数字
      const withMatch = (j.candidates || []).filter((c) => (c.matchedBy || []).length > 0);
      check(
        'matchedTotal 等于默认视图条数',
        j.matchedTotal === withMatch.length,
        `matchedTotal=${j.matchedTotal} 默认视图=${withMatch.length}`,
      );
      check('默认视图比全量窄（过滤真的生效）', j.matchedTotal <= j.total, `matchedTotal=${j.matchedTotal} total=${j.total}`);
      // 噪声 exe（卸载器/安装器）不得出现在已适配视图里——按 exe 基名判定，不看显示名
      const basename = (p) => String(p || '').split(/[\\/]/).pop();
      const noisy = withMatch.filter((c) => /^(uninstall|unins|setup|installer)/i.test(basename(c.exePath)));
      check('已适配视图里没有任何卸载器/安装器', noisy.length === 0, noisy.map((c) => `${c.name}[${basename(c.exePath)}]`).join(' | '));
    }
    {
      // R9-7：服务端过滤参数是给脚本/验收用的稳定契约
      const full = await (await fetch(base + '/api/scan', { headers: auth })).json();
      const filtered = await (await fetch(base + '/api/scan?matched=1', { headers: auth })).json();
      const off = await (await fetch(base + '/api/scan?matched=0', { headers: auth })).json();
      const fullMatched = (full.candidates || []).filter((c) => (c.matchedBy || []).length > 0).length;
      check('?matched=1 的条数 === matchedTotal', filtered.candidates.length === filtered.matchedTotal, `${filtered.candidates.length} vs ${filtered.matchedTotal}`);
      check('?matched=1 的条数 === 全量里 matchedBy 非空的条数', filtered.candidates.length === fullMatched, `${filtered.candidates.length} vs ${fullMatched}`);
      check('?matched=1 返回的每条都确实有 matchedBy', filtered.candidates.every((c) => (c.matchedBy || []).length > 0));
      check('?matched=0 与不带参数等价（都返回全量）', off.candidates.length === full.candidates.length, `${off.candidates.length} vs ${full.candidates.length}`);
      check('响应里带 filtered 标记', filtered.filtered === true && off.filtered === false, `${filtered.filtered} / ${off.filtered}`);
    }
    {
      const r = await fetch(base + '/api/adapters', { headers: auth });
      const j = await r.json();
      check('/api/adapters 返回 200', r.status === 200, `实际 ${r.status}`);
      check('包含 local-openai-service', (j.adapters || []).some((a) => a.id === ADAPTER_ID), JSON.stringify((j.adapters || []).map((a) => a.id)));
      const a = (j.adapters || []).find((x) => x.id === ADAPTER_ID);
      check('该适配器标记为 port-scan', a?.matchStatus === 'port-scan', String(a?.matchStatus));
      check('该适配器上游代理策略为 clear', a?.proxyEnv?.mode === 'clear', JSON.stringify(a?.proxyEnv));
    }

    console.log('\n[4] 通过控制台启动代理');
    {
      const r = await fetch(base + '/api/start', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ adapterId: ADAPTER_ID }),
      });
      const j = await r.json();
      proxyInfo = j;
      check('/api/start 返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 240)}`);
      check('返回 baseURL', typeof j.baseUrl === 'string' && j.baseUrl.startsWith('http://127.0.0.1:'), String(j.baseUrl));
      check('模型清单非空', Array.isArray(j.models) && j.models.length > 0, `实际 ${j.models?.length}`);
      check('upstreamPort 为命中端口', j.upstreamPort === found.port, `${j.upstreamPort} vs ${found.port}`);
      // 最小暴露：启动响应里不该有下游令牌
      check('/api/start 不返回下游令牌', !('token' in j), Object.keys(j).join(','));
      check('/api/start 响应体不含 sk-local-', !JSON.stringify(j).includes('sk-local-'));
    }
    {
      const r = await fetch(base + '/api/status', { headers: auth });
      const j = await r.json();
      const raw = JSON.stringify(j);
      check('/api/status running=true', j.running === true, raw.slice(0, 200));
      check('status 带端口与模型', j.port > 0 && (j.models || []).length > 0);
      check('status 带并发统计', j.concurrency?.maxConcurrent > 0 && typeof j.concurrency.active === 'number', JSON.stringify(j.concurrency));
      check('status 带最近请求字段', Array.isArray(j.recentRequests), JSON.stringify(j.recentRequests));
      // R2：轮询接口绝不能带凭据明文
      check('/api/status 不含 apiKey 字段', !('apiKey' in j), Object.keys(j).join(','));
      check('/api/status 响应体不含 sk-local-', !raw.includes('sk-local-'));
    }
    {
      const r = await fetch(base + '/api/snippet', { headers: auth });
      const j = await r.json();
      check('/api/snippet 返回三件套', r.status === 200 && j.baseURL && j.apiKey && Array.isArray(j.models), JSON.stringify(j).slice(0, 200));
      // 令牌只允许从 snippet 取——后面打代理就用它，等于顺带验证 snippet 可用
      proxyInfo.token = j.apiKey;
      // 不断言前缀：老版本装机的本地令牌可能是别的格式，断言形状即可
      // （sk-local- 只是当前版本的生成前缀，不是协议约定）
      check('snippet.apiKey 是非空令牌', typeof j.apiKey === 'string' && j.apiKey.length >= 20 && /^sk-/.test(j.apiKey), String(j.apiKey).slice(0, 9));
    }
    {
      // 令牌稳定性：连续两次 snippet 必须完全相同（变了就说明被意外轮换了）
      const a = await (await fetch(base + '/api/snippet', { headers: auth })).json();
      const b = await (await fetch(base + '/api/snippet', { headers: auth })).json();
      check('两次 /api/snippet 返回同一 apiKey', a.apiKey === b.apiKey && Boolean(a.apiKey), `${String(a.apiKey).slice(0, 9)}… vs ${String(b.apiKey).slice(0, 9)}…`);
    }

    console.log('\n[5] 通过代理打真模型');
    const model = proxyInfo.models[0].alias;
    const proxyAuth = { authorization: `Bearer ${proxyInfo.token}`, 'content-type': 'application/json' };
    {
      const r = await fetch(`${proxyInfo.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: proxyAuth,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '用一句中文回答：2+2 等于几？' }] }),
      });
      const j = await r.json().catch(() => null);
      const content = j?.choices?.[0]?.message?.content;
      check('非流式 200', r.status === 200, `实际 ${r.status}`);
      check('content 非空', typeof content === 'string' && content.trim().length > 0, JSON.stringify(content).slice(0, 120));
    }
    {
      const r = await fetch(`${proxyInfo.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: proxyAuth,
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: '数到三，只输出中文数字。' }] }),
      });
      check('流式 200', r.status === 200, `实际 ${r.status}`);
      const sse = await readSse(r);
      check('流式帧数 ≥ 3', sse.frames >= 3, `帧数 ${sse.frames}`);
      check('流式含 [DONE]', sse.text.includes('[DONE]'));
    }
    {
      const r = await fetch(base + '/api/status', { headers: auth });
      const j = await r.json();
      check('统计里出现请求数', (j.stats?.requests || 0) >= 2, JSON.stringify(j.stats));
    }

    console.log('\n[6] 通过控制台停止');
    let proxyPort = proxyInfo.port;
    {
      const r = await fetch(base + '/api/stop', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json();
      check('/api/stop 返回 200', r.status === 200, `实际 ${r.status}`);
      check('报告已停止', j.stopped === true, JSON.stringify(j).slice(0, 160));
      check('返回释放的端口', Array.isArray(j.ports) && j.ports.includes(proxyPort), JSON.stringify(j.ports));
    }
    {
      const r = await fetch(base + '/api/status', { headers: auth });
      const j = await r.json();
      check('status running=false', j.running === false, JSON.stringify(j).slice(0, 160));
    }
    {
      let closed = false;
      for (let i = 0; i < 12 && !closed; i++) {
        closed = !(await portOpen(proxyPort));
        if (!closed) await new Promise((r) => setTimeout(r, 120));
      }
      check('代理端口拒绝连接', closed, `端口 ${proxyPort} 仍在监听`);
    }

    console.log('\n[7] 空候选也能直接启动（port-scan 型不需要选中软件）');
    {
      // 刻意不选任何候选、也不传 upstreamPort：模拟"默认视图一条都没有，用户直接点启动"
      const r = await fetch(base + '/api/start', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ adapterId: ADAPTER_ID }),
      });
      const j = await r.json();
      check('无候选时 /api/start 仍返回 200', r.status === 200, `实际 ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
      check('返回了 baseURL', typeof j.baseUrl === 'string' && j.baseUrl.length > 0, String(j.baseUrl));
      const snip = await (await fetch(base + '/api/snippet', { headers: auth })).json();
      const m = await fetch(`${j.baseUrl}/models`, { headers: { authorization: `Bearer ${snip.apiKey}` } });
      const mj = await m.json().catch(() => null);
      check('/v1/models 非空', m.status === 200 && Array.isArray(mj?.data) && mj.data.length > 0, `实际 ${m.status} data=${mj?.data?.length}`);
      const st = await fetch(base + '/api/stop', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
      const sj = await st.json().catch(() => null);
      check('随后 /api/stop 返回 200 且已停止', st.status === 200 && sj?.stopped === true, `实际 ${st.status} ${JSON.stringify(sj).slice(0, 120)}`);
    }
  } finally {
    await controller.stop().catch(() => {});
    await consoleSrv.close().catch(() => {});
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
