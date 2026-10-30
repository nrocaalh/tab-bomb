'use strict';
/**
 * Tab Bomb — mata pestañas zombi.
 *
 * Cada pestaña tiene un TTL (tiempo máximo sin usarse). Al agotarse el TTL
 * se "arma la bomba": cuenta atrás visible (badge + overlay en la página) y,
 * al llegar a cero, la pestaña se cierra (o se suspende).
 *
 * Compatible Chrome / Brave / Edge (MV3 service worker) y Firefox (MV3 event page).
 */

const api = globalThis.browser || globalThis.chrome;

const ALARM_SWEEP = 'tabbomb-sweep';
const STORAGE_KEY = 'state';
const BADGE_BG = '#e11d48';
const BADGE_BG_ARMED = '#e11d48';
const HOST_ID = '__tabbomb_overlay__';
const FAST_TICK_MS = 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  ttlMinutes: 60,           // vida máxima sin usarse
  graceSeconds: 60,         // cuenta atrás de la bomba antes de ejecutar
  mode: 'close',            // 'close' | 'discard'
  ignorePinned: true,
  ignoreAudible: true,      // pestañas con audio (música, vídeo, llamadas)
  ignoreActive: true,       // la pestaña que estás mirando ahora mismo
  ignoreDiscarded: true,    // ya suspendidas: no consumen RAM
  ignoreGrouped: false,     // grupos de pestañas
  keepLastTabInWindow: true,
  whitelist: [],            // dominios que nunca mueren
  showOverlay: true,
  pauseWhenIdle: true,      // no matar nada mientras el equipo está ausente
  returnGraceSeconds: 90,   // margen al volver del idle
  notifyOnArm: false,
  seedFromLastAccessed: false
};

function defaultState() {
  return {
    version: 1,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    tabs: {},
    stats: { closed: 0, discarded: 0, rescued: 0, lastAt: 0, lastTitle: '' },
    pauseUntil: 0,
    installedAt: Date.now()
  };
}

let state = defaultState();
let readyPromise = null;
let fastTimer = null;
let persistTimer = null;

const nowMs = () => Date.now();
const ttlMs = (s) => Math.max(1, Number(s.ttlMinutes) || 1) * 60000;
const graceMs = (s) => Math.max(0, Number(s.graceSeconds) || 0) * 1000;

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

function newRec(ts) {
  return { lastUsed: ts, born: ts, keep: false, snoozeUntil: 0, armed: false, notified: false };
}

function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function init() {
  try {
    const got = await api.storage.local.get(STORAGE_KEY);
    const stored = got && got[STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      const base = defaultState();
      state = {
        version: 1,
        settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings || {}),
        tabs: stored.tabs && typeof stored.tabs === 'object' ? stored.tabs : {},
        stats: Object.assign({}, base.stats, stored.stats || {}),
        pauseUntil: Number(stored.pauseUntil) || 0,
        installedAt: Number(stored.installedAt) || nowMs()
      };
      // normalizar registros viejos / corruptos
      for (const [id, r] of Object.entries(state.tabs)) {
        if (!r || typeof r !== 'object' || !Number.isFinite(r.lastUsed)) state.tabs[id] = newRec(nowMs());
        else if (!Number.isFinite(r.snoozeUntil)) r.snoozeUntil = 0;
      }
    }
  } catch (e) {
    console.warn('[TabBomb] no se pudo leer storage:', e);
  }

  setupAlarms();
  await pruneAndSeed();
  markDirty();
  return state;
}

async function pruneAndSeed() {
  let tabs = [];
  try { tabs = await api.tabs.query({}); } catch (e) { return; }
  const alive = new Set(tabs.map((t) => t.id));
  for (const key of Object.keys(state.tabs)) {
    if (!alive.has(Number(key))) delete state.tabs[key];
  }
  const t = nowMs();
  for (const tab of tabs) {
    if (!state.tabs[tab.id]) state.tabs[tab.id] = newRec(seedFor(tab, t));
  }
}

function seedFor(tab, fallback) {
  if (state.settings.seedFromLastAccessed && Number.isFinite(tab && tab.lastAccessed)) {
    const ts = Number(tab.lastAccessed);
    if (ts > 0 && ts <= fallback) return ts;
  }
  return fallback;
}

function markDirty() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flush();
  }, 1200);
}

