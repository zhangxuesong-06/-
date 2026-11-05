// 适配器 manifest：加载、校验、故障隔离、热重载不依赖主程序改版。
// 设计要点：manifest 只描述「是什么、怎么找、怎么连」，不描述「怎么翻译」。
// 翻译逻辑在 translator（代码），这样不会长出一门没人维护的 YAML DSL。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNoiseExe } from '../lib/exec-noise.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_DIR = path.resolve(HERE, '../../adapters');

export function userAdapterDir() {
  const base = process.env.APPDATA || path.join(process.env.HOME || '.', '.config');
  return path.join(base, 'apx', 'adapters');
}

/** 额外适配器目录（测试与团队共享用），路径分隔符为系统默认。 */
export function extraAdapterDirs() {
  const raw = process.env.APX_ADAPTER_DIRS;
  return raw ? raw.split(path.delimiter).filter(Boolean) : [];
}

const REQUIRED = ['schemaVersion', 'id', 'name', 'serviceFace'];
const FACE_TYPES = new Set(['openai-passthrough', 'http-openapi', 'acp', 'cli-headless', 'custom']);
const PORT_STRATEGIES = new Set(['launch-assigned', 'cli-command', 'static', 'listen-scan', 'port-scan', 'remote']);

function validate(m, file) {
  const errors = [];
  for (const k of REQUIRED) if (m[k] === undefined) errors.push({ field: k, expected: 'required', actual: 'missing' });
  if (m.id && !/^[a-z0-9][a-z0-9-]*$/.test(m.id)) errors.push({ field: 'id', expected: 'lowercase [a-z0-9-]', actual: m.id });
  const face = m.serviceFace || {};
  if (face.type && !FACE_TYPES.has(face.type)) {
    errors.push({ field: 'serviceFace.type', expected: [...FACE_TYPES].join('|'), actual: face.type });
  }
  const strat = face.portDiscovery?.strategy;
  if (strat && !PORT_STRATEGIES.has(strat)) {
    errors.push({ field: 'serviceFace.portDiscovery.strategy', expected: [...PORT_STRATEGIES].join('|'), actual: strat });
  }
  // port-scan 必须有候选端口，且必须是正整数数组
  if (strat === 'port-scan') {
    const cands = face.portDiscovery?.candidates;
    if (!Array.isArray(cands) || !cands.length) {
      errors.push({ field: 'serviceFace.portDiscovery.candidates', expected: 'non-empty array', actual: JSON.stringify(cands) });
    } else if (cands.some((p) => !Number.isInteger(Number(p)) || Number(p) <= 0)) {
      errors.push({ field: 'serviceFace.portDiscovery.candidates', expected: 'positive integers', actual: JSON.stringify(cands) });
    }
  }
  // 上游代理变量策略：只接受三种形态
  const pe = face.proxyEnv;
  if (pe !== undefined && pe !== null) {
    const isMode = pe === 'clear' || pe === 'inherit';
    const isCustom = typeof pe === 'object' && pe.custom && typeof pe.custom === 'object';
    const isWrapped = typeof pe === 'object' && (pe.mode === 'clear' || pe.mode === 'inherit');
    if (!isMode && !isCustom && !isWrapped) {
      errors.push({
        field: 'serviceFace.proxyEnv',
        expected: '"clear" | "inherit" | {"custom":{...}}',
        actual: JSON.stringify(pe),
      });
    }
  }
  // 并发/超时上限（N7）：只接受正整数（maxQueue 允许 0 = 不排队），写错在加载时报错。
  if (m.limits !== undefined) {
    if (!m.limits || typeof m.limits !== 'object' || Array.isArray(m.limits)) {
      errors.push({ field: 'limits', expected: 'object', actual: JSON.stringify(m.limits) });
    } else {
      for (const [key, min] of [
        ['maxConcurrent', 1],
        ['maxQueue', 0],
        ['queueTimeoutMs', 1],
        ['requestTimeoutMs', 1],
        ['streamFirstByteTimeoutMs', 1],
        ['streamIdleTimeoutMs', 1],
      ]) {
        if (m.limits[key] === undefined) continue;
        if (!Number.isInteger(m.limits[key]) || m.limits[key] < min) {
          errors.push({ field: `limits.${key}`, expected: `integer >= ${min}`, actual: String(m.limits[key]) });
        }
      }
    }
  }
  // baseUrl 必须是 origin（协议://host[:port]，不带路径、不带尾斜杠）。
  // 这是「规范化」而不是「拼接去重魔法」：路径一律写在各 endpoint 的 path 里，
  // 主程序不做任何猜测性改写，写错就在加载时报错。
  const ORIGIN_RE = /^https?:\/\/[^/]+$/i;
  for (const [field, value] of [
    ['serviceFace.baseUrl', face.baseUrl],
    ['upstream.baseUrl', m.upstream?.baseUrl],
  ]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !ORIGIN_RE.test(value)) {
      errors.push({
        field,
        expected: 'origin only, 如 https://api.example.com',
        actual: `${value} —— 必须是 origin（协议://host[:port]，无路径、无尾斜杠）；路径请写在各 endpoint 的 path 里`,
      });
    }
  }

  // 远端上游：必须有 baseUrl
  if (strat === 'remote') {
    if (!face.baseUrl && !m.upstream?.baseUrl) {
      errors.push({ field: 'serviceFace.baseUrl', expected: 'required when strategy=remote', actual: 'missing' });
    }
    // remote + inherit 是「假装支持」：Node 的 fetch(undici) 默认不读 HTTP_PROXY，
    // inherit 在这里不会产生任何效果，必须显式拒绝而不是让用户以为流量走了代理。
    if (pe === 'inherit') {
      errors.push({
        field: 'serviceFace.proxyEnv',
        expected: '"clear" 或 {"custom":{...}}',
        actual: '"inherit" 对 remote 型无意义 —— Node fetch 不读系统代理，inherit 不会改变任何请求；要经代理请用 custom 并自建 Agent，本版本不支持',
      });
    }
  }
  // 凭证来源的必填项（写错要让 manifest 直接加载失败，而不是运行时静默无凭据）
  const authKind = m.upstream?.auth?.kind;
  if (authKind === 'regex-file') {
    for (const k of ['path', 'pattern']) {
      if (!m.upstream.auth[k]) {
        errors.push({ field: `upstream.auth.${k}`, expected: 'required for regex-file', actual: 'missing' });
      }
    }
    if (m.upstream.auth.pattern) {
      try {
        new RegExp(m.upstream.auth.pattern);
      } catch (e) {
        errors.push({ field: 'upstream.auth.pattern', expected: 'valid regex', actual: String(e.message) });
      }
    }
  }
  // 边界：manifest 不得携带可执行代码或 shell 拼接
  const raw = JSON.stringify(m);
  for (const bad of ['exec(', 'child_process', 'require(', 'eval(', '${process']) {
    if (raw.includes(bad)) errors.push({ field: '(body)', expected: 'declarative only', actual: `contains "${bad}"` });
  }
  if (m.match?.registryNamePattern) {
    try {
      new RegExp(m.match.registryNamePattern, 'i');
    } catch (e) {
      errors.push({ field: 'match.registryNamePattern', expected: 'valid regex', actual: String(e.message) });
    }
  }
  return errors.map((e) => ({ ...e, file }));
}

