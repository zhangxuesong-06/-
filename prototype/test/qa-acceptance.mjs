#!/usr/bin/env node
/**
 * APX 独立验收（QA / 严过关）
 *
 * 原则：
 *  - 不复用工程师 test/*.mjs 的断言与夹具，全部黑盒：起真进程、看真输出。
 *  - 假上游内嵌在本文件里，不依赖本机是否装了 ollama；依赖真模型的用例在不可达时 skip。
 *  - 只报告，不修源码。
 *
 * 运行：node test/qa-acceptance.mjs
 *
 * 会临时改写 ~/.apx/state.json（这是被测行为的一部分），结束时（含异常退出）还原。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

// 状态隔离：验收过程绝不碰用户真实的 ~/.apx/state.json（那是用户已配好的凭据）。
// 依赖产品提供的 APX_STATE_DIR 覆盖点，把状态锁在临时目录里，跑完即删。
const QA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-qa-'));
const STATE_FILE = path.join(QA_STATE_DIR, 'state.json');
const CHILD_ENV = { ...process.env, APX_STATE_DIR: QA_STATE_DIR };

/* ------------------------------------------------------------------ 基础设施 */

const results = [];
const children = [];
const upstreams = [];

class Skip extends Error {}

const skip = (reason) => {
  throw new Skip(reason);
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 断言失败也继续收集（用于同一项内的多个子断言），最后统一抛出。 */
function collector(notesRef) {
  const fails = [];
  return {
    ok(cond, msg) {
      if (!cond) fails.push(msg);
      return Boolean(cond);
    },
    throwIfFailed(prefix = '') {
      if (fails.length) {
        // 失败时也要能看到现场证据，否则无法复现
        const ctx = notesRef && notesRef.length ? `\n--- 现场 ---\n${notesRef.join('\n')}` : '';
        throw new Error((prefix ? prefix + '；' : '') + fails.join(' | ') + ctx);
      }
    },
    get list() {
      return fails;
    },
  };
}

async function step(id, title, fn) {
  process.stdout.write(`\n▶ [${id}] ${title}\n`);
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ id, title, status: 'pass', detail: detail || '' });
    console.log(`  ✓ PASS  (${Date.now() - t0}ms)`);
    if (detail) console.log(`    ${detail.replace(/\n/g, '\n    ')}`);
  } catch (e) {
    if (e instanceof Skip) {
      results.push({ id, title, status: 'skip', detail: e.message });
      console.log(`  ↷ SKIP  ${e.message}`);
    } else {
      results.push({ id, title, status: 'fail', detail: e.message });
      console.log(`  ✗ FAIL  ${e.message}`);
    }
  }
}

function readStateRaw() {
  try {
    return fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return null;
  }
}

function writeStateRaw(text) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, text);
}

function readStateJson() {
  try {
    return JSON.parse(readStateRaw());
  } catch {
    return null;
  }
}

function runCli(args, { timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd: ROOT, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: env || CHILD_ENV },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : 0,
          timedOut: Boolean(err && err.killed),
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          ms: Date.now() - t0,
        });
      },
    );
  });
}

/** 起一个长时间运行的 CLI 子进程，收集输出并支持等待某行出现。 */
function spawnCli(args, envOverride) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    windowsHide: true,
    env: envOverride || CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const state = { child, out: '', err: '', exited: false };
  child.stdout.on('data', (d) => {
    state.out += String(d);
  });
  child.stderr.on('data', (d) => {
    state.err += String(d);
  });
  child.on('exit', () => {
    state.exited = true;
  });
  state.stop = () =>
    new Promise((resolve) => {
      if (state.exited) return resolve();
      child.once('exit', () => resolve());
      try {
        child.kill();
      } catch {
        resolve();
      }
      setTimeout(resolve, 3000);
    });
  state.waitFor = (regex, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const m = state.out.match(regex);
        if (m) return resolve(m);
        if (state.exited) return reject(new Error(`子进程提前退出：${state.out.slice(-400)}${state.err.slice(-400)}`));
        if (Date.now() - t0 > timeoutMs) return reject(new Error(`等待 ${regex} 超时（${timeoutMs}ms）输出：${state.out.slice(-500)}`));
        setTimeout(tick, 40);
      };
      tick();
    });
  return state;
}

async function httpReq(url, opts = {}) {
  const t0 = Date.now();
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const headers = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, text, json, ms: Date.now() - t0 };
}

function tcpProbe(port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (r) => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    s.setTimeout(timeout, () => done({ ok: false, reason: 'timeout' }));
    s.once('connect', () => done({ ok: true }));
    s.once('error', (e) => done({ ok: false, reason: e.code || e.message }));
  });
}

function curlNoproxy(url, extraArgs = []) {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-s', '--noproxy', '*', '-m', '5', '-o', os.devNull, '-w', '%{http_code}', ...extraArgs, url],
      { windowsHide: true },
      (err, stdout, stderr) => resolve({ code: err ? String(err.code || 1) : '0', httpCode: String(stdout || '').trim(), stderr: String(stderr || '') }),
    );
  });
}

function psOutput(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ProgressPreference="SilentlyContinue"; ${script}`],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : String(stdout || '')),
    );
  });
}

async function tasklistHas(pid) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(new RegExp(`\\b${pid}\\b`).test(String(stdout)));
    });
  });
}

/** 只统计本项目起的 node 进程，避免把用户自己的 node 当残留。 */
async function apxNodePids() {
  const out = await psOutput(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*本地代理*' } | Select-Object -ExpandProperty ProcessId`,
  );
  return out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/* ------------------------------------------------------------------ 假上游 */

