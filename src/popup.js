'use strict';

const api = globalThis.browser || globalThis.chrome;

const PROTECT_LABEL = {
  keep: '🛟 protegida',
  pinned: '📌 fija',
  audible: '🔊 con audio',
  active: '👁️ activa',
  discarded: '💤 suspendida',
  whitelist: '✅ lista blanca',
  grouped: '📁 en grupo',
  'last-in-window': '🪟 única',
  internal: '⚙️ interna'
};

let lastSig = '';
let timer = null;
let settingsViewOpen = false;

/* ------------------------------ utilidades ------------------------------ */

function fmtSpan(ms) {
  const abs = Math.abs(ms);
  const m = Math.floor(abs / 60000);
  if (m < 1) return Math.max(1, Math.round(abs / 1000)) + ' s';
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? h + ' h ' + mm + ' min' : h + ' h';
  const d = Math.floor(h / 24);
  return d + ' d ' + (h % 24) + ' h';
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function send(msg) {
  return api.runtime.sendMessage(msg);
}

/* ------------------------------ render lista ------------------------------ */

function renderList(state) {
  const list = document.getElementById('tabs');
  const empty = document.getElementById('empty');
  const scroll = list.parentElement.scrollTop;

  list.textContent = '';

  if (!state.tabs.length) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const t of state.tabs) {
      const row = el('div', 'tab' + (t.active ? ' active' : ''));
      row.dataset.id = String(t.id);

      const fav = el('div', 'fav');
      if (t.favIconUrl) {
        const img = document.createElement('img');
        img.src = t.favIconUrl;
        img.onerror = () => { img.remove(); fav.textContent = '•'; };
        fav.appendChild(img);
      } else {
        fav.textContent = '•';
      }

      const info = el('div', 'tinfo');
      const title = el('div', 'ttitle', t.title);
      title.title = t.url || t.title;
      const host = el('div', 'thost', (t.host || '—') + ' · hace ' + fmtSpan(t.ageMs));
      info.appendChild(title);
      info.appendChild(host);

      const right = el('div', 'tright');

      let pill;
      if (t.protect) {
        pill = el('span', 'pill ' + (t.protect === 'keep' || t.protect === 'whitelist' ? 'keep' : 'off'), PROTECT_LABEL[t.protect] || t.protect);
      } else if (t.armed) {
        pill = el('span', 'pill bomb', t.killInMs > 0 ? '💣 ' + mmss(t.killInMs) : '💣 ¡ya!');
      } else if (t.killInMs < 15 * 60000) {
        pill = el('span', 'pill warn', 'muere en ' + fmtSpan(t.killInMs));
      } else {
        pill = el('span', 'pill ok', 'muere en ' + fmtSpan(t.killInMs));
      }
      right.appendChild(pill);

      const acts = el('div', 'acts');
      const bKeep = el('button', 'act', t.keep ? '💔' : '🛟');
      bKeep.title = t.keep ? 'Quitar protección' : 'Mantener viva (no se cierra nunca)';
      bKeep.dataset.act = t.keep ? 'unkeep' : 'keep';
      bKeep.dataset.id = String(t.id);

      const bSnooze = el('button', 'act', '💤');
      bSnooze.title = 'Ampliar 15 minutos';
      bSnooze.dataset.act = 'snooze';
      bSnooze.dataset.id = String(t.id);

      const bClose = el('button', 'act', '✕');
      bClose.title = 'Cerrar ahora';
      bClose.dataset.act = 'closeNow';
      bClose.dataset.id = String(t.id);

      acts.appendChild(bSnooze);
      acts.appendChild(bKeep);
      acts.appendChild(bClose);
      right.appendChild(acts);

      row.appendChild(fav);
      row.appendChild(info);
      row.appendChild(right);
      list.appendChild(row);
    }
  }

  list.parentElement.scrollTop = scroll;
}

/* ------------------------------ settings ------------------------------ */

function fillSettings(s) {
  const active = document.activeElement;
  const setRange = (id, val, labelId, suffix) => {
    const input = document.getElementById(id);
    if (document.activeElement !== input) input.value = val;
    document.getElementById(labelId).textContent = val + ' ' + suffix;
  };
  setRange('ttl', s.ttlMinutes, 'ttl-val', 'min');
  setRange('grace', s.graceSeconds, 'grace-val', 's');

  if (active !== document.getElementById('mode')) document.getElementById('mode').value = s.mode;

  const boxes = ['ignorePinned', 'ignoreAudible', 'ignoreActive', 'ignoreDiscarded', 'ignoreGrouped',
    'keepLastTabInWindow', 'showOverlay', 'notifyOnArm', 'pauseWhenIdle'];
  for (const id of boxes) {
    const input = document.getElementById(id);
    if (document.activeElement !== input) input.checked = !!s[id];
  }

  const wl = document.getElementById('whitelist');
  if (document.activeElement !== wl) wl.value = (s.whitelist || []).join('\n');

  document.getElementById('enabled').checked = !!s.enabled;
}

