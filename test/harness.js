#!/usr/bin/env node
'use strict';
/**
 * Banco de pruebas de Tab Bomb.
 *
 * Carga background.js en un sandbox `vm` con una implementación falsa de la API
 * de extensiones (chrome/browser), un reloj controlable y pestañas simuladas.
 * Verifica el motor de TTL/bomba de verdad: no hay mocks de la lógica, solo del
 * navegador.
 *
 *   node test/harness.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src', 'background.js');
const CODE = fs.readFileSync(SRC, 'utf8');

const MIN = 60000;

/* ------------------------------------------------------------------ */
/* Entorno falso                                                       */
/* ------------------------------------------------------------------ */

function createEnv(opts = {}) {
  let clock = 1700000000000;
  let seq = 1;
  const timeouts = [];
  const intervals = new Map();
  const listeners = {};
  const tabs = new Map();
  const store = {};
  if (opts.stored) store.state = JSON.parse(JSON.stringify(opts.stored));

  const log = { removed: [], discarded: [], badges: new Map(), injected: [], notifications: [], menus: [] };

  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }
  async function fire(name, ...args) {
    const fns = listeners[name] || [];
    const out = [];
    for (const fn of fns) out.push(await fn(...args));
    return out;
  }

  const tabList = () => Array.from(tabs.values()).map((t) => ({ ...t }));

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => on('runtime.onMessage', fn) },
      onInstalled: { addListener: (fn) => on('runtime.onInstalled', fn) },
      onStartup: { addListener: (fn) => on('runtime.onStartup', fn) },
      onSuspend: { addListener: (fn) => on('runtime.onSuspend', fn) },
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'chrome-extension://fake/' + p,
      sendMessage: async (msg) => {
        // los mensajes que el background manda al popup no se usan en tests
        return { ok: true, msg };
      },
      lastError: null
    },
    tabs: {
      query: async (q) => {
        let list = tabList();
        if (q && typeof q === 'object') {
          if (q.active) list = list.filter((t) => t.active);
          if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        }
        return list;
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
        return { ...tabs.get(id) };
      },
      remove: async (id) => {
        log.removed.push(id);
        tabs.delete(id);
        for (const fn of (listeners['tabs.onRemoved'] || [])) {
          try { fn(id, { windowId: 1, isWindowClosing: false }); } catch (e) {}
        }
      },
      discard: async (id) => {
        log.discarded.push(id);
        const t = tabs.get(id);
        if (t) t.discarded = true;
      },
      update: async (id, props) => Object.assign(tabs.get(id) || {}, props),
      sendMessage: async (id, msg) => {
        if (!tabs.has(id)) throw new Error('no tab');
        return { ok: true };
      },
      onCreated: { addListener: (fn) => on('tabs.onCreated', fn) },
      onActivated: { addListener: (fn) => on('tabs.onActivated', fn) },
      onUpdated: { addListener: (fn) => on('tabs.onUpdated', fn) },
      onRemoved: { addListener: (fn) => on('tabs.onRemoved', fn) }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener: (fn) => on('windows.onFocusChanged', fn) }
    },
    action: {
      setBadgeText: (o) => { log.badges.set(o.tabId, o.text); },
      setBadgeBackgroundColor: () => {},
      setBadgeTextColor: () => {},
      setTitle: () => {}
    },
    alarms: {
      create: () => {},
      clear: async () => {},
      onAlarm: { addListener: (fn) => on('alarms.onAlarm', fn) }
    },
    storage: {
      local: {
        get: async (key) => {
          if (key == null) return JSON.parse(JSON.stringify(store));
          if (typeof key === 'string') return key in store ? { [key]: JSON.parse(JSON.stringify(store[key])) } : {};
          const out = {};
          for (const k of key) if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
          return out;
        },
        set: async (obj) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); }
      }
    },
    scripting: {
      executeScript: async (o) => { log.injected.push(o.target.tabId); }
    },
    idle: {
      queryState: async () => 'active',
      onStateChanged: { addListener: (fn) => on('idle.onStateChanged', fn) }
    },
    contextMenus: {
      create: (o) => log.menus.push(o.id),
      removeAll: async () => {},
      onClicked: { addListener: (fn) => on('contextMenus.onClicked', fn) }
    },
    notifications: {
      create: (id, o) => log.notifications.push({ id, ...o })
    }
  };

  const sandbox = {
    chrome,
    console,
    URL,
    Date: { now: () => clock },
    setTimeout: (fn, ms) => {
      const id = seq++;
      timeouts.push({ id, at: clock + (ms || 0), fn });
      return id;
    },
    clearTimeout: (id) => {
      const i = timeouts.findIndex((t) => t.id === id);
      if (i >= 0) timeouts.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      const id = seq++;
      intervals.set(id, { fn, ms: ms || 1000, next: clock + (ms || 1000) });
      return id;
    },
    clearInterval: (id) => { intervals.delete(id); },
    queueMicrotask
  };

  vm.createContext(sandbox);

  const env = {
    sandbox,
    log,
    store,
    chrome,
    get clock() { return clock; },
    set clock(v) { clock = v; },
    get intervals() { return intervals.size; },

    async load() {
      vm.runInContext(CODE, sandbox, { filename: 'background.js' });
      await env.settle();
    },

    async settle(n = 12) {
      for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    },

    addTab(props) {
      const id = props.id != null ? props.id : seq++;
      const tab = {
        id,
        windowId: 1,
        url: 'https://example.com/' + id,
        pendingUrl: undefined,
        title: 'Tab ' + id,
        active: false,
        pinned: false,
        audible: false,
        discarded: false,
        groupId: -1,
        favIconUrl: '',
        ...props
      };
      tabs.set(id, tab);
      return tab;
    },

    async fire(name, ...args) {
      await fire(name, ...args);
      await env.settle();
    },

    async send(msg, sender = {}) {
      const fns = listeners['runtime.onMessage'] || [];
      let out;
      await new Promise((resolve) => {
        let done = false;
        const sendResponse = (r) => { done = true; out = r; resolve(); };
        for (const fn of fns) {
          try { fn(msg, sender, sendResponse); } catch (e) { resolve(); }
        }
        setTimeoutHost(resolve, 50);
      });
      await env.settle();
      return out;
    },

    advance(ms) {
      const target = clock + ms;
      // ejecuta los setTimeout que vencen en el intervalo (persistencia, etc.)
      for (;;) {
        timeouts.sort((a, b) => a.at - b.at);
        const due = timeouts[0];
        if (!due || due.at > target) break;
        timeouts.shift();
        clock = Math.max(clock, due.at);
        try { due.fn(); } catch (e) { /* noop */ }
      }
      clock = target;
    },

    async sweep() {
      await sandbox.__tabBomb.sweep();
      await env.settle(6);
    },

    async hook() {
      return sandbox.__tabBomb;
    },

    snapshot() {
      return JSON.parse(JSON.stringify(sandbox.__tabBomb.state));
    }
  };

  // setTimeout real (fuera del reloj falso) para el mensaje
  function setTimeoutHost(fn, ms) { return setTimeout(fn, ms); }

  return env;
}

