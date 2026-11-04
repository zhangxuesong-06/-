// 上游健康监控测试（N5）：代理进程活着 ≠ 上游活着。
//
// 关注三件事：
//   1) 启动时完成一次健康检查，状态为 ok；
//   2) 上游连续 2 次探测失败 → down（不是一次抖动就报红）；
//   3) 上游恢复 → 状态回到 ok，失败计数清零。
import './_isolate-state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createController } from '../src/runtime/controller.mjs';
import { pickFreePort } from '../src/runtime/supervisor.mjs';

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

async function waitFor(fn, { timeout = 5000, interval = 60 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

async function main() {
  console.log('== health：启动检查 / 连续失败判红 / 恢复 ==');
  let healthy = true;
  const upstream = http.createServer((req, res) => {
    if (!healthy) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'upstream down' } }));
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1' }] }));
    }
    res.writeHead(404);
    res.end('nope');
  });
  const upstreamPort = await listen(upstream);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-health-'));
  const adapterDir = path.join(tmp, 'adapters');
  fs.mkdirSync(adapterDir);
  fs.writeFileSync(
    path.join(adapterDir, 'health-fake.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'health-fake',
      name: '健康检查夹具',
      version: '1.0.0',
      match: { exeNames: [], pathGlobs: [] },
      serviceFace: { type: 'openai-passthrough', portDiscovery: { strategy: 'listen-scan' }, auth: { type: 'none' } },
      upstream: {
        auth: { kind: 'none' },
        listModels: { path: '/v1/models', items: '$.data' },
        generate: { path: '/v1/chat/completions', textPath: '$.choices[0].message.content' },
        requestHooks: [],
      },
      capabilities: { streaming: false, tools: false },
      sessionPolicy: 'stateless',
    }),
  );
  process.env.APX_ADAPTER_DIRS = adapterDir;

  const controller = createController({ healthIntervalMs: 100, healthFailureThreshold: 2 });
  const proxyPort = await pickFreePort(18991);
  let started = false;

  try {
    await controller.start({ adapterId: 'health-fake', upstreamPort, proxyPort });
    started = true;

    const initial = controller.status();
    check('启动后状态为 ok', initial.upstreamHealth?.state === 'ok', JSON.stringify(initial.upstreamHealth));
    check('启动时已做过一次探测', (initial.upstreamHealth?.checks || 0) >= 1, JSON.stringify(initial.upstreamHealth));

    healthy = false;
    const down = await waitFor(() => {
      const h = controller.status().upstreamHealth;
      return h && h.state === 'down' ? h : null;
    });
    check('连续失败后判 down', Boolean(down), JSON.stringify(controller.status().upstreamHealth));
    check('失败计数 ≥ 2（不是一次就报红）', (down?.consecutiveFailures || 0) >= 2, JSON.stringify(down));
    check('记录失败原因', Boolean(down?.lastError), JSON.stringify(down));

    healthy = true;
    const recovered = await waitFor(() => {
      const h = controller.status().upstreamHealth;
      return h && h.state === 'ok' && h.consecutiveFailures === 0 ? h : null;
    });
    check('上游恢复后回到 ok', Boolean(recovered), JSON.stringify(controller.status().upstreamHealth));
    check('恢复后失败计数清零', recovered?.consecutiveFailures === 0, JSON.stringify(recovered));
  } finally {
    if (started) await controller.stop();
    upstream.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  check('停止后不再有运行态', controller.status().running === false);

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