function renderStats(state) {
  const st = state.stats || {};
  const wrap = document.getElementById('stats');
  wrap.textContent = '';
  wrap.appendChild(el('div', null, 'Cerradas: ' + (st.closed || 0) + ' · Suspendidas: ' + (st.discarded || 0) + ' · Rescatadas: ' + (st.rescued || 0)));
  if (st.lastAt) {
    wrap.appendChild(el('div', null, 'Última: «' + (st.lastTitle || '—') + '» (' + fmtSpan(Date.now() - st.lastAt) + ' atrás)'));
  }
  wrap.appendChild(el('div', null, 'Tab Bomb v' + state.version));
}

/* ------------------------------ ciclo ------------------------------ */

async function refresh() {
  let state;
  try {
    state = await send({ type: 'getState' });
  } catch (e) {
    document.getElementById('subtitle').textContent = 'error de conexión';
    return;
  }
  if (!state || state.ok === false) {
    document.getElementById('subtitle').textContent = 'error: ' + (state && state.error);
    return;
  }

  const armedCount = state.tabs.filter((t) => t.armed).length;
  document.getElementById('subtitle').textContent =
    state.total + ' pestañas · ' + state.zombies + ' zombi' + (state.zombies === 1 ? '' : 's') +
    (armedCount ? ' · ' + armedCount + ' con bomba' : '');
  document.getElementById('paused').classList.toggle('hidden', !state.paused);
  document.getElementById('enabled').checked = !!state.settings.enabled;

  const sig = JSON.stringify([
    state.tabs.map((t) => [t.id, t.title, t.protect, t.armed, Math.round(t.killInMs / 1000), Math.round(t.ageMs / 60000), t.keep, t.active]),
    state.total, state.zombies, state.paused
  ]);

  if (sig !== lastSig) {
    lastSig = sig;
    renderList(state);
  }

  fillSettings(state.settings);
  renderStats(state);
  document.getElementById('btn-zombies').disabled = state.zombies === 0;
}

function start() {
  refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.hidden) return;
    refresh();
  }, 1200);
}

/* ------------------------------ eventos ------------------------------ */

document.addEventListener('click', async (ev) => {
  const target = ev.target.closest('[data-act]');
  if (!target) return;
  const id = Number(target.dataset.id);
  const act = target.dataset.act;

  try {
    if (act === 'keep') await send({ type: 'keep', tabId: id });
    else if (act === 'unkeep') await send({ type: 'unkeep', tabId: id });
    else if (act === 'snooze') await send({ type: 'snooze', tabId: id, minutes: 15 });
    else if (act === 'closeNow') await send({ type: 'closeNow', tabId: id });
  } catch (e) { /* noop */ }
  lastSig = '';
  refresh();
});

document.getElementById('enabled').addEventListener('change', async (ev) => {
  await send({ type: 'settings', patch: { enabled: ev.target.checked } });
  lastSig = '';
  refresh();
});

document.getElementById('btn-settings').addEventListener('click', () => {
  settingsViewOpen = !settingsViewOpen;
  document.getElementById('view-list').classList.toggle('hidden', settingsViewOpen);
  document.getElementById('view-settings').classList.toggle('hidden', !settingsViewOpen);
});

document.getElementById('btn-refresh').addEventListener('click', () => { lastSig = ''; refresh(); });

document.getElementById('btn-zombies').addEventListener('click', async () => {
  await send({ type: 'sweepNow' });
  lastSig = '';
  refresh();
});

function bindSetting(id, key, transform) {
  const node = document.getElementById(id);
  const handler = async () => {
    let value;
    if (node.type === 'checkbox') value = node.checked;
    else if (node.type === 'range' || node.type === 'number') value = Number(node.value);
    else value = node.value;
    if (transform) value = transform(value);
    await send({ type: 'settings', patch: { [key]: value } });
    lastSig = '';
    refresh();
  };
  node.addEventListener('input', () => {
    if (id === 'ttl') document.getElementById('ttl-val').textContent = node.value + ' min';
    if (id === 'grace') document.getElementById('grace-val').textContent = node.value + ' s';
  });
  node.addEventListener('change', handler);
}

bindSetting('ttl', 'ttlMinutes');
bindSetting('grace', 'graceSeconds');
bindSetting('mode', 'mode');
bindSetting('ignorePinned', 'ignorePinned');
bindSetting('ignoreAudible', 'ignoreAudible');
bindSetting('ignoreActive', 'ignoreActive');
bindSetting('ignoreDiscarded', 'ignoreDiscarded');
bindSetting('ignoreGrouped', 'ignoreGrouped');
bindSetting('keepLastTabInWindow', 'keepLastTabInWindow');
bindSetting('showOverlay', 'showOverlay');
bindSetting('notifyOnArm', 'notifyOnArm');
bindSetting('pauseWhenIdle', 'pauseWhenIdle');
bindSetting('whitelist', 'whitelist', (v) => String(v).split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean));

start();