function loadDir(dir, origin) {
  const loaded = [];
  const errors = [];
  if (!fs.existsSync(dir)) return { loaded, errors };
  for (const name of fs.readdirSync(dir)) {
    if (!/\.json$/i.test(name) || name.startsWith('_')) continue;
    const file = path.join(dir, name);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const errs = validate(raw, file);
      if (errs.length) {
        errors.push(...errs);
        continue; // 故障隔离：单个文件坏掉不影响其他
      }
      loaded.push({ ...raw, origin, file });
    } catch (e) {
      errors.push({ file, field: '(json)', expected: 'parseable', actual: String(e.message) });
    }
  }
  return { loaded, errors };
}

/** 加载全部适配器：用户目录优先覆盖内置同 id。 */
export function loadAdapters({ extraDirs = [] } = {}) {
  const builtin = loadDir(BUILTIN_DIR, 'builtin');
  const dirs = [userAdapterDir(), ...extraAdapterDirs(), ...extraDirs].filter(Boolean);
  // 每个目录独立收集错误：即使这个目录里**没有一个是合法的**，它报的错也必须能被看到
  // （旧实现只从"加载成功的项"里带出错误，导致全非法目录的错误被静默吞掉）
  const userLoads = dirs.map((d) => loadDir(d, 'user'));
  const user = userLoads.flatMap((r) => r.loaded);

  const byId = new Map();
  for (const a of builtin.loaded) byId.set(a.id, a);
  const overridden = [];
  for (const a of user) {
    if (byId.has(a.id)) overridden.push(a.id);
    byId.set(a.id, a);
  }
  return {
    adapters: [...byId.values()],
    errors: [...builtin.errors, ...userLoads.flatMap((r) => r.errors)],
    overridden,
  };
}

export function findAdapter(id) {
  const { adapters } = loadAdapters();
  return adapters.find((a) => a.id === id) || null;
}

function globToRegex(glob) {
  const expanded = glob.replace(/%([A-Za-z_]+)%/g, (_, k) => process.env[k] || `%${k}%`);
  const esc = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return { regex: new RegExp(`^${esc}$`, 'i'), expanded };
}

/** 用 manifest 的匹配规则把候选收敛成"这款适配器对应的软件"。 */
export function matchAdapter(adapter, candidates) {
  const exeNames = (adapter.match?.exeNames || []).map((s) => s.toLowerCase());
  const globs = (adapter.match?.pathGlobs || []).map(globToRegex);
  const nameRe = adapter.match?.registryNamePattern ? new RegExp(adapter.match.registryNamePattern, 'i') : null;

  const hits = [];
  for (const c of candidates) {
    const base = c.exePath ? path.basename(c.exePath) : '';
    const explicit = base ? exeNames.includes(base.toLowerCase()) : false;
    const why = [];

    // 噪声 exe（卸载器/安装器/更新器）只压制"靠 glob / 注册表名顺带命中"的情况：
    // manifest 的 exeNames 显式列出这个基名时放行（有的软件主程序真叫 update.exe）。
    // 这里是**直接不计分**而不是降权——分数低一点仍会出现在首屏，而点卸载器等于卸载软件。
    if (base && !explicit && isNoiseExe(base)) {
      why.push('noise-exe'); // 诊断用：说明这条为什么没进结果
      continue;
    }

    let score = 0;
    if (c.exePath) {
      if (explicit) {
        score += 50;
        why.push('exe-name');
      }
      for (const g of globs) {
        if (g.regex.test(c.exePath)) {
          score += 40;
          why.push('path-glob');
          break;
        }
      }
    }
    if (nameRe && nameRe.test(c.name || '')) {
      score += 30;
      why.push('registry-name');
    }
    if (score > 0) hits.push({ candidate: c, score, why });
  }
  hits.sort((a, b) => b.score - a.score || (b.candidate.running - a.candidate.running));
  return hits;
}
