/**
 * settingsPanel.js
 *
 * Settings panel: Game / Controls / Keybinds / Credits tabs, spinning cog
 * button. Same simple look as the other panels: solid fill, thick border,
 * white outlined text.
 *
 * Keybinds tab: every rebindable action from client/keymap.js with a main
 * and an alternative key. Click a key box, press the new key (Esc cancels,
 * Backspace clears); a key already used elsewhere moves to the new action.
 * "Reset to default" restores the whole table.
 *
 * The Mouse Movement / Invert shortcuts live in keybinds.js and call
 * refreshSettingsPanel().
 */

import { settings }                                from '../settings.js';
import { registerPanel, togglePanel, closePanel } from './panels.js';
import {
  ACTIONS, keysFor, setKey, resetKeymap, isDefaultKeymap, keyName, eventCode, onKeymapChange,
} from '../keymap.js';

// ─────────────────────────────────────────────────────────────────────────────
// Colours
// ─────────────────────────────────────────────────────────────────────────────
const FILL    = '#A7A7A7';
const OUTLINE = '#7F7F7F';
const FIELD   = '#909090';
const FIELD_HI = '#9C9C9C';

// ─────────────────────────────────────────────────────────────────────────────
// Inject styles
// ─────────────────────────────────────────────────────────────────────────────
(function injectSettingsStyles() {
  const s = document.createElement('style');
  s.textContent = `
    /* ── Settings button ─────────────────────────────────────────────────── */
    #settings-btn {
      position: fixed; top: 16px; left: 16px;
      width: 44px; height: 44px; border-radius: 8px;
      background: #aaaaaa; border: 3px solid #888888;
      cursor: pointer; z-index: 101;
      display: flex; align-items: center; justify-content: center;
      padding: 4px; box-sizing: border-box; user-select: none;
    }
    #settings-btn:active { transform: scale(0.95); }
    #settings-btn img {
      width: 100%; height: 100%; object-fit: contain; display: block;
      transition: transform 0.45s cubic-bezier(0.22,1,0.36,1);
      transform-origin: center center;
    }

    /* ── Panel ───────────────────────────────────────────────────────────── */
    #settings-panel {
      position: fixed; top: 76px; left: 16px; width: 320px;
      background: ${FILL}; border: 3px solid ${OUTLINE}; border-radius: 12px;
      font-family: 'UbuntuCustom', 'Ubuntu', Arial, sans-serif;
      z-index: 200; user-select: none; box-sizing: border-box; overflow: hidden;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
      opacity: 0; pointer-events: none;
      transform: translateX(calc(-100% - 32px));
      transition: opacity 0.20s cubic-bezier(0.22,1,0.36,1), transform 0.22s cubic-bezier(0.22,1,0.36,1);
    }
    #settings-panel.open { opacity: 1; pointer-events: auto; transform: translateX(0); }
    #settings-panel .sp-stroke, #settings-panel .sp-title, #settings-panel .sp-label,
    #settings-panel .sp-group, #settings-panel .sp-hint, #settings-panel .sp-credit-name {
      color: #fff; -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }

    #settings-panel .sp-titlebar { position: relative; padding: 9px 12px 4px; }
    #settings-panel .sp-title { font-size: 17px; font-weight: 900; -webkit-text-stroke-width: 3px; }
    #settings-panel .sp-close {
      position: absolute; right: 8px; top: 8px;
      background: #c1565e; border: 2px solid #90464b; border-radius: 6px;
      color: #eee; font-size: 12px; font-weight: 900;
      width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; padding: 0; line-height: 1; font-family: inherit;
      transition: background 0.12s, transform 0.12s;
    }
    #settings-panel .sp-close:hover { background: #a03040; transform: scale(1.08); }

    /* ── Tabs ────────────────────────────────────────────────────────────── */
    #settings-panel .sp-tabs { display: flex; gap: 5px; padding: 4px 12px 8px; }
    #settings-panel .sp-tab {
      flex: 1; padding: 4px 0; font-family: inherit; font-size: 11.5px; font-weight: 900;
      background: ${FIELD}; border: 2px solid ${OUTLINE}; border-radius: 7px; cursor: pointer;
      color: #fff; -webkit-text-stroke: 2px #000; paint-order: stroke fill;
      transition: background 0.12s, color 0.12s;
    }
    #settings-panel .sp-tab:hover { background: ${FIELD_HI}; }
    #settings-panel .sp-tab.active { background: #fff; color: #6f6f6f; -webkit-text-stroke: 0; }

    /* ── Body ────────────────────────────────────────────────────────────── */
    #settings-panel .sp-body { padding: 0 12px 12px; }
    #settings-panel .sp-row {
      display: flex; align-items: center; gap: 9px; padding: 5px 6px;
      border-radius: 7px; cursor: pointer; transition: background 0.1s;
    }
    #settings-panel .sp-row:hover { background: rgba(255,255,255,0.16); }
    #settings-panel .sp-check {
      width: 18px; height: 18px; border-radius: 5px; box-sizing: border-box; flex-shrink: 0;
      background: ${FIELD}; border: 2px solid ${OUTLINE}; position: relative;
      transition: background 0.12s, border-color 0.12s;
    }
    #settings-panel .sp-check.on { background: #fff; border-color: #fff; }
    #settings-panel .sp-check.on::after {
      content: ''; position: absolute; left: 4px; top: 0px; width: 5px; height: 9px;
      border: solid #6f6f6f; border-width: 0 2.5px 2.5px 0; transform: rotate(45deg);
    }
    #settings-panel .sp-label { font-size: 12.5px; font-weight: 900; flex: 1; }
    #settings-panel .sp-badge {
      font-size: 10.5px; font-weight: 900; min-width: 16px; text-align: center;
      padding: 1px 6px; border-radius: 5px; background: ${FIELD}; border: 2px solid ${OUTLINE};
      color: #fff; -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }

    /* ── Keybinds ────────────────────────────────────────────────────────── */
    #settings-panel .sp-keys {
      max-height: 300px; overflow-y: auto; scrollbar-width: none; margin: 0 -4px; padding: 0 4px;
    }
    #settings-panel .sp-keys::-webkit-scrollbar { display: none; }
    #settings-panel .sp-group {
      display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 900;
      padding: 8px 2px 3px;
    }
    #settings-panel .sp-group:first-child { padding-top: 2px; }
    #settings-panel .sp-group::after { content: ''; flex: 1; height: 2px; border-radius: 2px; background: ${OUTLINE}; }
    #settings-panel .sp-bind { cursor: default; padding: 3px 6px; }
    #settings-panel .sp-bind.flash { animation: sp-flash 0.7s ease-out; }
    @keyframes sp-flash { from { background: rgba(255,255,255,0.45); } to { background: transparent; } }
    #settings-panel .sp-key {
      width: 62px; height: 22px; box-sizing: border-box; flex-shrink: 0;
      font-family: inherit; font-size: 11px; font-weight: 900; padding: 0;
      background: ${FIELD}; border: 2px solid ${OUTLINE}; border-radius: 6px; cursor: pointer;
      color: #fff; -webkit-text-stroke: 2px #000; paint-order: stroke fill;
      transition: background 0.1s, border-color 0.1s, transform 0.1s;
    }
    #settings-panel .sp-key:hover { background: ${FIELD_HI}; }
    #settings-panel .sp-key.empty { color: rgba(255,255,255,0.55); -webkit-text-stroke: 0; }
    #settings-panel .sp-key.listening {
      background: #fff; border-color: #fff; color: #6f6f6f; -webkit-text-stroke: 0;
      animation: sp-pulse 0.9s ease-in-out infinite;
    }
    @keyframes sp-pulse { 50% { transform: scale(1.06); } }
    #settings-panel .sp-foot { display: flex; align-items: center; gap: 8px; padding-top: 10px; }
    #settings-panel .sp-hint { flex: 1; font-size: 10px; font-weight: 900; line-height: 1.3; opacity: 0.9; }
    #settings-panel .sp-reset {
      padding: 5px 10px; font-family: inherit; font-size: 11.5px; font-weight: 900;
      background: ${FIELD}; border: 2px solid ${OUTLINE}; border-radius: 7px; cursor: pointer;
      color: #fff; -webkit-text-stroke: 2px #000; paint-order: stroke fill; white-space: nowrap;
      transition: background 0.12s, opacity 0.15s;
    }
    #settings-panel .sp-reset:hover { background: ${FIELD_HI}; }
    #settings-panel .sp-reset:disabled { opacity: 0.5; cursor: default; background: ${FIELD}; }

    /* ── Credits ─────────────────────────────────────────────────────────── */
    #settings-panel .sp-credit-row { padding: 6px 6px; font-size: 12px; line-height: 1.45; }
    #settings-panel .sp-credit-name { font-weight: 900; font-size: 13px; }
    #settings-panel .sp-credit-role { font-weight: 700; color: #262626; }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let settingsOpen = false;
let settingsTab  = 'game';   // 'game' | 'controls' | 'keybinds' | 'credits'
let capture      = null;     // { id, slot } while a key box waits for a key
let bodyEl       = null;

// Cog rotation
let cogAngle    = 0;
let cogLastTime = 0;
const COG_SPEED = 0.0012; // rad/ms

// ─────────────────────────────────────────────────────────────────────────────
// Setting definitions
// ─────────────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'game',     label: 'Game' },
  { id: 'controls', label: 'Controls' },
  { id: 'keybinds', label: 'Keybinds' },
  { id: 'credits',  label: 'Credits' },
];

const SETTINGS_DEFS = [
  { key: 'reduceDamageFlash',   label: 'Disable Damage Flash' },
  { key: 'statBoxes',           label: 'Stat Boxes' },
  { key: 'showDamageNumbers',   label: 'Show Damage Numbers' },
  { key: 'equipDrops',          label: 'Equip Drops' },
  { key: 'showReloadingPetals', label: 'Show Reloading Petals' },
];

// `action` = the keymap action that toggles it (its key is shown as a badge)
const CONTROLS_DEFS = [
  { key: 'mouseMovement', label: 'Mouse Movement', action: 'mouseMovement' },
  { key: 'invertAttack',  label: 'Invert Attack',  action: 'invertAttack' },
  { key: 'invertDefend',  label: 'Invert Defend',  action: 'invertDefend' },
];

const CREDITS = [
  { name: 'Vyx',       role: 'coding and developing, mob designs.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export function isSettingsOpen() { return settingsOpen; }

/** True while the Keybinds tab is waiting for a key (shortcuts stay quiet). */
export function isCapturingKey() { return capture !== null; }

export function closeSettings() {
  settingsOpen = false;
  capture = null;
  document.getElementById('settings-panel')?.classList.remove('open');
  cogLastTime = 0;
}

function openSettings() {
  settingsOpen = true;
  document.getElementById('settings-panel')?.classList.add('open');
  renderBody(); // refresh in case a keybind changed something
}

/** Re-draws the body after a setting was changed from elsewhere (keybinds). */
export function refreshSettingsPanel() {
  if (settingsOpen) renderBody();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderTabs() {
  document.querySelectorAll('#settings-panel .sp-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === settingsTab));
}

function switchTab(id) {
  if (id === settingsTab) return;
  capture = null;
  const from = bodyEl.offsetHeight;
  settingsTab = id;
  renderTabs();
  renderBody();
  // Glide the panel to the new height and fade the new content in
  const to = bodyEl.offsetHeight;
  bodyEl.animate([{ height: from + 'px' }, { height: to + 'px' }],
    { duration: 220, easing: 'cubic-bezier(0.22,1,0.36,1)' });
  bodyEl.firstElementChild?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
    { duration: 200, easing: 'ease-out' });
}

function renderBody() {
  if (!bodyEl) return;
  const wrap = document.createElement('div');
  if (settingsTab === 'game') wrap.append(...toggleRows(SETTINGS_DEFS));
  else if (settingsTab === 'controls') wrap.append(...toggleRows(CONTROLS_DEFS));
  else if (settingsTab === 'keybinds') buildKeybinds(wrap);
  else {
    wrap.innerHTML = CREDITS.map(c =>
      `<div class="sp-credit-row"><span class="sp-credit-name">${esc(c.name)}</span>` +
      `<span class="sp-credit-role"> — ${esc(c.role)}</span></div>`).join('');
  }
  // Keep the keybind list's scroll position across re-renders
  const oldList = bodyEl.querySelector('.sp-keys');
  const scrollTop = oldList?.scrollTop ?? 0;
  bodyEl.replaceChildren(wrap);
  const list = bodyEl.querySelector('.sp-keys');
  if (list) list.scrollTop = scrollTop;
}

function toggleRows(defs) {
  return defs.map(def => {
    const row = document.createElement('div');
    row.className = 'sp-row';
    const key = def.action ? keysFor(def.action).find(Boolean) : null;
    row.innerHTML = `<div class="sp-check${settings[def.key] ? ' on' : ''}"></div>` +
      `<span class="sp-label">${esc(def.label)}</span>` +
      (key ? `<span class="sp-badge">${esc(keyName(key))}</span>` : '');
    row.addEventListener('click', () => {
      settings[def.key] = !settings[def.key];
      row.firstElementChild.classList.toggle('on', settings[def.key]);
    });
    return row;
  });
}

function buildKeybinds(wrap) {
  const list = document.createElement('div');
  list.className = 'sp-keys';
  let group = null;
  for (const a of ACTIONS) {
    if (a.group !== group) {
      group = a.group;
      const g = document.createElement('div');
      g.className = 'sp-group';
      g.textContent = group;
      list.appendChild(g);
    }
    const row = document.createElement('div');
    row.className = 'sp-row sp-bind';
    row.dataset.action = a.id;
    row.innerHTML = `<span class="sp-label">${esc(a.label)}</span>`;
    keysFor(a.id).forEach((code, slot) => {
      const b = document.createElement('button');
      const listening = capture && capture.id === a.id && capture.slot === slot;
      b.className = 'sp-key' + (listening ? ' listening' : code ? '' : ' empty');
      b.textContent = listening ? 'Press a key' : code ? keyName(code) : '—';
      b.addEventListener('click', e => {
        e.stopPropagation();
        capture = listening ? null : { id: a.id, slot };
        renderBody();
      });
      row.appendChild(b);
    });
    list.appendChild(row);
  }

  const foot = document.createElement('div');
  foot.className = 'sp-foot';
  foot.innerHTML = `<span class="sp-hint">Click a key to change it.<br>Esc cancels · Backspace clears</span>` +
    `<button class="sp-reset"${isDefaultKeymap() ? ' disabled' : ''}>Reset to default</button>`;
  foot.querySelector('.sp-reset').addEventListener('click', () => { capture = null; resetKeymap(); });
  wrap.append(list, foot);
}

function flashRow(actionId) {
  const row = bodyEl?.querySelector(`.sp-bind[data-action="${actionId}"]`);
  if (!row) return;
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
}

// While a key box is listening, the next key press goes to it — and nowhere
// else (capture phase + stopImmediatePropagation keeps it from moving the
// player, closing panels or opening chat).
window.addEventListener('keydown', e => {
  if (!capture) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat) return;
  const { id, slot } = capture;
  capture = null;
  if (e.key === 'Escape') { renderBody(); return; }
  const code = (e.key === 'Backspace' || e.key === 'Delete') ? null : eventCode(e);
  const lostFrom = setKey(id, slot, code);   // re-renders through onKeymapChange
  if (lostFrom) flashRow(lostFrom);
}, true);

// Clicking anywhere else stops listening
window.addEventListener('mousedown', e => {
  if (capture && !e.target.closest?.('.sp-key')) { capture = null; renderBody(); }
}, true);

onKeymapChange(() => refreshSettingsPanel());

// ─────────────────────────────────────────────────────────────────────────────
// Cog animation  (called every frame from game loop)
// ─────────────────────────────────────────────────────────────────────────────
export function updateSettingsCog(now) {
  const btn = document.getElementById('settings-btn');
  if (!btn) return;
  const img = btn.querySelector('img');
  if (!img) return;

  if (settingsOpen) {
    const dt = cogLastTime ? now - cogLastTime : 0;
    cogAngle += COG_SPEED * dt;
    img.style.transition = 'none';
    img.style.transform  = `rotate(${cogAngle}rad)`;
  } else if (cogAngle !== 0) {
    img.style.transition = 'transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)';
    img.style.transform  = 'rotate(0rad)';
    cogAngle = 0;
  }
  cogLastTime = now;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function ensureSettingsBtn() {
  if (document.getElementById('settings-btn')) return;

  // ── Button ────────────────────────────────────────────────────────────────
  const btn = document.createElement('div');
  btn.id = 'settings-btn';
  const img = document.createElement('img');
  img.src = './public/icons/settings.png'; img.draggable = false;
  btn.appendChild(img);
  document.body.appendChild(btn);
  btn.addEventListener('mousedown', e => e.stopPropagation());

  // ── Panel ─────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.innerHTML = `
    <div class="sp-titlebar">
      <span class="sp-title">Settings</span>
      <button class="sp-close">✕</button>
    </div>
    <div class="sp-tabs">${TABS.map(t => `<button class="sp-tab" data-tab="${t.id}">${t.label}</button>`).join('')}</div>
    <div class="sp-body"></div>
  `;
  panel.addEventListener('mousedown', e => e.stopPropagation());
  document.body.appendChild(panel);
  bodyEl = panel.querySelector('.sp-body');
  panel.querySelector('.sp-close').addEventListener('click', () => closePanel('settings'));
  panel.querySelectorAll('.sp-tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  renderTabs();
  renderBody();

  // ── Toggle ────────────────────────────────────────────────────────────────
  btn.addEventListener('click', () => togglePanel('settings'));
  registerPanel('settings', {
    open: openSettings, close: closeSettings, isOpen: () => settingsOpen,
    rootIds: ['settings-panel', 'settings-btn'],
  });
}
