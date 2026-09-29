/**
 * client/ui/inventoryPanel.js — the Inventory panel.
 *
 * A live, keyed petal grid: tiles are created once and then updated in place,
 * so every change animates instead of the whole grid being rebuilt —
 *   - new petals (drops picked up, crafted, unequipped) pop in,
 *   - counts bump when they change,
 *   - a tile whose last petal leaves shrinks away and the rest slide over.
 *
 * Two layouts:
 *   - Default: grouped by rarity (highest first) under a coloured separator.
 *   - Stack:   one tile per petal, A–Z. The tile shows the highest rarity you
 *              own with its count; lower rarities sit underneath it and move
 *              up once the top one runs out.
 *
 * Dragging a petal out only takes ONE off the tile's count while it's in the
 * air (the tile only goes away if that was the last one). The actual move
 * still goes through game/commands.js on drop.
 */

import { localPlayer as player } from '../localPlayer.js';
import * as commands from '../../game/commands.js';
import { PETAL_TYPES } from '../../shared/petalTypes.js';
import { rarityTier, raritySuffix, rarityText, rarityCss, rarityBorderWidth } from '../../shared/rarities.js';
import { drawInventoryIcon, isAnimatedIcon } from '../render/petalDrawing.js';
import { setPetalHover } from './petalTooltip.js';
import {
  drag, flyPetal,
  setInvSlotCSS, registerInvAccess, getDragJustEnded,
} from './hotbar.js';
import { registerPanel, togglePanel, closePanel } from './panels.js';

// ─────────────────────────────────────────────────────────────────────────────
// Look
// ─────────────────────────────────────────────────────────────────────────────
const FILL     = '#5A9FDB';   // panel + toolbar button
const OUTLINE  = '#4981B1';   // outlines, fields, separator lines
const FIELD_HI = '#5389BA';   // field hover

const PANEL_W = 316;
const COLS    = 5;
const TILE    = 50;     // tile size in CSS px
const GAP     = 8;
const TILE_BW = rarityBorderWidth(TILE);   // same border thickness as every other petal box


const EASE_OUT = 'cubic-bezier(0.22,1,0.36,1)';
const EASE_POP = 'cubic-bezier(0.34,1.56,0.64,1)';

const LS_STACK = 'invStackMode';

