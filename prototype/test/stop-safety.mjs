// `apx stop` 的安全性测试：pid 会被系统回收，回收前必须验明身份。
//
// 覆盖三类场景：
//   ① 状态文件里的 pid 指向一个无关进程（exe 路径不符）→ 必须跳过、只清状态；
//   ② exe 路径对得上但启动时间对不上（模拟 pid 复用）→ 必须跳过；
//   ③ 正常启动后再 stop → 必须真的杀掉且端口释放。
//
// 判定标准是「那个无关进程还活着」，不是「命令退出码为 0」——后者说明不了任何事。
import './_isolate-state.mjs';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState, writeState } from '../src/security/token.mjs';
import { getProcessInfo, isOurProcess } from '../src/runtime/procinfo.mjs';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

/** 真实调用 `apx stop`，返回 stdout 全文。 */
function runStop() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.mjs'), 'stop'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (out += b.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  console.log('== stop-safety：回收前验身份 ==');
  const backup = readState();

  // 一个"无关进程"：存活 120s 的 node，我们绝不允许 stop 杀掉它
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore' });
  await sleep(400);
  const victimInfo = await getProcessInfo(victim.pid);
  check('无关进程已就绪且可取证', Boolean(victimInfo), JSON.stringify(victimInfo));

  try {
    // ---- ① exe 路径不符 ----
    console.log('\n[1] 状态文件指向无关进程（exe 路径不符）');
    writeState({
      pid: victim.pid,
      proxyPort: 45999,
      adapterId: 'not-ours',
      serviceFacePid: null,
      upstreamPort: null,
      proxyProc: { exePath: 'C:\\definitely\\not\\ours.exe', startMs: victimInfo?.startMs ?? Date.now() },
      serviceFaceProc: null,
    });
    const r1 = await runStop();
    check('输出含"已跳过（进程已不是我们启动的那个）"', r1.out.includes('已跳过（进程已不是我们启动的那个）'), r1.out.trim().slice(0, 200));
    await sleep(300);
    check('无关进程仍然存活（未被误杀）', await getProcessInfo(victim.pid) !== null);
    check('状态文件已清空 pid', readState().pid === null, JSON.stringify(readState()).slice(0, 200));

    // ---- ② exe 路径对得上，但启动时间对不上（pid 复用）----
    console.log('\n[2] exe 路径一致但启动时间不符（模拟 pid 复用）');
    writeState({
      pid: victim.pid,
      proxyPort: 45999,
      adapterId: 'not-ours',
      serviceFacePid: null,
      upstreamPort: null,
      // 记录成"10 分钟后才启动"→ 现有进程的启动时间必然早于它
      proxyProc: { exePath: victimInfo?.exePath, startMs: Date.now() + 600000 },
      serviceFaceProc: null,
    });
    const r2 = await runStop();
    check('输出含"已跳过"', r2.out.includes('已跳过'), r2.out.trim().slice(0, 200));
    check('输出解释了 pid 复用', /启动时间早于记录时间/.test(r2.out), r2.out.trim().slice(0, 240));
    await sleep(300);
    check('无关进程仍然存活', await getProcessInfo(victim.pid) !== null);

    // 三条件正向用例：身份完全正确时 isOurProcess 必须放行（否则 stop 永远杀不掉任何东西）
    const okVerdict = await isOurProcess({ pid: victim.pid, exePath: victimInfo?.exePath, startMs: victimInfo?.startMs });
    check('身份完全匹配时三条件校验放行', okVerdict.ok === true, JSON.stringify(okVerdict));

    // ---- ③ 正常启动 → stop ----
    console.log('\n[3] 正常启动后 stop');
    const upstream = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-1' }] }));
      }
      res.writeHead(404);
      res.end('no');
    });
    const upstreamPort = await listen(upstream);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-stopsafe-'));
    const adapterDir = path.join(tmp, 'adapters');
    fs.mkdirSync(adapterDir);
    fs.writeFileSync(
      path.join(adapterDir, 'fake-upstream.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'fake-upstream',
        name: '假上游（测试用）',
        match: { exeNames: [], pathGlobs: [] },
        serviceFace: { type: 'openai-passthrough', portDiscovery: { strategy: 'listen-scan' } },
        upstream: {
          auth: { kind: 'none' },
          listModels: { path: '/v1/models', items: '$.data' },
          generate: { path: '/v1/chat/completions', textPath: '$.choices[0].message.content' },
        },
        capabilities: { streaming: true, tools: true },
        sessionPolicy: 'stateless',
      }),
    );

    const serve = spawn(
      process.execPath,
      [path.join(ROOT, 'src/cli.mjs'), 'serve', '--adapter', 'fake-upstream', '--upstream-port', String(upstreamPort), '--port', '8795'],
      { cwd: ROOT, env: { ...process.env, APX_ADAPTER_DIRS: adapterDir }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let serveOut = '';
    serve.stdout.on('data', (b) => (serveOut += b.toString()));
    serve.stderr.on('data', (b) => (serveOut += b.toString()));

    let st = null;
    for (let i = 0; i < 100 && !st; i++) {
      const cur = readState();
      if (cur.proxyPort && cur.adapterId === 'fake-upstream') st = cur;
      else await sleep(150);
    }
    check('serve 已就绪并写入状态', Boolean(st), serveOut.slice(-300));
    check('状态里记录了代理进程的 exePath', Boolean(st?.proxyProc?.exePath), JSON.stringify(st?.proxyProc));
    check('状态里记录了代理进程的 startMs', Number.isInteger(st?.proxyProc?.startMs), JSON.stringify(st?.proxyProc));
    const proxyPort = st?.proxyPort;
    check('代理端口在监听', proxyPort ? await portOpen(proxyPort) : false, String(proxyPort));

    const r3 = await runStop();
    check('stop 输出含"已回收"', r3.out.includes('已回收'), r3.out.trim().slice(0, 240));
    check('stop 输出未出现跳过', !r3.out.includes('已跳过'), r3.out.trim().slice(0, 240));

    let closed = false;
    for (let i = 0; i < 20 && !closed; i++) {
      closed = !(await portOpen(proxyPort));
      if (!closed) await sleep(150);
    }
    check('代理端口已释放', closed, `端口 ${proxyPort} 仍在监听`);
    await sleep(500);
    check('serve 进程已退出', await getProcessInfo(serve.pid) === null, `pid ${serve.pid} 仍存活`);
    check('状态文件已清空', readState().pid === null);

    upstream.close();
    try {
      serve.kill();
    } catch {
      /* 已退出 */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    try {
      victim.kill();
    } catch {
      /* ignore */
    }
    writeState({
      pid: backup.pid ?? null,
      proxyPort: backup.proxyPort ?? null,
      adapterId: backup.adapterId ?? null,
      serviceFacePid: backup.serviceFacePid ?? null,
      upstreamPort: backup.upstreamPort ?? null,
      proxyProc: backup.proxyProc ?? null,
      serviceFaceProc: backup.serviceFaceProc ?? null,
    });
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
