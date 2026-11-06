package gateway

import "strings"

func (s *Server) page() string {
	return strings.ReplaceAll(pageHTML, "__APX_TOKEN__", s.cfg.Token)
}

const pageHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="apx-console-token" content="__APX_TOKEN__">
<title>apx2 · 本地模型网关</title>
<style>
:root{
  --bg:#0b0c0e; --panel:#14161a; --panel2:#191c21; --line:#24282f;
  --text:#e6e8eb; --dim:#8b929e; --green:#7ee787; --amber:#f0b429; --red:#ff7b72; --blue:#79c0ff;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
code,pre,.mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
header{position:sticky;top:0;z-index:5;background:rgba(11,12,14,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
.bar{display:flex;align-items:center;gap:14px;height:58px}
.logo{font-weight:700;letter-spacing:.4px}
.logo span{color:var(--green)}
.pill{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:3px 10px;color:var(--dim);font-size:12px}
.grow{flex:1}
button{cursor:pointer;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:13px}
button:hover{border-color:#3a4048;background:var(--panel2)}
button.primary{border-color:#2f5d3a;background:#13251a;color:var(--green)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:20px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.stat .k{color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.stat .v{font-size:26px;font-weight:650;margin-top:4px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin:26px 0 10px}
.providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:12px}
.provider{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.provider.off{opacity:.62}
.phead{display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--dim);box-shadow:0 0 0 3px rgba(255,255,255,.03)}
.dot.ok{background:var(--green)} .dot.bad{background:var(--red)} .dot.warn{background:var(--amber)}
.pname{font-weight:650}
.ptype{margin-left:auto;font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.purl{color:var(--dim);font-size:12px;margin:6px 0 9px;word-break:break-all}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:12px;color:#c9cfd8}
.note{margin-top:9px;color:var(--dim);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:12.5px;vertical-align:top}
th{color:var(--dim);font-weight:500;background:#121418}
tr:last-child td{border-bottom:none}
.ok{color:var(--green)} .bad{color:var(--red)} .warn{color:var(--amber)} .dim{color:var(--dim)}
.endpoint{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:18px 0 4px}
.codebox{display:flex;align-items:center;gap:8px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
.codebox code{color:var(--blue);font-size:12.5px}
.hidden{display:none}
.findings{margin-top:10px;display:grid;gap:8px}
.finding{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.tag{display:inline-block;font-size:11px;border-radius:5px;padding:1px 6px;margin-left:6px}
.tag.yes{background:#12301c;color:var(--green)} .tag.no{background:#301817;color:var(--red)}
footer{color:var(--dim);font-size:12px;padding:30px 0}
a{color:var(--blue)}
@media (max-width:640px){.bar{height:auto;padding:12px 0;flex-wrap:wrap}}
</style>
</head>
<body>
<header><div class="wrap bar">
  <div class="logo">apx<span>2</span></div>
  <div class="pill" id="ver">v2</div>
  <div class="pill" id="uptime">—</div>
  <div class="grow"></div>
  <button onclick="scan()">扫描本机 harness</button>
  <button onclick="reload()">重载配置</button>
</div></header>

<main class="wrap">
  <div class="endpoint">
    <div class="codebox"><span class="dim">端点</span><code id="endpoint">http://127.0.0.1:8787/v1</code><button onclick="copy('endpoint')">复制</button></div>
    <div class="codebox"><span class="dim">Key</span><code id="token">__APX_TOKEN__</code><button onclick="copy('token')">复制</button></div>
  </div>

  <div class="grid">
    <div class="card stat"><div class="k">请求</div><div class="v" id="s-req">0</div></div>
    <div class="card stat"><div class="k">错误</div><div class="v" id="s-err">0</div></div>
    <div class="card stat"><div class="k">Tokens</div><div class="v" id="s-tok">0</div></div>
    <div class="card stat"><div class="k">模型</div><div class="v" id="s-models">0</div></div>
  </div>

  <h2>Providers</h2>
  <div class="providers" id="providers"></div>

  <h2>路由组</h2>
  <div id="groups" class="providers"></div>

  <h2>最近请求</h2>
  <table><thead><tr><th>时间</th><th>模型</th><th>命中</th><th>状态</th><th>耗时</th><th>Tokens</th><th>说明</th></tr></thead>
  <tbody id="recent"></tbody></table>

  <h2>本机 harness 扫描</h2>
  <div class="dim" style="font-size:12.5px">只读取公开配置/明文凭据；不decrypt加密存储，不读取 magpie 的凭据，也不依赖 3425。</div>
  <div class="findings" id="findings"></div>

  <footer>apx2 · 本地 OpenAI 兼容网关 · 单二进制 · 不依赖 magpie</footer>
</main>

<script>
const TOKEN = document.querySelector('meta[name="apx-console-token"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function copy(id){ navigator.clipboard.writeText($(id).textContent.trim()); }
function fmtTime(s){ try{ return new Date(s).toLocaleTimeString(); }catch(e){ return s; } }

async function refresh(){
  const r = await fetch('/api/status');
  const s = await r.json();
  $('ver').textContent = 'v' + (s.version || '2');
  $('uptime').textContent = s.uptime || '—';
  $('endpoint').textContent = s.baseURL || '';
  $('s-req').textContent = s.requests || 0;
  $('s-err').textContent = s.errors || 0;
  $('s-tok').textContent = (s.tokens || 0).toLocaleString();
  $('s-models').textContent = (s.models || []).length;

  $('providers').innerHTML = (s.providers || []).map(p => {
    const h = p.health || {};
    const ok = h.ok === undefined ? '' : (h.ok ? 'ok' : 'bad');
    const state = h.ok === undefined ? '未使用' : (h.ok ? '正常' : '失败');
    const latency = h.lastLatencyMs ? h.lastLatencyMs + 'ms' : '';
    const chips = (p.models || []).map(m => '<span class="chip">'+esc(m)+'</span>').join('') || '<span class="dim">等待发现模型</span>';
    return '<div class="provider '+(p.disabled?'off':'')+'">'
      + '<div class="phead"><span class="dot '+ok+'"></span><span class="pname">'+esc(p.name||p.id)+'</span>'
      + '<span class="ptype">'+esc(p.protocol)+'</span></div>'
      + '<div class="purl">'+esc(p.baseUrl)+'</div>'
      + '<div class="chips">'+chips+'</div>'
      + '<div class="note"><span class="'+ok+'">'+state+'</span> '+latency+' '+esc(h.lastError||'')+'</div>'
      + (p.notes ? '<div class="note">'+esc(p.notes)+'</div>' : '')
      + '</div>';
  }).join('') || '<div class="dim">还没有 provider，运行 apx init 或扫描本机。</div>';

  $('groups').innerHTML = (s.groups || []).map(g =>
    '<div class="provider"><div class="phead"><span class="pname">'+esc(g.id)+'</span>'
    + '<span class="ptype">'+esc(g.strategy || 'order')+'</span></div>'
    + '<div class="chips" style="margin-top:8px">'+(g.providers||[]).map(p=>'<span class="chip">'+esc(p)+'</span>').join('')+'</div>'
    + '</div>').join('') || '<div class="dim">没有路由组。</div>';

  $('recent').innerHTML = (s.recent || []).slice().reverse().map(r => {
    const cls = r.status >= 400 ? 'bad' : 'ok';
    const hit = r.provider ? esc(r.provider) + (r.group ? ' <span class="dim">via '+esc(r.group)+'</span>' : '') : '<span class="dim">—</span>';
    return '<tr><td class="dim">'+fmtTime(r.at)+'</td><td>'+esc(r.model||'')+'</td><td>'+hit+'</td>'
      + '<td class="'+cls+'">'+r.status+'</td><td class="dim">'+(r.ms||0)+'ms</td><td class="dim">'+(r.tokens||0)+'</td>'
      + '<td class="dim">'+esc(r.code||'')+' '+esc(r.error||'')+'</td></tr>';
  }).join('') || '<tr><td colspan="7" class="dim">还没有请求。</td></tr>';
}

async function scan(){
  $('findings').innerHTML = '<div class="dim">正在扫描…</div>';
  const r = await fetch('/api/scan');
  const s = await r.json();
  $('findings').innerHTML = (s.findings || []).map(f => {
    const tag = f.available ? '<span class="tag yes">可用</span>' : '<span class="tag no">缺凭据</span>';
    const healthy = f.healthy === undefined || f.healthy === null ? '' : (f.healthy ? ' <span class="tag yes">网络可达</span>' : ' <span class="tag no">网络不可达</span>');
    return '<div class="finding"><b>'+esc(f.name)+'</b>'+tag+healthy
      + '<div class="dim">'+esc(f.detail||'')+'</div>'
      + (f.models&&f.models.length?'<div class="chips" style="margin-top:6px">'+f.models.map(m=>'<span class="chip">'+esc(m)+'</span>').join('')+'</div>':'')
      + (f.note?'<div class="note">'+esc(f.note)+'</div>':'')+'</div>';
  }).join('');
  refresh();
}

async function reload(){
  await fetch('/api/reload', {method:'POST'});
  refresh();
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`
