// 上游进程的环境变量策略（只影响我们 spawn 出来的上游，不影响本进程）。
//
// 为什么需要它：本机开着 HTTP_PROXY=127.0.0.1:27137 之类的系统代理时，上游把
// 「去 127.0.0.1 拿模型」的请求也交给代理，代理拒绝开隧道 → 上游回
// 502 ERR_PROXY_TUNNEL: Proxy refused to open a tunnel。链路明明是通的，却看起来像挂了。
//
// 三种策略（写在 manifest 的 serviceFace.proxyEnv）：
//   "clear"（默认）  清掉所有代理变量 + 设置 NO_PROXY=127.0.0.1,localhost,::1
//   "inherit"        继承父进程的代理变量，但仍把回环地址**追加**进 NO_PROXY
//                    （回环流量永远不该走代理，这不是策略选择，是常识）
//   {"custom":{...}} 清掉代理变量后按给定键值注入
//
// 这里只做环境变量搬运，不执行任何外部命令。

/** 需要被 clear 掉的大小写两套代理变量（Windows / POSIX 都存在大小写变体）。 */
export const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/** 回环地址永远不该走代理。 */
export const LOOPBACK_NO_PROXY = '127.0.0.1,localhost,::1';

/**
 * 把 manifest 里的 proxyEnv 归一化成 { mode, custom }。
 * 非法取值直接抛错（manifest 写错要立刻看见，不能静默按默认跑）。
 *
 * @param {string|object|undefined} policy
 * @returns {{mode: 'clear'|'inherit'|'custom', custom?: Record<string,string>}}
 */
export function normalizeProxyPolicy(policy) {
  if (policy === undefined || policy === null || policy === '') return { mode: 'clear' };
  if (typeof policy === 'string') {
    const mode = policy.trim().toLowerCase();
    if (mode === 'clear' || mode === 'inherit') return { mode };
    throw new Error(`未知的 serviceFace.proxyEnv 取值：${policy}（可选 "clear" / "inherit" / {"custom":{...}}）`);
  }
  if (typeof policy === 'object') {
    if (policy.custom && typeof policy.custom === 'object') {
      return { mode: 'custom', custom: policy.custom };
    }
    if (typeof policy.mode === 'string') return normalizeProxyPolicy(policy.mode);
  }
  throw new Error(`无法解析 serviceFace.proxyEnv：${JSON.stringify(policy)}`);
}

/** 把回环地址追加进已有的 NO_PROXY（保留用户原有条目）。 */
function mergeNoProxy(existing) {
  const items = String(existing || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const lower = new Set(items.map((s) => s.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY.split(',')) {
    if (!lower.has(host.toLowerCase())) {
      items.push(host);
      lower.add(host.toLowerCase());
    }
  }
  return items.join(',');
}

/**
 * 根据策略算出上游进程最终使用的环境变量。
 *
 * 返回 { env, applied }：applied 是给状态页/日志用的「实际做了什么」的证据，
 * 只说键名与模式，不打印任何值。
 *
 * @param {Record<string,string|undefined>} baseEnv 通常是 {...process.env, ...manifest 里的 env}
 * @param {string|object|undefined} policy manifest 的 serviceFace.proxyEnv
 */
export function applyProxyPolicy(baseEnv = {}, policy = undefined) {
  const norm = normalizeProxyPolicy(policy);
  const env = { ...baseEnv };

  if (norm.mode === 'inherit') {
    // 原样继承代理变量，但回环必须直连：追加而不是覆盖用户已有的 NO_PROXY 条目。
    const merged = mergeNoProxy(env.NO_PROXY ?? env.no_proxy);
    env.NO_PROXY = merged;
    if (env.no_proxy !== undefined) env.no_proxy = merged;
    return { env, applied: { mode: 'inherit', removed: [], injected: ['NO_PROXY'], noProxy: merged } };
  }

  const removed = [];
  for (const key of PROXY_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }

  const injected = [];
  if (norm.mode === 'custom') {
    for (const [key, value] of Object.entries(norm.custom)) {
      env[key] = String(value);
      injected.push(key);
    }
  }

  // 回环必须直连：即使用户在 custom 里显式写了 NO_PROXY，也把回环补进去。
  const merged = mergeNoProxy(env.NO_PROXY ?? env.no_proxy);
  env.NO_PROXY = merged;
  if (env.no_proxy !== undefined) env.no_proxy = merged;
  if (!injected.includes('NO_PROXY')) injected.push('NO_PROXY');

  return { env, applied: { mode: norm.mode, removed, injected, noProxy: merged } };
}

/** 给界面用的一句话描述，不涉及任何具体值。 */
export function describeProxyPolicy(policy) {
  const norm = normalizeProxyPolicy(policy);
  if (norm.mode === 'inherit') return { mode: 'inherit', label: '继承系统代理（回环仍直连）' };
  if (norm.mode === 'custom') return { mode: 'custom', label: `自定义代理变量（${Object.keys(norm.custom).join(', ') || '空'}）` };
  return { mode: 'clear', label: '清除系统代理（回环直连）' };
}
