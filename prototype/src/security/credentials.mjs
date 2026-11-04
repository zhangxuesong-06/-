// 凭证生命周期。
// 教训来自实践：上游 token 往往由宿主应用刷新（OAuth access token 约 30 天），
// 代理若在启动时读一次就会静默失效。所以：
//   - 凭证按需读取（每请求），不缓存；
//   - 读到的是「当前有效值」，不是「启动时的值」；
//   - 401 时强制重读一次再重放（仅非流式，流式重放会产生重复输出）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 进程级稳定会话 ID：上游用它做路由与 prompt cache，每请求换会打散命中率。 */
export const SESSION_UUID = randomUUID();

export function expandPath(p) {
  if (!p) return p;
  const withEnv = String(p).replace(/%([A-Za-z_]+)%/g, (_, k) => process.env[k] || '');
  return withEnv.replace(/^~(?=$|[\\/])/, os.homedir());
}

function getByPath(obj, expr) {
  return String(expr || '')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? o : o[k]), obj);
}

function noopProvider(reason = 'none') {
  return {
    kind: reason,
    async get() {
      return null;
    },
    invalidate() {},
    describe() {
      return { kind: reason, ok: true, detail: '无需凭证' };
    },
  };
}

/**
 * spec:
 *  { kind: 'none' }
 *  { kind: 'static', value, scheme }
 *  { kind: 'env', name, scheme }
 *  { kind: 'file-json', path, field, scheme, header? }
 *  { kind: 'regex-file', path, pattern, group?, flags?, scheme, header? }  // 任意文本文件里按正则取一组
 *  { kind: 'sqlite-json', path, sql, field, scheme, header? }   // 宿主应用的凭证库
 */
export function createCredentialProvider(spec, { onEvent = () => {} } = {}) {
  if (!spec || !spec.kind || spec.kind === 'none') return noopProvider();

  let lastError = null;
  let lastReadAt = null;
  let cached = null; // 仅用于 describe() 展示，不作为请求取值来源

  const scheme = spec.scheme || 'bearer';

  async function readRaw() {
    switch (spec.kind) {
      case 'static':
        return spec.value;
      case 'env':
        return process.env[spec.name];
      case 'file-json': {
        const p = expandPath(spec.path);
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const v = getByPath(raw, spec.field);
        return typeof v === 'string' ? v : v == null ? null : String(v);
      }
      case 'regex-file': {
        // 从任意文本文件里按正则取一组。用于宿主把凭据写在 YAML / JSON / TOML / .env 里的情况：
        // 我们不去理解那份文件的格式，只按 manifest 声明的位置取一个值。
        const p = expandPath(spec.path);
        const text = fs.readFileSync(p, 'utf8');
        let re;
        try {
          re = new RegExp(spec.pattern, spec.flags || '');
        } catch (e) {
          throw new Error(`regex-file 的 pattern 不是合法正则：${e.message}`);
        }
        const m = text.match(re);
        if (!m) return null; // 文件在但没匹配到 → 当作"暂时没有凭据"，不抛错
        const idx = Number.isInteger(spec.group) ? spec.group : 1;
        const v = m[idx] ?? m[0];
        return v == null ? null : String(v).trim() || null;
      }
      case 'sqlite-json': {
        // 只读打开，避免与宿主应用的 WAL 写入互相阻塞；不建连接池，QPS 低，开销可忽略。
        const { DatabaseSync } = await import('node:sqlite');
        const p = expandPath(spec.path);
        const db = new DatabaseSync(p, { readOnly: true });
        try {
          db.exec('PRAGMA busy_timeout = 5000');
          const row = db.prepare(spec.sql).get();
          if (!row) return null;
          const cell = row[Object.keys(row)[0]];
          let parsed = cell;
          try {
            parsed = JSON.parse(cell);
          } catch {
            /* 有的库直接存字符串 */
          }
          const v = typeof parsed === 'string' ? parsed : getByPath(parsed, spec.field);
          return v == null ? null : String(v);
        } finally {
          db.close();
        }
      }
      default:
        throw new Error(`未知的凭证来源类型：${spec.kind}`);
    }
  }

  return {
    kind: spec.kind,
    expiresAt: spec.expiresAt || null,

    async get() {
      // 不缓存：每次请求都重新读，宿主刷新 token 后下一次请求自动生效。
      try {
        const token = await readRaw();
        lastReadAt = new Date().toISOString();
        lastError = null;
        if (!token) {
          cached = null;
          return null;
        }
        cached = { scheme, token, source: spec.kind, readAt: lastReadAt };
        return cached;
      } catch (e) {
        lastError = String(e.message || e);
        cached = null;
        onEvent(`[apx] 读取凭证失败（${spec.kind}）：${lastError}`);
        return null;
      }
    },

    /** 让下一次 get() 重新读取。401 之后调用它，拿到宿主刚刷新的新 token。 */
    invalidate() {
      cached = null;
    },

    describe() {
      const exists = spec.path ? fs.existsSync(expandPath(spec.path)) : true;
      return {
        kind: spec.kind,
        ok: !lastError && exists,
        hasToken: Boolean(cached),
        lastReadAt,
        expiresAt: spec.expiresAt || null,
        detail: lastError || (cached ? `已读取（${String(cached.token).length} 字符）` : exists ? '尚未读取' : '凭证文件不存在'),
      };
    },
  };
}

/** 把凭证转成请求头；绝不把 token 写进日志。 */
export function authHeaders(cred) {
  if (!cred || !cred.token) return {};
  if (cred.scheme === 'basic') {
    return { authorization: `Basic ${Buffer.from(cred.token).toString('base64')}` };
  }
  if (cred.scheme === 'header' && cred.header) return { [cred.header]: cred.token };
  return { authorization: `Bearer ${cred.token}` };
}

export function maskSecret(s) {
  if (!s) return '<none>';
  const str = String(s);
  return str.length <= 12 ? `${str.slice(0, 4)}…` : `${str.slice(0, 6)}…${str.slice(-4)}`;
}
