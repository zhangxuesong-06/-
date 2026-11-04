// 本地令牌与状态持久化。
//
// 令牌是下游鉴权的唯一凭据，同时也是 CSRF 防线：带 Authorization 的跨域请求必须预检，
// 而我们对预检一律拒绝，所以网页里的 fetch 根本发不出去。
//
// 两条硬约束（都是踩过的坑）：
//  1) **令牌绝不自动变化**。用户把 baseURL/apiKey 配进下游程序后，令牌一换就是一片 401，
//     且报错信息里看不出原因。所以只有 `apx token rotate` 这一个显式入口能换令牌；
//     读到损坏的状态文件时**抛错**，绝不"当作没令牌 → 生成新的"。
//  2) **写入必须原子**。半写文件会被下一次读取当成损坏，进而引发上面那条。
//     做法：同目录 tmp 文件 + rename 替换（rename 在同一文件系统上是原子的），
//     并用一个排他创建（wx）的锁文件避免多进程同时首次生成出两个不同令牌。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const LOCK_TIMEOUT_MS = 4000; // 抢锁总等待
const LOCK_STALE_MS = 5000; // 锁文件超过这个年龄视为进程已死，可抢占

/**
 * 状态目录。默认 `~/.apx`（全局单例）。
 *
 * `APX_STATE_DIR` 可覆盖：测试与并行验收必须用它把状态隔离到临时目录，
 * 否则两个进程会互相改同一个 state.json（本项目真实踩过：并行跑测试时
 * 一个套件读到另一个套件写下的半成品，表现为"令牌被换 / 代理未就绪"的假失败）。
 */
export function stateDir() {
  const override = process.env.APX_STATE_DIR;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.apx');
}

function stateFile() {
  return path.join(stateDir(), 'state.json');
}

function lockFile() {
  return path.join(stateDir(), 'state.json.lock');
}

/** 同步 sleep：抢锁失败时退避，不引入异步（writeState 是同步 API）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 排他锁：拿不到就退避重试；锁过期（持锁进程崩了）则抢占。 */
function withLock(fn) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const lock = lockFile();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        /* 锁刚被释放，直接重试 */
      }
      if (Date.now() > deadline) {
        // 极端情况：超时也不再死等，清掉锁继续（宁可轻微竞争，也不要卡住 CLI）。
        // 这条分支无法用测试稳定复现（要注入 sleep），所以必须留下日志——
        // 线上真出现多令牌问题时，这行是唯一线索。
        try {
          process.stderr.write('⚠ 抢锁超过 4s，已强制接管（可能有并发首启）\n');
        } catch {
          /* stderr 不可写时忽略，不能因为打日志把主流程搞挂 */
        }
        try {
          fs.unlinkSync(lock);
        } catch {
          /* ignore */
        }
        continue;
      }
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      /* 已被别人清掉 */
    }
  }
}

/**
 * 读状态。
 *
 * - 文件不存在 → `{}`（全新安装，正常）
 * - 解析失败/顶层不是对象 → `{ __corrupt: true }`
 *   **绝不返回 `{}`**：那会让 getToken() 以为"没有令牌"从而生成新的，把用户的配置搞失效。
 */
export function readState() {
  let raw;
  try {
    raw = fs.readFileSync(stateFile(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { __corrupt: true, __raw: raw.slice(0, 200) };
    return parsed;
  } catch {
    return { __corrupt: true, __raw: raw.slice(0, 200) };
  }
}

/** 不含锁的写入：调用方必须已经持锁。 */
function writeUnlocked(patch) {
  const cur = readState();
  const base = cur && cur.__corrupt ? {} : cur; // 损坏时不要把 __corrupt 写回文件
  const next = { ...base, ...patch };
  const tmp = path.join(stateDir(), `state.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  // 同目录 rename：要么是旧文件，要么是新文件，不会出现半截内容
  fs.renameSync(tmp, stateFile());
  return next;
}

/** 原子写入状态（合并 patch）。 */
export function writeState(patch) {
  fs.mkdirSync(stateDir(), { recursive: true });
  return withLock(() => writeUnlocked(patch));
}

/** 损坏状态的标准错误：给用户一条明确的出路，而不是让人猜。 */
export function corruptStateError() {
  return new Error('状态文件损坏（~/.apx/state.json）。请删除该文件，或运行 `apx token rotate` 重新生成令牌后再试。');
}

/**
 * 取下游令牌。
 *
 * 注意：**没有令牌且不是 rotate 时才会生成**，且生成过程在锁内二次确认，
 * 多进程同时首次启动也只会有一个令牌胜出（其余读到同一个值）。
 *
 * @param {{rotate?:boolean}} [opts] rotate=true 是唯一允许更换令牌的路径
 */
export function getToken({ rotate = false } = {}) {
  if (rotate) {
    return withLock(() => {
      const token = `sk-local-${randomBytes(24).toString('base64url')}`;
      writeUnlocked({ token, tokenCreatedAt: new Date().toISOString() });
      return token;
    });
  }

  const st = readState();
  if (st.__corrupt) throw corruptStateError();
  if (st.token) return st.token;

  return withLock(() => {
    const cur = readState();
    if (cur.__corrupt) throw corruptStateError();
    if (cur.token) return cur.token; // 别的进程刚写好，用它的
    const token = `sk-local-${randomBytes(24).toString('base64url')}`;
    writeUnlocked({ token, tokenCreatedAt: new Date().toISOString() });
    return token;
  });
}

export function maskToken(token) {
  if (!token) return '';
  return `${token.slice(0, 12)}…${token.slice(-4)}`;
}

/** 常量时间比较，避免计时侧信道。 */
export function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