async function flush() {
  try {
    await api.storage.local.set({ [STORAGE_KEY]: state });
  } catch (e) {
    console.warn('[TabBomb] no se pudo guardar:', e);
  }
}

/* ------------------------------------------------------------------ */
/* Registro de actividad                                               */
/* ------------------------------------------------------------------ */

function recFor(tabId, ts) {
  let r = state.tabs[tabId];
  if (!r || typeof r !== 'object') {
    r = state.tabs[tabId] = newRec(ts);
  }
  return r;
}

function touch(tabId, reason) {
  if (tabId == null || tabId < 0) return;
  const t = nowMs();
  const r = recFor(tabId, t);
  const wasArmed = r.armed;
  r.lastUsed = t;
  r.armed = false;
  r.notified = false;
  markDirty();
  if (wasArmed) {
    clearBadge(tabId);
    disarmOverlay(tabId);
    ensureFastTimer();
  }
}

function deadlineOf(r, s) {
  const base = Math.max(Number(r.lastUsed) || 0, Number(r.snoozeUntil) || 0);
  const armAt = base + ttlMs(s);
  return { base, armAt, killAt: armAt + graceMs(s) };
}

/* ------------------------------------------------------------------ */
/* Protecciones                                                        */
/* ------------------------------------------------------------------ */

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

function inWhitelist(url, list) {
  if (!Array.isArray(list) || !list.length) return false;
  const host = hostOf(url);
  if (!host) return false;
  return list.some((raw) => {
    const entry = String(raw || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '')
      .replace(/^\./, '');
    if (!entry) return false;
    return host === entry || host.endsWith('.' + entry);
  });
}

function skipReason(tab, r, s, windowCounts) {
  if (r && r.keep) return 'keep';
  if (s.ignorePinned && tab.pinned) return 'pinned';
  if (s.ignoreAudible && tab.audible) return 'audible';
  if (s.ignoreActive && tab.active) return 'active';
  if (s.ignoreDiscarded && tab.discarded) return 'discarded';
  if (s.ignoreGrouped && Number.isFinite(tab.groupId) && tab.groupId >= 0) return 'grouped';

  const url = tab.url || tab.pendingUrl || '';
  // Solo tocamos páginas web reales: nunca chrome://, about:, extensiones, PDF viewer interno, etc.
  if (!/^https?:\/\//i.test(url)) return 'internal';
  if (inWhitelist(url, s.whitelist)) return 'whitelist';
  if (s.keepLastTabInWindow && (windowCounts[tab.windowId] || 0) <= 1) return 'last-in-window';
  return null;
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

function setBadge(tabId, seconds) {
  try {
    const text = seconds >= 60 ? Math.ceil(seconds / 60) + 'm' : String(Math.max(0, seconds)) + 's';
    api.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG_ARMED });
    if (api.action.setBadgeTextColor) api.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    api.action.setBadgeText({ tabId, text });
    api.action.setTitle({ tabId, title: 'Tab Bomb — se cerrará en ' + text });
  } catch (e) { /* pestaña ya cerrada */ }
}

function clearBadge(tabId) {
  try {
    api.action.setBadgeText({ tabId, text: '' });
    api.action.setTitle({ tabId, title: 'Tab Bomb' });
  } catch (e) { /* noop */ }
}

function clearAllBadges(tabs) {
  for (const tab of tabs || []) clearBadge(tab.id);
}

/* ------------------------------------------------------------------ */
/* Overlay en la página                                                */
/* ------------------------------------------------------------------ */

function disarmOverlay(tabId) {
  try {
    const p = api.tabs.sendMessage(tabId, { type: 'tabbomb:disarm' });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* no hay content script en esa pestaña */ }
}

async function injectOverlay(tabId, killAt) {
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: tabBombOverlay,
      args: [killAt]
    });
  } catch (e) { /* chrome://, web store, PDFs... sin inyección posible */ }
}

/* Esta función se serializa y se ejecuta DENTRO de la página (mundo aislado).
   No puede usar nada del scope de background.js. */