function jsonRes(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/**
 * 起一个假上游。
 * handler(req, res, events) 自己写响应；events 用来记录"客户端是否断开"。
 */
function startUpstream(name, handler) {
  return new Promise((resolve, reject) => {
    const events = [];
    const server = http.createServer((req, res) => {
      Promise.resolve(handler(req, res, events)).catch(() => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const up = {
        name,
        port,
        events,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      };
      upstreams.push(up);
      resolve(up);
    });
  });
}

/** 从 CLI probe --port 的 JSON 输出里取 level。 */
async function probePort(port) {
  const r = await runCli(['probe', '--port', String(port), '--json'], { timeout: 60000 });
  const idx = r.stdout.indexOf('{');
  assert(idx >= 0, `probe --port ${port} 没有输出 JSON：${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}`);
  return { ...JSON.parse(r.stdout.slice(idx)), _ms: r.ms };
}

const FREE_PORT = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

/* ================================================================== 用例 1：发现层 */

async function case1() {
  const notes = [];
  const r = await runCli(['scan', '--min', '0.9', '--json'], { timeout: 180000 });
  notes.push('`node src/cli.mjs scan --min 0.9 --json` → 退出码 ' + r.code + '，墙钟 ' + r.ms + 'ms');
  const msMatch = r.stdout.match(/发现 (\d+) 个候选，置信度 ≥ [\d.]+ 的 (\d+) 个（(\d+) ms）/);
  if (msMatch) notes.push(`自报：候选 ${msMatch[1]} / ≥0.9 的 ${msMatch[2]} / 内部耗时 ${msMatch[3]}ms`);

  const idx = r.stdout.lastIndexOf('\n[');
  assert(idx >= 0, 'scan --json 没输出 JSON 数组');
  const candidates = JSON.parse(r.stdout.slice(idx + 1));
  assert(Array.isArray(candidates) && candidates.length > 0, '候选列表为空');

  const c = collector(notes);
  c.ok(candidates.length > 0, '候选总数为 0');

  const ollama = candidates.filter((x) => /ollama/i.test(`${x.name || ''} ${x.exePath || ''}`));
  const ollamaServing = ollama.filter((x) => (x.ports || []).some((p) => p.port === 11434));
  c.ok(ollama.length > 0, '没有 ollama 类条目');
  c.ok(ollamaServing.length > 0, '没有带 11434 端口的 ollama 条目');
  notes.push(`ollama 类条目 ${ollama.length} 个，其中带 11434 端口 ${ollamaServing.length} 个（${ollama.map((x) => x.name).join(' / ')}）`);

  const opencode = candidates.filter((x) => /opencode/i.test(`${x.name || ''} ${x.exePath || ''}`));
  c.ok(opencode.length > 0, '没有 opencode 类条目');
  notes.push(`opencode 类条目 ${opencode.length} 个（${opencode.map((x) => `${x.name}:${x.confidence}`).join(' / ')}）`);

  // 去重：按 exe 绝对路径分组，任何一组 > 1 即"重复计数"
  const byExe = new Map();
  for (const x of candidates) {
    if (!x.exePath) continue;
    const k = path.resolve(x.exePath).toLowerCase();
    byExe.set(k, (byExe.get(k) || 0) + 1);
  }
  const dups = [...byExe.entries()].filter(([, n]) => n > 1);
  c.ok(dups.length === 0, `按 exe 绝对路径去重后仍有 ${dups.length} 组重复：${dups.slice(0, 3).map(([k, n]) => `${k}×${n}`).join(', ')}`);
  notes.push(`参与去重的 exe 绝对路径 ${byExe.size} 条，重复组 ${dups.length} 组`);

  const merged = candidates.filter((x) => (x.pids || []).length > 1);
  notes.push(`多开合并证据：pids.length>1 的候选 ${merged.length} 个${merged.length ? `（例：${merged[0].name} pids=${JSON.stringify(merged[0].pids)}）` : ''}`);

  c.throwIfFailed();
  return notes.join('\n');
}

/* ================================================================== 用例 2：分级 */

async function case2() {
  const notes = [];
  const c = collector(notes);

  const real = await probePort(11434);
  notes.push(`probe --port 11434 → level=${real.level}（${real._ms}ms）；理由：${(real.reasons || [])[0] || '-'}`);
  c.ok(real.level === 'L1', `11434 的判定是 ${real.level}，期望 L1`);

  // 58241：本机当前未监听 → 如实记录为未验证，不臆造
  const p58241 = await probePort(58241);
  if (p58241.reachable === false) {
    notes.push(`probe --port 58241 → reachable=false（${(p58241.reasons || [])[0] || '-'}）。本机该端口未监听，此项无法验证，未计入通过。`);
  } else {
    notes.push(`probe --port 58241 → level=${p58241.level}`);
    c.ok(p58241.level !== 'L1', `58241（混合方言 + 路径 id）被判成 ${p58241.level}，绝不能是 L1`);
  }

  // 自建三个假上游
  const spaHtml = '<!doctype html><html><body><div id="app"></div><script src="/assets/index-abc123.js"></script></body></html>';
  const ea = await startUpstream('SPA 兜底', (req, res) => {
    const body = Buffer.from(spaHtml);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
    res.end(body);
  });
  const eb = await startUpstream('混合方言', (req, res) => {
    if (req.url === '/') {
      const body = Buffer.from('root-ok');
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
      return res.end(body);
    }
    return jsonRes(res, 200, {
      models: [{ name: 'llama3', model: 'llama3', type: 'llm' }],
      data: [{ id: 'C:\\x\\blob-1', object: 'model' }],
    });
  });
  const ec = await startUpstream('标准 OpenAI', (req, res) => {
    if (req.url === '/') {
      const body = Buffer.from('root-ok');
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
      return res.end(body);
    }
    return jsonRes(res, 200, { object: 'list', data: [{ id: 'm1', object: 'model' }] });
  });

  const ra = await probePort(ea.port);
  const rb = await probePort(eb.port);
  const rc = await probePort(ec.port);
  notes.push(`假上游(a) SPA 兜底 :${ea.port} → ${ra.level}`);
  notes.push(`假上游(b) 混合方言 :${eb.port} → ${rb.level}`);
  notes.push(`假上游(c) 标准 OpenAI:${ec.port} → ${rc.level}`);

  c.ok(['UNKNOWN', 'L2'].includes(ra.level), `(a) SPA 兜底被判成 ${ra.level}，期望 UNKNOWN/L2`);
  c.ok(ra.level !== 'L1', '(a) SPA 兜底被判成 L1 —— 假绿');
  c.ok(rb.level === 'L2', `(b) 混合方言被判成 ${rb.level}，期望 L2`);
  c.ok(rb.level !== 'L1', '(b) 混合方言被判成 L1 —— 假绿');
  c.ok(rc.level === 'L1', `(c) 标准 OpenAI 被判成 ${rc.level}，期望 L1`);

  await ea.close();
  await eb.close();
  await ec.close();

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 3：控制台鉴权 */

let consoleProc = null;
let consolePort = null;
let consoleToken = null;

async function ensureConsole() {
  if (consoleProc && !consoleProc.exited) return;
  consoleProc = spawnCli(['ui', '--port', '8902']);
  const m = await consoleProc.waitFor(/控制台已就绪 http:\/\/127\.0\.0\.1:(\d+)\//, 30000);
  consolePort = Number(m[1]);
  const page = await httpReq(`http://127.0.0.1:${consolePort}/`);
  assert(page.status === 200, `控制台首页返回 ${page.status}`);
  const tm = page.text.match(/<meta name="apx-console-token" content="([^"]+)">/);
  assert(tm, '首页里找不到 <meta name="apx-console-token">');
  consoleToken = tm[1];
  assert(consoleToken.startsWith('apx-console-'), `页面内嵌令牌前缀异常：${consoleToken.slice(0, 16)}`);
}

const api = (p, opts = {}) =>
  httpReq(`http://127.0.0.1:${consolePort}${p}`, {
    ...opts,
    headers: { ...(opts.headers || {}), 'x-apx-console-token': consoleToken },
  });

async function case3() {
  await ensureConsole();
  const notes = [];
  const c = collector(notes);

  const noTok = await httpReq(`http://127.0.0.1:${consolePort}/api/scan`);
  notes.push(`GET /api/scan 无令牌 → ${noTok.status}`);
  c.ok(noTok.status === 401, `无令牌访问 /api/scan 返回 ${noTok.status}，期望 401`);

  const withTok = await api('/api/scan');
  notes.push(`GET /api/scan 带令牌 → ${withTok.status}，total=${withTok.json?.total}，tookMs=${withTok.json?.tookMs}`);
  c.ok(withTok.status === 200, `带令牌访问 /api/scan 返回 ${withTok.status}`);
  c.ok((withTok.json?.total || 0) > 0, `/api/scan total=${withTok.json?.total}，期望 >0`);

  const badTok = await httpReq(`http://127.0.0.1:${consolePort}/api/scan`, { headers: { 'x-apx-console-token': 'apx-console-wrong' } });
  notes.push(`GET /api/scan 错误令牌 → ${badTok.status}`);
  c.ok(badTok.status === 401, `错误令牌返回 ${badTok.status}，期望 401`);

  const st = await api('/api/status');
  const stText = JSON.stringify(st.json);
  const realToken = readStateJson()?.token || '';
  const leaks = [];
  if (realToken && stText.includes(realToken)) leaks.push('状态接口原样返回了下游令牌');
  if (/sk-local-[A-Za-z0-9_-]{8,}/.test(stText)) leaks.push('状态接口出现 sk-local- 令牌');
  if (/sk-[a-z]+-[A-Za-z0-9_-]{16,}/.test(stText)) leaks.push('状态接口出现类 sk-* 长令牌');
  notes.push(`GET /api/status → ${st.status}，body 长度 ${stText.length}；泄漏检查：${leaks.length ? leaks.join('；') : '无'}`);
  c.ok(leaks.length === 0, leaks.join('；'));

  c.throwIfFailed();
  return notes.join('\n');
}

/* ================================================== 用例 5：真模型端到端（+ 7 准备） */

let proxyPort = null;
let proxyToken = null;
let modelAlias = null;

async function ollamaReachable() {
  try {
    const r = await httpReq('http://127.0.0.1:11434/v1/models', { signal: AbortSignal.timeout(2500) });
    return r.status === 200 && Array.isArray(r.json?.data);
  } catch {
    return false;
  }
}

async function case5() {
  await ensureConsole();
  if (!(await ollamaReachable())) skip('127.0.0.1:11434 不可达，依赖真实模型的端到端无法执行');

  const notes = [];
  const c = collector(notes);

  const start = await api('/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adapterId: 'local-openai-service', proxyPort: 8901 }),
  });
  notes.push(`POST /api/start {adapterId:local-openai-service} → ${start.status}，${(start.ms / 1000).toFixed(2)}s`);
  if (start.status !== 200) throw new Error(`启动失败：${start.status} ${start.text.slice(0, 300)}`);

  const snippet = await api('/api/snippet');
  proxyPort = start.json?.port;
  proxyToken = snippet.json?.apiKey;
  notes.push(`启动返回 port=${proxyPort}，baseUrl=${start.json?.baseUrl}，streaming=${start.json?.streaming}`);
  c.ok(Boolean(proxyPort), '启动响应没有 port');
  c.ok(Boolean(proxyToken), '/api/snippet 没有 apiKey');
  if (!proxyPort || !proxyToken) {
    c.throwIfFailed();
  }

  const models = await httpReq(`http://127.0.0.1:${proxyPort}/v1/models`, { headers: { authorization: `Bearer ${proxyToken}` } });
  const ids = (models.json?.data || []).map((m) => m.id);
  notes.push(`GET /v1/models → ${models.status}，模型 ${ids.length} 个：${ids.join(', ')}`);
  c.ok(models.status === 200 && ids.length > 0, `/v1/models 返回 ${models.status} / ${ids.length} 个模型`);
  if (!ids.length) {
    c.throwIfFailed();
  }
  modelAlias = ids[0];

  // 非流式
  const nonStream = await httpReq(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelAlias, messages: [{ role: 'user', content: '只回答两个字：你好' }] }),
    signal: AbortSignal.timeout(120000),
  });
  const content = nonStream.json?.choices?.[0]?.message?.content;
  notes.push(`非流式 chat/completions → ${nonStream.status}，${(nonStream.ms / 1000).toFixed(2)}s，content=${JSON.stringify(String(content || '').slice(0, 60))}`);
  c.ok(nonStream.status === 200, `非流式返回 ${nonStream.status}`);
  c.ok(typeof content === 'string' && content.trim().length > 0, '非流式 content 为空');

  // 流式：自己读原始字节，数帧 + 抓首块时间
  const streamStats = await streamOnce(proxyPort, proxyToken, modelAlias);
  notes.push(
    `流式：帧 ${streamStats.frames} 个，含[DONE]=${streamStats.hasDone}，首块 ${streamStats.ttft}ms（从发出请求算），总耗时 ${streamStats.total}ms，响应头 x-apx-stream=${streamStats.header}，拼出的正文=${JSON.stringify(streamStats.text.slice(0, 40))}`,
  );
  c.ok(streamStats.frames >= 3, `流式帧数 ${streamStats.frames}，期望 ≥3`);
  c.ok(streamStats.hasDone, '流式缺少 [DONE]');
  c.ok(streamStats.ttft < 3000, `首块到达 ${streamStats.ttft}ms，期望 <3000ms`);
  c.ok(streamStats.text.trim().length > 0, '流式正文拼出来是空的（可能只有心跳帧）');

  c.throwIfFailed();
  return notes.join('\n');
}

