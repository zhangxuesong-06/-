// 编排层：把「找到上游 → 起上游服务面 → 建 translator → 起代理 → 写状态」收成一个对象。
//
// 为什么抽出来：CLI（apx serve）和 Web 控制台（apx ui）需要完全一样的行为。
// 编排写在 cli.mjs 里，两边就会各写一遍，然后慢慢漂移（一边修了 502，另一边没修）。
//
// 幂等策略（显式选择其一，避免"第二次 start 静默返回旧配置"这种坑）：
//   已运行时再 start → 先 stop() 再完全重新 start()。
//   理由：控制台里用户改端口/换适配器后点「启动」，期望的是新配置生效，
//        而不是拿到一个参数已经过期的旧实例。代价是一次回收，可接受。
import { discover } from '../discovery/index.mjs';
import { findAdapter, matchAdapter, loadAdapters } from '../adapters/loader.mjs';
import { createTranslator } from '../adapters/translator.mjs';
import { createProxyServer } from '../proxy/server.mjs';
import { ServiceFace, pickFreePort, sleep } from './supervisor.mjs';
import { getToken, writeState } from '../security/token.mjs';
import { createCredentialProvider } from '../security/credentials.mjs';
import { portScanEndpoints } from './portscan.mjs';
import { describeProxyPolicy } from './proxyenv.mjs';
import { getProcessInfo } from './procinfo.mjs';
import { createLimiter } from './limiter.mjs';

const DEFAULT_PROXY_PORT = 8787;
const CATALOG_TTL_MS = 30000;
const DEFAULT_MODELS_PATH = '/v1/models';

/** 适配器声明的搜索路径：厂商知识只在 manifest 里，主程序不硬编码。 */
export function adapterGlobs() {
  try {
    return loadAdapters().adapters.flatMap((a) => a.match?.pathGlobs || []);
  } catch {
    return [];
  }
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * 把端口反查成本机软件名。
 *
 * 为什么需要它：port-scan / listen-scan 型适配器的「提供方」不是 manifest 名，
 * 而是那个端口后面真的在跑的程序（例如本机推理服务）。界面上只显示适配器名，
 * 用户就分不清「我到底代理的是哪个软件」。
 */
async function identifyUpstreamCandidate(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0) return null;
  try {
    const candidates = await discover({ adapterGlobs: adapterGlobs() });
    return (
      candidates.find((c) => (c.ports || []).some((x) => Number(x.port) === p)) || null
    );
  } catch {
    return null;
  }
}

function providerNameFromCandidate(candidate, fallback) {
  const exe = candidate?.exePath ? String(candidate.exePath).split(/[\\/]/).pop() : null;
  return candidate?.name || exe || fallback;
}

function cacheCatalog(getter, ttlMs = CATALOG_TTL_MS) {
  let cache = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    const value = await getter();
    cache = { at: Date.now(), value };
    return value;
  };
}

/** 统一的错误：带中文可读信息 + 进程退出码，CLI 直接照搬。 */
function apxError(message, exitCode = 1, extra = {}) {
  const err = new Error(message);
  err.exitCode = exitCode;
  Object.assign(err, extra);
  return err;
}

/**
 * manifest 里 baseUrl 通常按 OpenAI 习惯写成 `https://host/v1`，
 * 而路径也写成 `/v1/models` —— 直接拼会变成 `/v1/v1/models`。
 * 这里只在"重复了同一段版本前缀"时去掉一次，不做其它改写。
 *
 * 导出是为了让测试能直接钉住这条拼接规则（不启动任何进程）。
 */
export function dedupeVersionPrefix(baseUrl, firstPath) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  const p = String(firstPath || '');
  const m = url.match(/\/(v\d+)$/i);
  if (m && p.toLowerCase().startsWith(`/${m[1].toLowerCase()}/`)) {
    return { baseUrl: url.slice(0, -m[0].length), stripped: m[0] };
  }
  return { baseUrl: url, stripped: null };
}

/**
 * 创建一个编排控制器。
 *
 * @param {{log?:Function}} [opts] log 用于输出进度行（CLI 传 console.log，控制台传自己的日志器）
 */