function tabBombOverlay(killAt) {
  try {
    var HID = '__tabbomb_overlay__';
    var prev = document.getElementById(HID);
    if (prev) {
      if (typeof prev.__tbUpdate === 'function') { prev.__tbUpdate(killAt); return; }
      prev.remove();
    }
    if (!document.body) return;

    var host = document.createElement('div');
    host.id = HID;
    host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var card = document.createElement('div');
    card.style.cssText = [
      'box-sizing: border-box',
      'width: 236px',
      'padding: 12px 14px',
      'border-radius: 14px',
      'background: #16131a',
      'border: 1px solid #3a2b33',
      'box-shadow: 0 10px 30px rgba(0,0,0,.45)',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
      'color: #fff',
      'user-select: none'
    ].join(';');

    var top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';

    var label = document.createElement('div');
    label.textContent = '💣 Pestaña zombi';
    label.style.cssText = 'font-size:12px;font-weight:600;color:#fecdd3;letter-spacing:.2px';

    var close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Ocultar aviso (la bomba sigue activa)';
    close.style.cssText = 'all:unset;cursor:pointer;color:#9ca3af;font-size:12px;line-height:1;padding:2px 4px;border-radius:6px';

    top.appendChild(label);
    top.appendChild(close);

    var time = document.createElement('div');
    time.style.cssText = 'font-family: ui-monospace, SFMono-Regular, Menlo, monospace;font-size:28px;font-weight:700;letter-spacing:1px;margin:2px 0 0';

    var sub = document.createElement('div');
    sub.textContent = 'se cerrará automáticamente';
    sub.style.cssText = 'font-size:11px;color:#9ca3af;margin-bottom:10px';

    var save = document.createElement('button');
    save.textContent = '🛟 Mantener viva';
    save.style.cssText = [
      'display:block', 'width:100%', 'cursor:pointer', 'border:0', 'border-radius:9px',
      'padding:8px 10px', 'font-size:12px', 'font-weight:600',
      'background:#e11d48', 'color:#fff'
    ].join(';');

    card.appendChild(top);
    card.appendChild(time);
    card.appendChild(sub);
    card.appendChild(save);
    root.appendChild(card);
    document.documentElement.appendChild(host);

    function remove() { try { host.remove(); } catch (e) {} }

    function paint() {
      var left = Math.max(0, Math.ceil((killAt - Date.now()) / 1000));
      var m = Math.floor(left / 60);
      var s = left % 60;
      time.textContent = left > 0 ? (m + ':' + String(s).padStart(2, '0')) : '0:00';
      time.style.color = left <= 10 ? '#f87171' : '#fff';
    }

    host.__tbUpdate = function (next) { killAt = next; paint(); };
    paint();
    var iv = setInterval(paint, 500);

    close.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      clearInterval(iv);
      remove();
    }, true);

    save.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'keep' });
      } catch (e) {
        try { browser.runtime.sendMessage({ type: 'keep' }); } catch (e2) {}
      }
      clearInterval(iv);
      remove();
    }, true);

    if (!globalThis.__tabbombDisarmHooked) {
      globalThis.__tabbombDisarmHooked = true;
      try {
        chrome.runtime.onMessage.addListener(function (msg) {
          if (msg && msg.type === 'tabbomb:disarm') {
            var el = document.getElementById(HID);
            if (el) el.remove();
          }
        });
      } catch (e) {}
    }
  } catch (e) { /* nunca romper la página del usuario */ }
}

/* ------------------------------------------------------------------ */
/* Motor                                                               */
/* ------------------------------------------------------------------ */

async function shouldPause() {
  if (!state.settings.pauseWhenIdle) return false;
  if (nowMs() < (Number(state.pauseUntil) || 0)) return true;
  if (api.idle && api.idle.queryState) {
    try {
      const st = await api.idle.queryState(120);
      if (st && st !== 'active') return true;
    } catch (e) { /* sin permiso idle */ }
  }
  return false;
}

