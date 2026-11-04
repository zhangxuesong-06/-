// 一次性的全端口扫描：找出"哪些本机软件自己暴露了 OpenAI 风格模型接口"。
// 这是产品 L1 检测能力的实证，也用来回答"到底能不能代理别的 agent"。
import { execFileSync } from 'node:child_process';
import { probeEndpoint } from '../prototype/src/probe.mjs';

function listening() {
  const ps = `
$ProgressPreference='SilentlyContinue';
$rows = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0','::','::1') } |
  Select-Object LocalPort, OwningProcess;
$rows | ForEach-Object {
  $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue;
  [pscustomobject]@{ port = $_.LocalPort; pid = $_.OwningProcess; name = $p.ProcessName }
} | Sort-Object port -Unique | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 8 << 20,
  });
  const data = JSON.parse(out);
  return (Array.isArray(data) ? data : [data]).filter((r) => r && r.port);
}

const rows = listening();
console.log(`监听端口 ${rows.length} 个，开始探测…\n`);

const results = [];
const CONCURRENCY = 8;
let idx = 0;

async function worker() {
  while (idx < rows.length) {
    const row = rows[idx++];
    const r = await probeEndpoint({ port: row.port });
    if (r.reachable) results.push({ ...row, level: r.level, reasons: r.reasons });
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const hit = results.filter((r) => r.level === 'L1');
const l2 = results.filter((r) => r.level === 'L2');
console.log('=== L1（可直接接入：返回 OpenAI 风格模型清单）===');
for (const r of hit) console.log(`  ${String(r.port).padEnd(6)} ${String(r.name || '?').padEnd(28)} ${r.reasons[0] || ''}`);
console.log('\n=== L2（有 JSON 但非标准形态，需适配）===');
for (const r of l2.slice(0, 12)) console.log(`  ${String(r.port).padEnd(6)} ${String(r.name || '?').padEnd(28)} ${r.reasons[0] || ''}`);
console.log(`\n小结：可达 ${results.length} / ${rows.length}；L1 ${hit.length} 个，L2 ${l2.length} 个。`);