(function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #inv-toggle-btn {
      position: fixed; width: 54px; height: 54px; border-radius: 10px;
      background: ${FILL}; border: 3px solid ${OUTLINE};
      cursor: pointer; z-index: 101;
      display: flex; align-items: center; justify-content: center;
      padding: 5px; box-sizing: border-box; user-select: none;
      transition: filter 0.12s;
    }
    #inv-toggle-btn:hover  { filter: brightness(1.08); }
    #inv-toggle-btn:active { transform: scale(0.95); }
    #inv-toggle-btn img { width:100%; height:100%; object-fit:contain; display:block; mix-blend-mode:screen; }

    #inv-panel {
      position: fixed; width: ${PANEL_W}px; display: flex; flex-direction: column;
      max-height: min(400px, calc(100vh - 20px));
      background: ${FILL}; border: 3px solid ${OUTLINE}; border-radius: 12px;
      box-sizing: border-box;
      font-family: 'UbuntuCustom', 'Ubuntu', Arial, sans-serif;
      z-index: 100; user-select: none; opacity: 0; pointer-events: none;
      transform: translateY(calc(100% + 24px));
      transition: opacity 0.22s ${EASE_OUT}, transform 0.22s ${EASE_OUT};
      overflow: hidden;
    }
    #inv-panel.open { opacity: 1; pointer-events: auto; transform: translateY(0); }

    /* Header */
    #inv-panel .inv-hdr {
      flex-shrink: 0; position: relative;
      display: flex; align-items: center; justify-content: center;
      padding: 7px 10px 4px;
    }
    #inv-panel .inv-title {
      color: #fff; font-size: 18px; font-weight: 700; letter-spacing: 0.5px;
      -webkit-text-stroke: 3px #000; paint-order: stroke fill;
    }
    #inv-panel .inv-close {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      width: 24px; height: 24px; padding: 0;
      background: #e05050; border: 2px solid #9c2d2d; border-radius: 6px;
      color: #fff; font-family: inherit; font-size: 12px; font-weight: 900; line-height: 1; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.12s;
    }
    #inv-panel .inv-close:hover { background: #c03838; }

    /* Search + Stack toggle */
    #inv-panel .inv-tools { flex-shrink: 0; display: flex; gap: 6px; padding: 4px 10px 8px; }
    #inv-panel .inv-search {
      flex: 1; min-width: 0; box-sizing: border-box;
      background: ${OUTLINE}; border: 2px solid ${OUTLINE}; border-radius: 7px;
      color: #fff; font-family: inherit; font-size: 12px; font-weight: 700; padding: 5px 9px;
      outline: none; transition: background 0.15s, border-color 0.15s;
    }
    #inv-panel .inv-search::placeholder { color: rgba(255,255,255,0.65); }
    #inv-panel .inv-search:hover { background: ${FIELD_HI}; }
    #inv-panel .inv-search:focus { background: ${OUTLINE}; border-color: #fff; }
    #inv-panel .inv-stack-btn {
      display: flex; align-items: center; gap: 6px; flex-shrink: 0;
      background: ${OUTLINE}; border: 2px solid ${OUTLINE}; border-radius: 7px;
      color: #fff; font-family: inherit; font-size: 12px; font-weight: 700; padding: 0 9px; cursor: pointer;
      transition: background 0.12s, color 0.12s;
    }
    #inv-panel .inv-stack-btn:hover { background: ${FIELD_HI}; }
    #inv-panel .inv-stack-box {
      width: 13px; height: 13px; border-radius: 3px; box-sizing: border-box;
      border: 2px solid #fff; position: relative;
      transition: background 0.12s;
    }
    #inv-panel .inv-stack-btn[aria-pressed="true"] { background: #fff; border-color: #fff; color: ${OUTLINE}; }
    #inv-panel .inv-stack-btn[aria-pressed="true"] .inv-stack-box { background: ${OUTLINE}; border-color: ${OUTLINE}; }
    #inv-panel .inv-stack-btn[aria-pressed="true"] .inv-stack-box::after {
      content: ''; position: absolute; left: 2.5px; top: -0.5px; width: 3px; height: 6px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }

    /* Scroll area */
    #inv-scroll {
      overflow-y: auto; overflow-x: hidden; flex: 1; min-height: 0;
      scrollbar-gutter: stable both-edges;
      scrollbar-width: thin; scrollbar-color: ${OUTLINE} transparent;
    }
    #inv-scroll::-webkit-scrollbar { width: 6px; }
    #inv-scroll::-webkit-scrollbar-track { background: transparent; }
    #inv-scroll::-webkit-scrollbar-thumb { background: ${OUTLINE}; border-radius: 4px; }
    #inv-panel .inv-content { position: relative; padding: 0 0 12px; }
    #inv-panel .inv-grid {
      display: grid; grid-template-columns: repeat(${COLS}, ${TILE}px);
      column-gap: ${GAP}px; row-gap: ${GAP}px; justify-content: center;
    }
    #inv-panel.stacked .inv-grid { row-gap: ${GAP + 6}px; padding-top: 2px; }
    #inv-panel .inv-ghosts { position: absolute; inset: 0; pointer-events: none; }

    /* Rarity separator */
    #inv-panel .inv-sep {
      grid-column: 1 / -1; display: flex; align-items: center; gap: 8px;
      padding: 4px 0 0; margin-bottom: -2px;
    }
    #inv-panel .inv-sep::before, #inv-panel .inv-sep::after {
      content: ''; flex: 1; height: 3px; border-radius: 2px; background: ${OUTLINE};
    }
    #inv-panel .inv-sep-label {
      font-size: 14px; font-weight: 700; letter-spacing: 0.3px; line-height: 1.2;
      -webkit-text-stroke: 3px #000; paint-order: stroke fill;
    }

    /* Petal tile */
    #inv-panel .inv-tile {
      position: relative; width: ${TILE}px; height: ${TILE}px; cursor: pointer;
    }
    #inv-panel .inv-face {
      position: absolute; inset: 0; z-index: 3; box-sizing: border-box;
      border: ${TILE_BW}px solid; border-radius: 7px; overflow: hidden;
      transition: transform 0.1s, filter 0.1s;
    }
    #inv-panel .inv-tile:hover .inv-face { filter: brightness(1.1); }
    #inv-panel .inv-tile:active .inv-face { transform: scale(0.94); }
    #inv-panel .inv-face canvas {
      position: absolute; inset: 0; width: 100%; height: 100%;
      display: block; pointer-events: none;
    }
    #inv-panel .inv-cnt {
      position: absolute; top: -5px; right: -6px; z-index: 4;
      font-size: 12px; font-weight: 700; color: #fff; line-height: 1;
      -webkit-text-stroke: 2.5px #000; paint-order: stroke fill;
      transform: rotate(15deg); pointer-events: none;
    }
    /* Lower rarities peeking out under a stacked tile */
    #inv-panel .inv-layer {
      position: absolute; inset: 0; box-sizing: border-box;
      border: ${TILE_BW}px solid; border-radius: 7px; pointer-events: none;
      transition: transform 0.25s ${EASE_OUT}, opacity 0.2s;
    }
    #inv-panel .inv-layer.l1 { z-index: 2; transform: translateY(5px)  scale(0.9); }
    #inv-panel .inv-layer.l2 { z-index: 1; transform: translateY(10px) scale(0.8); }
    #inv-panel .inv-layer.off { opacity: 0; transform: translateY(0) scale(0.8); }

    #inv-panel .inv-empty {
      grid-column: 1 / -1; text-align: center; color: rgba(255,255,255,0.85);
      font-size: 13px; font-weight: 700; padding: 26px 0 16px;
      -webkit-text-stroke: 2px rgba(0,0,0,0.55); paint-order: stroke fill;
    }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────────────────────
