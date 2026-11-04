// `apx stop` 的安全回收：先验身份，再决定动不动手。
//
// 背景：状态文件里存的是裸 pid。用户在半小时后（甚至重启后）跑 `apx stop`，
// 这个 pid 很可能已经被系统分配给了别的程序——直接 taskkill /F 就是误杀。
// 所以回收流程是「取证 → 判定 → 再杀」，任一条不满足就只清状态、不动进程。
import { readState, writeState } from '../security/token.mjs';
import { isOurProcess, killTree } from './procinfo.mjs';

/** 清空状态时统一写这一份，避免各处漏字段。 */
export const CLEARED_STATE = {
  pid: null,
  proxyPort: null,
  adapterId: null,
  serviceFacePid: null,
  upstreamPort: null,
  proxyProc: null,
  serviceFaceProc: null,
};

/**
 * 按状态文件回收进程（安全版）。
 *
 * @param {{log?:Function, dryRun?:boolean}} [opts]
 * @returns {Promise<{stopped:boolean, killed:Array, skipped:Array, ports:number[], reason?:string}>}
 */
export async function stopRecordedProcesses({ log = () => {}, dryRun = false } = {}) {
  const st = readState();
  // 状态损坏时无法确认身份 → 一个都不杀（安全默认），并明确告诉用户该做什么
  if (st.__corrupt) {
    log('状态文件损坏（~/.apx/state.json），无法确认进程身份 → 不杀任何进程。请手动检查进程，或删除该文件后重试。');
    return { stopped: false, killed: [], skipped: [], ports: [], reason: 'corrupt' };
  }
  const records = [];

  if (st.pid) {
    records.push({ role: '代理进程', pid: Number(st.pid), exePath: st.proxyProc?.exePath || null, startMs: st.proxyProc?.startMs ?? null });
  }
  if (st.serviceFacePid) {
    records.push({
      role: '上游进程',
      pid: Number(st.serviceFacePid),
      exePath: st.serviceFaceProc?.exePath || null,
      startMs: st.serviceFaceProc?.startMs ?? null,
    });
  }

  if (!records.length) return { stopped: false, killed: [], skipped: [], ports: [], reason: 'no-record' };

  const killed = [];
  const skipped = [];

  for (const rec of records) {
    const verdict = await isOurProcess(rec);
    if (!verdict.ok) {
      // 关键分支：宁可留一个孤儿进程让用户手动处理，也不误杀别人的进程
      log(`已跳过（进程已不是我们启动的那个）${rec.role} pid ${rec.pid}：${verdict.reason}`);
      skipped.push({ ...rec, reason: verdict.reason });
      continue;
    }
    if (dryRun) {
      killed.push({ ...rec, dryRun: true });
      continue;
    }
    const ok = await killTree(rec.pid);
    log(`已回收${rec.role} pid ${rec.pid}${ok ? '' : '（taskkill 返回失败，可能已退出）'}`);
    killed.push({ ...rec, ok });
  }

  if (!dryRun) writeState(CLEARED_STATE);

  const ports = [Number(st.proxyPort)].filter((p) => Number.isInteger(p) && p > 0);
  return { stopped: killed.length > 0, killed, skipped, ports };
}
