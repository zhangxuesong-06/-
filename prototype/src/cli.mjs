#!/usr/bin/env node
// apx —— Agent Proxy Launcher 原型 CLI
// 命令：scan / list / probe / adapters / serve / ui / status / stop
//
// 编排（起上游 → 建 translator → 起代理）全部在 runtime/controller.mjs 里，
// 这里只负责参数解析与终端输出：控制台（apx ui）用的是同一个 controller，
// 两条入口的行为不会漂移。
import { discover } from './discovery/index.mjs';
import { loadAdapters, matchAdapter, userAdapterDir, BUILTIN_DIR } from './adapters/loader.mjs';
import { classifyCandidate, probeEndpoint } from './probe.mjs';
import { createController, adapterGlobs } from './runtime/controller.mjs';
import { isAlive, isOurProcess } from './runtime/procinfo.mjs';
import { getToken, maskToken, readState, stateDir } from './security/token.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function flag(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = (n) => argv.includes(`--${n}`);

function line(ch = '─', n = 78) {
  return ch.repeat(n);
}

function pad(s, n) {
  const str = String(s ?? '');
  const width = [...str].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
  return str + ' '.repeat(Math.max(0, n - width));
}

const LEVEL_LABEL = {
  L1: 'L1 可直接接入',
  L2: 'L2 可接入需适配',
  L3: 'L3 仅 CLI 包装',
  L0: 'L0 不可代理',
  NOT_READY: '未运行',
  UNKNOWN: '未知',
  EXCLUDED: '已排除(WSL)',
};

async function cmdScan() {
  const min = Number(flag('min', 0.85));
  const all = has('all');
  const t0 = Date.now();
  const candidates = await discover({ adapterGlobs: adapterGlobs() });
  const shown = candidates.filter((c) => c.confidence >= min);
  console.log(`\n发现 ${candidates.length} 个候选，置信度 ≥ ${min} 的 ${shown.length} 个（${Date.now() - t0} ms）`);
  console.log(line());
  console.log(pad('置信', 6) + pad('状态', 6) + pad('名称', 26) + pad('版本', 14) + pad('来源', 26) + '端口');
  console.log(line());
  for (const c of (all ? candidates : shown).slice(0, all ? 500 : 40)) {
    console.log(
      pad(c.confidence.toFixed(2), 6) +
        pad(c.running ? '● 运行' : '○ 停止', 6) +
        pad((c.name || '?').slice(0, 24), 26) +
        pad(String(c.version || '-').slice(0, 12), 14) +
        pad(c.sources.join('+').slice(0, 24), 26) +
        (c.ports || []).map((p) => p.port).join(','),
    );
  }
  console.log(line());
  console.log('提示：候选 ≠ 白名单。这里只列"装了/在跑"的软件，能不能代理要跑 `apx probe` 或用适配器确认。');
  if (has('json')) console.log(JSON.stringify(candidates, null, 2));
}

async function cmdList() {
  const { adapters, errors } = loadAdapters();
  const candidates = await discover({ adapterGlobs: adapterGlobs() });
  console.log(`\n已加载适配器 ${adapters.length} 个（内置 ${BUILTIN_DIR} / 用户 ${userAdapterDir()}）`);
  if (errors.length) {
    console.log(`⚠ ${errors.length} 个适配器加载失败（已隔离，不影响其他）：`);
    for (const e of errors.slice(0, 5)) console.log(`   - ${path.basename(e.file)} :: ${e.field} ${e.expected} (实际 ${e.actual})`);
  }
  console.log(line());
  console.log(pad('适配器', 22) + pad('名称', 26) + pad('匹配', 10) + '状态');
  console.log(line());
  for (const a of adapters) {
    const strategy = a.serviceFace?.portDiscovery?.strategy || 'listen-scan';
    const hits = matchAdapter(a, candidates);
    const best = hits[0];
    let statusText;
    if (strategy === 'remote') {
      statusText = `远端上游 ${a.serviceFace?.baseUrl || a.upstream?.baseUrl}（不起进程）`;
    } else if (strategy === 'port-scan') {
      statusText = `按候选端口自动发现（${(a.serviceFace.portDiscovery.candidates || []).join(',')}）`;
    } else if (best) {
      statusText = `${best.candidate.running ? '运行中' : '已安装'} · ${path.basename(best.candidate.exePath || '')}`;
    } else {
      statusText = '未检测到该软件';
    }
    const matchLabel = strategy === 'port-scan' ? '自动' : strategy === 'remote' ? '远端' : best ? '命中' : '-';
    console.log(pad(a.id, 22) + pad((a.name || '').slice(0, 24), 26) + pad(matchLabel, 10) + statusText);
  }
  console.log(line());
}

