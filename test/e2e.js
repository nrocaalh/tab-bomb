#!/usr/bin/env node
'use strict';
/**
 * Prueba de humo E2E en Chromium real: carga la extensión empaquetada, abre
 * pestañas HTTP reales y comprueba con la API real del navegador que:
 *   1) la bomba se arma y pinta el cartel dentro de la página,
 *   2) el botón «Mantener viva» del cartel rescata la pestaña,
 *   3) al vencer el TTL la pestaña se cierra de verdad (chrome.tabs.remove).
 *
 *   node test/e2e.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT = path.join(__dirname, '..', 'dist', 'chrome');
const PORT_CDP = 9333;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabbomb-prof-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra) {
  results.push(!!cond);
  console.log('  ' + (cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m') + ' ' + name + (cond ? '' : '  → ' + JSON.stringify(extra)));
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
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.ws = null; this.events = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error'));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.method) this.events.push(msg);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: r, reject: j } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) j(new Error(msg.error.message));
          else r(msg.result);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    }
    return r.result.value;
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>página ' + req.url + '</title><h1>ok ' + req.url + '</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT_HTTP = server.address().port;

  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage',
    '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT,
    '--disable-extensions-except=' + EXT,
    '--remote-debugging-port=' + PORT_CDP,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  try {
    let version = null;
    for (let i = 0; i < 60; i++) {
      try { version = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/version`); break; } catch (e) { await sleep(250); }
    }
    if (!version) throw new Error('CDP no arrancó:\n' + chromeErr.slice(-1500));
    console.log('  navegador:', version.Browser);

    let swTarget = null;
    for (let i = 0; i < 40; i++) {
      const list = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
      swTarget = list.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url));
      if (swTarget) break;
      await sleep(250);
    }
    if (!swTarget) throw new Error('la extensión no registró service worker');
    console.log('  extensión cargada:', swTarget.url.replace(/\/background\.js$/, ''));
    check('el service worker de la extensión arranca', true);

    const sw = new CDP(swTarget.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send('Runtime.enable');
    check('el motor está expuesto en el SW', (await sw.eval('typeof globalThis.__tabBomb')) === 'object');

    // ---------------------------------------------------------------
    // Escenario A: bomba + cartel en la página + rescate
    // ---------------------------------------------------------------
    console.log('\n\x1b[1mA. Bomba, cartel en la página y rescate\x1b[0m');
    const aIds = await sw.eval(`(async () => {
      const out = [];
      for (const n of ['a1','a2']) {
        const t = await chrome.tabs.create({ url: 'http://127.0.0.1:${PORT_HTTP}/' + n, active: false });
        out.push(t.id);
      }
      await new Promise(r => setTimeout(r, 800));
      return out;
    })()`);
    await sw.eval(`__tabBomb.handleMessage({ type: 'settings', patch: { ttlMinutes: 1, graceSeconds: 180, showOverlay: true, keepLastTabInWindow: false, mode: 'close' } }, {})`);

    const armed = await sw.eval(`(async () => {
      const id = ${aIds[0]};
      __tabBomb.state.tabs[id].lastUsed = Date.now() - 90 * 1000; // 1m30 → TTL de 1 min agotado
      await __tabBomb.sweep();
      return { armed: __tabBomb.state.tabs[id].armed };
    })()`);
    check('la bomba se arma al agotarse el TTL', armed && armed.armed === true, armed);

    await sleep(1500);
    const pages = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
    const pageTarget = pages.find((t) => t.type === 'page' && t.url.includes('/a1'));
    check('la pestaña armada sigue abierta', !!pageTarget);

    if (pageTarget) {
      const pg = new CDP(pageTarget.webSocketDebuggerUrl);
      await pg.connect();
      await pg.send('Runtime.enable');

      const overlay = await pg.eval(`(() => {
        const host = document.getElementById('__tabbomb_overlay__');
        if (!host || !host.shadowRoot) return null;
        const txt = host.shadowRoot.textContent || '';
        const btns = [...host.shadowRoot.querySelectorAll('button')].map(b => b.textContent.trim());
        return { txt, btns };
      })()`);
      check('el cartel aparece dentro de la página', !!overlay, overlay);
      if (overlay) {
        check('el cartel muestra cuenta atrás', /\d:\d\d/.test(overlay.txt), overlay.txt);
        check('el cartel ofrece «Mantener viva»', overlay.btns.some((b) => /Mantener/.test(b)), overlay.btns);

        await pg.eval(`(() => {
          const root = document.getElementById('__tabbomb_overlay__').shadowRoot;
          const btn = [...root.querySelectorAll('button')].find(b => /Mantener/.test(b.textContent));
          btn.click();
          return true;
        })()`);
        await sleep(1200);

        const rescued = await sw.eval(`(async () => {
          await new Promise(r => setTimeout(r, 300));
          return { armed: __tabBomb.state.tabs[${aIds[0]}].armed, rescued: __tabBomb.state.stats.rescued };
        })()`);
        check('«Mantener viva» rescata la pestaña (el mensaje llega al motor)', rescued.rescued >= 1 && rescued.armed === false, rescued);

        const gone = await pg.eval(`!document.getElementById('__tabbomb_overlay__')`);
        check('el cartel desaparece tras rescatar', gone === true, gone);
      }
      pg.ws.close();
    }

    // ---------------------------------------------------------------
    // Escenario C: el popup renderiza con datos reales
    // ---------------------------------------------------------------
    console.log('\n\x1b[1mC. Interfaz del popup\x1b[0m');
    const extId = swTarget.url.split('/')[2];
    await sw.eval(`chrome.tabs.create({ url: 'chrome-extension://${extId}/popup.html', active: false })`);
    await sleep(800);
    const allPages = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
    const popupTarget = allPages.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
    check('el popup se abre', !!popupTarget);

    if (popupTarget) {
      const pu = new CDP(popupTarget.webSocketDebuggerUrl);
      await pu.connect();
      await pu.send('Runtime.enable');
      await pu.send('Log.enable');
      await sleep(1200);
      const ui = await pu.eval(`(() => ({
        rows: document.querySelectorAll('.tab').length,
        subtitle: (document.getElementById('subtitle') || {}).textContent || '',
        ttl: (document.getElementById('ttl') || {}).value,
        stats: (document.getElementById('stats') || {}).textContent || ''
      }))()`);
      check('el popup pinta la lista de pestañas', ui.rows > 0, ui.rows);
      check('el subtítulo cuenta pestañas', /pestaña/i.test(ui.subtitle), ui.subtitle);
      check('los ajustes llegan al popup (TTL = 1 min)', ui.ttl === '1', ui.ttl);
      check('el popup muestra estadísticas', /Cerradas:/.test(ui.stats), ui.stats);

      const errs = pu.events.filter((e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      );
      check('sin errores JS en el popup', errs.length === 0, errs.map((e) => JSON.stringify(e.params).slice(0, 200)));
      pu.ws.close();
    }

    // ---------------------------------------------------------------
    // Escenario B: cierre real
    // ---------------------------------------------------------------
    console.log('\n\x1b[1mB. Cierre real de zombis\x1b[0m');
    const bIds = await sw.eval(`(async () => {
      const out = [];
      for (const n of ['b1','b2','b3']) {
        const t = await chrome.tabs.create({ url: 'http://127.0.0.1:${PORT_HTTP}/' + n, active: false });
        out.push(t.id);
      }
      await new Promise(r => setTimeout(r, 800));
      return out;
    })()`);
    await sw.eval(`__tabBomb.handleMessage({ type: 'settings', patch: { ttlMinutes: 1, graceSeconds: 0, showOverlay: false } }, {})`);

    const before = await sw.eval('(async () => (await chrome.tabs.query({})).length)()');
    const after = await sw.eval(`(async () => {
      const old = Date.now() - 2 * 3600 * 1000;
      for (const id of ${JSON.stringify(bIds)}) {
        if (__tabBomb.state.tabs[id]) __tabBomb.state.tabs[id].lastUsed = old;
      }
      await __tabBomb.sweep();
      await new Promise(r => setTimeout(r, 600));
      return (await chrome.tabs.query({})).map(t => t.id);
    })()`);

    const survivors = bIds.filter((id) => after.includes(id));
    const stats = await sw.eval('JSON.parse(JSON.stringify(__tabBomb.state.stats))');
    check('las 3 pestañas viejas se cierran', survivors.length === 0, survivors);
    check('el contador de cerradas sube', stats.closed >= 3, stats);
    check('quedan pestañas vivas (no arrasa la ventana)', after.length >= 1, after.length);

    console.log('\n  abiertas antes:', before, '· después:', after.length, '· stats:', JSON.stringify(stats));

    const ok = results.every(Boolean);
    console.log(ok ? '\n\x1b[32mE2E OK (' + results.length + ' comprobaciones)\x1b[0m'
                   : '\n\x1b[31mE2E FALLÓ (' + results.filter((x) => !x).length + ' de ' + results.length + ')\x1b[0m');
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.log('\x1b[31mE2E error:\x1b[0m ' + e.message);
    process.exitCode = 1;
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    server.close();
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
}

main();
