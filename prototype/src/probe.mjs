// 可代理性探测：L0–L3 + 假绿三级否决。
// 核心教训：端口活着不代表有模型 API。Electron 的 SPA 兜底会让任意路径返回 200 + 同一份 HTML。
// 所以判定顺序是「先否决，再晋级」：content-type → 与根路径同构 → JSON 结构。

const JSON_PATHS = ['/v1/models', '/models', '/api/v1/models', '/api/model'];
const DEFAULT_TIMEOUT = 2500;

async function fetchSoft(url, { timeout = DEFAULT_TIMEOUT, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      size: buf.length,
      body: buf,
      json: tryJson(buf),
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function tryJson(buf) {
  if (!buf || !buf.length) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** 形如 C:\... / \\server\share / /abs/path 的 id 是文件路径，不是模型标识。 */
const PATH_LIKE_ID = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/**
 * 是否是「能直接当 OpenAI 上游用」的模型列表。
 *
 * 只认 OpenAI 形状：顶层带 data[]，且 data[0].id 是非空字符串。
 * 两类假阳性被显式挡掉（都实测踩过）：
 *   ① 只有旧版 models[]（元素是 {name, model, type}）——这是原生形状，不是 OpenAI。
 *      判成 L1 之后调用会 500。可以判 L2（需协议适配），绝不能判 L1。
 *   ② 同时给出 models[] 与 data[] 的「混合方言」——OpenAI 字段只是兼容层；
 *      更糟的是 data[0].id 往往是文件路径（如 %USERPROFILE%\.ollama\models\blobs\sha256-...），
 *      把这种 id 原样回传会得到 500 "invalid string: forbidden character after backslash"。
 *
 * 这个函数是 L1 判据的唯一来源：probe 与 port-scan 都调它，避免一处修了另一处漏。
 */
export function looksLikeModelList(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
  const data = json.data;
  if (!Array.isArray(data) || !data.length) return false;
  const first = data[0];
  if (!first || typeof first !== 'object') return false;
  if (typeof first.id !== 'string' || !first.id.trim()) return false;
  // 混合方言：同时给了原生 models[] → OpenAI 字段只是兼容层，降级到 L2
  if (Array.isArray(json.models) && json.models.length) return false;
  // id 是文件路径 → 不是可回传的模型标识
  if (PATH_LIKE_ID.test(first.id)) return false;
  return true;
}

/** 给界面/日志用的可读理由（说明「为什么不是 L1」），与 looksLikeModelList 判据一一对应。 */
export function describeModelListShape(json) {
  if (json == null) return '不是 JSON';
  if (typeof json !== 'object') return '不是 JSON 对象';
  if (Array.isArray(json)) return '顶层是数组，不是 OpenAI 的 {object:"list", data:[]} 形状';
  const data = json.data;
  const hasModels = Array.isArray(json.models) && json.models.length > 0;
  if (!Array.isArray(data) || !data.length) {
    return hasModels ? '只有 models[]（原生形状），没有 OpenAI 的顶层 data[]' : '缺少顶层 data[] 数组';
  }
  const first = data[0];
  if (!first || typeof first !== 'object') return 'data[0] 不是对象';
  if (typeof first.id !== 'string' || !first.id.trim()) return 'data[0].id 不是非空字符串';
  if (hasModels) return '同时给出 models[] 与 data[]（混合方言），OpenAI 字段很可能是兼容层';
  if (PATH_LIKE_ID.test(first.id)) return 'data[0].id 是文件路径而不是模型标识（原样回传会被上游拒绝）';
  return '符合 OpenAI 模型列表形状';
}

/**
 * 探测一个端口。
 * 返回 { reachable, level, reasons[], evidence{...} }
 * level ∈ L1 | L2 | L2_SPA | UNKNOWN
 */
export async function probeEndpoint({ host = '127.0.0.1', port }) {
  const base = `http://${host}:${port}`;
  const reasons = [];
  const root = await fetchSoft(`${base}/`);
  if (!root.ok) {
    return { reachable: false, level: 'UNKNOWN', reasons: [`根路径不可达：${root.error}`], evidence: {} };
  }

  const rootJson = root.json;
  const rootIsHtml = /text\/html/i.test(root.contentType);

  const candidates = [];
  for (const p of JSON_PATHS) {
    const r = await fetchSoft(`${base}${p}`);
    if (!r.ok) {
      candidates.push({ path: p, ok: false, error: r.error });
      continue;
    }
    const shape = describeModelListShape(r.json);
    const sameAsRoot = root.size > 0 && r.size === root.size;
    const isHtml = /text\/html/i.test(r.contentType);
    candidates.push({
      path: p,
      status: r.status,
      contentType: r.contentType,
      size: r.size,
      json: Boolean(r.json),
      html: isHtml,
      sameAsRoot,
      modelList: looksLikeModelList(r.json),
      shape,
    });
    // 三级否决 ①：HTML 一律不算 API
    if (isHtml) continue;
    // 三级否决 ②：与 GET / 同字节数 → 判定 SPA 兜底
    if (sameAsRoot) continue;
    // 三级否决 ③：必须能解析成 JSON
    if (!r.json) continue;
    if (looksLikeModelList(r.json)) {
      reasons.push(`${p} 返回 OpenAI 形状的模型列表（${r.contentType}，${r.size}B）`);
      return {
        reachable: true,
        level: 'L1',
        reasons,
        evidence: { root: summarize(root), candidates, matched: p },
      };
    }
    reasons.push(`${p} 返回 JSON 但不是 OpenAI 模型列表形状：${shape}`);
  }

  const anyJson = candidates.some((c) => c.json && !c.sameAsRoot && !c.html);
  const spaHole = candidates.some((c) => c.html && c.sameAsRoot);

  let level = 'UNKNOWN';
  if (anyJson) {
    level = 'L2';
    reasons.push('存在 JSON 响应但结构非 OpenAI 形态，需要协议适配');
  } else if (spaHole) {
    level = 'L2';
    reasons.push('所有候选路径返回与根路径完全相同的 HTML —— 典型 SPA 兜底，不可直连');
  } else if (rootIsHtml) {
    level = 'UNKNOWN';
    reasons.push('根路径为 HTML 且无任何 JSON 端点，疑似纯 Web UI');
  }

  return { reachable: true, level, reasons, evidence: { root: summarize(root), candidates } };
}

function summarize(r) {
  return { status: r.status, contentType: r.contentType, size: r.size, json: Boolean(r.json) };
}

const HEADLESS_HINTS = /(--print|--json|--output|-p,|--prompt|--exec|--run\b|headless|non-interactive|--format)/i;

/** 通过 `--help` 判断是否有无头执行能力（L0 vs L3 的分界线）。 */
export async function probeCli(exePath, { timeout = 4000 } = {}) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(exePath, ['--help'], { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      if (!text.trim()) {
        return resolve({ ok: false, reason: err ? `执行失败：${err.code || err.message}` : '无输出' });
      }
      const headless = HEADLESS_HINTS.test(text);
      resolve({
        ok: true,
        headless,
        signals: HEADLESS_HINTS.test(text) ? text.match(HEADLESS_HINTS)?.[0] : null,
        helpPreview: text.split('\n').slice(0, 6).join(' | ').slice(0, 240),
      });
    });
  });
}