async function cmdProbe() {
  const port = flag('port');
  if (port) {
    const r = await probeEndpoint({ port: Number(port) });
    if (has('json')) return console.log(JSON.stringify(r, null, 2));
    console.log(`\n端口 ${port} → ${LEVEL_LABEL[r.level] || r.level}`);
    console.log(`根路径：${r.evidence?.root?.status} ${r.evidence?.root?.contentType} ${r.evidence?.root?.size}B`);
    for (const c of r.evidence?.candidates || []) {
      console.log(`  ${pad(c.path, 16)} ${c.status} ${pad(c.contentType || '-', 28)} ${String(c.size).padStart(7)}B  json=${c.json ? 'Y' : 'N'} 同根=${c.sameAsRoot ? 'Y' : 'N'}`);
    }
    console.log('判定理由：');
    for (const s of r.reasons) console.log(`  · ${s}`);
    return;
  }

  const id = flag('id');
  const candidates = await discover({ adapterGlobs: adapterGlobs() });
  const target = id
    ? candidates.find((c) => c.id === id) || candidates.find((c) => (c.name || '').toLowerCase().includes(String(id).toLowerCase()))
    : candidates.find((c) => c.running && c.ports.length);
  if (!target) return console.log('未找到可探测目标，用 --id 或 --port 指定');

  const r = await classifyCandidate(target);
  console.log(`\n${target.name} ${target.version || ''} → ${LEVEL_LABEL[r.level] || r.level}`);
  for (const s of r.reasons) console.log(`  · ${s}`);
  if (r.chosenPort) console.log(`  端口：${r.chosenPort}`);
  if (r.cli) console.log(`  CLI：headless=${r.cli.headless} signal=${r.cli.signals || '-'}`);
}

/** 终端横幅：告诉用户下游要填哪三项。文案与重构前保持一致。 */
function printReadyBanner(info) {
  const base = info.baseUrl;
  const token = info.token;
  const firstModel = info.models[0]?.alias || '<先看 /v1/models>';
  console.log(`\n${line('═')}`);
  console.log(`  本地代理已就绪  ${base}`);
  console.log(line('═'));
  console.log('  下游程序填这三项即可：');
  console.log(`    baseURL : ${base}`);
  console.log(`    apiKey  : ${token}`);
  console.log(`    model   : ${firstModel}`);
  console.log('');
  console.log('  自检：');
  console.log(`    curl -s ${base}/models -H "Authorization: Bearer ${token}"`);
  console.log('');
  console.log('  注意：消耗的是上游账号的额度；本端点只绑定 127.0.0.1。Ctrl+C 停止并回收进程。');
  console.log(line('═'));
}