function streamOnce(port, token, model) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: '数到三' }], stream: true });
    const t0 = Date.now(); // 首块时延从"发出请求"开始算，才是用户真正感知的等待
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let frames = 0;
        let raw = '';
        let ttft = -1;
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (ttft < 0) ttft = Date.now() - t0;
          raw += chunk;
          frames += (chunk.match(/^data: /gm) || []).length;
        });
        res.on('end', () => {
          // 把每个 chunk 里的 content 拼起来，确认流里带的是真文本而不是心跳
          let text = '';
          for (const m of raw.matchAll(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
            try {
              text += JSON.parse(`"${m[1]}"`);
            } catch {
              text += m[1];
            }
          }
          resolve({
            frames,
            hasDone: raw.includes('[DONE]'),
            ttft: ttft < 0 ? 99999 : ttft,
            total: Date.now() - t0,
            header: res.headers['x-apx-stream'] || '(无)',
            text,
            rawTail: raw.slice(-120),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('流式客户端超时')));
    req.end(body);
  });
}

/* ============================================================ 用例 4a：令牌不得静默轮换（无代理时） */

async function case4a() {
  const notes = [];
  const c = collector(notes);

  const before = readStateRaw();
  const rawToken = readStateJson()?.token || '';
  const maskOf = (t) => (t ? `${t.slice(0, 12)}…${t.slice(-4)}` : '');
  assert(rawToken, '隔离状态目录里没有令牌（main 未 seed），用例前置条件不成立');

  try {
    // 把 state.json 写成半截内容：令牌命令必须明确报错，而不是悄悄生成新令牌
    writeStateRaw('{"token":');
    const show = await runCli(['token', 'show'], { timeout: 30000 });
    const showText = show.stdout + show.stderr;
    notes.push(`state.json 半截后执行 token show → 退出码 ${show.code}，输出：${showText.trim().split('\n')[0] || '(空)'}`);
    c.ok(show.code !== 0, `token show 在状态损坏时退出码 ${show.code}，期望非 0`);
    c.ok(/损坏/.test(showText), 'token show 在状态损坏时没有明确说“损坏”');
    c.ok(readStateRaw() === '{"token":', 'token show 私自改写了损坏的状态文件');

    const ad = await runCli(['adapters'], { timeout: 60000 });
    const adText = ad.stdout + ad.stderr;
    notes.push(`state.json 半截后执行 adapters → 退出码 ${ad.code}；含“读取失败”=${/读取失败/.test(adText)}，含新令牌=${/sk-local-[A-Za-z0-9_-]{8,}/.test(adText)}`);
    c.ok(!/sk-local-[A-Za-z0-9_-]{8,}/.test(adText), 'adapters 在状态损坏时悄悄生成了新令牌');
    c.ok(readStateRaw() === '{"token":', 'adapters 在状态损坏时悄悄改写了状态文件（= 令牌被静默轮换）');

    const stop = await runCli(['stop'], { timeout: 30000 });
    const stopText = stop.stdout + stop.stderr;
    notes.push(`state.json 半截后执行 stop → 退出码 ${stop.code}，输出：${stopText.trim().split('\n')[0] || '(空)'}`);
    c.ok(stop.code !== 0, `stop 在状态损坏时退出码 ${stop.code}，期望非 0`);
  } finally {
    // 隔离目录里最初可能没有 state.json —— 那就该删掉半截内容，而不是留着
    if (before === null) {
      try {
        fs.unlinkSync(STATE_FILE);
      } catch {
        /* ignore */
      }
    } else {
      writeStateRaw(before);
    }
  }

  const after = await runCli(['token', 'show'], { timeout: 30000 });
  const restored = readStateJson()?.token || '';
  notes.push(`还原后 token show → ${(after.stdout || '').trim().split('\n')[0]}；令牌未变=${restored === rawToken}（原始掩码 ${maskOf(rawToken)}）`);
  c.ok(restored === rawToken, `损坏-还原过程后令牌被改变：${maskOf(rawToken)} → ${maskOf(restored)}`);
  c.ok((after.stdout || '').includes(maskOf(rawToken)), 'token show 显示的掩码与 state.json 里的令牌不符');

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 4b：令牌一致性（代理运行中） */

async function case4b() {
  if (!proxyPort) skip('代理未启动（依赖用例 5），无法验证 snippet 稳定性');
  const notes = [];
  const c = collector(notes);

  const a = await api('/api/snippet');
  const b = await api('/api/snippet');
  const k1 = a.json?.apiKey;
  const k2 = b.json?.apiKey;
  const stateToken = readStateJson()?.token || '';
  notes.push(`连续两次 /api/snippet：${a.status}/${b.status}，apiKey 一致=${Boolean(k1) && k1 === k2}（${String(k1).slice(0, 12)}…）`);
  notes.push(`与 state.json 中的令牌一致=${k1 === stateToken}`);
  c.ok(Boolean(k1) && k1 === k2, `两次 /api/snippet 的 apiKey 不一致：${String(k1).slice(0, 12)} vs ${String(k2).slice(0, 12)}`);
  c.ok(k1 === stateToken, 'snippet 给出的 apiKey 与 state.json 里的令牌不同（下游会在重启后 401）');
  c.ok(a.json?.baseURL === `http://127.0.0.1:${proxyPort}/v1`, `snippet baseURL 异常：${a.json?.baseURL}`);

  // 运行态（body 里带 credential/stats 等丰富字段）才是"令牌会不会被摊在状态接口上"的真正考场
  const stNow = await api('/api/status');
  const stText = JSON.stringify(stNow.json);
  const leaks = [];
  if (stateToken && stText.includes(stateToken)) leaks.push('原样返回下游令牌');
  if (/sk-local-[A-Za-z0-9_-]{8,}/.test(stText)) leaks.push('出现 sk-local- 令牌');
  if (/sk-[a-z]+-[A-Za-z0-9_-]{16,}/.test(stText)) leaks.push('出现类 sk-* 长令牌');
  notes.push(`运行态 GET /api/status → ${stNow.status}，body ${stText.length}B；泄漏检查：${leaks.length ? leaks.join('；') : '无'}`);
  c.ok(leaks.length === 0, `运行态 /api/status 泄漏令牌：${leaks.join('；')}`);
  c.ok(stText.length > 200, `运行态 /api/status body 只有 ${stText.length}B，样本不足以证明不泄漏`);

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 7：安全边界 */

async function case7() {
  if (!proxyPort || !proxyToken) skip('代理未启动（依赖用例 5），无法验证');
  const notes = [];
  const c = collector(notes);
  const base = `http://127.0.0.1:${proxyPort}`;

  const opt = await httpReq(`${base}/v1/models`, {
    method: 'OPTIONS',
    headers: { origin: 'http://evil.com', 'access-control-request-method': 'POST', authorization: `Bearer ${proxyToken}` },
  });
  const optAcao = Object.keys(opt.headers).filter((h) => h.startsWith('access-control-'));
  notes.push(`OPTIONS /v1/models → ${opt.status}，access-control-* 头 ${optAcao.length} 个${optAcao.length ? '：' + optAcao.join(',') : ''}`);
  c.ok(opt.status === 403, `OPTIONS 返回 ${opt.status}，期望 403`);
  c.ok(optAcao.length === 0, `OPTIONS 响应带了 CORS 头：${optAcao.join(',')}`);

  const evil = await httpReq(`${base}/v1/models`, { headers: { origin: 'http://evil.com', authorization: `Bearer ${proxyToken}` } });
  const evilAcao = evil.headers['access-control-allow-origin'];
  notes.push(`GET /v1/models + Origin: http://evil.com → ${evil.status}，ACAO=${evilAcao || '(无)'}`);
  c.ok(!evilAcao, `带恶意 Origin 时返回了 ACAO=${evilAcao}`);

  const cross = await httpReq(`${base}/v1/models`, { headers: { 'sec-fetch-site': 'cross-site', authorization: `Bearer ${proxyToken}` } });
  notes.push(`GET /v1/models + Sec-Fetch-Site: cross-site → ${cross.status}`);
  c.ok(cross.status === 403, `跨站请求返回 ${cross.status}，期望 403`);

  const noAuth = await httpReq(`${base}/v1/models`);
  const noAuthMsg = noAuth.json?.error?.message || '';
  notes.push(`GET /v1/models 无 token → ${noAuth.status}，www-authenticate=${noAuth.headers['www-authenticate'] || '(无)'}`);
  notes.push(`401 message=${JSON.stringify(noAuthMsg)}`);
  c.ok(noAuth.status === 401, `无 token 返回 ${noAuth.status}，期望 401`);
  // R8-2：文案不得写死令牌前缀（老安装的令牌前缀可能不是 sk-local-）
  c.ok(!/sk-local-/.test(noAuthMsg), `401 文案仍写死 "sk-local-"：${noAuthMsg}`);

  const wrongAuth = await httpReq(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local-wrongtokenwrongtoken' } });
  notes.push(`GET /v1/models 错误 token → ${wrongAuth.status}`);
  c.ok(wrongAuth.status === 401, `错误 token 返回 ${wrongAuth.status}，期望 401`);

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 8：停止与回收 */

async function case8() {
  if (!proxyPort) skip('代理未启动（依赖用例 5），无法验证');
  const notes = [];
  const c = collector(notes);

  const pidsBefore = await apxNodePids();

  const stop = await api('/api/stop', { method: 'POST' });
  notes.push(`POST /api/stop → ${stop.status} ${JSON.stringify(stop.json)?.slice(0, 160)}`);
  c.ok(stop.status === 200, `/api/stop 返回 ${stop.status}`);

  const tcp = await tcpProbe(proxyPort);
  notes.push(`停后 TCP 连 ${proxyPort} → ${tcp.ok ? '仍可连接（未释放）' : '被拒（' + tcp.reason + '）'}`);
  c.ok(!tcp.ok, `停止后端口 ${proxyPort} 仍可连接`);

  const curl = await curlNoproxy(`http://127.0.0.1:${proxyPort}/v1/models`);
  notes.push(`curl --noproxy '*' → http_code=${curl.httpCode}（000/拒绝 表示已释放）`);
  c.ok(curl.httpCode === '000', `curl 仍能连上：http_code=${curl.httpCode}`);

  const st = readStateJson() || {};
  notes.push(`state.json：pid=${st.pid}，proxyPort=${st.proxyPort}，adapterId=${st.adapterId}，serviceFacePid=${st.serviceFacePid}`);
  c.ok(st.pid === null || st.pid === undefined, `state.json pid=${st.pid}，期望 null`);
  c.ok(st.proxyPort === null || st.proxyPort === undefined, `state.json proxyPort=${st.proxyPort}，期望 null`);

  const pidsAfter = await apxNodePids();
  const leftover = pidsAfter.filter((p) => !pidsBefore.includes(p));
  const consolePid = consoleProc?.child?.pid;
  const unexpected = leftover.filter((p) => p !== consolePid);
  notes.push(`本项目 node 进程：停前 ${pidsBefore.length} 个 → 停后 ${pidsAfter.length} 个；新增 ${leftover.length} 个，其中非控制台 ${unexpected.length} 个`);
  c.ok(unexpected.length === 0, `停止后仍有残留代理进程：${unexpected.join(',')}`);
  notes.push('说明：local-openai-service 是 port-scan 型，不自起上游进程，因此“上游子进程回收”在该适配器下无对象可查（记为 N/A）。');

  // 顺带确认没有误杀别人的 ollama
  if (await ollamaReachable()) {
    notes.push('停后 11434 仍可达 → 未误杀上游服务');
  }

  proxyPort = null;
  proxyToken = null;
  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 6：断连取消 */

async function case6() {
  const notes = [];
  const c = collector(notes);

  const up = await startUpstream('SSE 慢上游', async (req, res, events) => {
    if (req.url === '/v1/models') return jsonRes(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
    if (req.url !== '/v1/chat/completions') return jsonRes(res, 404, { error: { message: 'nf' } });
    await readBody(req);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const openedAt = Date.now();
    events.push({ type: 'sse_open', at: openedAt });
    let sent = 0;
    let closed = false;
    res.on('close', () => {
      closed = true;
      events.push({ type: 'sse_close', at: Date.now(), sent });
    });
    const timer = setInterval(() => {
      if (closed) return clearInterval(timer);
      if (Date.now() - openedAt > 30000) {
        clearInterval(timer);
        if (!closed) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }
      sent++;
      res.write(
        `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [{ index: 0, delta: { content: 'tok' }, finish_reason: null }] })}\n\n`,
      );
    }, 50);
  });

  const serve = spawnCli(['serve', '--adapter', 'openai-passthrough', '--upstream-port', String(up.port), '--port', String(await FREE_PORT())]);
  try {
    const banner = await serve.waitFor(/本地代理已就绪\s+http:\/\/127\.0\.0\.1:(\d+)\/v1/, 30000);
    const port = Number(banner[1]);
    const tokMatch = serve.out.match(/apiKey\s+:\s+(\S+)/);
    assert(tokMatch, '就绪横幅里没有 apiKey');
    notes.push(`apx serve 起在 ${port}，上游假 SSE 在 ${up.port}`);

    const model = 'fake-model';
    const abortAt = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: true });
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${tokMatch[1]}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let chunks = 0;
          res.on('data', () => {
            chunks++;
            if (chunks === 2) {
              const at = Date.now();
              req.destroy(); // 客户端主动 abort
              resolve(at);
            }
          });
          res.on('end', () => resolve(-1));
        },
      );
      req.on('error', (e) => {
        if (/ECONNRESET|socket hang up/i.test(e.message)) return; // abort 后的正常报错
        reject(e);
      });
      setTimeout(() => reject(new Error('3000ms 内没收到两帧，无法 abort')), 8000);
      req.end(body);
    });
    assert(abortAt > 0, '客户端在收到帧之前就结束了');

    // 等到上游确认断开，或超时 2.5s
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (up.events.some((e) => e.type === 'sse_close')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const closeEv = up.events.find((e) => e.type === 'sse_close');
    const opened = up.events.find((e) => e.type === 'sse_open');
    notes.push(`上游事件：open=${opened ? 'Y' : 'N'}，close=${closeEv ? 'Y' : 'N'}`);
    c.ok(Boolean(closeEv), '客户端 abort 后 2.5s 内上游连接没有断开（额度会继续被烧）');
    if (closeEv) {
      const lag = closeEv.at - abortAt;
      notes.push(`客户端 abort → 上游连接断开：${lag}ms（abort 前上游已推送 ${closeEv.sent} 块）`);
      c.ok(lag < 1500, `断开延迟 ${lag}ms，期望 <1500ms`);
    }
  } finally {
    await serve.stop();
    await up.close();
  }

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 9：stop 防误杀 */

async function case9() {
  const notes = [];
  const c = collector(notes);

  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { windowsHide: true, stdio: 'ignore' });
  children.push(victim);
  await new Promise((r) => setTimeout(r, 400));
  const victimPid = victim.pid;
  assert(await tasklistHas(victimPid), `诱饵进程 ${victimPid} 没起来`);

  const before = readStateRaw();
  const cur = readStateJson() || {};
  const realExe = await psOutput(`(Get-Process -Id ${process.pid}).Path`);

  try {
    // 情形一：exePath 伪造 → 必须跳过
    writeStateRaw(
      JSON.stringify(
        {
          ...cur,
          pid: victimPid,
          proxyPort: 45999,
          adapterId: 'fake',
          proxyProc: { exePath: 'C:\\definitely\\not\\ours.exe', startMs: Date.now() },
        },
        null,
        2,
      ),
    );
    const r1 = await runCli(['stop'], { timeout: 60000 });
    const t1 = r1.stdout + r1.stderr;
    const alive1 = await tasklistHas(victimPid);
    notes.push(`伪造 exePath 后 apx stop → 退出码 ${r1.code}；输出：${t1.trim().replace(/\n/g, ' ⏎ ') || '(空)'}`);
    notes.push(`诱饵进程 ${victimPid} 存活=${alive1}`);
    c.ok(alive1, `apx stop 误杀了无关进程 ${victimPid}`);
    c.ok(/已跳过/.test(t1), 'apx stop 输出里没有“已跳过”');
    c.ok((readStateJson() || {}).pid === null, '状态没有被清空');

    // 情形二：exePath 正确但启动时间晚于记录（pid 复用判定）→ 也必须跳过
    writeStateRaw(
      JSON.stringify(
        {
          ...(readStateJson() || cur),
          pid: victimPid,
          proxyPort: 45999,
          adapterId: 'fake',
          proxyProc: { exePath: realExe.trim(), startMs: Date.now() + 3600_000 },
        },
        null,
        2,
      ),
    );
    const r2 = await runCli(['stop'], { timeout: 60000 });
    const t2 = r2.stdout + r2.stderr;
    const alive2 = await tasklistHas(victimPid);
    notes.push(`exePath 正确但 startMs 在未来 1h → apx stop 输出：${t2.trim().replace(/\n/g, ' ⏎ ') || '(空)'}；存活=${alive2}`);
    c.ok(alive2, `启动时间校验失效，误杀了 ${victimPid}`);
    c.ok(/已跳过/.test(t2), '情形二没有输出“已跳过”');

    // 情形三（对照）：记录完全正确时应该真的回收。用一个自己的诱饵验证"该杀的时候能杀"
    const victim2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { windowsHide: true, stdio: 'ignore' });
    children.push(victim2);
    await new Promise((r) => setTimeout(r, 400));
    const exe2 = (await psOutput(`(Get-Process -Id ${victim2.pid}).Path`)).trim();
    const start2 = (
      await psOutput(
        `$p=Get-Process -Id ${victim2.pid}; [int64](($p.StartTime).ToUniversalTime() - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds`,
      )
    ).trim();
    writeStateRaw(
      JSON.stringify({ ...(readStateJson() || cur), pid: victim2.pid, proxyPort: 45998, proxyProc: { exePath: exe2, startMs: Number(start2) } }, null, 2),
    );
    const r3 = await runCli(['stop'], { timeout: 60000 });
    await new Promise((r) => setTimeout(r, 600));
    const alive3 = await tasklistHas(victim2.pid);
    notes.push(`对照：记录完全匹配 → apx stop 输出：${(r3.stdout + r3.stderr).trim().replace(/\n/g, ' ⏎ ')}；该进程存活=${alive3}（期望 false）`);
    c.ok(!alive3, '对照用例失败：记录完全匹配时 apx stop 没能回收进程（漏杀）');
  } finally {
    if (before !== null) writeStateRaw(before);
    try {
      victim.kill();
    } catch {
      /* ignore */
    }
  }

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 用例 10：错误语义 */

async function case10() {
  const notes = [];
  const c = collector(notes);

  const up = await startUpstream('错误码上游', async (req, res) => {
    if (req.url === '/v1/models')
      return jsonRes(res, 200, {
        object: 'list',
        data: [
          { id: 'rl', object: 'model' },
          { id: 'rlbody', object: 'model' },
          { id: 'rlbodybig', object: 'model' },
          { id: 'rlhttpdate', object: 'model' },
          { id: 'rlstream', object: 'model' },
          { id: 'err503', object: 'model' },
          { id: 'err502', object: 'model' },
          { id: 'err500', object: 'model' },
          { id: 'html200', object: 'model' },
          { id: 'unauth', object: 'model' },
          { id: 'ok', object: 'model' },
        ],
      });
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.model === 'rl')
        return jsonRes(res, 429, { error: { message: 'slow down', type: 'rate_limit_exceeded' } }, { 'retry-after': '7' });
      // 变体：只有 body 里的 retryAfterMs，没有响应头 —— 也要能折算成 retry-after
      if (body.model === 'rlbody') return jsonRes(res, 429, { error: { message: 'slow down' }, retryAfterMs: 7000 });
      // 变体：大数值（约 8.77 小时），验证不会被截断/取整错
      if (body.model === 'rlbodybig') return jsonRes(res, 429, { error: { message: 'quota exhausted' }, retryAfterMs: 31556000 });
      // 变体：HTTP-date 形式的 Retry-After（RFC 允许两种格式）
      if (body.model === 'rlhttpdate')
        return jsonRes(
          res,
          429,
          { error: { message: 'slow down' } },
          { 'retry-after': new Date(Date.now() + 7000).toUTCString() },
        );
      // 变体：流式请求也被限流 —— 下游必须是 429 + 头，且绝不能吐 SSE 帧
      if (body.model === 'rlstream') return jsonRes(res, 429, { error: { message: 'slow down' } }, { 'retry-after': '5' });
      // R9-2：503 也要带 retry-after（此前只有 429 有断言）
      if (body.model === 'err503') return jsonRes(res, 503, { error: { message: 'upstream overloaded' } }, { 'retry-after': '4' });
      if (body.model === 'err502') return jsonRes(res, 502, { error: { message: 'bad gateway upstream' } });
      if (body.model === 'err500') return jsonRes(res, 500, { error: { message: 'upstream internal' } });
      // 200 但 body 不是 JSON（典型：SPA 兜底 HTML）—— 这是"形状不对"，不是"不可达"
      if (body.model === 'html200') {
        const h = Buffer.from('<!doctype html><html><body><div id="app"></div></body></html>');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': h.length });
        return res.end(h);
      }
      if (body.model === 'unauth') return jsonRes(res, 401, { error: { message: 'invalid api key provided', type: 'invalid_request_error' } });
      return jsonRes(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    }
    return jsonRes(res, 404, { error: { message: 'nf' } });
  });

  const serve = spawnCli(['serve', '--adapter', 'openai-passthrough', '--upstream-port', String(up.port), '--port', String(await FREE_PORT())]);
  try {
    const banner = await serve.waitFor(/本地代理已就绪\s+http:\/\/127\.0\.0\.1:(\d+)\/v1/, 30000);
    const port = Number(banner[1]);
    const tok = serve.out.match(/apiKey\s+:\s+(\S+)/)?.[1];
    assert(tok, '横幅里没有 apiKey');

    const post = (model) =>
      httpReq(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(30000),
      });

    const rl = await post('rl');
    notes.push(
      `上游 429+Retry-After:7 → 代理 ${rl.status}，error.code=${rl.json?.error?.code}，retry-after 头=${rl.headers['retry-after'] || '(缺失)'}，body=${rl.text.slice(0, 120)}`,
    );
    c.ok(rl.status === 429, `上游 429 被代理改写成 ${rl.status}（期望 429，不能是 500/502）`);
    c.ok(rl.status !== 500 && rl.status !== 502, `上游 429 被吞成 ${rl.status}`);
    c.ok(Boolean(rl.headers['retry-after']), '上游的 Retry-After 没有透传给客户端');

    // 只有 body.retryAfterMs（无响应头）的变体：验证折算分支，避免"只认头"的假修复
    const rlBody = await post('rlbody');
    notes.push(`上游 429+body.retryAfterMs:7000（无响应头）→ 代理 ${rlBody.status}，retry-after 头=${rlBody.headers['retry-after'] || '(缺失)'}`);
    c.ok(rlBody.status === 429, `body 变体的 429 被改写成 ${rlBody.status}`);
    c.ok(Number(rlBody.headers['retry-after']) === 7, `body.retryAfterMs 没有折算成 retry-after=7（实际 ${rlBody.headers['retry-after'] || '缺失'}）`);

    // 大数值不被截断
    const rlBig = await post('rlbodybig');
    const bigSec = Number(rlBig.headers['retry-after']);
    notes.push(`上游 429+body.retryAfterMs:31556000 → 代理 ${rlBig.status}，retry-after=${rlBig.headers['retry-after'] || '(缺失)'}（期望 ≈31556 秒）`);
    c.ok(rlBig.status === 429, `大数值变体状态码 ${rlBig.status}`);
    c.ok(bigSec >= 31555 && bigSec <= 31557, `31556000ms 折算成 ${rlBig.headers['retry-after']} 秒，期望 31556 附近`);

    // HTTP-date 形式的 Retry-After
    const rlDate = await post('rlhttpdate');
    const dateSec = Number(rlDate.headers['retry-after']);
    notes.push(`上游 429+Retry-After:<HTTP-date +7s> → 代理 ${rlDate.status}，retry-after=${rlDate.headers['retry-after'] || '(缺失)'}（期望 5–9 秒）`);
    c.ok(rlDate.status === 429, `HTTP-date 变体状态码 ${rlDate.status}`);
    c.ok(dateSec >= 5 && dateSec <= 9, `HTTP-date 折算成 ${rlDate.headers['retry-after']} 秒，期望 5–9`);

    // 流式路径被限流：必须 429 + 头，且一个 SSE 帧都不能吐
    const rlStream = await httpReq(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'rlstream', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      signal: AbortSignal.timeout(30000),
    });
    const hasFrame = /^data: /m.test(rlStream.text);
    notes.push(
      `流式(stream:true) + 上游 429 → 代理 ${rlStream.status}，retry-after=${rlStream.headers['retry-after'] || '(缺失)'}，SSE 帧=${hasFrame ? '有(不该有)' : '无'}，content-type=${rlStream.headers['content-type']}`,
    );
    c.ok(rlStream.status === 429, `流式 429 被改写成 ${rlStream.status}（期望 429）`);
    c.ok(Boolean(rlStream.headers['retry-after']), '流式 429 没有回 retry-after 头');
    c.ok(!hasFrame, '流式 429 仍然吐出了 SSE data: 帧（下游会当成正常流继续读）');
    // 不能"先给 200 + event-stream 再报错"——那会让客户端已经进入流式状态
    c.ok(
      /application\/json/i.test(rlStream.headers['content-type'] || ''),
      `流式 429 的 content-type 是 ${rlStream.headers['content-type'] || '(空)'}，期望 application/json`,
    );

    // R9-2（主理人裁定）：合法 HTTP 状态必须原样透传，5xx 不得静默归一成 502
    const r503 = await post('err503');
    notes.push(
      `上游 503+Retry-After:4 → 代理 ${r503.status}，retry-after=${r503.headers['retry-after'] || '(缺失)'}，code=${r503.json?.error?.code}`,
    );
    c.ok(r503.status === 503, `上游 503 被改写成 ${r503.status}，期望严格 503（5xx 不得静默归一）`);
    c.ok(Number(r503.headers['retry-after']) === 4, `503 的 retry-after 未透传（实际 ${r503.headers['retry-after'] || '缺失'}）`);

    const r502 = await post('err502');
    notes.push(`上游 502 → 代理 ${r502.status}`);
    c.ok(r502.status === 502, `上游 502 被改写成 ${r502.status}，期望 502`);

    const r500 = await post('err500');
    notes.push(
      `上游 500 → 代理 ${r500.status}（实测实现为"4xx/5xx 全量原样透传"，只有 status=0/传输失败才归 502；契约文字曾写 500→502，已被实测更正）`,
    );
    c.ok(r500.status === 500, `上游 500 应原样透传 500（当前实现口径），实际 ${r500.status}`);

    const un = await post('unauth');
    const msg = un.json?.error?.message || '';
    notes.push(`上游 401 → 代理 ${un.status}，error.code=${un.json?.error?.code}，message=${JSON.stringify(msg.slice(0, 80))}`);
    c.ok(un.status === 401, `上游 401 被代理改写成 ${un.status}（期望 401）`);
    c.ok(msg.trim().length > 0, '401 的 message 为空/不可读');

    const ok = await post('ok');
    notes.push(`对照：上游 200 → 代理 ${ok.status}，content=${JSON.stringify(ok.json?.choices?.[0]?.message?.content)}`);
    c.ok(ok.status === 200, `正常路径返回 ${ok.status}`);

    // 边界①：上游 200 但 body 不是 JSON（HTML 兜底页）→ 502 + apx_upstream_error，不能算 unreachable
    const rHtml = await post('html200');
    notes.push(`上游 200+text/html → 代理 ${rHtml.status}，code=${rHtml.json?.error?.code}`);
    c.ok(rHtml.status === 502, `200 非 JSON 应归 502，实际 ${rHtml.status}`);
    c.ok(rHtml.json?.error?.code === 'apx_upstream_error', `200 非 JSON 的 code 应为 apx_upstream_error，实际 ${rHtml.json?.error?.code}`);
    c.ok(
      rHtml.json?.error?.code !== 'apx_upstream_unreachable',
      '200 非 JSON 被误判成"不可达"（会让用户去查网络，实际是上游形状不对）',
    );

    // 边界②：连响应都没有（把上游关掉）→ 502 + apx_upstream_unreachable
    await up.close();
    const rDown = await post('ok');
    notes.push(`上游已关闭 → 代理 ${rDown.status}，code=${rDown.json?.error?.code}`);
    c.ok(rDown.status === 502, `上游断连应归 502，实际 ${rDown.status}`);
    c.ok(
      rDown.json?.error?.code === 'apx_upstream_unreachable',
      `上游断连的 code 应为 apx_upstream_unreachable，实际 ${rDown.json?.error?.code}`,
    );
  } finally {
    await serve.stop();
    await up.close();
  }

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 第 2 轮：R8-4 token rotate 守卫 */