export function createController({
  log = () => {},
  // N5：启动即检查 + 周期探测。20s 是"用户感知前"与"别把上游打爆"的折中；
  // 连续 2 次失败才标红，避免一次网络抖动就把正常实例渲染成故障。
  healthIntervalMs = Number(process.env.APX_HEALTH_INTERVAL_MS) || 20000,
  healthFailureThreshold = 2,
} = {}) {
  /** 当前运行会话；null 表示未运行。 */
  let session = null;

  async function resolveUpstream({ adapter, upstreamPort, servicePort, timeoutMs }) {
    const strategy = adapter.serviceFace?.portDiscovery?.strategy || 'listen-scan';

    // ---- 1) 自起隔离实例：端口由我们分配，凭据从 stdout 抓 ----
    if (strategy === 'launch-assigned') {
      const candidates = await discover({ adapterGlobs: adapterGlobs() });
      const hits = matchAdapter(adapter, candidates);
      const candidate = hits.find((h) => h.candidate.running)?.candidate || hits[0]?.candidate;
      if (!candidate) {
        throw apxError(`未找到该适配器对应的可执行文件（可能未安装）。用 \`apx scan --all\` 确认。`, 3);
      }

      const svcPort = await pickFreePort(Number(servicePort) || null);
      const face = new ServiceFace(adapter, candidate, { port: svcPort, onLog: (l) => log(`  │ ${l}`) });
      const exeName = String(candidate.exePath || '').split(/[\\/]/).pop();
      log(`\n▶ 启动上游服务面：${exeName} --port ${svcPort}`);
      face.start();

      const ready = await face.waitReady({ timeoutMs });
      if (!ready.ok) {
        await face.stop();
        throw apxError(`上游未就绪（最后状态：${ready.last}）。进程日志：\n  ${face.logLines.slice(-6).join('\n  ')}`, 4);
      }
      log(`✓ 上游就绪：${face.baseUrl}`);

      // 我们自起的实例：凭据来自 stdout，生命周期与本进程一致 → static provider 足够。
      const authCfg = adapter.serviceFace?.auth || {};
      const spec =
        authCfg.type === 'basic'
          ? { kind: 'static', value: `${authCfg.username || ''}:${face.secret}`, scheme: 'basic' }
          : authCfg.type === 'none'
            ? { kind: 'none' }
            : { kind: 'static', value: face.secret, scheme: authCfg.type === 'header' ? 'header' : 'bearer' };

      return {
        face,
        baseUrl: face.baseUrl,
        credentials: createCredentialProvider(spec),
        upstreamPort: svcPort,
        upstreamName: providerNameFromCandidate(candidate, `127.0.0.1:${svcPort} 的服务面`),
        candidate,
        strategy,
      };
    }

    // ---- 2) 远端上游：不起进程、不扫端口，直接用 manifest 声明的 origin ----
    if (strategy === 'remote') {
      const configured = adapter.serviceFace?.baseUrl || adapter.upstream?.baseUrl || '';
      if (!configured) {
        throw apxError('该适配器声明 portDiscovery.strategy = "remote"，但未提供 serviceFace.baseUrl / upstream.baseUrl', 2);
      }
      // 规范化后 baseUrl 只应是 origin；下面这层去重是**防线**，正常不该触发。
      // 触发说明 manifest 绕过了 loader 校验（例如用户目录被手改），只 warn 不静默改语义。
      const { baseUrl, stripped } = dedupeVersionPrefix(configured, adapter.upstream?.listModels?.path);
      if (stripped) {
        log(`⚠ 适配器 baseUrl 带了路径前缀 ${stripped}（应为 origin，路径写进 endpoint），已按 origin 处理；请修正 manifest`);
      }
      log(`✓ 使用远端上游：${baseUrl}`);
      return {
        face: null,
        baseUrl,
        credentials: createCredentialProvider(adapter.upstream?.auth || { kind: 'none' }),
        upstreamPort: null,
        upstreamName: adapter.name || adapter.id,
        candidate: null,
        strategy,
      };
    }

    // ---- 3) 端口扫描：上游是"已经在跑的别人"，我们只负责接上 ----
    if (strategy === 'port-scan') {
      const pd = adapter.serviceFace?.portDiscovery || {};
      const candidates = Array.isArray(pd.candidates) ? pd.candidates : [];
      const modelsPath = pd.modelsPath || adapter.upstream?.listModels?.path || DEFAULT_MODELS_PATH;
      const scan = await portScanEndpoints({
        candidates,
        modelsPath,
        onTry: (t) => log(`  · 探测端口 ${t.port}：${t.reason}`),
      });
      if (!scan.ok) {
        const detail = scan.attempts.map((a) => `  · 端口 ${a.port}：${a.reason}`).join('\n');
        throw apxError(
          `端口扫描未命中任何 OpenAI 兼容服务（候选：${candidates.join(', ') || '空'}）。逐个失败原因：\n${detail}\n  提示：确认目标服务已启动；或在适配器 manifest 的 serviceFace.portDiscovery.candidates 里补上正确端口。`,
          5,
        );
      }
      log(`✓ 端口扫描命中：127.0.0.1:${scan.port}（${scan.probe.reason}）`);
      const providerCandidate = await identifyUpstreamCandidate(scan.port);
      return {
        face: null,
        baseUrl: `http://127.0.0.1:${scan.port}`,
        credentials: createCredentialProvider(adapter.upstream?.auth || { kind: 'none' }),
        upstreamPort: scan.port,
        upstreamName: providerNameFromCandidate(
          providerCandidate,
          `127.0.0.1:${scan.port} 的本机服务`,
        ),
        candidate: providerCandidate,
        strategy,
      };
    }

    // ---- 4) listen-scan / static：必须由调用方给端口 ----
    const up = Number(upstreamPort);
    if (!Number.isInteger(up) || up <= 0) {
      throw apxError(`该适配器为 ${strategy} 类型，需要指定 --upstream-port（已运行的上游端口）。`, 2);
    }
    log(`✓ 使用已运行的上游：127.0.0.1:${up}`);
    const providerCandidate = await identifyUpstreamCandidate(up);
    return {
      face: null,
      baseUrl: `http://127.0.0.1:${up}`,
      // 挂到别人的实例上：凭证必须每请求现取（宿主会刷新 token）。
      credentials: createCredentialProvider(adapter.upstream?.auth || { kind: 'none' }),
      upstreamPort: up,
      upstreamName: providerNameFromCandidate(
        providerCandidate,
        `127.0.0.1:${up} 的本机服务`,
      ),
      candidate: providerCandidate,
      strategy,
    };
  }

  /**
   * 启动代理。已运行则先回收再启动（幂等策略见文件头注释）。
   *
   * @param {{adapterId:string, proxyPort?:number, upstreamPort?:number,
   *          servicePort?:number, authEnabled?:boolean, timeoutMs?:number}} opts
   * @returns {Promise<{baseUrl:string, token:string, port:number, adapterId:string,
   *   models:Array<{alias:string,upstreamId:string,provider:string|null}>,
   *   streaming:string, upstreamPid:number|null, upstreamPort:number, proxyEnv:object}>}
   */
  async function start(opts = {}) {
    const { adapterId, proxyPort, upstreamPort, servicePort, authEnabled = true, timeoutMs = 60000 } = opts;

    if (session) {
      log('  · 检测到已有运行中的代理，先回收再启动（保证新参数生效）');
      await stop();
    }
    if (!adapterId) throw apxError('缺少 adapterId（先跑 `apx list` 看可用适配器）', 2);

    const adapter = findAdapter(adapterId);
    if (!adapter) throw apxError(`未找到适配器 ${adapterId}（先跑 \`apx list\` 看可用适配器）`, 2);

    const limits = adapter.limits || {};
    const limiter = createLimiter({
      maxConcurrent: limits.maxConcurrent,
      maxQueue: limits.maxQueue,
      queueTimeoutMs: limits.queueTimeoutMs,
    });

    const token = getToken();
    const up = await resolveUpstream({ adapter, upstreamPort, servicePort, timeoutMs });

    // ---- translator ----
    let catalog = { models: [] };
    const translator = createTranslator({
      adapter,
      ctx: {
        baseUrl: up.baseUrl,
        credentials: up.credentials,
        resolveModel: (alias) => {
          const found = catalog.models.find((m) => m.alias === alias || m.upstreamId === alias);
          if (found) return { alias: found.alias, upstreamId: found.upstreamId, provider: found.provider };
          return null;
        },
      },
    });

    const getCatalog = cacheCatalog(async () => {
      const r = await translator.listModels();
      if (r.models?.length) catalog = r;
      else if (r.error) return { ...r, models: catalog.models };
      return r;
    });

    // 拉起前先确认模型清单可读：空清单也能跑，但用户必须被明确告知
    const first = await getCatalog();
    if (!first.models.length) {
      log(`⚠ 模型清单为空${first.error ? `（${first.error.message}）` : ''}。端点仍会启动，但 /v1/models 将返回空列表。`);
    } else {
      log(`✓ 模型清单 ${first.models.length} 个，例如：${first.models.slice(0, 3).map((m) => m.alias).join(', ')}`);
    }

    // ---- 代理端点 ----
    const port = await pickFreePort(Number(proxyPort) || DEFAULT_PROXY_PORT);
    const server = createProxyServer({
      token,
      translator,
      adapter,
      getCatalog,
      credentials: up.credentials,
      authEnabled,
      limiter,
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });

    const upstreamPid = up.face?.child?.pid || null;
    const proxyEnv = describeProxyPolicy(adapter.serviceFace?.proxyEnv);

    // 进程身份取证：pid 会被系统回收，所以把「exe 路径 + 启动时刻」一并写进状态文件。
    // stop 时按这三个条件复核，不满足就只清状态、不动进程（见 runtime/stopguard.mjs）。
    const proxyProcInfo = await getProcessInfo(process.pid);
    const faceProcInfo = upstreamPid ? await getProcessInfo(upstreamPid) : null;

    // 上游健康：与"代理进程是否活着"分开。代理活着但上游死了，是最容易骗过用户的假绿。
    const health = {
      state: first.error ? 'degraded' : 'ok',
      lastCheckAt: Date.now(),
      lastOkAt: first.error ? null : Date.now(),
      consecutiveFailures: first.error ? 1 : 0,
      checks: 1,
      lastError: first.error?.message || null,
      timer: null,
    };

    session = {
      adapter,
      token,
      port,
      upstreamPort: up.upstreamPort,
      upstreamBaseUrl: up.baseUrl,
      upstreamName: up.upstreamName || null,
      providerPid: up.candidate?.pids?.[0] ?? null,
      providerExePath: up.candidate?.exePath ?? null,
      face: up.face,
      server,
      catalog,
      getCatalog,
      credentials: up.credentials,
      streaming: adapter.capabilities?.streaming ? 'passthrough' : 'pseudo',
      proxyEnv,
      health,
      limiter,
      startedAt: new Date().toISOString(),
    };

    const current = session;
    let healthChecking = false; // 探测慢于周期时跳过本轮，避免请求堆叠
    const runHealthCheck = async () => {
      if (session !== current || healthChecking) return;
      healthChecking = true;
      try {
        health.checks++;
        health.lastCheckAt = Date.now();

        // 自起实例的进程退出是确定性信号，不用等探测超时。
        const child = current.face?.child;
        if (child && child.exitCode !== null) {
          health.consecutiveFailures = Math.max(health.consecutiveFailures + 1, healthFailureThreshold);
          health.state = 'down';
          health.lastError = `上游服务面进程已退出（exit ${child.exitCode}）`;
          return;
        }

        let r;
        try {
          r = await translator.listModels();
        } catch (e) {
          r = { models: [], error: { message: String(e.message || e) } };
        }
        if (session !== current) return;

        if (r.error) {
          health.consecutiveFailures++;
          health.lastError = r.error.message || '上游探测失败';
          health.state = health.consecutiveFailures >= healthFailureThreshold ? 'down' : 'degraded';
          return;
        }
        health.consecutiveFailures = 0;
        health.lastError = null;
        health.lastOkAt = Date.now();
        health.state = 'ok';
      } finally {
        healthChecking = false;
      }
    };
    health.timer = setInterval(runHealthCheck, healthIntervalMs);
    health.timer.unref?.();

    writeState({
      pid: process.pid,
      proxyPort: port,
      adapterId: adapter.id,
      serviceFacePid: upstreamPid,
      upstreamPort: up.upstreamPort,
      startedAt: session.startedAt,
      proxyProc: { exePath: proxyProcInfo?.exePath ?? null, startMs: proxyProcInfo?.startMs ?? null },
      serviceFaceProc: faceProcInfo ? { exePath: faceProcInfo.exePath ?? null, startMs: faceProcInfo.startMs ?? null } : null,
    });

    return {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      token,
      port,
      adapterId: adapter.id,
      models: catalog.models.map((m) => ({ alias: m.alias, upstreamId: m.upstreamId, provider: m.provider ?? null })),
      streaming: session.streaming,
      upstreamPid,
      upstreamPort: up.upstreamPort,
      upstreamName: up.upstreamName || null,
      providerName: up.upstreamName || null,
      providerExePath: up.candidate?.exePath ?? null,
      proxyEnv,
    };
  }

  /**
   * 停止：关代理 → 停上游（杀进程树）→ 清状态文件。
   *
   * @returns {Promise<{stopped:boolean, ports:number[], detail:Array<{port:number, role:string}>, reason?:string}>}
   */
  async function stop() {
    if (!session) return { stopped: false, ports: [], detail: [], reason: 'not-running' };
    const s = session;
    session = null; // 先摘掉引用，避免并发 stop 重复回收

    if (s.health?.timer) clearInterval(s.health.timer);

    try {
      await new Promise((resolve) => s.server.close(() => resolve()));
    } catch {
      /* 已经关掉了 */
    }

    const detail = [{ port: s.port, role: 'proxy' }];
    if (s.face) {
      try {
        const r = await s.face.stop();
        log(`  上游进程已处理：${JSON.stringify(r)}`);
      } catch (e) {
        log(`  ⚠ 上游回收异常：${e.message}`);
      }
      if (s.face.port) detail.push({ port: s.face.port, role: 'service' });
    }

    writeState({ pid: null, proxyPort: null, adapterId: null, serviceFacePid: null, upstreamPort: null, proxyProc: null, serviceFaceProc: null });
    // 给 OS 一点时间真正释放监听（Windows 上 close 回调后端口偶有短暂占用）
    await sleep(80);

    return { stopped: true, ports: detail.map((d) => d.port), detail };
  }

  /**
   * 运行状态。未运行返回 { running:false }。
   * 同步返回（stats 是代理进程里的活对象，不需要额外网络请求）。
   *
   * 注意：这里**不返回下游令牌**。状态接口是轮询接口（每 3s 一次），
   * 把凭据摊在轮询响应里等于人为扩大暴露面；明文只走 /api/snippet 这一个接口。
   */
  function status() {
    if (!session) return { running: false };
    const s = session;
    const cred = s.credentials?.describe?.() || { kind: 'none', ok: true };
    const st = s.server.stats || {};
    return {
      running: true,
      port: s.port,
      adapterId: s.adapter.id,
      adapterName: s.adapter.name || s.adapter.id,
      baseURL: `http://127.0.0.1:${s.port}/v1`,
      upstreamPort: s.upstreamPort,
      upstreamBaseUrl: s.upstreamBaseUrl,
      upstreamName: s.upstreamName || null,
      providerName: s.upstreamName || null,
      providerExePath: s.providerExePath ?? null,
      providerPid: s.providerPid ?? null,
      models: s.catalog.models.map((m) => ({ alias: m.alias, upstreamId: m.upstreamId, provider: m.provider ?? null })),
      streaming: s.streaming,
      proxyEnv: s.proxyEnv,
      startedAt: s.startedAt,
      credential: {
        kind: cred.kind,
        ok: cred.ok,
        hasToken: cred.hasToken,
        lastReadAt: cred.lastReadAt ?? null,
        expiresAt: cred.expiresAt ?? null,
        detail: cred.detail ?? null,
      },
      // 与 credential 并列：让 UI 能回答"代理活着，但上游还活着吗"。
      upstreamHealth: s.health
        ? {
            state: s.health.state,
            lastCheckAt: s.health.lastCheckAt ? new Date(s.health.lastCheckAt).toISOString() : null,
            lastOkAt: s.health.lastOkAt ? new Date(s.health.lastOkAt).toISOString() : null,
            consecutiveFailures: s.health.consecutiveFailures,
            checks: s.health.checks,
            lastError: s.health.lastError,
          }
        : null,
      concurrency: s.limiter?.stats?.() || null,
      // 定位「下游说响应格式不兼容」时，先看它到底打了哪个端点、拿到的状态码与错误码。
      recentRequests: (s.server.stats?.recent || []).slice(-15),
      stats: {
        requests: st.requests || 0,
        errors: st.errors || 0,
        streams: st.streams || 0,
        p50Ms: percentile(st.latencies || [], 0.5),
        p95Ms: percentile(st.latencies || [], 0.95),
        uptimeSec: st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : 0,
      },
    };
  }

  /** 是否正在运行。 */
  function isRunning() {
    return Boolean(session);
  }

  /**
   * 当前下游令牌（未运行返回 null）。
   *
   * 单独开一个方法而不是塞进 status()：status 是每 3s 轮询的接口，
   * 把凭据摊在轮询响应里等于人为扩大暴露面。明文只允许走「用户显式要复制」的入口。
   */
  function currentToken() {
    return session ? session.token : null;
  }

  return { start, stop, status, isRunning, currentToken };
}