async function sweep(opts) {
  const force = !!(opts && opts.force);
  await ensureReady();
  const s = state.settings;
  const t = nowMs();

  let tabs = [];
  try { tabs = await api.tabs.query({}); } catch (e) { return { closed: 0 }; }

  // limpiar registros de pestañas que ya no existen
  const alive = new Set(tabs.map((x) => x.id));
  for (const key of Object.keys(state.tabs)) {
    if (!alive.has(Number(key))) delete state.tabs[key];
  }

  if (!s.enabled) {
    clearAllBadges(tabs);
    for (const r of Object.values(state.tabs)) r.armed = false;
    ensureFastTimer();
    return { closed: 0 };
  }

  const paused = await shouldPause();
  const windowCounts = {};
  for (const tab of tabs) windowCounts[tab.windowId] = (windowCounts[tab.windowId] || 0) + 1;

  let closed = 0;
  for (const tab of tabs) {
    const r = recFor(tab.id, t);
    const reason = skipReason(tab, r, s, windowCounts);

    if (reason) {
      if (r.armed) {
        r.armed = false;
        clearBadge(tab.id);
        disarmOverlay(tab.id);
      }
      continue;
    }

    const d = deadlineOf(r, s);

    if (!paused && t >= (force ? d.armAt : d.killAt)) {
      await execute(tab, s);
      closed += 1;
      continue;
    }

    if (!paused && t >= d.armAt) {
      const remain = Math.max(1, Math.ceil((d.killAt - t) / 1000));
      r.armed = true;
      setBadge(tab.id, remain);
      if (s.showOverlay) injectOverlay(tab.id, d.killAt);
      if (s.notifyOnArm && !r.notified) {
        r.notified = true;
        notify(tab, remain);
      }
    } else if (r.armed) {
      r.armed = false;
      clearBadge(tab.id);
      disarmOverlay(tab.id);
    }
  }

  markDirty();
  ensureFastTimer();
  return { closed };
}

async function execute(tab, s) {
  try {
    if (s.mode === 'discard') {
      await api.tabs.discard(tab.id);
      state.stats.discarded += 1;
      const r = state.tabs[tab.id];
      if (r) { r.lastUsed = nowMs(); r.armed = false; r.notified = false; }
    } else {
      await api.tabs.remove(tab.id);
      state.stats.closed += 1;
      delete state.tabs[tab.id];
    }
    state.stats.lastAt = nowMs();
    state.stats.lastTitle = tab.title || hostOf(tab.url || '') || '(pestaña)';
  } catch (e) {
    // la pestaña ya no existe o no se puede cerrar
    delete state.tabs[tab.id];
  }
  clearBadge(tab.id);
  disarmOverlay(tab.id);
}

function notify(tab, seconds) {
  if (!api.notifications || !api.notifications.create) return;
  try {
    const mins = Math.max(1, Math.round(seconds / 60));
    api.notifications.create('tabbomb-' + tab.id, {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: '💣 Bomba activada',
      message: '«' + (tab.title || 'Pestaña') + '» se cerrará en ' + mins + ' min si no la usas.'
    });
  } catch (e) { /* noop */ }
}

function ensureFastTimer() {
  const anyArmed = Object.values(state.tabs).some((r) => r && r.armed);
  if (anyArmed && !fastTimer) {
    fastTimer = setInterval(() => { sweep().catch(() => {}); }, FAST_TICK_MS);
  } else if (!anyArmed && fastTimer) {
    clearInterval(fastTimer);
    fastTimer = null;
  }
}

