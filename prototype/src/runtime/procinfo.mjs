// 进程身份取证：判断"这个 pid 现在还是不是我当初启动的那个进程"。
//
// 为什么要它：状态文件里记的是裸 pid，而 pid 会被系统回收。
// 用户半小时后再跑 `apx stop`，那个 pid 可能已经属于某个完全无关的程序——
// 此时 taskkill /F 就是误杀别人的进程。三个条件全满足才允许动手：
//   ① 该 pid 现在存在
//   ② 该 pid 的可执行文件路径 == 记录值
//   ③ 该进程的启动时间不早于记录时间（容差 2s）
//
// Windows 走 PowerShell（与其他发现层同一套入口）；POSIX 用 ps，取不到全路径时降级为
// 比较 basename，并在返回值里标明取证等级，由调用方决定是否接受。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { psJson, IS_WIN } from '../lib/ps.mjs';

/** stop 时允许的启动时间误差：记录值与系统值之间可能有一次查询的往返延迟。 */
export const START_TIME_TOLERANCE_MS = 2000;

function normalizePath(p) {
  if (!p) return null;
  return String(p).replace(/\\/g, '/').toLowerCase();
}

/** 路径是否"同一个"：全路径相等，或（POSIX 只拿到 basename 时）basename 相等。 */
function samePath(a, b) {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (!na.includes('/') || !nb.includes('/')) return path.posix.basename(na) === path.posix.basename(nb);
  return false;
}

/**
 * 批量查询进程信息。
 *
 * @param {number[]} pids
 * @returns {Promise<Record<number, {pid:number, exePath:string|null, startMs:number|null, source:string}>>}
 *          只包含**当前存在**的 pid；不存在的 pid 不出现在结果里。
 */
export async function getProcessInfoMany(pids = []) {
  const wanted = [...new Set(pids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = {};
  if (!wanted.length) return out;

  if (IS_WIN) {
    const ids = wanted.join(',');
    const script = `$ids = @(${ids});
$ids | ForEach-Object {
  $p = Get-Process -Id $_ -ErrorAction SilentlyContinue;
  if ($p) {
    $exe = $null; try { $exe = $p.Path } catch { $exe = $null }
    $start = $null; try { $start = [int64](($p.StartTime).ToUniversalTime() - [datetime]'1970-01-01T00:00:00Z').TotalMilliseconds } catch { $start = $null }
    [pscustomobject]@{ id = $p.Id; exePath = $exe; startMs = $start }
  }
} | ConvertTo-Json -Depth 3 -Compress`;
    const data = await psJson(script, { timeout: 20000 });
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    for (const r of rows) {
      const pid = Number(r?.id);
      if (!Number.isInteger(pid)) continue;
      out[pid] = {
        pid,
        exePath: r.exePath ? String(r.exePath) : null,
        startMs: r.startMs == null ? null : Number(r.startMs),
        source: r.exePath && r.startMs != null ? 'win32:full' : 'win32:partial',
      };
    }
    return out;
  }

  // POSIX：etimes 是已运行秒数，据此反推启动时刻；comm 只有名字，没有全路径。
  const args = ['-p', wanted.join(','), '-o', 'pid=,etimes=,comm='];
  const text = await new Promise((resolve) => {
    execFile('ps', args, { timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
  const now = Date.now();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const etimes = Number(parts[1]);
    const comm = parts.slice(2).join(' ');
    if (!Number.isInteger(pid)) continue;
    out[pid] = {
      pid,
      exePath: comm || null,
      startMs: Number.isFinite(etimes) ? now - etimes * 1000 : null,
      source: 'posix:basename',
    };
  }
  return out;
}

/** 单个进程的信息；不存在返回 null。 */
export async function getProcessInfo(pid) {
  const map = await getProcessInfoMany([pid]);
  return map[Number(pid)] || null;
}

/** 进程是否还活着（只做存在性判断，不做身份校验）。 */
export async function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  const info = await getProcessInfo(n);
  return Boolean(info);
}

/**
 * 三条件校验：这个 pid 现在还是不是 rec 记录的那个进程。
 *
 * @param {{pid:number, exePath?:string|null, startMs?:number|null}} rec
 * @returns {Promise<{ok:boolean, reason:string, info:object|null}>}
 */
export async function isOurProcess(rec) {
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: '记录里没有合法 pid', info: null };

  const info = await getProcessInfo(pid);
  // ① 存在性
  if (!info) return { ok: false, reason: `pid ${pid} 已不存在`, info: null };

  // ② 可执行路径。取不到就判"不可确认"，宁可跳过也不误杀。
  if (!rec.exePath) return { ok: false, reason: `pid ${pid} 的记录里没有可执行路径，无法确认身份`, info };
  if (!info.exePath) return { ok: false, reason: `pid ${pid} 的可执行路径不可读（权限不足），无法确认身份`, info };
  if (!samePath(info.exePath, rec.exePath)) {
    return { ok: false, reason: `pid ${pid} 的可执行路径是 ${info.exePath}，与记录的 ${rec.exePath} 不符`, info };
  }

  // ③ 启动时间：不能早于记录时间（早于 = 这是更早启动的另一个进程复用了同一个 pid）
  if (rec.startMs == null || info.startMs == null) {
    return { ok: false, reason: `pid ${pid} 的启动时间不可读，无法确认身份`, info };
  }
  if (info.startMs < Number(rec.startMs) - START_TIME_TOLERANCE_MS) {
    return {
      ok: false,
      reason: `pid ${pid} 的启动时间早于记录时间 ${Math.round((Number(rec.startMs) - info.startMs) / 1000)}s，判定为 pid 复用`,
      info,
    };
  }

  return { ok: true, reason: '三条件均满足', info };
}

/** 杀进程树：Windows 用 taskkill /T /F；POSIX 先杀进程组再退化为单进程。 */
export async function killTree(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (IS_WIN) {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(n), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
    });
  }
  try {
    process.kill(-n, 'SIGTERM');
    return true;
  } catch {
    try {
      process.kill(n, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}