const maskOfToken = (t) => (t ? `${t.slice(0, 12)}…${t.slice(-4)}` : '');

async function case11() {
  await ensureConsole();
  const notes = [];
  const c = collector(notes);

  const start = await api('/api/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adapterId: 'local-openai-service', proxyPort: 8903 }),
  });
  if (start.status !== 200) throw new Error(`起代理失败 ${start.status} ${start.text.slice(0, 200)}`);
  const tokBefore = readStateJson()?.token || '';
  notes.push(`代理由 8903 起来，当前令牌 ${maskOfToken(tokBefore)}`);

  // 运行中 rotate 必须被拒绝：否则运行中的进程仍持旧令牌，下游立刻全 401
  const rotate = await runCli(['token', 'rotate'], { timeout: 30000 });
  const rotateText = rotate.stdout + rotate.stderr;
  const tokAfter = readStateJson()?.token || '';
  notes.push(`运行中 rotate → 退出码 ${rotate.code}；输出：${rotateText.trim().replace(/\n/g, ' ⏎ ') || '(空)'}`);
  notes.push(`运行中 rotate 后落盘令牌变化=${tokAfter !== tokBefore}`);
  c.ok(rotate.code !== 0, `运行中 rotate 退出码 ${rotate.code}，期望非 0（运行中应拒绝）`);
  c.ok(tokAfter === tokBefore, '运行中 rotate 改掉了落盘令牌（运行中代理仍持旧令牌 → 下游立刻全 401）');
  // 文案必须能指导用户下一步：含"运行" + 含"apx stop"或"停止"
  c.ok(/运行/.test(rotateText), `运行中 rotate 的文案没有提到"运行"：${rotateText.trim().slice(0, 120)}`);
  c.ok(/apx stop|停止/.test(rotateText), `运行中 rotate 的文案没有告诉用户先停止（apx stop / 停止）：${rotateText.trim().slice(0, 120)}`);

  await api('/api/stop', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 400));

  const rotate2 = await runCli(['token', 'rotate'], { timeout: 30000 });
  const tokFinal = readStateJson()?.token || '';
  notes.push(`停止后 rotate → 退出码 ${rotate2.code}，输出：${(rotate2.stdout || '').trim().split('\n')[0] || '(空)'}；新旧不同=${tokFinal !== tokBefore}`);
  c.ok(rotate2.code === 0, `停止后 rotate 退出码 ${rotate2.code}，期望 0`);
  c.ok(tokFinal !== tokBefore, '停止后 rotate 没有换掉令牌');

  const check = await runCli(['token', 'show'], { timeout: 30000 });
  c.ok((check.stdout || '').includes(maskOfToken(tokFinal)), 'rotate 后 token show 与落盘值不一致');

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 第 2 轮：R8-5 首屏只看已适配 */

