#!/usr/bin/env node
'use strict';
/**
 * Graba la demo real de Tab Bomb: captura frames del popup y de una página
 * con la bomba armada, accionando la extensión de verdad.
 *   node test/demo.js    →  dist/demo/frames/{a,b,c}/*.jpg
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const DEMO = path.join(ROOT, 'dist', 'demo');
const FRAMES = path.join(DEMO, 'frames');
const PORT_CDP = 9335;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabbomb-demo-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITES = {
  'github.test': {
    title: 'Pull requests · nrocaalh/tab-bomb',
    accent: '#24292f',
    h1: 'Pull requests',
    sub: 'nrocaalh/tab-bomb · 3 abiertos',
    rows: ['feat: TTL por pestaña', 'fix: no cerrar pestañas con audio', 'docs: cómo funciona la bomba']
  },
  'notion.test': {
    title: 'Notas de la reunión — Notion',
    accent: '#111111',
    h1: 'Notas de la reunión',
    sub: 'Equipo producto · editado hace 2 h',
    rows: ['Revisar el roadmap de Q4', 'Pendiente: presupuesto de infra', 'Decisión: posponer la migración']
  },
  'mdn.test': {
    title: 'chrome.tabs — MDN Web Docs',
    accent: '#1a5cff',
    h1: 'chrome.tabs',
    sub: 'API de extensiones · Manifest V3',
    rows: ['tabs.query()', 'tabs.onActivated', 'tabs.remove()']
  },
  'wiki.test': {
    title: 'Pestaña (informática) — Wikipedia',
    accent: '#63666a',
    h1: 'Pestaña (informática)',
    sub: 'De Wikipedia, la enciclopedia libre',
    rows: ['Una pestaña es un elemento de la interfaz…', 'Navegadores modernos permiten agruparlas…', 'Véase también: Gestor de pestañas']
  }
};

function page(host) {
  const s = SITES[host] || { title: host, accent: '#333', h1: host, sub: '', rows: [] };
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>${s.title}</title>
<link rel="icon" href="/fav.png">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color:#1b1f24; background:#fff; }
  header { display:flex; align-items:center; gap:14px; padding:16px 42px; border-bottom:1px solid #e6e8eb; }
  .logo { width:30px;height:30px;border-radius:8px;background:${s.accent};color:#fff;display:grid;place-items:center;font-weight:700 }
  nav { display:flex; gap:22px; font-size:14px; color:#57606a }
  main { max-width:760px; margin:0 auto; padding:54px 42px 120px; }
  h1 { font-size:38px; margin:0 0 8px; letter-spacing:-.5px }
  .sub { color:#6a737d; font-size:14px; margin-bottom:34px }
  .card { border:1px solid #e6e8eb; border-radius:10px; padding:16px 20px; margin-bottom:12px; display:flex; gap:14px; align-items:center }
  .dot { width:8px;height:8px;border-radius:50%;background:${s.accent}; flex:0 0 auto }
  p { line-height:1.65; color:#3d444d; }
  .ghost { height:190px; border-radius:10px; background:linear-gradient(180deg,#fafbfc,#f3f4f6); border:1px solid #eef0f2; }
</style></head><body>
<header><div class="logo">${s.h1[0]}</div><nav><span>${s.h1}</span><span>Explorar</span><span>Ayuda</span></nav></header>
<main>
  <h1>${s.h1}</h1>
  <div class="sub">${s.sub}</div>
  ${s.rows.map((r) => `<div class="card"><span class="dot"></span><span>${r}</span></div>`).join('\n  ')}
  <p>Esta pestaña lleva un buen rato abierta y nadie la ha tocado. Tab Bomb la vigila en segundo plano: cuando se cumpla su TTL aparecerá la cuenta atrás y, si no la usas, se cerrará sola.</p>
  <div class="ghost"></div>
</main>
</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (req.url.startsWith('/fav.png')) {
      const f = path.join(DEMO, 'fav', host + '.png');
      if (fs.existsSync(f)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(fs.readFileSync(f));
      }
      res.writeHead(404); return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(host));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.ws = null; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws'));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.pending.has(m.id)) {
          const { resolve: r, reject: j } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) j(new Error(m.error.message)); else r(m.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  }
}

async function fitPopup(cdp) {
  const h = await cdp.eval('Math.min(580, Math.max(430, Math.ceil(document.body.getBoundingClientRect().height + 2)))');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: Math.round(h), deviceScaleFactor: 2, mobile: false });
  await sleep(350);
  return h;
}

async function capture(cdp, dir, seconds, actions = [], label = '') {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  await cdp.send('Page.enable');
  const t0 = Date.now();
  const end = t0 + seconds * 1000;
  const queue = actions.slice().sort((a, b) => a.at - b.at);
  let i = 0;
  while (Date.now() < end) {
    while (queue.length && Date.now() - t0 >= queue[0].at * 1000) {
      const a = queue.shift();
      try { console.log('   ↳ ' + a.what); await a.fn(); } catch (e) { console.log('   ! acción falló:', a.what, e.message); }
    }
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, fromSurface: true });
    fs.writeFileSync(path.join(dir, String(++i).padStart(4, '0') + '.jpg'), Buffer.from(r.data, 'base64'));
    await sleep(85);
  }
  console.log('  ' + label + ': ' + i + ' frames');
  return i;
}

(async () => {
  const { server, port } = await startServer();
  console.log('  servidor en :' + port);

  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--host-resolver-rules=MAP github.test 127.0.0.1, MAP notion.test 127.0.0.1, MAP mdn.test 127.0.0.1, MAP wiki.test 127.0.0.1',
    '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--remote-debugging-port=' + PORT_CDP, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    let v = null;
    for (let i = 0; i < 60; i++) { try { v = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/version`); break; } catch (e) { await sleep(250); } }
    if (!v) throw new Error('CDP no arrancó');

    let swT = null;
    for (let i = 0; i < 40; i++) {
      const list = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
      swT = list.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url));
      if (swT) break;
      await sleep(250);
    }
    if (!swT) throw new Error('sin service worker');
    const extId = swT.url.split('/')[2];
    const sw = new CDP(swT.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send('Runtime.enable');

    // pestañas de trabajo
    const tabs = await sw.eval(`(async () => {
      const urls = [
        'http://github.test:${port}/pulls',
        'http://notion.test:${port}/notas',
        'http://mdn.test:${port}/docs',
        'http://wiki.test:${port}/pestana'
      ];
      const out = {};
      for (const u of urls) {
        const t = await chrome.tabs.create({ url: u, active: false });
        out[new URL(u).hostname] = t.id;
      }
      await new Promise(r => setTimeout(r, 2500));
      return out;
    })()`);
    console.log('  pestañas:', JSON.stringify(tabs));

    // ajustes de demo: TTL 2 min, bomba 25 s
    await sw.eval(`__tabBomb.handleMessage({ type: 'settings', patch: {
      ttlMinutes: 2, graceSeconds: 25, showOverlay: true, keepLastTabInWindow: false, ignoreActive: true, mode: 'close', enabled: true
    } }, {})`);

    // popup como pestaña
    await sw.eval(`chrome.tabs.create({ url: 'chrome-extension://${extId}/popup.html', active: true })`);
    await sleep(1200);

    const list = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
    const popupT = list.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
    const ghT = list.find((t) => t.type === 'page' && t.url.includes('github.test'));
    if (!popupT || !ghT) throw new Error('faltan targets: ' + JSON.stringify(list.map((t) => t.url)));

    const popup = new CDP(popupT.webSocketDebuggerUrl);
    await popup.connect();
    await popup.send('Runtime.enable');
    await popup.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 580, deviceScaleFactor: 2, mobile: false });

    const gh = new CDP(ghT.webSocketDebuggerUrl);
    await gh.connect();
    await gh.send('Runtime.enable');
    await gh.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await sleep(800);

    // estado inicial: github ya con la bomba a punto de armarse
    await sw.eval(`(async () => {
      const id = ${tabs['github.test']};
      __tabBomb.state.tabs[id].lastUsed = Date.now() - 125 * 1000; // TTL 2 min → bomba armada, ~20 s
      await __tabBomb.sweep();
      return true;
    })()`);

    // ---------- Escena A: popup ----------
    await sw.eval(`(async () => {
      const ps = await chrome.tabs.query({});
      const p = ps.find(t => t.url.endsWith('/popup.html'));
      if (p) await chrome.tabs.update(p.id, { active: true });
      return true;
    })()`);
    await sleep(700);
    console.log('  alto del popup:', await fitPopup(popup));
    console.log('  grabando A (popup)…');
    await capture(popup, path.join(FRAMES, 'a'), 7, [], 'A');

    // ---------- Escena B: página con la bomba ----------
    // re-armar con ~22 s por delante
    await sw.eval(`__tabBomb.handleMessage({ type: 'settings', patch: { ignoreActive: false } }, {})`);
    const armedB = await sw.eval(`(async () => {
      const id = ${tabs['github.test']};
      await chrome.tabs.update(id, { active: true });
      await new Promise(r => setTimeout(r, 450));
      __tabBomb.state.tabs[id].lastUsed = Date.now() - 123000; // killAt = +145 s → ~22 s de bomba
      __tabBomb.state.tabs[id].armed = false;
      __tabBomb.state.tabs[id].keep = false;
      await __tabBomb.sweep();
      return { armed: __tabBomb.state.tabs[id].armed, id };
    })()`);
    console.log('  escena B armada:', JSON.stringify(armedB));
    await sleep(600);
    console.log('  grabando B (página)…');
    await capture(gh, path.join(FRAMES, 'b'), 17, [{
      at: 13.5,
      what: 'clic en «Mantener viva» dentro de la página',
      fn: async () => console.log('     →', await gh.eval(`(() => {
        const host = document.getElementById('__tabbomb_overlay__');
        if (!host || !host.shadowRoot) return 'sin cartel';
        const b = [...host.shadowRoot.querySelectorAll('button')].find(x => /Mantener/.test(x.textContent));
        if (!b) return 'sin botón';
        b.click();
        return 'clic ok';
      })()`))
    }], 'B');

    await sw.eval(`__tabBomb.handleMessage({ type: 'settings', patch: { ignoreActive: true } }, {})`);

    // ---------- Escena C: cerrar zombis ----------
    await sw.eval(`(async () => {
      const ps = await chrome.tabs.query({});
      const p = ps.find(t => t.url.endsWith('/popup.html'));
      if (p) await chrome.tabs.update(p.id, { active: true });
      const old = Date.now() - 128 * 1000;
      for (const h of ['notion.test', 'mdn.test', 'wiki.test']) {
        const id = ${JSON.stringify(tabs)}[h];
        if (id && __tabBomb.state.tabs[id]) { __tabBomb.state.tabs[id].lastUsed = old; __tabBomb.state.tabs[id].armed = false; }
      }
      await __tabBomb.sweep();
      return true;
    })()`);
    await sleep(900);
    await fitPopup(popup);
    console.log('  grabando C (popup + cierre)…');
    await capture(popup, path.join(FRAMES, 'c'), 9, [{
      at: 4,
      what: 'clic en «Cerrar zombis ahora»',
      fn: async () => console.log('     →', await popup.eval(`(() => { const b = document.getElementById('btn-zombies'); if (!b) return 'sin botón'; if (b.disabled) return 'botón desactivado'; b.click(); return 'clic ok'; })()`))
    }], 'C');

    // comprobación final de que se cerraron de verdad
    const finalCount = await sw.eval('(async () => (await chrome.tabs.query({})).map(t => t.url))()');
    console.log('\n  pestañas que quedan:', finalCount.length);
    finalCount.forEach((u) => console.log('   ·', u));
    console.log('  stats:', await sw.eval('JSON.stringify(__tabBomb.state.stats)'));
  } catch (e) {
    console.log('\x1b[31merror:\x1b[0m ' + e.message);
    process.exitCode = 1;
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    server.close();
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})();
