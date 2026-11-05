// N7：并发上限 + 有界队列 + 超时。
//
// 两层验证：
//   1) limiter 本身：FIFO、队列满快速失败、排队超时、release 幂等；
//   2) 代理端点：并发槽真的限制在途请求，队列满返回 503 apx_queue_full（不是挂住）。
import './_isolate-state.mjs';
import { createLimiter } from '../src/runtime/limiter.mjs';
import { createProxyServer } from '../src/proxy/server.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function main() {
  console.log('== limiter：并发上限 / 有界队列 / 超时 ==');

  console.log('\n[1] 并发、FIFO 与队列满');
  {
    const limiter = createLimiter({ maxConcurrent: 2, maxQueue: 1, queueTimeoutMs: 500 });
    const s1 = await limiter.acquire();
    const s2 = await limiter.acquire();
    check('前两个立即放行', limiter.active === 2, JSON.stringify(limiter.stats()));

    const waiting = limiter.acquire();
    await sleep(10);
    check('第三个进入队列', limiter.queued === 1, JSON.stringify(limiter.stats()));

    const rejected = await limiter.acquire().catch((e) => e);
    check('队列满立即拒绝', rejected?.code === 'apx_queue_full', JSON.stringify(rejected));
    check('拒绝是 503 且带 retry-after=1', rejected?.status === 503 && rejected?.upstream?.retryAfter === 1, JSON.stringify(rejected));

    s1.release();
    const s3 = await waiting;
    check('释放后队首被唤醒（active 不抖动）', limiter.active === 2 && limiter.queued === 0, JSON.stringify(limiter.stats()));

    s1.release(); // 重复释放必须幂等
    check('重复 release 不把并发计数打穿', limiter.active === 2, JSON.stringify(limiter.stats()));

    s2.release();
    s3.release();
    check('全部释放后归零', limiter.active === 0, JSON.stringify(limiter.stats()));
  }

  console.log('\n[2] 排队超时');
  {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 60 });
    const held = await limiter.acquire();
    const timedOut = await limiter.acquire().catch((e) => e);
    check('排队超时 code=apx_queue_timeout', timedOut?.code === 'apx_queue_timeout', JSON.stringify(timedOut));
    check('排队超时也是 503', timedOut?.status === 503, String(timedOut?.status));
    check('超时 waiter 已从队列移除', limiter.queued === 0, JSON.stringify(limiter.stats()));
    held.release();
  }

  console.log('\n[3] 代理端点：并发受控 + 队列满快速 503');
  {
    let inFlight = 0;
    let maxInFlight = 0;
    const translator = {
      async chat(body) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(body.messages?.[0]?.content === 'slow' ? 120 : 10);
        inFlight--;
        return { text: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      },
      async openStream() {
        return { unsupported: true };
      },
      async listModels() {
        return { models: [{ alias: 'm', upstreamId: 'm', provider: null }] };
      },
    };
    const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 500 });
    const server = createProxyServer({
      token: 'tok',
      translator,
      adapter: { id: 'lim-test', capabilities: { streaming: false } },
      getCatalog: async () => ({ models: [] }),
      limiter,
    });
    const port = await listen(server);
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' };
    const call = (content) =>
      fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }) });

    try {
      const first = call('slow');
      await sleep(30); // 先让第一个请求确实进到上游，再发第二个
      const second = call('slow');
      await sleep(60); // 给第二个请求足够时间进入队列
      check('一个在途、一个排队', limiter.stats().active === 1 && limiter.stats().queued === 1, JSON.stringify(limiter.stats()));

      const t0 = Date.now();
      const third = await call('x');
      const thirdBody = await third.json().catch(() => null);
      const elapsed = Date.now() - t0;
      check('第三个请求 503', third.status === 503, `实际 ${third.status}`);
      check('code=apx_queue_full', thirdBody?.error?.code === 'apx_queue_full', JSON.stringify(thirdBody));
      check('快速失败（<300ms，不是等上游）', elapsed < 300, `${elapsed}ms`);
      check('带 retry-after 头', third.headers.get('retry-after') === '1', String(third.headers.get('retry-after')));

      const [r1, r2] = await Promise.all([first, second]);
      check('排队请求最终成功', r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
      check('上游最大在途数 = 1（槽位真的生效）', maxInFlight === 1, String(maxInFlight));
      check('结束后槽位归零', limiter.active === 0, JSON.stringify(limiter.stats()));

      const again = await call('fast');
      check('队列清空后新请求恢复 200', again.status === 200, String(again.status));
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