async function case12() {
  await ensureConsole();
  const notes = [];
  const c = collector(notes);

  // ---- 契约（主理人裁定，已钉死，不再探测参数名）----
  //   GET /api/scan           → 全量 + 每个候选带 matchedBy + 顶层 matchedTotal
  //   GET /api/scan?matched=1 → 只返回 matchedBy 非空的候选，条数 === matchedTotal
  //   GET /api/scan?matched=0 → 与不带参数等价（没有"关闭"专用参数）
  const fullRes = await api('/api/scan');
  const jf = fullRes.json || {};
  const fullList = Array.isArray(jf.candidates) ? jf.candidates : [];
  const fullCount = fullList.length;
  const total = typeof jf.total === 'number' ? jf.total : fullCount;
  const matchedTotal =
    typeof jf.matchedTotal === 'number' ? jf.matchedTotal : Array.isArray(jf.matchedBy) ? jf.matchedBy.length : undefined;
  notes.push(
    `不带参数 /api/scan → ${fullRes.status}，candidates=${fullCount}，total=${total}，matchedTotal=${matchedTotal}，matchedBy=${Array.isArray(jf.matchedBy) ? jf.matchedBy.length + ' 项' : JSON.stringify(jf.matchedBy)}`,
  );

  const m1 = await api('/api/scan?matched=1');
  const j1 = m1.json || {};
  const list1 = Array.isArray(j1.candidates) ? j1.candidates : [];
  notes.push(`?matched=1 → ${m1.status}，candidates=${list1.length}，total=${j1.total}`);

  const m0 = await api('/api/scan?matched=0');
  const j0 = m0.json || {};
  const list0 = Array.isArray(j0.candidates) ? j0.candidates : [];
  notes.push(`?matched=0 → ${m0.status}，candidates=${list0.length}`);

  c.ok(typeof matchedTotal === 'number', 'payload 里既没有 matchedTotal 也没有 matchedBy（R9-3 未交付）');
  c.ok(fullCount > 0, '不带参数的 /api/scan 返回 0 条');
  // 核心一致性：过滤视图条数 === matchedTotal
  if (typeof matchedTotal === 'number') {
    c.ok(list1.length === matchedTotal, `?matched=1 返回 ${list1.length} 条 ≠ matchedTotal ${matchedTotal}`);
    c.ok(matchedTotal < fullCount, `matchedTotal ${matchedTotal} 未小于全量 ${fullCount}（过滤形同虚设）`);
  }
  // ?matched=0 与不带参数等价
  c.ok(list0.length === fullCount, `?matched=0 返回 ${list0.length} 条，应与不带参数（${fullCount}）等价`);

  // 只返回 matchedBy 非空的候选（payload 若带该字段则逐条校验）
  const withField = list1.filter((x) => Object.prototype.hasOwnProperty.call(x, 'matchedBy'));
  if (withField.length) {
    const empty = withField.filter((x) => !Array.isArray(x.matchedBy) || x.matchedBy.length === 0);
    notes.push(`?matched=1 里 matchedBy 字段为空的条目：${empty.length}`);
    c.ok(empty.length === 0, `?matched=1 里混进了 ${empty.length} 条 matchedBy 为空的候选`);
  }

  // 第三段交叉校验：?matched=1 的条数 === 不带参数时 matchedBy 非空的条数
  const withMatchedField = fullList.filter((x) => Object.prototype.hasOwnProperty.call(x, 'matchedBy'));
  if (withMatchedField.length === fullList.length && fullList.length) {
    const nonEmpty = withMatchedField.filter((x) => Array.isArray(x.matchedBy) && x.matchedBy.length > 0).length;
    notes.push(`不带参数时 matchedBy 非空的候选 ${nonEmpty} 条 vs ?matched=1 返回 ${list1.length} 条`);
    c.ok(nonEmpty === list1.length, `?matched=1 返回 ${list1.length} 条 ≠ 不带参数时 matchedBy 非空的 ${nonEmpty} 条`);
  } else {
    notes.push('候选上没有逐条 matchedBy 字段 → 第三段交叉校验跳过（仅比对 matchedTotal）');
  }

  // R9-1 验收点：卸载器/安装器不得进过滤视图
  const noiseRe = /^(uninstall|unins\d*|unins|setup|installer)/i;
  const noise = list1.filter((x) => noiseRe.test((x.exePath || '').split(/[\\/]/).pop() || ''));
  notes.push(
    `?matched=1 条目：${list1
      .map((x) => `${x.name}(${(x.exePath || '').split(/[\\/]/).pop() || '-'})`)
      .join(' / ')
      .slice(0, 320)}`,
  );
  c.ok(noise.length === 0, `过滤视图仍含卸载/安装类噪声 ${noise.length} 条：${noise.map((x) => x.name).join(', ')}`);

  // 无命中时 UI 不能空白
  const page = await httpReq(`http://127.0.0.1:${consolePort}/`);
  const emptyOk = /未检测到已适配软件|没有扫描到候选/.test(page.text);
  notes.push(`页面空态提示文案存在=${emptyOk}`);
  c.ok(emptyOk, 'UI 里找不到空态提示文案（无命中时会白屏）');

  // 真正要保证的：不选任何候选，也能一键起 port-scan 型适配器（口径 A 下这才是"首屏有用"）
  if (!(await ollamaReachable())) {
    notes.push('11434 不可达 → "空候选直接启动 port-scan 型" 这条无法执行，已跳过（不计入通过）');
  } else {
    const s = await api('/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapterId: 'local-openai-service', proxyPort: 8905 }),
    });
    notes.push(`不选候选直接 POST /api/start {adapterId:local-openai-service} → ${s.status}`);
    c.ok(s.status === 200, `空候选启动返回 ${s.status}：${s.text.slice(0, 160)}`);
    if (s.status === 200) {
      const sn = await api('/api/snippet');
      const mm = await httpReq(`http://127.0.0.1:${s.json.port}/v1/models`, {
        headers: { authorization: `Bearer ${sn.json?.apiKey}` },
      });
      const n = (mm.json?.data || []).length;
      notes.push(`空候选启动后 /v1/models → ${mm.status}，模型 ${n} 个`);
      c.ok(mm.status === 200 && n > 0, `/v1/models 返回 ${mm.status} / ${n} 个模型（期望非空）`);
      await api('/api/stop', { method: 'POST' });
    }
  }

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 第 2 轮：R8-2 401 文案 + R8-3 注释对齐 */

