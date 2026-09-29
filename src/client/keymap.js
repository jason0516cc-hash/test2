/**
 * keymap.js — which key does what. NO imports (inputState.js reads it).
 *
 * Every rebindable action is listed in ACTIONS with up to two keys (a main
 * key and an alternative). Keys are physical key codes (KeyboardEvent.code,
 * left/right modifiers merged), so Shift doesn't turn "=" into "+" and the
 * layout of the keys stays put on any keyboard language.
 *
 * The player's changes are saved in localStorage; resetKeymap() restores the
 * defaults. Held keys (movement, attack, defend) are read by inputState.js,
 * one-shot shortcuts are run by ui/keybinds.js, and the settings panel's
 * Keybinds tab edits the table.
 */

/** @type {{id:string, label:string, group:string, keys:(string|null)[]}[]} */
export const ACTIONS = [
  { id: 'moveUp',        label: 'Move Up',          group: 'Movement',  keys: ['KeyW', 'ArrowUp'] },
  { id: 'moveLeft',      label: 'Move Left',        group: 'Movement',  keys: ['KeyA', 'ArrowLeft'] },
  { id: 'moveDown',      label: 'Move Down',        group: 'Movement',  keys: ['KeyS', 'ArrowDown'] },
  { id: 'moveRight',     label: 'Move Right',       group: 'Movement',  keys: ['KeyD', 'ArrowRight'] },
  { id: 'attack',        label: 'Attack',           group: 'Combat',    keys: ['Space', null] },
  { id: 'defend',        label: 'Defend',           group: 'Combat',    keys: ['Shift', null] },
  { id: 'swapAll',       label: 'Swap All Petals',  group: 'Combat',    keys: ['KeyR', null] },
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `swap${i + 1}`, label: `Swap Slot ${i + 1}`, group: 'Combat',
    keys: [i === 9 ? 'Digit0' : `Digit${i + 1}`, null],
  })),
  { id: 'inventory',     label: 'Inventory',        group: 'Menus',     keys: ['KeyX', null] },
  { id: 'crafting',      label: 'Crafting',         group: 'Menus',     keys: ['KeyC', null] },
  { id: 'mobGallery',    label: 'Mob Gallery',      group: 'Menus',     keys: ['KeyV', null] },
  { id: 'settings',      label: 'Settings',         group: 'Menus',     keys: [null, null] },
  { id: 'closeMenus',    label: 'Close Menus',      group: 'Menus',     keys: ['Escape', null] },
  { id: 'chat',          label: 'Chat',             group: 'Menus',     keys: ['Enter', null] },
  { id: 'minimap',       label: 'Zoom Minimap',     group: 'Other',     keys: ['KeyM', null] },
  { id: 'hitboxes',      label: 'Show Hitboxes',    group: 'Other',     keys: ['KeyF', null] },
  { id: 'mouseMovement', label: 'Mouse Movement',   group: 'Other',     keys: ['KeyK', null] },
  { id: 'invertAttack',  label: 'Invert Attack',    group: 'Other',     keys: ['Equal', null] },
  { id: 'invertDefend',  label: 'Invert Defend',    group: 'Other',     keys: ['Minus', null] },
];

const LS_KEY = 'keybinds';
const DEFAULTS = Object.fromEntries(ACTIONS.map(a => [a.id, [...a.keys]]));

let map = load();
let byCode = new Map();       // code → action id
const listeners = new Set();
reindex();

function load() {
  const out = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    for (const id in saved) {
      if (out[id] && Array.isArray(saved[id])) out[id] = [saved[id][0] ?? null, saved[id][1] ?? null];
    }
  } catch {}
  return out;
}

function save() {
  // Only what differs from the defaults, so new defaults still reach players
  const diff = {};
  for (const id in map) if (map[id][0] !== DEFAULTS[id][0] || map[id][1] !== DEFAULTS[id][1]) diff[id] = map[id];
  try { localStorage.setItem(LS_KEY, JSON.stringify(diff)); } catch {}
}

function reindex() {
  byCode = new Map();
  for (const a of ACTIONS) for (const c of map[a.id]) if (c && !byCode.has(c)) byCode.set(c, a.id);
  for (const fn of listeners) fn();
}

/** KeyboardEvent → the code used in the keymap ('ShiftLeft' → 'Shift'). */
export function eventCode(e) {
  const c = e.code || '';
  if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(c)) return c.replace(/(Left|Right)$/, '');
  if (c) return c;
  // Very old browsers / synthetic events without a code
  return e.key === ' ' ? 'Space' : e.key?.length === 1 ? 'Key' + e.key.toUpperCase() : (e.key ?? '');
}

/** The action a key code triggers, or null. */
export function actionFor(code) { return byCode.get(code) ?? null; }

/** Both keys of an action ([main, alt], either may be null). */
export function keysFor(id) { return map[id] ?? [null, null]; }

/** True while any key of the action is held in `held` (code → bool). */
export function isHeld(id, held) {
  const k = map[id];
  return !!(k && ((k[0] && held[k[0]]) || (k[1] && held[k[1]])));
}

/**
 * Binds `code` to one of an action's two slots. A key can only do one thing:
 * if another action had it, that slot is cleared. Returns the id of the
 * action that lost the key (or null). `code` null unbinds the slot.
 */
export function setKey(id, slot, code) {
  let stolenFrom = null;
  if (code) {
    for (const a of ACTIONS) {
      const k = map[a.id];
      for (let s = 0; s < 2; s++) {
        if (k[s] === code && !(a.id === id && s === slot)) { k[s] = null; if (a.id !== id) stolenFrom = a.id; }
      }
    }
  }
  map[id][slot] = code;
  save(); reindex();
  return stolenFrom;
}

export function resetKeymap() {
  map = structuredClone(DEFAULTS);
  save(); reindex();
}

export function isDefaultKeymap() {
  return ACTIONS.every(a => map[a.id][0] === DEFAULTS[a.id][0] && map[a.id][1] === DEFAULTS[a.id][1]);
}

/** Runs `fn` whenever any binding changes. */
export function onKeymapChange(fn) { listeners.add(fn); }

const NAMES = {
  Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab',
  Shift: 'Shift', Control: 'Ctrl', Alt: 'Alt', Meta: 'Meta', CapsLock: 'Caps',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  Insert: 'Ins', Delete: 'Del', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadEnter: 'Num Enter', NumpadDecimal: 'Num .',
};

/** Short label for a key code: 'KeyW' → 'W', 'Digit1' → '1', 'Space' → 'Space'. */
export function keyName(code) {
  if (!code) return '';
  if (NAMES[code]) return NAMES[code];
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(code))) return 'Num ' + m[1];
  return code;
}
