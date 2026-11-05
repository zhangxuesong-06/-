// 并发限流 + 有界队列。
//
// 为什么需要它：本机上游（尤其是 agent 起的 serve 实例）常常是串行或低并发的。
// 下游多个程序同时打过来时，没有上限就会把上游拖垮，而且失败会以「超时」而不是
// 「忙」的形式出现——前者让客户端等 120s，后者可以立刻退避。
//
// 语义（N7）：
//   - active < maxConcurrent        → 立即放行；
//   - 否则 queue 未满                → 排队，最多等 queueTimeoutMs；
//   - 队列已满                       → 立刻 503 apx_queue_full；
//   - 排队超时                       → 503 apx_queue_timeout。
// 队列严格 FIFO；release 幂等，防止重复释放把并发计数打穿。

export function createLimiter({
  maxConcurrent = 8,
  maxQueue = 32,
  queueTimeoutMs = 30000,
} = {}) {
  const limit = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 8;
  const queueLimit = Number.isInteger(maxQueue) && maxQueue >= 0 ? maxQueue : 32;
  const waitTimeout = Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0 ? queueTimeoutMs : 30000;

  let active = 0;
  const waiters = [];
  const waits = [];
  const stats = { admitted: 0, rejected: 0, timedOut: 0, maxWaitMs: 0 };

  function snapshot() {
    const sorted = [...waits].sort((a, b) => a - b);
    return {
      maxConcurrent: limit,
      maxQueue: queueLimit,
      queueTimeoutMs: waitTimeout,
      active,
      queued: waiters.length,
      admitted: stats.admitted,
      rejected: stats.rejected,
      timedOut: stats.timedOut,
      maxWaitMs: stats.maxWaitMs,
      p95WaitMs: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null,
    };
  }

  function makeRelease() {
    let released = false;
    return function release() {
      if (released) return;
      released = true;

      const next = waiters.shift();
      if (next) {
        clearTimeout(next.timer);
        const waited = Date.now() - next.enqueuedAt;
        waits.push(waited);
        if (waits.length > 500) waits.shift();
        stats.maxWaitMs = Math.max(stats.maxWaitMs, waited);
        stats.admitted++;
        // active 不变：这个槽位直接交给队首，不经历「先减后加」的窗口。
        next.resolve({ release: makeRelease() });
        return;
      }
      active = Math.max(0, active - 1);
    };
  }

  function acquire() {
    if (active < limit) {
      active++;
      stats.admitted++;
      return Promise.resolve({ release: makeRelease() });
    }

    if (waiters.length >= queueLimit) {
      stats.rejected++;
      const err = new Error(`并发已满（${limit}）且排队已满（${queueLimit}），请稍后重试`);
      err.status = 503;
      err.code = 'apx_queue_full';
      err.upstream = { retryAfter: 1 };
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        stats.timedOut++;
        const err = new Error(`排队超时（>${waitTimeout}ms），请稍后重试`);
        err.status = 503;
        err.code = 'apx_queue_timeout';
        err.upstream = { retryAfter: 1 };
        reject(err);
      }, waitTimeout);
      // 不 unref：排队中的请求必须能被超时唤醒；否则进程空闲时定时器会被直接回收。
      waiters.push(waiter);
    });
  }

  return {
    acquire,
    stats: snapshot,
    /** 供测试与诊断：当前在途数量。 */
    get active() {
      return active;
    },
    get queued() {
      return waiters.length;
    },
  };
}