async function case14() {
  await ensureConsole();
  const notes = [];
  const c = collector(notes);

  // 401 文案：代理已存在就复用，--round2 单跑时自己起一个（8904）
  let port = proxyPort;
  let startedHere = false;
  if (!port) {
    const s = await api('/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapterId: 'local-openai-service', proxyPort: 8904 }),
    });
    if (s.status !== 200) throw new Error(`起代理失败 ${s.status} ${s.text.slice(0, 200)}`);
    port = s.json?.port;
    startedHere = true;
  }

  try {
    const base = `http://127.0.0.1:${port}`;
    const noTok = await httpReq(`${base}/v1/models`);
    const msg1 = noTok.json?.error?.message || '';
    const wrong = await httpReq(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local-definitely-wrong-token' } });
    const msg2 = wrong.json?.error?.message || '';
    notes.push(`无 token 401 message=${JSON.stringify(msg1)}`);
    notes.push(`错 token 401 message=${JSON.stringify(msg2)}`);
    c.ok(noTok.status === 401 && wrong.status === 401, `401 状态码异常：${noTok.status}/${wrong.status}`);
    c.ok(!/sk-local-/.test(msg1), `R8-2 未完成：401 文案仍写死 "sk-local-"：${msg1}`);
    c.ok(!/sk-local-/.test(msg2), `R8-2 未完成：错误令牌的文案仍写死 "sk-local-"：${msg2}`);
    c.ok(msg1.trim().length > 0, '401 文案为空');
  } finally {
    if (startedHere) await api('/api/stop', { method: 'POST' });
  }

  // R8-3：token.test.mjs 的头部注释必须与"已隔离"的实现一致
  const tf = path.join(ROOT, 'test', 'token.test.mjs');
  const head = fs.readFileSync(tf, 'utf8').split(/\r?\n/).slice(0, 20).join('\n');
  notes.push(`token.test.mjs 前 20 行：\n${head}`);
  c.ok(!/会临时改写真实的\s*~\/\.apx\/state\.json|改写真实的\s*~\/\.apx\/state\.json/.test(head), 'R8-3 未完成：注释仍声称会改写真实 ~/.apx/state.json');
  c.ok(/_isolate-state/.test(head), 'token.test.mjs 头部没有 import ./_isolate-state.mjs（说明没有隔离状态）');

  c.throwIfFailed();
  return notes.join('\n');
}

