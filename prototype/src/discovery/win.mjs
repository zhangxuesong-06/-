// Windows 发现源：注册表 / 进程 / 监听端口 / 目录约定。
// 设计原则：这里的不出现任何厂商名——发现层只负责"列出候选"，判断是不是某款 agent 由适配器（manifest）完成。
import { psJson } from '../lib/ps.mjs';

const UNINSTALL_HIVES = [
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
];

/** 注册表安装项。置信度 0.95（有版本）/ 0.85（无版本）。 */
export async function scanRegistry() {
  const keys = UNINSTALL_HIVES.map((k) => `"${k}"`).join(',');
  const data = await psJson(
    `Get-ItemProperty -Path ${keys} -ErrorAction SilentlyContinue |
     Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
     Select-Object DisplayName, DisplayVersion, InstallLocation, DisplayIcon, Publisher |
     ConvertTo-Json -Depth 4 -Compress`,
  );
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.map((r) => ({
    kind: 'registry',
    name: String(r.DisplayName || '').trim(),
    version: r.DisplayVersion ? String(r.DisplayVersion).trim() : null,
    installLocation: r.InstallLocation ? String(r.InstallLocation).trim() : null,
    displayIcon: r.DisplayIcon ? String(r.DisplayIcon).replace(/,\d+$/, '') : null,
    publisher: r.Publisher || null,
    confidence: r.DisplayVersion ? 0.95 : 0.85,
    pathSource: r.InstallLocation ? 'registry' : null,
    exePath: null,
  }));
}

/** 运行中的进程（只保留能拿到 Path 的，即用户态可执行文件）。 */
export async function scanProcesses() {
  const data = await psJson(
    `Get-Process -ErrorAction SilentlyContinue |
     Where-Object { $_.Path } |
     Select-Object Id, ProcessName, Path, MainWindowTitle |
     ConvertTo-Json -Depth 3 -Compress`,
  );
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.map((r) => ({
    pid: Number(r.Id),
    processName: String(r.ProcessName || ''),
    exePath: r.Path ? String(r.Path) : null,
    windowTitle: r.MainWindowTitle ? String(r.MainWindowTitle) : '',
  }));
}

/** 监听中的 TCP 端口 → {addr, port, pid}。 */
export async function scanListening() {
  const data = await psJson(
    `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
     Select-Object LocalAddress, LocalPort, OwningProcess |
     ConvertTo-Json -Depth 3 -Compress`,
    30000,
  );
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.map((r) => ({
    addr: String(r.LocalAddress || ''),
    port: Number(r.LocalPort),
    pid: Number(r.OwningProcess),
  }));
}

/** 目录约定：常见安装落点里的可执行文件。置信度 0.60。 */
export async function scanConventions() {
  const roots = [
    '%LOCALAPPDATA%\\Programs',
    '%APPDATA%',
    '%ProgramFiles%',
    '%ProgramFiles(x86)%',
  ];
  const listed = roots.map((r) => `"${r}"`).join(',');
  const data = await psJson(
    `$roots = @(${listed});
     $out = @();
     foreach ($r in $roots) {
       $p = [Environment]::ExpandEnvironmentVariables($r);
       if (Test-Path $p) {
         $out += Get-ChildItem -Path $p -Filter *.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue |
                 Select-Object -First 400 -ExpandProperty FullName
       }
     }
     $out | ConvertTo-Json -Depth 2 -Compress`,
    60000,
  );
  const arr = Array.isArray(data) ? data : data ? [data] : [];
  return arr.map((p) => ({
    kind: 'convention',
    exePath: String(p),
    name: String(p).split(/[\\/]/).pop().replace(/\.exe$/i, ''),
    version: null,
    confidence: 0.6,
  }));
}

/**
 * 适配器声明的搜索路径（glob）。
 * 这是"通用性"的关键一环：厂商相关的深路径只写在 manifest 里，主程序不含任何厂商知识。
 */
export async function scanGlobs(patterns) {
  const list = (patterns || [])
    .map((p) => p.replace(/%([A-Za-z_]+)%/g, (_, k) => process.env[k] || ''))
    .filter(Boolean);
  if (!list.length) return [];
  const quoted = list.map((p) => `"${p.replace(/"/g, '""')}"`).join(',');
  const data = await psJson(
    `$pats = @(${quoted});
     $pats | ForEach-Object {
       Get-ChildItem -Path $_ -ErrorAction SilentlyContinue |
         Where-Object { -not $_.PSIsContainer } |
         ForEach-Object { [pscustomobject]@{ exe = $_.FullName; size = $_.Length } }
     } | ConvertTo-Json -Depth 3 -Compress`,
    45000,
  );
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows
    .filter((r) => r && r.exe)
    .map((r) => ({
      kind: 'adapter-glob',
      exePath: String(r.exe),
      name: String(r.exe).split(/[\\/]/).pop().replace(/\.exe$/i, ''),
      version: null,
      installLocation: String(r.exe).replace(/[\\/][^\\/]+$/, ''),
      confidence: 0.9,
      size: Number(r.size) || 0,
    }));
}

/** 读取 exe 的文件版本（注册表缺失时的备份来源）。 */export async function fileVersions(paths) {
  if (!paths.length) return {};
  const list = paths.slice(0, 60).map((p) => `"${p.replace(/"/g, '""')}"`).join(',');
  const data = await psJson(
    `$paths = @(${list});
     $paths | ForEach-Object {
       $f = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue;
       if ($f) { [pscustomobject]@{ path = $f.FullName; version = $f.VersionInfo.FileVersion } }
     } | ConvertTo-Json -Depth 3 -Compress`,
  );
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const map = {};
  for (const r of rows) if (r && r.path) map[r.path.toLowerCase()] = r.version || null;
  return map;
}
