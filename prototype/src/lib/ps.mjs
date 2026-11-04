// 平台进程/端口/注册表访问的统一入口。
// Windows 走 PowerShell（-NoProfile、UTF-8 输出、JSON 序列化），避免 GBK 代码页与本地化输出解析问题。
// POSIX 分支为占位实现，未在真机验证，调用时会显式说明。
import { execFile } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** 执行 PowerShell 并把结果解析为 JSON。失败返回 null（不抛），由调用方决定降级策略。 */
export function psJson(script, { timeout = 20000 } = {}) {
  if (!IS_WIN) return Promise.resolve(null);
  const wrapped = [
    '$ProgressPreference="SilentlyContinue";',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;',
    script,
  ].join(' ');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const text = String(stdout).trim();
        if (!text) return resolve(null);
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

export const platform = IS_WIN ? 'win32' : process.platform;

export { psQuote, IS_WIN };