/* ------------------------------------------------------------------ */
/* Mini framework de asserts                                           */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } else {
    failures.push(name);
    console.log('  \x1b[31m✗\x1b[0m ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}

async function test(name, fn) {
  console.log('\n\x1b[1m' + name + '\x1b[0m');
  try {
    await fn();
  } catch (e) {
    failures.push(name + ' (excepción)');
    console.log('  \x1b[31m✗ excepción:\x1b[0m ' + (e && e.stack || e));
  }
}

/* ------------------------------------------------------------------ */
/* Casos                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  await test('1. No cierra antes del TTL y sí cierra después de la bomba', async () => {
    const env = createEnv();
    env.addTab({ id: 1 });
    env.addTab({ id: 2 });
    await env.load();

    await env.advance(58 * MIN);
    await env.sweep();
    check('a los 58 min no ha cerrado nada', env.log.removed.length === 0, env.log.removed);
    check('sin bomba armada', env.snapshot().tabs[1].armed === false);

    await env.advance(2 * MIN + 20 * 1000); // 60:20 → TTL (60 min) agotado, bomba armada (gracia 60s)
    await env.sweep();
    check('a los 60:20 la bomba está armada', env.snapshot().tabs[1].armed === true);
    check('badge con cuenta atrás', /^\d+s$/.test(env.log.badges.get(1) || ''), env.log.badges.get(1));
    check('overlay inyectado', env.log.injected.includes(1));
    check('todavía no ha cerrado', env.log.removed.length === 0, env.log.removed);
    check('timer rápido activo mientras hay bomba', env.intervals === 1, env.intervals);

    await env.advance(50 * 1000); // pasa la cuenta atrás
    await env.sweep();
    check('cierra al llegar a cero', env.log.removed.includes(1) && env.log.removed.includes(2), env.log.removed);
    check('badge limpiado', !env.log.badges.get(1) || env.log.badges.get(1) === '');
    check('timer rápido parado', env.intervals === 0, env.intervals);
  });

  await test('2. Protecciones: fijada, con audio, activa, interna, última de ventana', async () => {
    const env = createEnv();
    env.addTab({ id: 10, pinned: true });
    env.addTab({ id: 11, audible: true });
    env.addTab({ id: 12, active: true });
    env.addTab({ id: 13, url: 'chrome://settings' });
    env.addTab({ id: 14, windowId: 2 });          // única de su ventana
    env.addTab({ id: 15 });                        // esta sí debe morir
    await env.load();

    await env.advance(3 * 60 * MIN);
    await env.sweep();

    check('pestaña fijada sobrevive', !env.log.removed.includes(10));
    check('pestaña con audio sobrevive', !env.log.removed.includes(11));
    check('pestaña activa sobrevive', !env.log.removed.includes(12));
    check('página interna sobrevive', !env.log.removed.includes(13));
    check('única de su ventana sobrevive', !env.log.removed.includes(14));
    check('la normal muere', env.log.removed.includes(15), env.log.removed);
  });

  await test('3. Lista blanca por dominio (incluye subdominios)', async () => {
    const env = createEnv();
    env.addTab({ id: 20, url: 'https://mail.google.com/mail/u/0' });
    env.addTab({ id: 21, url: 'https://evil-google.com/' });
    await env.load();

    await env.send({ type: 'settings', patch: { whitelist: 'google.com, github.com' } });
    await env.advance(5 * 60 * MIN);
    await env.sweep();

    check('subdominio en lista blanca sobrevive', !env.log.removed.includes(20));
    check('dominio parecido NO está protegido', env.log.removed.includes(21), env.log.removed);
  });

  await test('4. Mensajes: keep, rescue y snooze', async () => {
    const env = createEnv();
    env.addTab({ id: 30 });
    env.addTab({ id: 31 });
    env.addTab({ id: 32 });
    await env.load();

    await env.send({ type: 'keep', tabId: 30 });
    await env.send({ type: 'snooze', tabId: 31, minutes: 15 });
    await env.send({ type: 'rescue', tabId: 32 });

    const st = env.snapshot();
    check('keep marca la pestaña', st.tabs[30].keep === true);
    check('snooze fija vencimiento futuro', st.tabs[31].snoozeUntil > st.tabs[31].lastUsed);
    check('rescue suma al contador', st.stats.rescued === 1, st.stats);

    await env.advance(61 * MIN + 30000);
    await env.sweep();
    check('la pestaña con keep sigue viva', !env.log.removed.includes(30));
    check('la rescatada muere a su TTL', env.log.removed.includes(32), env.log.removed);
    check('la pospuesta sigue viva', !env.log.removed.includes(31));

    await env.advance(15 * MIN);
    await env.sweep();
    check('la pospuesta muere al acabar su prórroga', env.log.removed.includes(31), env.log.removed);
  });

  await test('5. Usar la pestaña resetea el TTL (onActivated)', async () => {
    const env = createEnv();
    env.addTab({ id: 40 });
    env.addTab({ id: 41 });
    await env.load();

    await env.advance(55 * MIN);
    await env.fire('tabs.onActivated', { tabId: 40, windowId: 1 });
    await env.advance(10 * MIN); // 65 min desde el inicio, 10 desde el uso
    await env.sweep();

    check('la usada recientemente sobrevive', !env.log.removed.includes(40));
    check('la olvidada muere', env.log.removed.includes(41), env.log.removed);
  });

  await test('6. Modo suspender (discard) en vez de cerrar', async () => {
    const env = createEnv();
    env.addTab({ id: 50 });
    env.addTab({ id: 51 });
    await env.load();
    await env.send({ type: 'settings', patch: { mode: 'discard', ttlMinutes: 10, graceSeconds: 0 } });

    await env.advance(11 * MIN);
    await env.sweep();

    check('llama a discard', env.log.discarded.includes(50), env.log.discarded);
    check('no cierra la pestaña', env.log.removed.length === 0, env.log.removed);
    check('suma en stats.discarded', env.snapshot().stats.discarded >= 1, env.snapshot().stats);
  });

  await test('7. Interruptor general apagado', async () => {
    const env = createEnv();
    env.addTab({ id: 60 });
    await env.load();
    await env.send({ type: 'settings', patch: { enabled: false } });

    await env.advance(10 * 60 * MIN);
    await env.sweep();

    check('no cierra nada con la extensión apagada', env.log.removed.length === 0);
    check('sin bombas armadas', env.snapshot().tabs[60].armed === false);
  });

  await test('8. El aviso de la bomba se desarma al usar la pestaña', async () => {
    const env = createEnv();
    env.addTab({ id: 70 });
    env.addTab({ id: 71 });
    await env.load();

    await env.advance(60 * MIN + 20 * 1000);
    await env.sweep();
    check('armada', env.snapshot().tabs[70].armed === true);

    await env.fire('tabs.onActivated', { tabId: 70, windowId: 1 });
    check('desarmada tras activarla', env.snapshot().tabs[70].armed === false);
    check('badge vacío', (env.log.badges.get(70) || '') === '', env.log.badges.get(70));

    await env.advance(30 * 1000); // la cuenta atrás antigua ya habría vencido
    await env.sweep();
    check('no muere tras desarmar', env.log.removed.length === 0, env.log.removed);
  });

  await test('9. Persistencia entre reinicios del service worker', async () => {
    const env = createEnv();
    env.addTab({ id: 80 });
    env.addTab({ id: 81 });
    await env.load();
    await env.advance(30 * MIN);
    await env.sweep();
    await env.advance(3 * 1000); // deja que salte el guardado diferido

    const stored = env.store.state;
    check('el estado se guardó en storage', !!stored && !!stored.tabs[80], Object.keys(env.store));

    const env2 = createEnv({ stored });
    env2.clock = env.clock;
    env2.addTab({ id: 80 });
    env2.addTab({ id: 81 });
    await env2.load();

    await env2.advance(30 * MIN + 30 * 1000); // 60:30 en total desde el último uso original
    await env2.sweep();
    check('tras reiniciar mantiene el TTL (bomba armada)', env2.snapshot().tabs[80].armed === true, env2.snapshot().tabs[80]);
    await env2.advance(61 * 1000);
    await env2.sweep();
    check('y muere a su hora', env2.log.removed.includes(80), env2.log.removed);
  });

  await test('10. Payload del popup (orden, zombies y protecciones)', async () => {
    const env = createEnv();
    env.addTab({ id: 90, title: 'Vieja', active: false });
    env.addTab({ id: 91, title: 'Nueva', active: true });
    await env.load();

    await env.advance(40 * MIN);
    await env.fire('tabs.onActivated', { tabId: 91, windowId: 1 });
    await env.advance(20 * MIN + 30 * 1000); // 60:30: la vieja pasó su TTL, la activa no
    await env.sweep();

    const payload = await env.sandbox.__tabBomb.buildPayload();
    check('total correcto', payload.total === 2, payload.total);
    check('la pestaña activa va protegida', payload.tabs.find((t) => t.id === 91).protect === 'active');
    check('la vieja aparece primero', payload.tabs[0].id === 90, payload.tabs.map((t) => t.id));
    check('la vieja ya es zombi', payload.zombies === 1, payload.zombies);
    check('settings viajan en el payload', payload.settings.ttlMinutes === 60);
  });

  await test('11. Higiene: al cerrar una pestaña se borra su registro', async () => {
    const env = createEnv();
    env.addTab({ id: 100 });
    await env.load();
    await env.fire('tabs.onRemoved', 100, { windowId: 1, isWindowClosing: false });
    check('registro eliminado', env.snapshot().tabs[100] === undefined, env.snapshot().tabs);

    // pestañas nuevas se registran solas
    env.addTab({ id: 101 });
    await env.fire('tabs.onCreated', { id: 101 });
    check('pestaña nueva registrada', !!env.snapshot().tabs[101]);
  });

  /* resumen */
  console.log('\n' + '─'.repeat(52));
  if (failures.length) {
    console.log('\x1b[31m' + failures.length + ' fallo(s)\x1b[0m · ' + passed + ' ok');
    process.exit(1);
  }
  console.log('\x1b[32mTodo verde:\x1b[0m ' + passed + ' comprobaciones');
})();