// Cross-module hooks (crafting registers these to avoid a circular import)
// ─────────────────────────────────────────────────────────────────────────────
const _craft = {
  isCraftingOpen: () => false,
  positionPanel:  () => {},
  renderPanel:    () => {},
};
export function registerCraftingWithInv(cbs) { Object.assign(_craft, cbs); }

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let invOpen    = false;
let invPanel   = null;
let invScroll  = null;
let contentEl  = null;
let gridEl     = null;
let ghostsEl   = null;
let stackBtn   = null;
let searchTerm = '';
let dirty      = true;
let hovering   = false;
let hoverEl    = null;    // tile under the mouse (for the petal tooltip)
let dragReserve = null;   // typeId currently being dragged out (shows one fewer)

let stackMode = false;
try { stackMode = localStorage.getItem(LS_STACK) === '1'; } catch {}

const live = new Map();   // key → element currently in the grid

export function isInventoryOpen() { return invOpen; }
export function markInventoryDirty() { dirty = true; }

// ─────────────────────────────────────────────────────────────────────────────
// What to show
// ─────────────────────────────────────────────────────────────────────────────
function tierOf(pt) { return pt.tier ?? rarityTier(pt.rarity); }

/** 'basic_ultra' → 'basic'. Petals without rarity variants are their own base. */
function baseIdOf(typeId, pt) {
  const t = tierOf(pt);
  if (t === 0) return typeId;
  const suffix = '_' + raritySuffix(t);
  return typeId.endsWith(suffix) ? typeId.slice(0, -suffix.length) : typeId;
}

// Petals still flying into the inventory (unequips, cancelled drags) aren't
// counted until they land, so the tile updates the moment they arrive.
const incoming = new Map();   // typeId → count in the air

function shownCount(typeId) {
  return (player.inventory[typeId] ?? 0)
    - (dragReserve === typeId ? 1 : 0)
    - (incoming.get(typeId) ?? 0);
}

