// 适配器层测试：manifest 是否都能加载、声明的策略是否被正确理解、以及「凭证型适配器」的机制是否真的通。
//
// 本文件不打印、不断言任何凭据明文（只断言"读到且长度 > 0"）。
// 远端探活失败一律 skip（打印原因），不 fail —— 上游可用性不由我们控制。
import './_isolate-state.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAdapters, findAdapter, matchAdapter } from '../src/adapters/loader.mjs';
import { createCredentialProvider, expandPath } from '../src/security/credentials.mjs';
import { applyProxyPolicy, describeProxyPolicy } from '../src/runtime/proxyenv.mjs';
import { createController, dedupeVersionPrefix } from '../src/runtime/controller.mjs';

let pass = 0;
let fail = 0;
let skipped = 0;
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

function skip(name, reason) {
  skipped++;
  console.log(`  - SKIP ${name}：${reason}`);
}

async function main() {
  console.log('== adapters：manifest 加载 / 策略声明 / 凭证机制 ==');

  console.log('\n[1] 全部 manifest 都能加载');
  const { adapters, errors } = loadAdapters();
  check('加载无校验错误', errors.length === 0, JSON.stringify(errors).slice(0, 300));
  const ids = adapters.map((a) => a.id);
  for (const id of ['local-openai-service', 'openai-passthrough', 'opencode-v2', 'deepseek-harness']) {
    check(`含 ${id}`, ids.includes(id), ids.join(','));
  }

  console.log('\n[2] 关键声明与行为一致（不是靠默认值碰巧对上）');
  {
    const a = findAdapter('opencode-v2');
    check('opencode-v2 策略 launch-assigned', a.serviceFace.portDiscovery.strategy === 'launch-assigned', a.serviceFace.portDiscovery.strategy);
    check('opencode-v2 显式声明 proxyEnv=clear', a.serviceFace.proxyEnv === 'clear', JSON.stringify(a.serviceFace.proxyEnv));
    check('opencode-v2 quirks 说明了 clear 的原因', (a.quirks?.knownIssues || []).some((s) => s.includes('proxyEnv')), '未找到说明');
  }
  {
    const a = findAdapter('local-openai-service');
    check('local-openai-service 策略 port-scan', a.serviceFace.portDiscovery.strategy === 'port-scan');
    check('候选端口来自 manifest', (a.serviceFace.portDiscovery.candidates || []).length > 0, JSON.stringify(a.serviceFace.portDiscovery.candidates));
    check('能力 streaming=true', a.capabilities?.streaming === true);
  }
  {
    const a = findAdapter('deepseek-harness');
    check('deepseek-harness 策略 remote', a.serviceFace.portDiscovery.strategy === 'remote', a.serviceFace.portDiscovery.strategy);
    check('声明了 baseUrl', Boolean(a.serviceFace.baseUrl), String(a.serviceFace.baseUrl));
    check('level 为 experimental（不假装可用）', a.level === 'experimental', String(a.level));
    check('凭据来源是 regex-file', a.upstream.auth.kind === 'regex-file', String(a.upstream.auth.kind));
    check(
      'knownIssues 如实记录了 503（机制就绪 ≠ 可用）',
      (a.quirks?.knownIssues || []).some((s) => s.includes('503')),
      JSON.stringify(a.quirks?.knownIssues || []).slice(0, 200),
    );
    check('knownIssues 提醒了 ToS 风险', (a.quirks?.knownIssues || []).some((s) => /条款|ToS/.test(s)), '未找到');
  }

  console.log('\n[3] baseUrl 拼接规则（避免 /v1/v1/models）');
  {
    const r1 = dedupeVersionPrefix('https://host/v1', '/v1/models');
    check('带 /v1 的 baseUrl + /v1/ 路径 → 去掉一次', r1.baseUrl === 'https://host' && r1.stripped === '/v1', JSON.stringify(r1));
    const r2 = dedupeVersionPrefix('https://host', '/v1/models');
    check('不带版本前缀的 baseUrl 不动', r2.baseUrl === 'https://host' && r2.stripped === null, JSON.stringify(r2));
    const r3 = dedupeVersionPrefix('https://host/v2', '/v1/models');
    check('版本号不一致时不动', r3.baseUrl === 'https://host/v2' && r3.stripped === null, JSON.stringify(r3));
    const r4 = dedupeVersionPrefix('https://host/v1/', '/v1/chat/completions');
    check('尾部斜杠不影响判定', r4.baseUrl === 'https://host', JSON.stringify(r4));
  }

  console.log('\n[4] proxyEnv 策略（clear / inherit / custom）');
  {
    const base = { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'x', http_proxy: 'y', PATH: '/bin' };
    const cleared = applyProxyPolicy(base, 'clear');
    check('clear 移除全部代理变量', ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy'].every((k) => cleared.env[k] === undefined), JSON.stringify(Object.keys(cleared.env)));
    check('clear 设置 NO_PROXY 含 127.0.0.1', String(cleared.env.NO_PROXY).includes('127.0.0.1'), String(cleared.env.NO_PROXY));
    check('clear 保留无关变量', cleared.env.PATH === '/bin');

    const inherited = applyProxyPolicy(base, 'inherit');
    check('inherit 保留代理变量', inherited.env.HTTP_PROXY === 'http://127.0.0.1:1');
    check('inherit 也把 127.0.0.1 加进 NO_PROXY', String(inherited.env.NO_PROXY).includes('127.0.0.1'), String(inherited.env.NO_PROXY));

    const withExisting = applyProxyPolicy({ ...base, NO_PROXY: 'corp.local' }, 'inherit');
    check('inherit 追加而不是覆盖已有 NO_PROXY', /corp\.local/.test(withExisting.env.NO_PROXY) && /127\.0\.0\.1/.test(withExisting.env.NO_PROXY), withExisting.env.NO_PROXY);

    const custom = applyProxyPolicy(base, { custom: { HTTP_PROXY: 'http://127.0.0.1:7890' } });
    check('custom 注入指定值', custom.env.HTTP_PROXY === 'http://127.0.0.1:7890', String(custom.env.HTTP_PROXY));
    check('custom 下 HTTPS_PROXY 被清掉', custom.env.HTTPS_PROXY === undefined);
    check('describe 能反映 inherit 语义', /回环/.test(describeProxyPolicy('inherit').label), describeProxyPolicy('inherit').label);
  }

  console.log('\n[5] 凭证型适配器：从 agent 的凭据文件按正则取（不打印明文）');
  // 真实凭据是外部状态：文件不存在或格式变了都不该让整个套件失败。
  // 真实文件可用就用真实的；否则换成本地夹具，保证 regex-file 机制本身被稳定验证。
  const dsh = findAdapter('deepseek-harness');
  const credPath = expandPath(dsh.upstream.auth.path);
  let authSpec = dsh.upstream.auth;
  let fixtureDir = null;
  let fixtureNote = '';
  const useFixture = () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-cred-'));
    const file = path.join(fixtureDir, 'credentials.yaml');
    fs.writeFileSync(file, 'DSH_API_KEY: "fixture-token-123"\n');
    authSpec = { ...dsh.upstream.auth, path: file };
  };
  if (!fs.existsSync(credPath)) {
    skip('真实 DSH 凭据', `文件不存在：${credPath}；改用夹具验证机制`);
    useFixture();
    fixtureNote = '（夹具）';
  } else {
    const probe = createCredentialProvider(dsh.upstream.auth);
    const probeCred = await probe.get();
    if (!probeCred?.token) {
      skip('真实 DSH 凭据', '文件存在但未匹配到 DSH_API_KEY（外部格式可能已变）；改用夹具验证机制');
      useFixture();
      fixtureNote = '（夹具）';
    }
  }

  {
    const provider = createCredentialProvider(authSpec);
    const cred = await provider.get();
    check(`凭据已读到${fixtureNote}`, Boolean(cred && cred.token), '读不到（正则没匹配上？）');
    check('凭据长度 > 0', Boolean(cred?.token?.length > 0), String(cred?.token?.length ?? 0));
    check('scheme 为 bearer', cred?.scheme === 'bearer', String(cred?.scheme));
    // 只断言"能读到"，绝不打印值
    const desc = provider.describe();
    check('describe 报告文件存在且已读取', desc.ok === true && desc.hasToken === true, JSON.stringify({ ok: desc.ok, hasToken: desc.hasToken, kind: desc.kind }));
    check('describe 不泄露凭据明文', !JSON.stringify(desc).includes(String(cred?.token || 'fixture-token-123')), JSON.stringify(desc));
  }
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });

  console.log('\n[6] 远端上游探活（失败即 skip，不 fail）');
  {
    const controller = createController({ log: (l) => console.log('  [controller] ' + l) });
    let info = null;
    try {
      info = await controller.start({ adapterId: 'deepseek-harness' });
      check('controller 能起 remote 型代理', Boolean(info.port), JSON.stringify(info).slice(0, 200));
      check('remote 型没有上游 pid', info.upstreamPid === null, String(info.upstreamPid));
      check('remote 型不写 upstreamPort', info.upstreamPort === null, String(info.upstreamPort));
      const r = await fetch(`${info.baseUrl}/models`, {
        headers: { authorization: `Bearer ${await controller.currentToken()}` },
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      if (!r.ok) {
        skip('/v1/models 探活', `上游返回 ${r.status}：${text.slice(0, 120)}`);
      } else {
        let j = null;
        try {
          j = JSON.parse(text);
        } catch {
          /* 非 JSON */
        }
        const count = Array.isArray(j?.data) ? j.data.length : 0;
        if (count === 0) skip('/v1/models 模型可用性', '中转 200 但模型清单为空（上游状态，不由本地控制）');
        else check('/v1/models 返回 200 且形状可解析', true, `data 数量 ${count}`);
      }
    } catch (e) {
      skip('远端上游探活', `启动或请求失败：${e.message}`);
    } finally {
      await controller.stop().catch(() => {});
    }
  }

  console.log('\n[7] 规范化校验：写错必须在加载期被拒（不靠运行时猜）');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-bad-adapter-'));
    const base = {
      schemaVersion: 1,
      name: '坏 manifest（测试用）',
      match: { exeNames: [], pathGlobs: [] },
      capabilities: { streaming: true },
      sessionPolicy: 'stateless',
    };
    fs.writeFileSync(
      path.join(tmp, 'with-path.json'),
      JSON.stringify({
        ...base,
        id: 'with-path',
        serviceFace: { type: 'openai-passthrough', baseUrl: 'https://api.example.com/v1', portDiscovery: { strategy: 'remote' } },
        upstream: { baseUrl: 'https://api.example.com/v1', listModels: { path: '/v1/models' }, generate: { path: '/v1/chat/completions' } },
      }),
    );
    fs.writeFileSync(
      path.join(tmp, 'remote-inherit.json'),
      JSON.stringify({
        ...base,
        id: 'remote-inherit',
        serviceFace: { type: 'openai-passthrough', baseUrl: 'https://api.example.com', proxyEnv: 'inherit', portDiscovery: { strategy: 'remote' } },
        upstream: { listModels: { path: '/v1/models' }, generate: { path: '/v1/chat/completions' } },
      }),
    );

    const loaded = loadAdapters({ extraDirs: [tmp] });
    const ids = loaded.adapters.map((a) => a.id);
    check('带路径的 baseUrl 那条没被加载', !ids.includes('with-path'), ids.join(','));
    check('remote+inherit 那条没被加载', !ids.includes('remote-inherit'), ids.join(','));

    const baseUrlErrs = loaded.errors.filter((e) => String(e.field).includes('baseUrl'));
    check('报出 baseUrl 字段级错误', baseUrlErrs.length >= 2, JSON.stringify(baseUrlErrs.map((e) => e.field)));
    check(
      '错误信息指明"路径请写在各 endpoint 里"',
      baseUrlErrs.some((e) => /path|路径/.test(String(e.actual))),
      JSON.stringify(baseUrlErrs.map((e) => e.actual).slice(0, 2)),
    );
    const inheritErrs = loaded.errors.filter((e) => /inherit/.test(String(e.actual)));
    check('报出 remote+inherit 不可用', inheritErrs.length >= 1, JSON.stringify(inheritErrs.map((e) => e.actual)));
    check('错误解释原因（fetch 不读系统代理）', inheritErrs.some((e) => /fetch|代理/.test(String(e.actual))), JSON.stringify(inheritErrs[0]?.actual));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n[8] 噪声 exe 不得进入匹配结果（卸载器/安装器/更新器）');
  {
    const mk = (name, exePath) => ({ id: name, name, exePath, running: false, ports: [], sources: ['registry'], confidence: 0.95 });
    const batch = [
      mk('Uninstall OpenCode', 'C:\\Apps\\OpenCode\\Uninstall OpenCode.exe'),
      mk('OpenCode', 'C:\\Apps\\OpenCode\\OpenCode.exe'),
      mk('OpenCode Updater', 'C:\\Apps\\OpenCode\\updater-setup.exe'),
    ];
    const hits = matchAdapter(findAdapter('opencode-v2'), batch);
    const names = hits.map((h) => h.candidate.name);
    check('卸载器被排除', !names.includes('Uninstall OpenCode'), names.join(' | '));
    check('安装器被排除', !names.includes('OpenCode Updater'), names.join(' | '));
    check('主程序仍命中', names.includes('OpenCode'), names.join(' | '));

    // 逃生口：manifest 显式列出 update.exe 时允许（有的软件主程序真叫这个名）
    const explicitAdapter = { match: { exeNames: ['update.exe'], pathGlobs: [], registryNamePattern: null } };
    const upd = [mk('某软件更新器', 'C:\\Apps\\X\\update.exe')];
    check('exeNames 显式列出时噪声豁免', matchAdapter(explicitAdapter, upd).length === 1, JSON.stringify(matchAdapter(explicitAdapter, upd)));
    const implicitAdapter = { match: { exeNames: [], pathGlobs: ['C:\\Apps\\X\\*.exe'], registryNamePattern: null } };
    check('仅靠 glob 顺带命中时被压制', matchAdapter(implicitAdapter, upd).length === 0, JSON.stringify(matchAdapter(implicitAdapter, upd)));
  }

  console.log('\n[9] limits（并发/超时）声明校验');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apx-limits-'));
    const base = {
      schemaVersion: 1,
      name: 'limits 夹具',
      version: '1.0.0',
      match: { exeNames: [], pathGlobs: [] },
      serviceFace: { type: 'openai-passthrough', portDiscovery: { strategy: 'listen-scan' } },
      upstream: { listModels: { path: '/v1/models' }, generate: { path: '/v1/chat/completions' } },
    };
    fs.writeFileSync(
      path.join(tmp, 'good.json'),
      JSON.stringify({ ...base, id: 'limits-good', limits: { maxConcurrent: 4, maxQueue: 8, queueTimeoutMs: 5000, requestTimeoutMs: 60000 } }),
    );
    fs.writeFileSync(
      path.join(tmp, 'bad.json'),
      JSON.stringify({ ...base, id: 'limits-bad', limits: { maxConcurrent: 0, maxQueue: -1, requestTimeoutMs: 'soon', maxInputChars: -1, maxTools: -2 } }),
    );
    const loaded = loadAdapters({ extraDirs: [tmp] });
    check('合法 limits 正常加载', loaded.adapters.some((a) => a.id === 'limits-good' && a.limits.maxConcurrent === 4), loaded.adapters.map((a) => a.id).join(','));
    check('非法 limits 被拒绝', !loaded.adapters.some((a) => a.id === 'limits-bad'), loaded.adapters.map((a) => a.id).join(','));
    const errs = loaded.errors.filter((e) => String(e.field).startsWith('limits.'));
    check('报出字段级 limits 错误', errs.length >= 3, JSON.stringify(errs.map((e) => `${e.field}=${e.actual}`)));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过`);
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
