// 「噪声可执行文件」的唯一判定：卸载器、安装器、崩溃上报、更新器。
//
// 为什么要有共享实现：发现层（pickBestExe 猜主程序）与匹配层（matchAdapter 判断
// "这是不是这款软件"）都需要它。两处各写一份正则，迟早出现"发现层排除了、匹配层没排除"，
// 表现就是首屏出现 `Uninstall xxx.exe` 这种条目 —— 用户点下去是卸载软件，不是启动。
//
// 边界：这里只负责**识别**，不决定怎么处理。
//   - 发现层：命中即大幅降权（因为要在一堆 exe 里挑主程序）
//   - 匹配层：命中即不计分（因为"能启动"比"分高"更要紧）
// manifest 的 match.exeNames 显式列出某个基名时视为豁免（有的软件主程序真叫 update.exe）。

const NOISE_PREFIX = /^(unins|setup|installer|install|crash|update)/i;
const NOISE_SUBSTR = ['unins'];

/**
 * @param {string} name 文件名或路径（`.exe` 可带可不带）
 * @returns {boolean}
 */
export function isNoiseExe(name) {
  const raw = String(name || '').trim();
  if (!raw) return false;
  const base = raw.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  if (!base) return false;
  const lower = base.toLowerCase();
  if (NOISE_SUBSTR.some((s) => lower.includes(s))) return true;
  return NOISE_PREFIX.test(base);
}

/** 给诊断用的短标签（命中时返回命中的规则，便于排查为什么被排除）。 */
export function noiseReason(name) {
  if (!isNoiseExe(name)) return null;
  const base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  const lower = base.toLowerCase();
  const sub = NOISE_SUBSTR.find((s) => lower.includes(s));
  if (sub) return `contains:${sub}`;
  const m = base.match(NOISE_PREFIX);
  return m ? `prefix:${m[1].toLowerCase()}` : 'noise';
}
