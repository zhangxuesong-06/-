// 测试用：把状态目录隔离到临时目录。
//
// 为什么必须这样：`~/.apx/state.json` 是全局单例。`token.test` 会故意写坏它来验证
// "损坏不重建"，`stop-safety` 会写假 pid 来验证"不误杀"。如果两个套件（或两个验收
// 进程）并行跑，就会互相读到对方的半成品，表现为"令牌被换 / 代理未就绪 / 状态损坏"
// 的假失败——本项目真的踩到过。
//
// 用法：在测试文件的第一行 `import './_isolate-state.mjs';`
// （ESM 按 import 顺序求值，所以它会在任何模块调用 stateDir() 之前生效）。
// 外部若设置了 APX_STATE_DIR 则尊重外部设置，不覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.APX_STATE_DIR || !String(process.env.APX_STATE_DIR).trim()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-state-'));
  process.env.APX_STATE_DIR = dir;
  // 进程退出时清掉，避免在 Temp 里堆一堆空目录（测试被杀时也可能留，属可接受的残留）
  process.on('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
}
