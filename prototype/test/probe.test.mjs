// 可代理性判定的回归测试：钉住两个实测出来的假阳性。
//
// 背景（都是真踩到的）：
//   ① 有的服务只回 {"models":[{"name":"...","model":"...","type":"model"}]} —— 原生形状，
//      不是 OpenAI。判成 L1 之后调用直接 500。必须只算 L2。
//   ② 更隐蔽的一种：同时回 models[] 和 data[]，data[0].id 是文件路径
//      （C:\Users\...\.ollama\models\blobs\sha256-...）。形状看起来完全合规，
//      但把那个 id 原样回传会被上游拒绝（500 invalid string: forbidden character after backslash）。
//   ③ 正确的形状（顶层 data[] + data[0].id 是字符串）必须仍然是 L1，不能因为收紧判据误杀。
//
// 本文件同时验证「probe 与 port-scan 共用同一判据」：结构判定只允许有一个实现。
import http from 'node:http';
import net from 'node:net';
import { looksLikeModelList, describeModelListShape, probeEndpoint } from '../src/probe.mjs';
import { portScanEndpoints } from '../src/runtime/portscan.mjs';

let pass = 0;
let fail = 0;
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

// 只在「真机探测」小节用到

/** 起一个假的 OpenAI 兼容服务，body 由调用方指定。 */
async function fakeService({ modelsBody, rootBody = { error: 'not found' }, rootStatus = 404 }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      const buf = Buffer.from(JSON.stringify(modelsBody));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
      return res.end(buf);
    }
    const buf = Buffer.from(JSON.stringify(rootBody));
    res.writeHead(rootStatus, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  });
  const port = await listen(server);
  return { server, port, close: () => new Promise((r) => server.close(() => r())) };
}

async function main() {
  console.log('== probe：L1 判据与 port-scan 命中判据 ==');

  console.log('\n[1] 判据函数本身（纯结构，无网络）');
  {
    check('OpenAI 形状判 L1', looksLikeModelList({ object: 'list', data: [{ id: 'qwen2.5:0.5b' }] }) === true);
    check('只有 models[] 不判 L1', looksLikeModelList({ models: [{ name: 'C:\\x\\sha256-a', model: 'C:\\x\\sha256-a', type: 'model' }] }) === false);
    check('空 data[] 不判 L1', looksLikeModelList({ object: 'list', data: [] }) === false);
    check('data[0].id 不是字符串不判 L1', looksLikeModelList({ data: [{ id: 123 }] }) === false);
    check('data[0] 只有 name 不判 L1', looksLikeModelList({ data: [{ name: 'foo' }] }) === false);
    check('顶层数组不判 L1', looksLikeModelList([{ id: 'x' }]) === false);
    check(
      '混合方言（models[] + data[]）不判 L1',
      looksLikeModelList({ object: 'list', models: [{ name: 'x' }], data: [{ id: 'real-model' }] }) === false,
    );
    check(
      'id 是 Windows 文件路径不判 L1',
      looksLikeModelList({ object: 'list', data: [{ id: 'C:\\Users\\u\\.ollama\\models\\blobs\\sha256-abc' }] }) === false,
    );
    check('id 是 POSIX 绝对路径不判 L1', looksLikeModelList({ data: [{ id: '/var/models/x.gguf' }] }) === false);
    check('合法 id 里含斜杠不算路径（如 org/model）', looksLikeModelList({ data: [{ id: 'org/model-x' }] }) === true);
    check('理由文本能说清"只有 models[]"', /models\[\]/.test(describeModelListShape({ models: [{ name: 'x' }] })));
    check('理由文本能说清"文件路径"', /文件路径/.test(describeModelListShape({ data: [{ id: 'C:\\a\\b' }] })));
  }

  console.log('\n[2] 假上游：只有 models[] 的服务必须只判 L2');
  const legacy = await fakeService({ modelsBody: { models: [{ name: 'C:\\x\\sha256-a', model: 'C:\\x\\sha256-a', type: 'model' }] } });
  try {
    const r = await probeEndpoint({ port: legacy.port });
    check('probe 判 L2（不是 L1）', r.level === 'L2', `实际 ${r.level}`);
    check('证据里 modelList=false', r.evidence?.candidates?.[0]?.modelList === false, JSON.stringify(r.evidence?.candidates?.[0]));
    const scan = await portScanEndpoints({ candidates: [legacy.port] });
    check('port-scan 不命中该端口', scan.ok === false, `实际 ok=${scan.ok}`);
    check('port-scan 给出结构原因', /OpenAI|models\[\]/.test(scan.attempts[0]?.reason || ''), scan.attempts[0]?.reason);
  } finally {
    await legacy.close();
  }

  console.log('\n[3] 假上游：混合方言 + 文件路径 id 必须只判 L2');
  const hybrid = await fakeService({
    modelsBody: {
      models: [{ name: 'C:\\Users\\u\\.ollama\\models\\blobs\\sha256-abc', model: 'C:\\Users\\u\\.ollama\\models\\blobs\\sha256-abc', type: 'model' }],
      object: 'list',
      data: [{ id: 'C:\\Users\\u\\.ollama\\models\\blobs\\sha256-abc', object: 'model', owned_by: 'llamacpp' }],
    },
  });
  try {
    const r = await probeEndpoint({ port: hybrid.port });
    check('probe 判 L2（不是 L1）', r.level === 'L2', `实际 ${r.level}`);
    check('理由提到混合方言/文件路径', r.reasons.some((s) => /混合方言|文件路径/.test(s)), JSON.stringify(r.reasons));
    const scan = await portScanEndpoints({ candidates: [hybrid.port] });
    check('port-scan 不命中该端口', scan.ok === false, `实际 ok=${scan.ok}`);
  } finally {
    await hybrid.close();
  }

  console.log('\n[4] 假上游：正确的 OpenAI 形状必须命中 L1');
  const good = await fakeService({ modelsBody: { object: 'list', data: [{ id: 'good-model-1', object: 'model' }] } });
  try {
    const r = await probeEndpoint({ port: good.port });
    check('probe 判 L1', r.level === 'L1', `实际 ${r.level} ${JSON.stringify(r.reasons)}`);
    const scan = await portScanEndpoints({ candidates: [good.port] });
    check('port-scan 命中', scan.ok === true && scan.port === good.port, JSON.stringify(scan.attempts));
    check('port-scan 取到模型 id', scan.ok && scan.probe.models[0] === 'good-model-1', JSON.stringify(scan.probe?.models));
  } finally {
    await good.close();
  }

  console.log('\n[5] 真机回归：本机两个已知端口');
  {
    // 11434：标准 OpenAI 形状，必须 L1（若本机没在跑则 skip）
    const has11434 = await portOpen(11434);
    if (has11434) {
      const r = await probeEndpoint({ port: 11434 });
      check('11434 判 L1（不误杀）', r.level === 'L1', `实际 ${r.level} ${JSON.stringify(r.reasons)}`);
    } else {
      console.log('  - 11434 未监听，跳过该断言');
    }
    // 58241：llama.cpp 的混合方言 + 文件路径 id，必须不是 L1（若没在跑则 skip）
    const has58241 = await portOpen(58241);
    if (has58241) {
      const r = await probeEndpoint({ port: 58241 });
      check('58241 不再是 L1（假阳性已修）', r.level !== 'L1', `实际 ${r.level}`);
      check('58241 判 L2', r.level === 'L2', `实际 ${r.level}`);
    } else {
      console.log('  - 58241 未监听，跳过该断言（用 [3] 的假上游等价覆盖）');
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
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