async function cmdServe() {
  const adapterId = flag('adapter');
  if (!adapterId) {
    console.error('用法：apx serve --adapter <id> [--port 8787] [--upstream-port 1234] [--no-auth]');
    console.error('先跑 `apx list` 看可用适配器。');
    process.exitCode = 2;
    return;
  }

  const controller = createController({ log: (l) => console.log(l) });

  let info;
  try {
    info = await controller.start({
      adapterId,
      proxyPort: Number(flag('port', 8787)),
      upstreamPort: flag('upstream-port') ? Number(flag('upstream-port')) : undefined,
      servicePort: Number(flag('service-port', 0)) || null,
      authEnabled: !has('no-auth'),
      timeoutMs: Number(flag('timeout', 60000)),
    });
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = e.exitCode || 1;
    return;
  }

  printReadyBanner(info);

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${sig}，正在回收…`);
    const r = await controller.stop();
    console.log(`  已释放端口：${(r.ports || []).join(', ') || '无'}`);
    console.log('已停止，端口已释放。');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdUi() {
  const { createConsoleServer } = await import('./console/server.mjs');
  const port = Number(flag('port', 8799));
  const controller = createController({ log: (l) => console.log(l) });

  let consoleSrv;
  try {
    consoleSrv = await createConsoleServer({ port, controller, log: (l) => console.log(l) });
  } catch (e) {
    console.error(`\n✗ 控制台启动失败：${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  令牌（掩码）：${maskToken(consoleSrv.token)} —— 已内嵌到页面，无需手输`);
  console.log('  仅绑定 127.0.0.1；跨站请求一律 403；接口需控制台令牌。Ctrl+C 停止。');

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${sig}，正在回收…`);
    await consoleSrv.close();
    const r = await controller.stop();
    if (r.stopped) console.log(`  已释放端口：${(r.ports || []).join(', ')}`);
    console.log('已停止。');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function cmdStatus() {
  const st = readState();
  if (st.__corrupt) {
    console.error('状态文件损坏（~/.apx/state.json）。可删除该文件，或运行 `apx token rotate` 重新生成。');
    process.exitCode = 1;
    return;
  }
  if (!st.proxyPort) return console.log('当前没有运行中的代理。');
  const token = getToken();
  const url = `http://127.0.0.1:${st.proxyPort}/health`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    console.log(`运行中：${url} → ${JSON.stringify(body)}`);
  } catch (e) {
    console.log(`状态文件存在但端点不可达（${e.message}）。可能需要 apx stop 清理。`);
  }
  console.log(`适配器：${st.adapterId}  上游 PID：${st.serviceFacePid}  代理 PID：${st.pid}`);
}

async function cmdStop() {
  // 安全回收：先验身份（pid 存在 + exe 路径一致 + 启动时间不早于记录），
  // 不满足就只清状态、不动进程 —— 否则 pid 复用会误杀别人的进程。
  const { stopRecordedProcesses } = await import('./runtime/stopguard.mjs');
  const r = await stopRecordedProcesses({ log: (l) => console.log(l) });
  if (r.reason === 'corrupt') {
    process.exitCode = 1;
    return;
  }
  if (r.reason === 'no-record') {
    console.log('没有需要回收的进程。');
    return;
  }
  if (r.killed.length) console.log(`已回收 ${r.killed.length} 个进程${r.ports.length ? `，释放端口：${r.ports.join(', ')}` : ''}`);
  if (r.skipped.length) console.log(`已跳过 ${r.skipped.length} 个进程（状态已清理，但这些 pid 现在不属于我们）。`);
}

/**
 * 判断状态文件里记录的代理是否还活着。用于 rotate 前的"运行中直接拒绝"。
 *
 * 两级判定（都不猜）：
 *  - 有 proxyProc（新版本写的）→ 走三条件验身份，验不过就当没在跑（那是别人的 pid）。
 *  - 没有 proxyProc（旧版本写的）→ 只能看 pid 是否还存在；存在就保守地当成在跑，
 *    并在提示里说明"无法校验身份"，让用户自己判断。
 */