/* ============================================================ 第 2 轮：launch-assigned 进程树回收 */

// 假上游：-e 内联（避免额外脚本文件），打印 "server password <random>"，/api/model 需要 Basic 鉴权
const LAUNCH_SVC = [
  'const http=process.getBuiltinModule("http");',
  'const argv=process.argv;',
  'const gi=(k,d)=>{const i=argv.indexOf(k);return i>=0&&argv[i+1]?argv[i+1]:d};',
  'const port=Number(gi("--port",0));const host=gi("--hostname","127.0.0.1");',
  'const secret="pw"+Math.random().toString(36).slice(2,10);',
  'const srv=http.createServer((req,res)=>{',
  'if(req.url==="/api/model"){',
  'const h=String(req.headers.authorization||"");',
  'if(h.indexOf("Basic ")!==0){res.writeHead(401,{"content-type":"application/json"});return res.end("{\\"error\\":1}");}',
  'const b=JSON.stringify({data:[{id:"fake",name:"fake-model",providerID:"qa"}]});',
  'res.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(b)});return res.end(b);',
  '}',
  'res.writeHead(404,{"content-type":"application/json"});res.end("{}");',
  '});',
  'srv.listen(port,host,()=>{console.log("server password "+secret);});',
].join('\n');

function launchManifest() {
  return {
    schemaVersion: 1,
    id: 'qa-launch',
    name: 'QA 假 launch-assigned 上游',
    maintainer: 'qa',
    version: '0.0.1',
    match: { exeNames: ['node.exe'], pathGlobs: [], registryNamePattern: null },
    serviceFace: {
      type: 'http-openapi',
      portDiscovery: {
        strategy: 'launch-assigned',
        // 注意 `--` 分隔符：否则 node 会把 --hostname 当成自己的参数（bad option）
        argv: ['{exe}', '-e', LAUNCH_SVC, '--', '--hostname', '{host}', '--port', '{port}'],
        cwd: '{installDir}',
      },
      proxyEnv: 'clear',
      readyProbe: { path: '/api/model', timeoutMs: 30000 },
      auth: { type: 'basic', username: 'qa', secretFrom: { kind: 'stdout', pattern: 'server password (\\S+)' } },
    },
    upstream: {
      listModels: { path: '/api/model', items: '$.data', fields: { id: 'id', provider: 'providerID', displayName: 'name' } },
      generate: { path: '/api/model', textPath: '$.data[0].name' },
      auth: { kind: 'none' },
      requestHooks: [],
    },
    capabilities: { streaming: false, tools: false, vision: false, embeddings: false },
    sessionPolicy: 'stateless',
  };
}

