// 服务面监管：起进程、抓凭据、等就绪、回收进程树。
// 三个真实教训被写进了实现：
// 1) 端口要我们自己分配（launch-assigned），不要从配置文件猜；
// 2) 凭据从 stdout 抓；配置文件里的那串"password"未必是当前实例的有效凭据；
// 3) 就绪判定不能只看 TCP 连得上——刚起的实例会返回 503 "plugins did not finish activating"。
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { applyProxyPolicy } from './proxyenv.mjs';

function expand(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function runQuiet(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, () => resolve());
  });
}

export class ServiceFace {
  constructor(adapter, candidate, { port, host = '127.0.0.1', onLog } = {}) {
    this.adapter = adapter;
    this.candidate = candidate;
    this.port = port;
    this.host = host;
    this.onLog = onLog || (() => {});
    this.child = null;
    this.secret = null;
    this.ready = false;
    this.logLines = [];
    /** 本次 spawn 实际施加的代理策略（给状态页当证据，不含任何值）。 */
    this.envApplied = null;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  authHeader() {
    const auth = this.adapter.serviceFace?.auth || { type: 'none' };
    if (auth.type === 'none') return {};
    if (auth.type === 'bearer') return { authorization: `Bearer ${this.secret}` };
    if (auth.type === 'basic') {
      const raw = `${auth.username || ''}:${this.secret || ''}`;
      return { authorization: `Basic ${Buffer.from(raw).toString('base64')}` };
    }
    if (auth.type === 'header' && auth.header) return { [auth.header]: this.secret };
    return {};
  }

  /** 启动服务面；返回 true 表示进程已起来（不代表已就绪）。 */
  start() {
    const pd = this.adapter.serviceFace?.portDiscovery || {};
    const vars = {
      exe: this.candidate.exePath,
      installDir: path.dirname(this.candidate.exePath || '.'),
      port: this.port,
      host: this.host,
    };
    const argv = (pd.argv || []).map((a) => expand(a, vars));
    if (!argv.length) throw new Error('适配器未声明 serviceFace.portDiscovery.argv，无法启动');
    const [cmd, ...args] = argv;

    // 代理变量策略：默认 clear（回环直连）。
    // 本机开着系统代理时，上游把去 127.0.0.1 的请求也交给代理，会得到
    // 502 ERR_PROXY_TUNNEL: Proxy refused to open a tunnel —— 看起来像上游挂了，其实是环境问题。
    const policy = this.adapter.serviceFace?.proxyEnv;
    const { env: withProxyPolicy, applied } = applyProxyPolicy(process.env, policy);
    // manifest 里显式写的 env 优先级最高（它比策略更具体）
    const finalEnv = { ...withProxyPolicy, ...(pd.env || {}) };
    this.envApplied = applied;

    this.child = spawn(cmd, args, {
      cwd: pd.cwd ? expand(pd.cwd, vars) : path.dirname(cmd),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: finalEnv,
    });

    const secretCfg = this.adapter.serviceFace?.auth?.secretFrom;
    const consume = (buf, stream) => {
      const text = buf.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logLines.push(`[${stream}] ${line.trim()}`);
        if (this.logLines.length > 200) this.logLines.shift();
        this.onLog(line.trim());
        if (!this.secret && secretCfg?.kind === 'stdout' && secretCfg.pattern) {
          const m = line.match(new RegExp(secretCfg.pattern));
          if (m) {
            this.secret = m[1];
            this.onLog(`[apx] 已从 stdout 取得凭据（${String(this.secret).length} 字符）`);
          }
        }
      }
    };
    this.child.stdout.on('data', (b) => consume(b, 'out'));
    this.child.stderr.on('data', (b) => consume(b, 'err'));
    this.child.on('exit', (code) => {
      this.ready = false;
      this.onLog(`[apx] 服务面进程退出，code=${code}`);
    });
    return true;
  }

  /** 就绪判定：契约端点返回 200 才算就绪；503/401 都不算。 */
  async waitReady({ timeoutMs = 45000, intervalMs = 1200 } = {}) {
    const probe = this.adapter.serviceFace?.readyProbe || { path: '/v1/models' };
    const deadline = Date.now() + timeoutMs;
    let last = 'no-attempt';
    while (Date.now() < deadline) {
      if (this.secret === null && this.adapter.serviceFace?.auth?.secretFrom) {
        await sleep(Math.min(intervalMs, 400));
        continue;
      }
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(`${this.baseUrl}${probe.path}`, {
          headers: this.authHeader(),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        last = `${res.status} ${text.slice(0, 120)}`;
        if (res.status === 200) {
          this.ready = true;
          return { ok: true, status: res.status, body: text.slice(0, 200) };
        }
      } catch (e) {
        last = String(e.message || e);
      }
      await sleep(intervalMs);
    }
    return { ok: false, last };
  }

  /** 停止：Windows 用 taskkill /T 杀整棵树；POSIX 用进程组。 */
  async stop() {
    if (!this.child?.pid) return { stopped: false, reason: 'no-child' };
    const pid = this.child.pid;
    if (process.platform === 'win32') {
      await runQuiet('taskkill', ['/PID', String(pid), '/T', '/F']);
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    this.ready = false;
    return { stopped: true, pid };
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 端口可用性探测：用于在启动前选一个空闲端口。 */
export async function pickFreePort(preferred) {
  const net = await import('node:net');
  const tryBind = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
  if (preferred && (await tryBind(preferred))) return preferred;
  for (let p = 0; p < 20; p++) {
    const port = 8787 + p;
    if (await tryBind(port)) return port;
  }
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