function setupAlarms() {
  try {
    api.alarms.create(ALARM_SWEEP, { delayInMinutes: 0.5, periodInMinutes: 1 });
  } catch (e) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* Payload para el popup                                               */
/* ------------------------------------------------------------------ */

async function buildPayload() {
  await ensureReady();
  const s = state.settings;
  const t = nowMs();
  let tabs = [];
  try { tabs = await api.tabs.query({}); } catch (e) { return { settings: s, stats: state.stats, tabs: [], paused: false }; }

  const windowCounts = {};
  for (const tab of tabs) windowCounts[tab.windowId] = (windowCounts[tab.windowId] || 0) + 1;
  const paused = await shouldPause();

  const rows = tabs.map((tab) => {
    const r = recFor(tab.id, t);
    const d = deadlineOf(r, s);
    const reason = skipReason(tab, r, s, windowCounts);
    return {
      id: tab.id,
      windowId: tab.windowId,
      title: tab.title || tab.url || '(sin título)',
      host: hostOf(tab.url || ''),
      url: tab.url || '',
      favIconUrl: tab.favIconUrl || '',
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      discarded: !!tab.discarded,
      keep: !!r.keep,
      snoozeUntil: Number(r.snoozeUntil) || 0,
      armed: !!r.armed,
      ageMs: Math.max(0, t - (Number(r.lastUsed) || t)),
      armInMs: d.armAt - t,
      killInMs: d.killAt - t,
      protect: reason
    };
  });

  rows.sort((a, b) => {
    const pa = a.protect ? 1 : 0;
    const pb = b.protect ? 1 : 0;
    if (pa !== pb) return pa - pb;              // primero las que van a morir
    return b.ageMs - a.ageMs;                    // y entre ellas, las más viejas
  });

  return {
    settings: s,
    stats: state.stats,
    paused,
    pauseUntil: Number(state.pauseUntil) || 0,
    total: tabs.length,
    zombies: rows.filter((x) => !x.protect && x.ageMs >= ttlMs(s)).length,
    tabs: rows,
    version: (api.runtime.getManifest && api.runtime.getManifest().version) || '1.0.0'
  };
}

/* ------------------------------------------------------------------ */
/* Mensajes                                                            */
/* ------------------------------------------------------------------ */

async function handleMessage(msg, sender) {
  await ensureReady();
  const s = state.settings;

  switch (msg && msg.type) {
    case 'getState':
      return await buildPayload();

    case 'settings': {
      const patch = msg.patch || {};
      for (const [k, raw] of Object.entries(patch)) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        let v = raw;
        if (k === 'ttlMinutes') v = Math.min(2880, Math.max(1, Number(v) || 1));
        else if (k === 'graceSeconds') v = Math.min(600, Math.max(0, Number(v) || 0));
        else if (k === 'returnGraceSeconds') v = Math.min(3600, Math.max(0, Number(v) || 0));
        else if (k === 'whitelist') v = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
        else if (k === 'mode') v = v === 'discard' ? 'discard' : 'close';
        else v = !!v;
        state.settings[k] = v;
      }
      await flush();
      sweep();
      return await buildPayload();
    }

    case 'keep': {
      const id = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      const r = recFor(id, nowMs());
      if (r.armed) state.stats.rescued = (state.stats.rescued || 0) + 1;
      r.keep = true;
      r.armed = false;
      clearBadge(id);
      disarmOverlay(id);
      ensureFastTimer();
      markDirty();
      return await buildPayload();
    }

    case 'unkeep': {
      const r = recFor(msg.tabId, nowMs());
      r.keep = false;
      r.lastUsed = nowMs();
      markDirty();
      return await buildPayload();
    }

    case 'rescue': {
      const id = msg.tabId != null ? msg.tabId : (sender && sender.tab && sender.tab.id);
      const r = recFor(id, nowMs());
      r.lastUsed = nowMs();
      r.snoozeUntil = 0;
      r.armed = false;
      r.notified = false;
      state.stats.rescued = (state.stats.rescued || 0) + 1;
      clearBadge(id);
      disarmOverlay(id);
      ensureFastTimer();
      markDirty();
      return await buildPayload();
    }

    case 'snooze': {
      const minutes = Math.min(720, Math.max(1, Number(msg.minutes) || 15));
      const r = recFor(msg.tabId, nowMs());
      r.snoozeUntil = nowMs() + minutes * 60000;
      r.armed = false;
      r.notified = false;
      clearBadge(msg.tabId);
      disarmOverlay(msg.tabId);
      ensureFastTimer();
      markDirty();
      return await buildPayload();
    }

    case 'closeNow': {
      try { await api.tabs.remove(msg.tabId); state.stats.closed += 1; } catch (e) {}
      delete state.tabs[msg.tabId];
      markDirty();
      return await buildPayload();
    }

    case 'sweepNow': {
      await sweep({ force: true });
      return await buildPayload();
    }

    case 'resetTab': {
      const r = recFor(msg.tabId, nowMs());
      r.lastUsed = nowMs();
      r.snoozeUntil = 0;
      r.armed = false;
      r.notified = false;
      clearBadge(msg.tabId);
      disarmOverlay(msg.tabId);
      ensureFastTimer();
      markDirty();
      return await buildPayload();
    }

    default:
      return { ok: false, error: 'tipo desconocido' };
  }
}

/* ------------------------------------------------------------------ */
/* Listeners (deben registrarse de forma síncrona)                     */
/* ------------------------------------------------------------------ */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then((res) => sendResponse(res))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // respuesta asíncrona
});

api.tabs.onCreated.addListener((tab) => {
  ensureReady().then(() => {
    if (!state.tabs[tab.id]) state.tabs[tab.id] = newRec(nowMs());
    markDirty();
  }).catch(() => {});
});

