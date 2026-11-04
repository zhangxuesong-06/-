// 发现层聚合：多源合并 → 规范化 → 去重 → 置信度。
// 置信度取单源最大值（不做求和），避免"三个弱证据凑成强结论"。
import { createHash } from 'node:crypto';
import path from 'node:path';
import { psJson } from '../lib/ps.mjs';
import { isNoiseExe } from '../lib/exec-noise.mjs';
import { scanRegistry, scanProcesses, scanListening, scanConventions, scanGlobs, fileVersions } from './win.mjs';

const SOURCE_PRIORITY = { registry: 0.95, 'adapter-glob': 0.9, 'process-path': 0.9, 'file-version': 0.85, convention: 0.6 };

function normalizeKey(p) {
  if (!p) return null;
  return path.resolve(p).toLowerCase();
}

function shortId(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

function squash(s) {
  return String(s || '').toLowerCase().replace(/[\s._\-()（）]/g, '');
}

/** 列出若干目录下的 exe（深度 1），用于把注册表条目补全成可执行路径。 */
async function listExesInDirs(dirs) {
  const uniq = [...new Set(dirs.filter(Boolean))];
  if (!uniq.length) return {};
  const list = uniq.slice(0, 80).map((d) => `"${d.replace(/"/g, '""')}"`).join(',');
  const data = await psJson(
    `$dirs = @(${list});
     $dirs | ForEach-Object {
       $d = $_;
       if (Test-Path -LiteralPath $d) {
         Get-ChildItem -LiteralPath $d -Filter *.exe -ErrorAction SilentlyContinue |
           ForEach-Object { [pscustomobject]@{ dir = $d; exe = $_.FullName; size = $_.Length } }
       }
     } | ConvertTo-Json -Depth 3 -Compress`,
    45000,
  );
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  const byDir = {};
  for (const r of rows) {
    if (!r || !r.dir || !r.exe) continue;
    const key = r.dir.toLowerCase();
    (byDir[key] ||= []).push({ exe: r.exe, size: Number(r.size) || 0 });
  }
  return byDir;
}

function pickBestExe(candidates, displayName) {
  if (!candidates?.length) return null;
  const target = squash(displayName);
  const scored = candidates.map((c) => {
    const base = squash(path.basename(c.exe, '.exe'));
    let score = 0;
    if (base && target.includes(base)) score += 10;
    // 噪声 exe（unins/setup/installer/crash/update）大幅降权：判定规则只有一份，见 lib/exec-noise.mjs
    if (base && isNoiseExe(path.basename(c.exe))) score -= 50;
    if (base.includes('helper')) score -= 5;
    score += Math.min(c.size / 50e6, 3);
    return { ...c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].exe : candidates[0].exe;
}

/**
 * 主入口：返回候选列表。
 * 每个候选都只带"客观事实"，不带"它是不是 agent"的判断。
 */
export async function discover({ includeConventions = true, adapterGlobs = [] } = {}) {
  const [registryRows, processes, listening, conventional, globbed] = await Promise.all([
    scanRegistry(),
    scanProcesses(),
    scanListening(),
    includeConventions ? scanConventions() : Promise.resolve([]),
    scanGlobs(adapterGlobs),
  ]);

  const procByExe = new Map();
  for (const p of processes) {
    const k = normalizeKey(p.exePath);
    if (!k) continue;
    const entry = procByExe.get(k) || { pids: [], windowTitles: [], exePath: p.exePath };
    entry.pids.push(p.pid);
    if (p.windowTitle) entry.windowTitles.push(p.windowTitle);
    procByExe.set(k, entry);
  }

  // 端口按 PID 归集
  const portsByPid = new Map();
  for (const l of listening) {
    if (!l.pid) continue;
    const arr = portsByPid.get(l.pid) || [];
    arr.push({ port: l.port, addr: l.addr });
    portsByPid.set(l.pid, arr);
  }

  // 为没有 exe 路径的注册表条目补全
  const needingResolve = registryRows.filter((r) => !r.exePath && r.installLocation);
  const dirMap = await listExesInDirs(needingResolve.map((r) => r.installLocation));

  const bucket = new Map(); // key = 规范化 exe 路径 或 name:<名字>

  const push = (cand) => {
    const key = cand.exePath ? normalizeKey(cand.exePath) : `name:${squash(cand.name)}`;
    const cur = bucket.get(key);
    if (!cur) {
      bucket.set(key, { ...cand, sources: [cand.kind], confidence: cand.confidence });
      return;
    }
    cur.sources.push(cand.kind);
    cur.confidence = Math.max(cur.confidence, cand.confidence);
    cur.version ||= cand.version;
    cur.installLocation ||= cand.installLocation;
    cur.publisher ||= cand.publisher;
    cur.exePath ||= cand.exePath;
    if (!cur.name && cand.name) cur.name = cand.name;
  };

  // 1) 注册表
  for (const r of registryRows) {
    if (!r.name) continue;
    let exe = r.displayIcon && /\.exe$/i.test(r.displayIcon) ? r.displayIcon : null;
    if (!exe && r.installLocation) {
      const key = path.resolve(r.installLocation).toLowerCase();
      exe = pickBestExe(dirMap[key], r.name);
    }
    push({ ...r, exePath: exe, pathSource: exe ? (r.displayIcon ? 'display-icon' : 'install-location') : null });
  }

  // 2) 目录约定
  for (const c of conventional) {
    push({ ...c, installLocation: path.dirname(c.exePath) });
  }

  // 3) 适配器声明的搜索路径（厂商知识只存在于 manifest，不在主程序）
  for (const g of globbed) {
    push({ ...g });
  }

  // 4) 进程路径（补全注册表缺失的真实路径 + 单独发现绿色版）
  for (const [key, p] of procByExe) {
    const existing = bucket.get(key);
    if (existing) {
      existing.sources.push('process-path');
      existing.confidence = Math.max(existing.confidence, 0.9);
      existing.exePath = existing.exePath || p.exePath;
      continue;
    }
    const base = path.basename(p.exePath, '.exe');
    push({
      kind: 'process-path',
      name: base,
      exePath: p.exePath,
      installLocation: path.dirname(p.exePath),
      version: null,
      confidence: 0.9,
    });
  }

  // 5) 补版本 + 挂进程/端口
  const toProbe = [];
  const candidates = [];
  for (const [key, c] of bucket) {
    if (!c.version && c.exePath) toProbe.push(c.exePath);
    const proc = c.exePath ? procByExe.get(normalizeKey(c.exePath)) : null;
    const ports = proc ? proc.pids.flatMap((pid) => portsByPid.get(pid) || []) : [];
    candidates.push({
      id: shortId(key),
      key,
      name: c.name,
      version: c.version,
      versionSource: c.versionSource || (c.version ? c.kind : null),
      exePath: c.exePath,
      installLocation: c.installLocation || null,
      publisher: c.publisher || null,
      pathSource: c.pathSource || null,
      sources: [...new Set(c.sources)],
      confidence: Number(c.confidence.toFixed(2)),
      running: Boolean(proc),
      pids: proc ? proc.pids : [],
      ports: [...new Map(ports.map((p) => [`${p.addr}:${p.port}`, p])).values()],
      windowTitles: proc ? proc.windowTitles : [],
    });
  }

  // 文件版本兜底
  const versions = await fileVersions(toProbe);
  for (const c of candidates) {
    if (c.version || !c.exePath) continue;
    const v = versions[c.exePath.toLowerCase()];
    if (v) {
      c.version = v;
      c.versionSource = 'file-version';
      c.sources.push('file-version');
      c.confidence = Math.max(c.confidence, SOURCE_PRIORITY['file-version']);
    }
  }

  candidates.sort((a, b) => (b.running - a.running) || (b.confidence - a.confidence) || a.name.localeCompare(b.name));
  return candidates;
}