async function liveProxy(st) {
  const pid = Number(st?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rec = { pid, exePath: st.proxyProc?.exePath || null, startMs: st.proxyProc?.startMs ?? null };
  if (rec.exePath && rec.startMs != null) {
    const verdict = await isOurProcess(rec);
    return verdict.ok ? { pid, port: st.proxyPort ?? null, verified: true } : null;
  }
  return (await isAlive(pid)) ? { pid, port: st.proxyPort ?? null, verified: false } : null;
}

/**
 * 令牌管理。这是**唯一**能更换令牌的入口。
 *
 * 令牌不会自己变：如果下游突然 401 而你没运行过 rotate，那是 bug，不是预期行为。
 */
async function cmdToken() {
  const sub = String(argv[1] || 'show').toLowerCase();

  if (sub === 'show') {
    const st = readState();
    if (st.__corrupt) {
      console.error('状态文件损坏（~/.apx/state.json）。运行 `apx token rotate` 可重新生成令牌。');
      process.exitCode = 1;
      return;
    }
    const t = getToken();
    console.log(`本地令牌（掩码）：${maskToken(t)}`);
    console.log(`创建时间：${st.tokenCreatedAt || '(未知)'}`);
    console.log('令牌不会自动变化。要更换请显式运行 `apx token rotate`（旧令牌会立即失效）。');
    return;
  }

  if (sub === 'rotate') {
    const st = readState();

    // 状态损坏：rotate 是恢复入口，直接重建（此时没有可判断的运行实例信息）
    if (st.__corrupt) {
      const t = getToken({ rotate: true });
      console.log(`已重建本地令牌（掩码）：${maskToken(t)}`);
      console.log('（状态文件原本已损坏，令牌已重新生成；请更新所有下游程序的 apiKey。）');
      return;
    }

    // 运行中直接拒绝：执行成功但实际不生效，比拒绝更糟——用户会以为换好了
    const live = await liveProxy(st);
    if (live) {
      const portText = live.port ? `端口 ${live.port}` : '端口未知';
      console.error(
        `代理正在运行（${portText}）。若代理是从控制台启动的，请先在控制台点「停止」；否则运行 \`apx stop\`。未停止前更换令牌会让下游继续使用旧值。`,
      );
      if (!live.verified) {
        console.error('（该实例由旧版本启动，无法校验进程身份，仅按 pid 存在判断；如确认已停止可删除 ~/.apx/state.json 后重试。）');
      }
      process.exitCode = 3;
      return;
    }

    const t = getToken({ rotate: true });
    console.log(`已更换本地令牌（掩码）：${maskToken(t)}`);
    console.log('⚠ 旧令牌立即失效：请更新所有下游程序的 apiKey。');
    console.log('⚠ 下次启动代理时生效（当前没有运行中的代理）。');
    return;
  }

  console.error('用法：');
  console.error('  apx token show     查看本地令牌（掩码）');
  console.error('  apx token rotate   更换本地令牌（唯一入口，旧值立即失效）');
  process.exitCode = 2;
}

async function cmdAdapters() {
  const { adapters, errors, overridden } = loadAdapters();
  console.log(`内置目录：${BUILTIN_DIR}`);
  console.log(`用户目录：${userAdapterDir()}`);
  console.log(`状态目录：${stateDir()}`);
  console.log(line());
  for (const a of adapters) {
    console.log(`${pad(a.id, 22)} ${pad(a.name || '', 30)} ${a.serviceFace?.type} · ${a.serviceFace?.portDiscovery?.strategy || '-'} · ${a.origin}`);
  }
  if (overridden.length) console.log(`用户覆盖内置：${overridden.join(', ')}`);
  if (errors.length) console.log(`加载失败 ${errors.length} 个`);
  console.log(line());
  try {
    console.log(`本地令牌：${maskToken(getToken())}`);
  } catch (e) {
    console.log(`本地令牌：读取失败（${e.message}）`);
  }
}

const commands = {
  scan: cmdScan,
  list: cmdList,
  probe: cmdProbe,
  serve: cmdServe,
  ui: cmdUi,
  status: cmdStatus,
  stop: cmdStop,
  adapters: cmdAdapters,
  token: cmdToken,
};

if (commands[cmd]) {
  commands[cmd]().catch((e) => {
    console.error('执行失败：', e);
    process.exitCode = 1;
  });
} else {
  console.log(`apx —— 把本机 agent 的模型能力，变成 127.0.0.1 上的 OpenAI 端点

用法：
  apx scan [--min 0.85] [--all] [--json]   扫描本机候选软件
  apx list                                 用适配器收敛出"可代理的软件"
  apx probe --port 3082 | --id <候选id>    可代理性分级（L0–L3）
  apx adapters                             查看适配器目录与令牌
  apx serve --adapter <id> [--port 8787]   启动本地代理
  apx ui [--port 8799]                     打开 Web 控制台（图形化同一套操作）
  apx status                               查看运行状态
  apx stop                                 回收进程（先验身份，pid 复用不会误杀）
  apx token show | rotate                  查看 / 更换本地令牌（rotate 是唯一更换入口）`);
}
