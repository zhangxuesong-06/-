// 令牌稳定性测试：令牌「自己变了」是最难查的一类故障（用户配好的客户端突然 401）。
//
// 硬约束（本文件逐条钉住）：
//   ① 正常情况反复取令牌，值必须恒定；
//   ② 状态文件损坏时 getToken() 必须抛错，且**不覆盖原文件**（不能"当作没令牌→生成新的"）；
//   ③ 只有显式 rotate 能换令牌，换后旧值不再被接受；
//   ④ 多进程并发首次启动，只能有一个令牌胜出（不能各生成一个）；
//   ⑤ 写入过程不留 tmp / lock 垃圾文件。
//
// 本测试**不得触碰真实的 `~/.apx`**：首行 `import './_isolate-state.mjs'` 会把
// `APX_STATE_DIR` 指到临时目录（mkdtemp），退出时清理。真实状态目录只读不写。
// 需要保留现场排查时：`APX_STATE_DIR=/some/dir node test/token.test.mjs`。
import './_isolate-state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stateDir, readState, getToken, maskToken, tokenMatches } from '../src/security/token.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_MODULE = pathToFileURL(path.resolve(HERE, '../src/security/token.mjs')).href;
const STATE_FILE = path.join(stateDir(), 'state.json');

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

/** 只在失败时展示，且永远掩码/截断，不打印明文令牌。 */
function mask(v) {
  return typeof v === 'string' && v.length > 8 ? maskToken(v) : String(v);
}

function listGarbage() {
  try {
    return fs.readdirSync(stateDir()).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
  } catch {
    return [];
  }
}

/** 起一个子进程，只做一次 getToken() 并打印（用于验证跨进程一致性）。 */
function childToken() {
  const script =
    `import { getToken, maskToken } from ${JSON.stringify(TOKEN_MODULE)};\n` +
    `try { process.stdout.write('OK:' + getToken()); } catch (e) { process.stdout.write('ERR:' + e.message); }\n`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errs = '';
    // 只从 stdout 取令牌值：stderr 可能有"抢锁强制接管"这类告警，混进来会污染比对
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (errs += b.toString()));
    child.on('exit', () => resolve({ out: out.trim(), errs: errs.trim() }));
  });
}

async function main() {
  console.log('== token：令牌不得被意外轮换 ==');
  const hadFile = fs.existsSync(STATE_FILE);
  const backup = hadFile ? fs.readFileSync(STATE_FILE, 'utf8') : null;

  try {
    console.log('\n[1] 反复取令牌，值恒定');
    {
      const t1 = getToken();
      const t2 = getToken();
      const t3 = getToken();
      check('三次取值完全相同', t1 === t2 && t2 === t3, `${mask(t1)} / ${mask(t2)} / ${mask(t3)}`);
      check('令牌形状符合 sk- 前缀', /^sk-/.test(t1) && t1.length >= 20, `${mask(t1)} len=${t1.length}`);
      check('落盘值与内存值一致', readState().token === t1, `${mask(readState().token)}`);
    }

    console.log('\n[2] 状态文件损坏：抛错、且不覆盖原文件');
    {
      const half = '{"token":';
      fs.writeFileSync(STATE_FILE, half, { encoding: 'utf8', mode: 0o600 });
      const before = fs.readFileSync(STATE_FILE, 'utf8');

      let err = null;
      try {
        getToken();
      } catch (e) {
        err = e;
      }
      check('getToken 抛错', Boolean(err), err ? '' : '没有抛错（会静默生成新令牌）');
      check('错误信息可操作（指向 state.json / rotate）', /state\.json/.test(err?.message || '') && /rotate/.test(err?.message || ''), err?.message);
      const after = fs.readFileSync(STATE_FILE, 'utf8');
      check('原文件未被覆盖', after === before, `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
      const st = readState();
      check('readState 返回 __corrupt 而不是 {}', st.__corrupt === true, JSON.stringify(st).slice(0, 120));
    }

    console.log('\n[3] rotate 是唯一换令牌的入口');
    {
      // 从损坏状态恢复：rotate 必须能救回来
      const t1 = getToken({ rotate: true });
      check('rotate 能从损坏状态恢复', /^sk-/.test(t1), mask(t1));
      const t2 = getToken({ rotate: true });
      check('rotate 后令牌变化', t1 !== t2, `${mask(t1)} / ${mask(t2)}`);
      check('当前值等于最后一次 rotate', getToken() === t2, mask(getToken()));
      check('旧令牌不再被接受', tokenMatches(t1, getToken()) === false);
      check('新令牌能被接受', tokenMatches(t2, getToken()) === true);
    }

    console.log('\n[4] 并发：多进程首次启动只能产生一个令牌');
    {
      // 清掉令牌，制造"首次安装"现场
      const st = readState();
      const cleared = { ...st };
      delete cleared.token;
      delete cleared.tokenCreatedAt;
      fs.writeFileSync(STATE_FILE, JSON.stringify(cleared, null, 2), { encoding: 'utf8', mode: 0o600 });

      const results = await Promise.all(Array.from({ length: 8 }, () => childToken()));
      const ok = results.map((r) => r.out).filter((o) => o.startsWith('OK:')).map((o) => o.slice(3));
      const errs = results.filter((r) => !r.out.startsWith('OK:')).map((r) => r.out || r.errs);
      check('8 个并发子进程都成功取到令牌', ok.length === 8 && errs.length === 0, errs.join(' | '));
      const uniq = [...new Set(ok)];
      check('8 个进程拿到的是同一个令牌', uniq.length === 1, `${uniq.length} 个不同值：${uniq.map(mask).join(', ')}`);
      check('落盘令牌与子进程一致', readState().token === ok[0], `${mask(readState().token)} vs ${mask(ok[0])}`);

      // 进程内 20 次（读路径）
      const many = Array.from({ length: 20 }, () => getToken());
      check('进程内 20 次取值恒等', new Set(many).size === 1, `${new Set(many).size} 个不同值`);
    }

    console.log('\n[5] 不留垃圾文件');
    {
      getToken();
      getToken({ rotate: true });
      const garbage = listGarbage();
      check('无 .tmp / .lock 残留', garbage.length === 0, garbage.join(', '));
    }
  } finally {
    // 恢复原状（令牌必须还原，否则会影响用户已配置的下游）
    try {
      if (backup !== null) fs.writeFileSync(STATE_FILE, backup, { encoding: 'utf8', mode: 0o600 });
      else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    } catch {
      /* ignore */
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