/**
 * 给一个候选软件定级。
 * 顺序：有监听端口就先探端口；否则看 CLI 是否支持无头；都不行才是 L0。
 */
export async function classifyCandidate(candidate, { cliProbe = true } = {}) {
  const ports = (candidate.ports || []).filter((p) => p.addr === '127.0.0.1' || p.addr === '0.0.0.0' || p.addr === '::');
  const notes = [];

  if (!candidate.running) {
    return { level: 'NOT_READY', reasons: ['软件未运行，先启动后再探测'], probes: [] };
  }

  const probes = [];
  for (const p of ports.slice(0, 4)) {
    const r = await probeEndpoint({ port: p.port });
    probes.push({ port: p.port, ...r });
    if (r.level === 'L1') {
      return { level: 'L1', reasons: r.reasons, probes, chosenPort: p.port };
    }
  }

  const best = probes.find((p) => p.level === 'L2');
  if (best) {
    notes.push(`端口 ${best.port} 有 HTTP 服务但不是标准模型接口`);
  }

  if (cliProbe && candidate.exePath) {
    const cli = await probeCli(candidate.exePath);
    if (cli.ok && cli.headless) {
      return { level: 'L3', reasons: [...notes, `CLI 支持无头调用（命中 ${cli.signals}），可做进程包装`], probes, cli };
    }
    if (cli.ok) notes.push('CLI 未发现无头开关');
  }

  if (best) return { level: 'L2', reasons: notes, probes, chosenPort: best.port };
  return { level: 'L0', reasons: [...notes, '无可用 HTTP 端点，且无无头 CLI'], probes };
}