/** Where a petal of `typeId` flying into the inventory should land: its tile
 *  (centre + size), or the top of the grid if it has no tile yet. */
function targetRectFor(typeId) {
  if (!invOpen) return null;
  let tile = null;
  for (const el of live.values()) if (el.dataset?.typeId === typeId) { tile = el; break; }
  if (!tile && stackMode) {
    const pt = PETAL_TYPES[typeId];
    if (pt) tile = live.get('stack:' + baseIdOf(typeId, pt)) ?? null;
  }
  if (tile) {
    const r = tile.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width };
  }
  // No tile yet (new petal): sink into the middle of the grid; its tile pops in on arrival
  const r = invScroll.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: TILE * 0.6, alpha: 0 };
}

function ownedPetals() {
  const out = [];
  for (const typeId of Object.keys(player.inventory)) {
    const pt = PETAL_TYPES[typeId];
    const count = shownCount(typeId);
    if (!pt || count <= 0) continue;
    if (searchTerm && !pt.name.toLowerCase().includes(searchTerm)) continue;
    out.push({ typeId, pt, count, tier: tierOf(pt) });
  }
  return out;
}

/** Ordered list of grid entries: separators and tiles, each with a stable key. */
function buildEntries() {
  const items = ownedPetals();
  const entries = [];

  if (stackMode) {
    const groups = new Map();
    for (const it of items) {
      const base = baseIdOf(it.typeId, it.pt);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(it);
    }
    const stacks = [...groups.entries()].map(([base, list]) => {
      list.sort((a, b) => b.tier - a.tier);
      return { base, list };
    });
    stacks.sort((a, b) => a.list[0].pt.name.localeCompare(b.list[0].pt.name) || a.base.localeCompare(b.base));
    for (const { base, list } of stacks) {
      entries.push({
        kind: 'tile', key: 'stack:' + base,
        typeId: list[0].typeId, count: list[0].count,
        below: list.slice(1, 3).map(it => it.pt.rarity),
      });
    }
    return entries;
  }

  items.sort((a, b) => (b.tier - a.tier) || a.pt.name.localeCompare(b.pt.name));
  let lastRarity = null;
  for (const it of items) {
    if (it.pt.rarity !== lastRarity) {
      lastRarity = it.pt.rarity;
      entries.push({ kind: 'sep', key: 'sep:' + lastRarity, rarity: lastRarity });
    }
    entries.push({ kind: 'tile', key: 'tile:' + it.typeId, typeId: it.typeId, count: it.count, below: [] });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Elements
// ─────────────────────────────────────────────────────────────────────────────
function paintBox(el, rarity) {
  const css = rarityCss(rarity);
  el.style.background  = css.background;
  el.style.borderColor = css.borderColor;
}

function createSep(entry) {
  const el = document.createElement('div');
  el.className = 'inv-sep';
  const label = document.createElement('span');
  label.className = 'inv-sep-label';
  label.textContent = entry.rarity;
  label.style.color = rarityText(entry.rarity);
  el.appendChild(label);
  return el;
}

function createTile() {
  const el = document.createElement('div');
  el.className = 'inv-tile';

  for (const cls of ['l1', 'l2']) {
    const layer = document.createElement('div');
    layer.className = `inv-layer ${cls} off`;
    el.appendChild(layer);
  }

  const face = document.createElement('div');
  face.className = 'inv-face';
  const cv = document.createElement('canvas');
  face.appendChild(cv);
  el.appendChild(face);

  const cnt = document.createElement('span');
  cnt.className = 'inv-cnt';
  el.appendChild(cnt);

  el._face = face; el._cv = cv; el._cnt = cnt;
  el._layers = el.querySelectorAll('.inv-layer');
  el._typeId = null; el._count = 0;
  return el;
}

function drawTileIcon(el) {
  const dpr  = window.devicePixelRatio || 1;
  const phys = Math.round((TILE - TILE_BW * 2) * dpr);   // inside the border
  if (el._cv.width !== phys) { el._cv.width = phys; el._cv.height = phys; }
  drawInventoryIcon(el._cv, el._typeId);
}

/** Brings a tile up to date; returns true if something visible changed. */
function updateTile(el, entry, animate) {
  const typeChanged  = el._typeId !== entry.typeId;
  const countChanged = el._count  !== entry.count;

  if (typeChanged) {
    const hadType = el._typeId !== null;
    el._typeId = entry.typeId;
    el.dataset.typeId = entry.typeId;
    paintBox(el._face, PETAL_TYPES[entry.typeId].rarity);
    drawTileIcon(el);
    if (animate && hadType) {
      el._face.animate(
        [{ transform: 'scale(0.8) rotate(-8deg)' }, { transform: 'none' }],
        { duration: 260, easing: EASE_POP });
    }
  }

  if (countChanged) {
    const grew = entry.count > el._count;
    el._count = entry.count;
    el._cnt.textContent = entry.count > 1 ? 'x' + entry.count : '';
    if (animate && entry.count > 1 && !typeChanged) {
      el._cnt.animate(
        [{ transform: `rotate(15deg) scale(${grew ? 1.5 : 0.7})` }, { transform: 'rotate(15deg) scale(1)' }],
        { duration: 240, easing: EASE_POP });
    }
  }

  el._layers.forEach((layer, i) => {
    const rarity = entry.below[i];
    if (rarity) { paintBox(layer, rarity); layer.classList.remove('off'); }
    else layer.classList.add('off');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync — diff the grid against the inventory and animate the difference
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {'live'|'intro'|'instant'} mode
 *   live    — FLIP-slide moved tiles, pop new ones, shrink removed ones
 *   intro   — every tile pops in, staggered (panel just opened / layout switched)
 *   instant — no animation
 */
function syncGrid(mode = 'live') {
  if (!gridEl) return;
  dirty = false;
  const animate = mode === 'live';

  const entries = buildEntries();
  const wanted  = new Set(entries.map(e => e.key));

  // FLIP "first" positions, relative to the content box
  const baseRect = contentEl.getBoundingClientRect();
  const before = new Map();
  if (animate) for (const [key, el] of live) before.set(key, el.getBoundingClientRect());

  // Removed → leave a ghost that shrinks away where the tile used to be
  for (const [key, el] of live) {
    if (wanted.has(key)) continue;
    live.delete(key);
    if (el === hoverEl) clearHover();
    const r = before.get(key);
    el.remove();
    if (!animate || !r) continue;
    el.style.position = 'absolute';
    el.style.left = (r.left - baseRect.left) + 'px';
    el.style.top  = (r.top  - baseRect.top)  + 'px';
    el.style.margin = '0';
    if (el.classList.contains('inv-sep')) el.style.width = r.width + 'px';
    ghostsEl.appendChild(el);
    el.animate(
      [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.3)', opacity: 0 }],
      { duration: 200, easing: 'ease-in', fill: 'forwards' },
    ).onfinish = () => el.remove();
  }

  // Create / update, in order
  const fresh = new Set();
  let prev = null;
  for (const entry of entries) {
    let el = live.get(entry.key);
    if (!el) {
      el = entry.kind === 'sep' ? createSep(entry) : createTile();
      live.set(entry.key, el);
      fresh.add(entry.key);
    }
    if (entry.kind === 'tile') {
      const oldType = el._typeId;
      updateTile(el, entry, animate && !fresh.has(entry.key));
      if (el === hoverEl && oldType !== el._typeId) showHover(el);   // stack moved to the next rarity
    }
    const ref = prev ? prev.nextSibling : gridEl.firstChild;
    if (ref !== el) gridEl.insertBefore(el, ref);
    prev = el;
  }

  // Empty message
  let emptyEl = gridEl.querySelector('.inv-empty');
  if (entries.length === 0) {
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'inv-empty';
      gridEl.appendChild(emptyEl);
    }
    emptyEl.textContent = searchTerm ? 'No petals match your search' : 'Your inventory is empty';
  } else if (emptyEl) {
    emptyEl.remove();
  }

  if (mode === 'instant') return;

  // Animate: new ones pop in, moved ones slide from where they were
  let i = 0;
  for (const [key, el] of live) {
    if (fresh.has(key) || mode === 'intro') {
      el.animate(
        [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 260, easing: EASE_POP, fill: 'backwards',
          delay: mode === 'intro' ? Math.min(i++ * 18, 320) : 0 });
      continue;
    }
    const a = before.get(key);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 280, easing: EASE_OUT });
    }
  }
}

/** Throws away every tile and rebuilds with the intro animation. */
function rebuildGrid() {
  for (const el of live.values()) el.remove();
  live.clear();
  ghostsEl.innerHTML = '';
  syncGrid('intro');
}

function setStackMode(on) {
  stackMode = on;
  try { localStorage.setItem(LS_STACK, on ? '1' : '0'); } catch {}
  stackBtn?.setAttribute('aria-pressed', String(on));
  invPanel?.classList.toggle('stacked', on);
  if (invOpen) rebuildGrid(); else dirty = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Positioning
// ─────────────────────────────────────────────────────────────────────────────
export function positionInvButton() {
  const btn = document.getElementById('inv-toggle-btn');
  if (!btn) return;
  btn.style.left = '16px';
  btn.style.top  = Math.round(window.innerHeight * 0.68 - 27) + 'px';
}

export function positionInvPanel() {
  if (!invPanel) return;
  const btn = document.getElementById('inv-toggle-btn');
  if (!btn) return;
  const btnRect = btn.getBoundingClientRect();
  const panelH  = invPanel.offsetHeight;
  const screenH = window.innerHeight;
  let top = btnRect.top;
  if (top + panelH > screenH - 8) top = screenH - 8 - panelH;
  if (top < 8) top = 8;
  invPanel.style.left = Math.round(btnRect.right + 10) + 'px';
  invPanel.style.top  = Math.round(top) + 'px';
}

// ─────────────────────────────────────────────────────────────────────────────
// Open / close (called by the panel registry — use togglePanel('inventory'))
// ─────────────────────────────────────────────────────────────────────────────
function openInv() {
  invOpen = true;
  invPanel.classList.add('open');
  rebuildGrid();
  positionInvPanel();
}

function closeInv() {
  invOpen = false;
  invPanel.classList.remove('open');
  clearHover();
}

function showHover(tile) {
  hovering = true; hoverEl = tile;
  const r = tile.getBoundingClientRect(), pr = invPanel.getBoundingClientRect();
  setPetalHover(tile.dataset.typeId, { x: pr.right, y: r.top, w: 0, h: r.height });
}

function clearHover() {
  if (!hovering && !hoverEl) return;
  hovering = false; hoverEl = null;
  setPetalHover(null, null);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function ensureInvDOM() {
  if (invPanel) return;

  invPanel = document.createElement('div');
  invPanel.id = 'inv-panel';
  invPanel.classList.toggle('stacked', stackMode);
  invPanel.addEventListener('mousedown', e => e.stopPropagation());
  invPanel.innerHTML = `
    <div class="inv-hdr">
      <span class="inv-title">Inventory</span>
      <button class="inv-close">✕</button>
    </div>
    <div class="inv-tools">
      <input class="inv-search" type="text" placeholder="Search petals…" autocomplete="off" spellcheck="false"/>
      <button class="inv-stack-btn" aria-pressed="${stackMode}">
        <span class="inv-stack-box"></span>Stack
      </button>
    </div>
    <div id="inv-scroll"><div class="inv-content"><div class="inv-grid"></div><div class="inv-ghosts"></div></div></div>
  `;
  document.body.appendChild(invPanel);

  invScroll = invPanel.querySelector('#inv-scroll');
  contentEl = invPanel.querySelector('.inv-content');
  gridEl    = invPanel.querySelector('.inv-grid');
  ghostsEl  = invPanel.querySelector('.inv-ghosts');
  stackBtn  = invPanel.querySelector('.inv-stack-btn');

  invPanel.querySelector('.inv-close').addEventListener('click', () => closePanel('inventory'));
  stackBtn.addEventListener('click', () => setStackMode(!stackMode));

  const searchEl = invPanel.querySelector('.inv-search');
  searchEl.addEventListener('input', () => {
    searchTerm = searchEl.value.trim().toLowerCase();
    if (invOpen) syncGrid('live'); else dirty = true;
  });
  searchEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') searchEl.blur();
  });

  // Toolbar button
  let invBtn = document.getElementById('inv-toggle-btn');
  if (!invBtn) {
    invBtn = document.createElement('div');
    invBtn.id = 'inv-toggle-btn';
    const img = document.createElement('img');
    img.src = './public/icons/inventory.png'; img.draggable = false;
    invBtn.appendChild(img);
    document.body.appendChild(invBtn);
    invBtn.addEventListener('click', () => togglePanel('inventory'));
    invBtn.addEventListener('mousedown', e => e.stopPropagation());
  }
  positionInvButton();

  setInvSlotCSS(TILE);
  registerInvAccess({
    markDirty:    () => { dirty = true; },
    onDragCommit: typeId => { dragReserve = typeId; dirty = true; },
    onDragEnd:    ()     => { dragReserve = null;   dirty = true; },
    addIncoming:  (typeId, n) => {
      const v = (incoming.get(typeId) ?? 0) + n;
      if (v > 0) incoming.set(typeId, v); else incoming.delete(typeId);
      dirty = true;
    },
    getTargetRect: targetRectFor,
  });

  registerPanel('inventory', {
    open: openInv, close: closeInv, isOpen: () => invOpen,
    rootIds: ['inv-panel', 'inv-toggle-btn'],
  });

  // Click a tile → equip one into the first free slot
  gridEl.addEventListener('click', e => {
    if (drag.committed || getDragJustEnded()) return;
    const tile = e.target.closest('.inv-tile');
    if (tile?.dataset.typeId) equipFromInventory(tile.dataset.typeId);
  });

  // Hover tooltips
  gridEl.addEventListener('mousemove', e => {
    if (drag.committed) return;
    const tile = e.target.closest('.inv-tile');
    if (tile?.dataset.typeId) showHover(tile);
    else clearHover();
  });
  gridEl.addEventListener('mouseleave', clearHover);

  // Press on a tile → start a (not yet committed) drag of its top petal
  gridEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const tile = e.target.closest('.inv-tile');
    const typeId = tile?.dataset.typeId;
    if (!typeId || !PETAL_TYPES[typeId] || shownCount(typeId) <= 0) return;
    const r = tile.getBoundingClientRect();
    Object.assign(drag, {
      active: true, committed: false, slotIdx: -1, fromInv: true, fromBench: false,
      typeId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      srcRect: { x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Click-to-equip (petal flies from its tile to the slot)
// ─────────────────────────────────────────────────────────────────────────────
export function equipFromInventory(typeId) {
  const emptyTop   = player.hotbar.indexOf(null);
  const emptyBench = player.bench.indexOf(null);
  let row, idx;
  if (emptyTop !== -1)        { row = 'hotbar'; idx = emptyTop; }
  else if (emptyBench !== -1) { row = 'bench';  idx = emptyBench; }
  else return;

  const from = targetRectFor(typeId);
  if (!commands.equipFromInventory(player, typeId, row, idx)) return;
  dirty = true;
  if (from) flyPetal(typeId, from, row, idx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame tick (both the homescreen and game loops call this)
// ─────────────────────────────────────────────────────────────────────────────
export function updateInventory() {
  ensureInvDOM();

  if (_craft.isCraftingOpen()) _craft.positionPanel();
  if (!invOpen) return;

  if (dirty) syncGrid('live');

  // Animated icons (e.g. Powder) redraw every frame while visible
  for (const el of live.values()) {
    if (el._typeId && isAnimatedIcon(el._typeId)) drawTileIcon(el);
  }
}

/** Called when the game reports the local player's items changed (pickups, crafts…). */
export function notifyInventoryChanged() {
  dirty = true;
  if (_craft.isCraftingOpen()) _craft.renderPanel();
}
