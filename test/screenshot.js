#!/usr/bin/env node
'use strict';
/**
 * Genera una captura del popup real (Chromium + extensión cargada) para
 * previsualizar la interfaz:  dist/preview-popup.png
 *
 *   node test/screenshot.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXT = path.join(__dirname, '..', 'dist', 'chrome');
const OUT = path.join(__dirname, '..', 'dist', 'preview-popup.png');
const PORT_CDP = 9334;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'tabbomb-shot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      ws.onerror = () => reject(new Error('ws error'));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: r, reject: j } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) j(new Error(msg.error.message)); else r(msg.result);
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

(async () => {
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--user-data-dir=' + PROFILE,
    '--load-extension=' + EXT, '--disable-extensions-except=' + EXT,
    '--remote-debugging-port=' + PORT_CDP, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    let ok = null;
    for (let i = 0; i < 60; i++) {
      try { ok = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/version`); break; } catch (e) { await sleep(250); }
    }
    if (!ok) throw new Error('CDP no arrancó');

    let swTarget = null;
    for (let i = 0; i < 40; i++) {
      const list = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
      swTarget = list.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url));
      if (swTarget) break;
      await sleep(250);
    }
    if (!swTarget) throw new Error('sin service worker');

    const sw = new CDP(swTarget.webSocketDebuggerUrl);
    await sw.connect();
    await sw.send('Runtime.enable');

    const ids = await sw.eval(`(async () => {
      const urls = [
        'https://news.ycombinator.com/',
        'https://developer.mozilla.org/es/',
        'https://es.wikipedia.org/wiki/Pesta%C3%B1a_(inform%C3%A1tica)',
        'https://www.python.org/'
      ];
      const out = [];
      for (const u of urls) {
        try { const t = await chrome.tabs.create({ url: u, active: false }); out.push(t.id); } catch (e) {}
      }
      await new Promise(r => setTimeout(r, 3500));
      return out;
    })()`);

    // una envejecida (bomba armada), otra con antigüedad media
    await sw.eval(`(async () => {
      const ids = ${JSON.stringify(ids)};
      if (ids.length) {
        __tabBomb.state.tabs[ids[0]].lastUsed = Date.now() - 78 * 60000;  // armada
        __tabBomb.state.tabs[ids[0]].armed = true;
      }
      if (ids.length > 1) __tabBomb.state.tabs[ids[1]].lastUsed = Date.now() - 43 * 60000;
      if (ids.length > 2) { __tabBomb.state.tabs[ids[2]].lastUsed = Date.now() - 12 * 60000; __tabBomb.state.tabs[ids[2]].keep = true; }
      __tabBomb.state.stats.closed = 37;
      __tabBomb.state.stats.discarded = 4;
      __tabBomb.state.stats.rescued = 6;
      return true;
    })()`);

    const extId = swTarget.url.split('/')[2];
    await sw.eval(`chrome.tabs.create({ url: 'chrome-extension://${extId}/popup.html', active: true })`);
    await sleep(900);

    const pages = await getJSON(`http://127.0.0.1:${PORT_CDP}/json/list`);
    const pt = pages.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
    if (!pt) throw new Error('no popup target');

    const pg = new CDP(pt.webSocketDebuggerUrl);
    await pg.connect();
    await pg.send('Runtime.enable');
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 580, deviceScaleFactor: 2, mobile: false });
    await sleep(1500);

    const shot = await pg.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('captura guardada:', OUT, fs.statSync(OUT).size, 'bytes');
  } catch (e) {
    console.log('error:', e.message);
    process.exitCode = 1;
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    await sleep(300);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})();
