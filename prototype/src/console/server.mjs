// Web 控制台：只绑 127.0.0.1 的本地运维页面。
//
// 安全模型（与代理端点同一套思路，但令牌是独立的）：
//   1) 独立 console token，与下游 sk-local- 令牌完全不同，避免"页面泄漏 = 下游令牌泄漏"；
//   2) 令牌注入在同源页面的 <meta> 里，JS 读出来放 x-apx-console-token 请求头；
//   3) 所有 /api/* 强制校验该头，缺失/错误一律 401；
//   4) 跨站请求（Sec-Fetch-Site: cross-site / Origin: null / 非同源 Origin）→ 403，
//      并且永不返回任何 Access-Control-Allow-*，让浏览器里第三方页面连响应体都读不到。
//
// 一句话：能被打开的只有本机用户手动打开的这一个页面。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { tokenMatches, maskToken } from '../security/token.mjs';
import { discover } from '../discovery/index.mjs';
import { loadAdapters, matchAdapter, userAdapterDir, BUILTIN_DIR } from '../adapters/loader.mjs';
import { probeEndpoint } from '../probe.mjs';
import { adapterGlobs } from '../runtime/controller.mjs';
import { pickFreePort } from '../runtime/supervisor.mjs';
import { describeProxyPolicy } from '../runtime/proxyenv.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_FILE = path.join(HERE, 'ui.html');
const TOKEN_PLACEHOLDER = '__APX_CONSOLE_TOKEN__';
const SCAN_CACHE_MS = 8000;

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    // 注意：这里永远不写 Access-Control-Allow-*
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function fail(res, status, message, code = 'apx_console_error') {
  return sendJson(res, status, { ok: false, error: { message, code } });
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 生成控制台专用令牌（与下游令牌不同前缀，一眼能区分）。 */
function generateConsoleToken() {
  return `apx-console-${randomBytes(24).toString('base64url')}`;
}

/** 把适配器整理成界面要的形状（不泄漏任何路径以外的秘密）。 */
function summarizeAdapter(adapter, candidates) {
  const pd = adapter.serviceFace?.portDiscovery || {};
  const strategy = pd.strategy || 'listen-scan';
  const hits = matchAdapter(adapter, candidates);
  const hasMatchRules = Boolean(adapter.match?.exeNames?.length || adapter.match?.pathGlobs?.length || adapter.match?.registryNamePattern);

  let matchStatus;
  if (strategy === 'remote') matchStatus = 'remote';
  else if (strategy === 'port-scan') matchStatus = 'port-scan';
  else if (!hasMatchRules) matchStatus = 'manual';
  else if (hits.length) matchStatus = 'hit';
  else matchStatus = 'not-installed';

  const needsUpstreamPort = strategy === 'listen-scan' || strategy === 'static' || strategy === 'cli-command';
  const remoteBaseUrl = adapter.serviceFace?.baseUrl || adapter.upstream?.baseUrl || null;

  return {
    id: adapter.id,
    name: adapter.name || adapter.id,
    description: adapter.description || '',
    version: adapter.version || '',
    level: adapter.level || '',
    origin: adapter.origin || '',
    capabilities: adapter.capabilities || {},
    quirks: adapter.quirks || {},
    serviceFace: {
      type: adapter.serviceFace?.type || '',
      strategy,
      candidates: Array.isArray(pd.candidates) ? pd.candidates : [],
      modelsPath: pd.modelsPath || adapter.upstream?.listModels?.path || '/v1/models',
      baseUrl: remoteBaseUrl,
    },
    proxyEnv: describeProxyPolicy(adapter.serviceFace?.proxyEnv),
    authKind: adapter.upstream?.auth?.kind || 'none',
    experimental: (adapter.level || '') === 'experimental',
    matchStatus,
    needsUpstreamPort,
    // 不需要先匹配到本机软件的适配器都能直接起（remote / port-scan / 手动端口型）
    startable: strategy !== 'launch-assigned' || matchStatus === 'hit',
    hits: hits.slice(0, 5).map((h) => ({
      candidateId: h.candidate.id,
      name: h.candidate.name || '',
      exePath: h.candidate.exePath || '',
      version: h.candidate.version || '',
      running: Boolean(h.candidate.running),
      ports: (h.candidate.ports || []).map((p) => p.port),
      score: h.score,
      why: h.why,
    })),
    hint:
      matchStatus === 'remote'
        ? `直连远端上游 ${remoteBaseUrl}（实验，不起进程；凭据来源 ${adapter.upstream?.auth?.kind || 'none'}）`
        : matchStatus === 'port-scan'
          ? `自动探测本机端口 ${(pd.candidates || []).join(' / ')}，命中第一个可用的 OpenAI 兼容服务`
          : needsUpstreamPort
            ? '需要填写上游端口（该服务已经在跑）'
            : matchStatus === 'hit'
              ? '本机已检测到该软件，启动时会自起隔离实例'
              : '未检测到该软件',
  };
}

/**
 * 创建控制台服务。
 *
 * @param {{port?:number, host?:string, controller:object, log?:Function}} opts
 * @returns {Promise<{url:string, port:number, token:string, maskedToken:string, server:object,
 *   close:Function, handleFetch:Function}>}
 */
export async function createConsoleServer({ port = 8799, host = '127.0.0.1', controller, log = () => {} } = {}) {
  if (!controller) throw new Error('createConsoleServer 需要 controller');

  const token = generateConsoleToken();
  const template = fs.readFileSync(UI_FILE, 'utf8');
  const html = template.split(TOKEN_PLACEHOLDER).join(token);

  let boundPort = 0;

  /** Origin 必须是本机同端口，否则一律拒绝（不止挡 cross-site，也挡本机其他端口的页面）。 */
  function originAllowed(origin) {
    try {
      const o = new URL(origin);
      const loopback = o.hostname === '127.0.0.1' || o.hostname === 'localhost' || o.hostname === '[::1]';
      const port = Number(o.port || (o.protocol === 'https:' ? 443 : 80));
      return loopback && port === boundPort;
    } catch {
      return false;
    }
  }

  // 扫描结果带短 TTL：界面每 3 秒轮询状态，不该每次触发一次 3 秒的全盘扫描。
  let scanCache = null;
  async function getCandidates({ refresh = false } = {}) {
    if (!refresh && scanCache && Date.now() - scanCache.at < SCAN_CACHE_MS) return scanCache.value;
    const value = await discover({ adapterGlobs: adapterGlobs() });
    scanCache = { at: Date.now(), value };
    return value;
  }

  /** 跨站与鉴权闸门：返回 true 表示已经拦下并写完响应。 */
  function gate(req, res, url) {
    // 预检直接拒绝，并且永不返回 ACAO —— 双保险
    if (req.method === 'OPTIONS') {
      fail(res, 403, '控制台不接受跨域预检请求', 'apx_cors_denied');
      return true;
    }
    const secFetchSite = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if (secFetchSite === 'cross-site') {
      fail(res, 403, '拒绝跨站请求（Sec-Fetch-Site: cross-site）', 'apx_cross_site_denied');
      return true;
    }
    if (origin === 'null') {
      fail(res, 403, '拒绝来源为 null 的请求', 'apx_cross_site_denied');
      return true;
    }
    if (origin) {
      const ok = originAllowed(origin);
      if (!ok) {
        fail(res, 403, `拒绝非同源请求（Origin: ${origin}）`, 'apx_cross_site_denied');
        return true;
      }
    }
    // /api/* 一律要控制台令牌
    if (url.pathname.startsWith('/api/')) {
      const given = req.headers['x-apx-console-token'];
      if (!tokenMatches(given, token)) {
        sendJson(res, 401, {
          ok: false,
          error: { message: '缺少或错误的控制台令牌（请在页面内操作，不要直接调用接口）', code: 'apx_console_unauthorized' },
        });
        return true;
      }
    }
    return false;
  }

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /api/scan') {
      const refresh = url.searchParams.get('refresh') === '1';
      const t0 = Date.now();
      const candidates = await getCandidates({ refresh });

      // 标注"被哪些适配器命中"。界面默认只看已适配软件——否则 447 个候选里
      // 绝大多数是系统进程（conhost/Explorer…），首屏全是噪声。
      const { adapters } = loadAdapters();
      const matchedMap = new Map();
      for (const a of adapters) {
        for (const hit of matchAdapter(a, candidates)) {
          const list = matchedMap.get(hit.candidate.id) || [];
          list.push(a.id);
          matchedMap.set(hit.candidate.id, list);
        }
      }

      // 服务端过滤参数：?matched=1 只返回被适配器命中的候选。
      // 这是给脚本与验收用的稳定契约（UI 自己也能按 matchedBy 过滤）；
      // 不带参数 / ?matched=0 都返回全量，行为与原实现一致。
      const onlyMatched = url.searchParams.get('matched') === '1';
      const rows = candidates.map((c) => ({
        id: c.id,
        name: c.name || '',
        version: c.version || '',
        exePath: c.exePath || '',
        installLocation: c.installLocation || '',
        publisher: c.publisher || '',
        sources: c.sources || [],
        confidence: Number(c.confidence || 0),
        running: Boolean(c.running),
        pids: c.pids || [],
        ports: (c.ports || []).map((p) => ({ port: p.port, addr: p.addr })),
        matchedBy: matchedMap.get(c.id) || [],
      }));

      return sendJson(res, 200, {
        ok: true,
        tookMs: Date.now() - t0,
        total: candidates.length,
        matchedTotal: [...matchedMap.keys()].length,
        filtered: onlyMatched,
        candidates: onlyMatched ? rows.filter((r) => r.matchedBy.length > 0) : rows,
      });
    }

    if (route === 'GET /api/adapters') {
      const { adapters, errors, overridden } = loadAdapters();
      const candidates = await getCandidates();
      return sendJson(res, 200, {
        ok: true,
        builtinDir: BUILTIN_DIR,
        userDir: userAdapterDir(),
        overridden,
        loadErrors: errors.map((e) => ({ file: path.basename(e.file || ''), field: e.field, expected: e.expected, actual: String(e.actual) })),
        adapters: adapters.map((a) => summarizeAdapter(a, candidates)),
      });
    }

    if (route === 'GET /api/probe') {
      const portRaw = url.searchParams.get('port');
      const portNum = Number(portRaw);
      if (!Number.isInteger(portNum) || portNum <= 0) return fail(res, 400, '缺少合法的 ?port= 参数', 'apx_bad_request');
      const result = await probeEndpoint({ port: portNum });
      return sendJson(res, 200, { ok: true, port: portNum, ...result });
    }

    if (route === 'POST /api/start') {
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return fail(res, 400, '请求体不是合法 JSON', 'apx_bad_json');
      }
      if (!body.adapterId) return fail(res, 400, '缺少 adapterId', 'apx_bad_request');
      const upstreamPort = body.upstreamPort ? Number(body.upstreamPort) : undefined;
      if (body.upstreamPort && (!Number.isInteger(upstreamPort) || upstreamPort <= 0)) {
        return fail(res, 400, 'upstreamPort 必须是正整数', 'apx_bad_request');
      }
      try {
        const info = await controller.start({
          adapterId: String(body.adapterId),
          upstreamPort,
          proxyPort: body.proxyPort ? Number(body.proxyPort) : undefined,
          authEnabled: body.authEnabled !== false,
        });
        scanCache = null;
        // 最小暴露：启动响应里不带下游令牌，令牌只从 /api/snippet 取
        const { token: _omitToken, ...publicInfo } = info;
        return sendJson(res, 200, { ok: true, ...publicInfo });
      } catch (e) {
        return fail(res, 400, e.message || String(e), 'apx_start_failed');
      }
    }

    if (route === 'POST /api/stop') {
      const r = await controller.stop();
      return sendJson(res, 200, { ok: true, ...r });
    }

    if (route === 'GET /api/status') {
      const st = controller.status();
      return sendJson(res, 200, { ok: true, ...st });
    }

    if (route === 'GET /api/snippet') {
      const st = controller.status();
      if (!st.running) return fail(res, 409, '代理未运行，先启动再复制配置', 'apx_not_running');
      const apiKey = typeof controller.currentToken === 'function' ? controller.currentToken() : null;
      if (!apiKey) return fail(res, 409, '拿不到下游令牌（代理刚停止？）', 'apx_not_running');
      return sendJson(res, 200, {
        ok: true,
        baseURL: st.baseURL,
        apiKey,
        models: st.models,
        defaultModel: st.models[0]?.alias || null,
      });
    }

    return fail(res, 404, `未知的控制台接口：${route}`, 'apx_not_found');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    try {
      if (gate(req, res, url)) return;

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': body.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // 页面不需要任何外部资源，直接锁死
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
          'referrer-policy': 'no-referrer',
        });
        return res.end(body);
      }

      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

      return fail(res, 404, '未找到该路径', 'apx_not_found');
    } catch (err) {
      if (res.destroyed) return;
      return fail(res, 500, `控制台内部错误：${err.message || err}`, 'apx_console_internal_error');
    }
  });

  boundPort = await pickFreePort(Number(port) || 8799);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(boundPort, host, resolve);
  });

  const url = `http://${host}:${boundPort}/`;
  log(`控制台已就绪 ${url}`);

  return {
    url,
    port: boundPort,
    token,
    maskedToken: maskToken(token),
    server,
    /** 关闭 HTTP 服务；不负责停代理（那是 controller 的职责）。 */
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