api.tabs.onActivated.addListener((info) => {
  ensureReady().then(() => touch(info.tabId, 'activated')).catch(() => {});
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  ensureReady().then(() => {
    // solo navegación real: evita que un autorefresco en segundo plano resetee el TTL
    if (changeInfo && changeInfo.url) touch(tabId, 'navigated');
  }).catch(() => {});
});

api.tabs.onRemoved.addListener((tabId) => {
  ensureReady().then(() => {
    if (state.tabs[tabId]) { delete state.tabs[tabId]; markDirty(); }
    clearBadge(tabId);
  }).catch(() => {});
});

if (api.windows && api.windows.onFocusChanged) {
  api.windows.onFocusChanged.addListener((windowId) => {
    ensureReady().then(async () => {
      if (windowId === api.windows.WINDOW_ID_NONE) return;
      try {
        const [tab] = await api.tabs.query({ active: true, windowId });
        if (tab) touch(tab.id, 'focus');
      } catch (e) {}
    }).catch(() => {});
  });
}

if (api.idle && api.idle.onStateChanged) {
  api.idle.onStateChanged.addListener((st) => {
    ensureReady().then(() => {
      if (st === 'active') {
        // Al volver, las que ya caducaron reciben su cuenta atrás final en vez de morir en silencio.
        const t = nowMs();
        const s = state.settings;
        const total = ttlMs(s) + graceMs(s);
        for (const r of Object.values(state.tabs)) {
          const d = deadlineOf(r, s);
          if (t >= d.killAt) {
            r.lastUsed = t - total + graceMs(s); // armAt = ahora → arranca la bomba
            r.armed = false;
            r.notified = false;
          }
        }
        state.pauseUntil = t + Math.max(0, Number(s.returnGraceSeconds) || 0) * 1000;
        markDirty();
      }
      sweep().catch(() => {});
    }).catch(() => {});
  });
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_SWEEP) sweep().catch(() => {});
});

api.runtime.onInstalled.addListener(() => {
  ensureReady().then(() => {
    setupAlarms();
    createMenus();
    sweep();
  }).catch(() => {});
});

api.runtime.onStartup.addListener(() => {
  readyPromise = null; // releer estado del disco
  ensureReady().then(() => sweep()).catch(() => {});
});

if (api.runtime.onSuspend) {
  api.runtime.onSuspend.addListener(() => { flush(); });
}

/* ------------------------------------------------------------------ */
/* Menú contextual                                                     */
/* ------------------------------------------------------------------ */

function createMenus() {
  if (!api.contextMenus || !api.contextMenus.create) return;
  try {
    if (api.contextMenus.removeAll) {
      const p = api.contextMenus.removeAll();
      if (p && p.catch) p.catch(() => {});
    }
    api.contextMenus.create({ id: 'tb-keep', title: '🛟 Tab Bomb: mantener esta pestaña', contexts: ['tab'] });
    api.contextMenus.create({ id: 'tb-close', title: '💣 Tab Bomb: cerrar esta pestaña ahora', contexts: ['tab'] });
  } catch (e) { /* noop */ }
}

if (api.contextMenus && api.contextMenus.onClicked) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    ensureReady().then(async () => {
      if (!tab) return;
      if (info.menuItemId === 'tb-keep') {
        const r = recFor(tab.id, nowMs());
        r.keep = true;
        r.armed = false;
        clearBadge(tab.id);
        disarmOverlay(tab.id);
        markDirty();
        ensureFastTimer();
      } else if (info.menuItemId === 'tb-close') {
        try { await api.tabs.remove(tab.id); state.stats.closed += 1; } catch (e) {}
        delete state.tabs[tab.id];
        markDirty();
      }
    }).catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */
createMenus();
ensureReady().then(() => {
  try {
    console.info('[Tab Bomb] listo v' + ((api.runtime.getManifest && api.runtime.getManifest().version) || '?') +
      ' · pestañas vigiladas: ' + Object.keys(state.tabs).length);
  } catch (e) { /* noop */ }
  ensureFastTimer();
  sweep().catch(() => {});
}).catch(() => {});

// Export para tests (inofensivo en producción)
globalThis.__tabBomb = {
  get state() { return state; },
  sweep,
  buildPayload,
  handleMessage,
  touch,
  deadlineOf,
  ensureReady,
  DEFAULT_SETTINGS
};