async function case13() {
  const notes = [];
  const c = collector(notes);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-qa-adapter-'));
  fs.writeFileSync(path.join(dir, 'qa-launch.json'), JSON.stringify(launchManifest(), null, 2));
  const env = { ...CHILD_ENV, APX_ADAPTER_DIRS: dir };

  const serve = spawnCli(['serve', '--adapter', 'qa-launch', '--port', String(await FREE_PORT()), '--timeout', '30000'], env);
  try {
    const m = await serve.waitFor(/本地代理已就绪\s+http:\/\/127\.0\.0\.1:(\d+)\/v1/, 45000);
    const port = Number(m[1]);
    const st = readStateJson() || {};
    notes.push(`launch-assigned 就绪：proxy=${port}，upstreamPort=${st.upstreamPort}，serviceFacePid=${st.serviceFacePid}`);
    c.ok(Boolean(st.serviceFacePid), 'state.json 没有记录上游子进程 pid（无法验证进程树回收）');

    if (st.serviceFacePid) {
      c.ok(await tasklistHas(st.serviceFacePid), `上游子进程 ${st.serviceFacePid} 未在运行`);

      const noAuth = await httpReq(`http://127.0.0.1:${st.upstreamPort}/api/model`);
      notes.push(`上游 /api/model 无凭据直连 → ${noAuth.status}（期望 401，证明 Basic 鉴权真的生效）`);
      c.ok(noAuth.status === 401, `上游无凭据访问返回 ${noAuth.status}，期望 401`);

      const stop = await runCli(['stop'], { timeout: 60000, env });
      notes.push(`apx stop → 退出码 ${stop.code}；输出：${(stop.stdout + stop.stderr).trim().replace(/\n/g, ' ⏎ ')}`);

      let gone = false;
      let refused = false;
      for (let i = 0; i < 40; i++) {
        gone = !(await tasklistHas(st.serviceFacePid));
        refused = !(await tcpProbe(port, 800)).ok;
        if (gone && refused) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      notes.push(`8s 内：上游子进程消失=${gone}，代理端口拒绝连接=${refused}`);
      c.ok(gone, `apx stop 后上游子进程 ${st.serviceFacePid} 仍存活 —— 进程树未回收`);
      c.ok(refused, 'apx stop 后代理端口仍可连接');

      const st2 = readStateJson() || {};
      c.ok(st2.pid === null && st2.proxyPort === null, 'apx stop 后 state 未清空');
      notes.push(`停后 state：pid=${st2.pid}，proxyPort=${st2.proxyPort}，serviceFacePid=${st2.serviceFacePid}`);
    }
  } finally {
    await serve.stop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  c.throwIfFailed();
  return notes.join('\n');
}

/* ================================================================== 收尾 */function restoreState(original) {
  try {
    if (original === null) {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } else {
      writeStateRaw(original);
    }
  } catch {
    /* ignore */
  }
}

async function cleanup() {
  for (const c of children) {
    try {
      if (!c.killed) c.kill();
    } catch {
      /* ignore */
    }
  }
  for (const u of upstreams) {
    try {
      await u.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const originalState = readStateRaw();
  const REAL_STATE = path.join(os.homedir(), '.apx', 'state.json');
  const realBefore = (() => {
    try {
      return fs.readFileSync(REAL_STATE, 'utf8');
    } catch {
      return null;
    }
  })();

  console.log('APX 独立验收 —— 全部黑盒，脚本内自建假上游');
  console.log(`Node ${process.version} · 工作目录 ${ROOT}`);
  console.log(`状态隔离目录 ${QA_STATE_DIR}（真实 ~/.apx 不会被改写）`);

  // 先确保没有残留代理，避免干扰
  await runCli(['stop'], { timeout: 30000 });
  // 在隔离目录里生成一次令牌：后续用例（尤其是"损坏-还原"）都以它为基准
  const seed = await runCli(['token', 'show'], { timeout: 30000 });
  console.log(`基准令牌 ${(seed.stdout || '').trim().split('\n')[0] || '(seed 失败)'}`);

  // --round2：只跑第 2 轮回归 + 扩面（改动后快速复验用）；默认跑全量
  const ONLY_R2 = process.argv.includes('--round2');

  if (!ONLY_R2) {
    await step('1', '发现层：候选数量 / ollama+opencode / 按 exe 路径去重', case1);
    await step('2', '分级正确性：11434→L1、58241≠L1、三个假上游', case2);
    await step('3', '控制台鉴权：无令牌 401 / 带令牌 200 / 状态接口不摊令牌', case3);
    await step('4a', '令牌稳定性：状态损坏必须明确报错，不得静默轮换', case4a);
    await step('5', '真实模型端到端：models / 非流式 / 真流式（帧数、DONE、首块）', case5);
    await step('4b', '令牌稳定性：运行中两次 /api/snippet 的 apiKey 必须一致', case4b);
    await step('7', '安全边界：OPTIONS 403 无 ACAO / evil Origin / cross-site 403 / 无 token 401', case7);
    await step('8', '停止与回收：端口拒绝、state 清空、无残留进程', case8);
    await step('6', '断连取消：客户端 abort 后上游连接 1.5s 内断开', case6);
    await step('9', 'stop 防误杀：伪造 pid 记录不得杀无关进程', case9);
    await step('10', '错误语义：429/Retry-After 与 401 透传', case10);
  }

  // 全量模式下 case10 已经覆盖了这批断言，只在 --round2 单跑时补一次，避免重复执行
  if (ONLY_R2) await step('R2-10', '429 透传扩面：HTTP-date / 大数值 / 流式（不得吐 SSE 帧）', case10);
  await step('R2-4', 'token rotate：运行中必须拒绝，停止后必须成功且换值', case11);
  await step('R2-2', '401 文案不含 sk-local- + token.test 注释与实现对齐（R8-2/R8-3）', case14);
  await step('R2-5', '/api/scan：?matched=1 条数===matchedTotal / ?matched=0 等价全量 / 无安装器噪声 / 空态 / 空候选可起 port-scan', case12);
  await step('R2-B', 'launch-assigned 上游：停止即回收进程树（子进程消失 + 端口拒绝）', case13);

  restoreState(originalState);
  await cleanup();

  const realAfter = (() => {
    try {
      return fs.readFileSync(REAL_STATE, 'utf8');
    } catch {
      return null;
    }
  })();
  const realUntouched = realAfter === realBefore;
  try {
    fs.rmSync(QA_STATE_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const pass = results.filter((r) => r.status === 'pass');
  const fail = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');

  console.log('\n' + '═'.repeat(78));
  console.log('验收汇总');
  console.log('═'.repeat(78));
  for (const r of results) {
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP';
    console.log(`${mark.padEnd(5)} [${r.id}] ${r.title}`);
    if (r.status !== 'pass' && r.detail) console.log(`      ↳ ${r.detail.split('\n')[0]}`);
  }
  console.log('─'.repeat(78));
  console.log(`通过 ${pass.length}  失败 ${fail.length}  跳过 ${skipped.length}  共 ${results.length} 项`);
  console.log(`用户真实 ~/.apx/state.json 未被改写（APX_STATE_DIR 隔离生效）：${realUntouched}`);

  if (fail.length) {
    console.log('\n失败明细：');
    for (const r of fail) console.log(`\n[${r.id}] ${r.title}\n${r.detail}`);
  }

  process.exitCode = fail.length ? 1 : 0;
}

process.on('uncaughtException', async (e) => {
  console.error('未捕获异常：', e);
  await cleanup();
  process.exit(1);
});

main().catch(async (e) => {
  console.error('验收脚本自身出错：', e);
  await cleanup();
  process.exit(1);
});
