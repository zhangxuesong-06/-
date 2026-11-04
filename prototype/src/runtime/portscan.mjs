// 端口扫描策略：把一个端口判断成「真的能当 OpenAI 上游用」还是「只是活着」。
//
// 复用 probe 的三级否决思路，因为只看状态码一定会误判：
//   ① Content-Type 是 HTML → 否决（SPA 兜底页也返回 200）
//   ② 与 GET / 字节数完全相同 → 否决（兜底页把任意路径都返回同一份 HTML）
//   ③ 解析不出 JSON → 否决
// 结构判定不再各写一套，直接调 probe.mjs 的 looksLikeModelList：
// OpenAI 形状（顶层 data[] + data[0].id 是字符串）才算命中；
// 只有 models[]（原生形状）、或 models[] 与 data[] 混在一起、或 id 是文件路径，都不算命中。
//
// 这条路只出现在 manifest 声明的 portDiscovery.strategy = "port-scan" 里；
// 端口候选值一律来自 manifest，主程序不含任何端口或厂商硬编码。
import { looksLikeModelList, describeModelListShape } from '../probe.mjs';

export const SCAN_TIMEOUT_MS = 2500;

function tryJson(buf) {
  if (!buf || !buf.length) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

async function fetchSoft(url, { timeout = SCAN_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'manual',
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      size: buf.length,
      json: tryJson(buf),
    };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测单个端口的可代理性。
 *
 * @param {{port:number, modelsPath?:string, host?:string, timeout?:number}} opts
 * @returns {Promise<{port:number, ok:boolean, reason:string, status?:number,
 *   contentType?:string, size?:number, modelCount?:number, models?:string[],
 *   evidence:{root:object|null, models:object|null}}>}
 */
export async function probeModelEndpoint({ port, modelsPath = '/v1/models', host = '127.0.0.1', timeout = SCAN_TIMEOUT_MS }) {
  const base = `http://${host}:${port}`;
  const root = await fetchSoft(`${base}/`, { timeout });
  const models = await fetchSoft(`${base}${modelsPath}`, { timeout });

  const evidence = {
    root: root.ok ? { status: root.status, contentType: root.contentType, size: root.size } : { error: root.error },
    models: models.ok
      ? { status: models.status, contentType: models.contentType, size: models.size, json: Boolean(models.json) }
      : { error: models.error },
    modelsPath,
  };

  const fail = (reason) => ({ port, ok: false, reason, status: models.status, contentType: models.contentType, size: models.size, evidence });

  // 端口本身连不上：这是最常见也最该说清楚的情况
  if (!models.ok) return fail(`不可达（${models.error}）`);

  // 否决 ①：HTML 一律不是模型接口
  if (/text\/html/i.test(models.contentType)) return fail(`返回 HTML（${models.contentType}，${models.size}B）—— 典型 Web UI 兜底页，不是模型接口`);

  // 否决 ②：与根路径同字节数 → 兜底页把任意路径映射到同一份内容
  if (root.ok && root.size > 0 && models.size === root.size) {
    return fail(`与 GET / 字节数完全相同（${models.size}B）—— 判定为 SPA/兜底页，不是真实接口`);
  }

  // 否决 ③：必须能解析成 JSON
  if (!models.json) return fail(`不是合法 JSON（${models.contentType || '无 Content-Type'}，${models.size}B）`);

  // 否决 ④：结构必须是 OpenAI 形状（判据与 probe 共用同一个函数，不另写一套）
  const json = models.json;
  const shape = describeModelListShape(json);
  if (!looksLikeModelList(json)) {
    return fail(`返回 JSON 但不是 OpenAI 模型列表形状：${shape}`);
  }

  const ids = json.data.filter((m) => m && typeof m === 'object' && typeof m.id === 'string' && m.id).map((m) => m.id);
  if (!ids.length) return fail(`data[] 元素缺少 id 字段（共 ${json.data.length} 项）`);

  return {
    port,
    ok: true,
    reason: `GET ${modelsPath} 返回 OpenAI 形状模型列表，含 ${ids.length} 个模型`,
    status: models.status,
    contentType: models.contentType,
    size: models.size,
    modelCount: ids.length,
    models: ids.slice(0, 50),
    shape,
    evidence,
  };
}

/**
 * 按 manifest 给的候选端口依次探测，首个命中即用。
 * 全部未命中时返回逐端口的失败原因（不静默、不猜）。
 *
 * @param {{candidates:number[], modelsPath?:string, host?:string, timeout?:number, onTry?:Function}} opts
 */
export async function portScanEndpoints({ candidates = [], modelsPath = '/v1/models', host = '127.0.0.1', timeout = SCAN_TIMEOUT_MS, onTry } = {}) {
  const attempts = [];
  for (const raw of candidates) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0) {
      attempts.push({ port: raw, ok: false, reason: '端口候选不合法' });
      continue;
    }
    const probe = await probeModelEndpoint({ port, modelsPath, host, timeout });
    attempts.push({ port, ok: probe.ok, reason: probe.reason, status: probe.status, modelCount: probe.modelCount ?? 0 });
    if (typeof onTry === 'function') onTry({ port, ok: probe.ok, reason: probe.reason });
    if (probe.ok) return { ok: true, port, attempts, probe };
  }
  return { ok: false, attempts };
}
