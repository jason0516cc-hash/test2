/**
 * craftingPanel.js — the Crafting panel.
 *
 * Top: the crafting table — 5 tiles in a pentagon, drawn on one canvas
 * ("stage") together with the crafted result and the confetti.
 * Bottom: a rarity × petal grid of what you own, to pick petals from.
 *
 * How crafting works (rules in game/crafting.js + commands.js):
 *   the petals on the table are one pool, shown spread over the 5 tiles.
 *   Pressing Craft runs attempts of 5 while at least 5 are left — a success
 *   uses the 5 up and makes 1 petal of the next rarity, a failure loses 1-4
 *   and puts the rest back. The game resolves every attempt at once; this
 *   file then plays them back round by round:
 *     - the tiles orbit, a little faster every round (sometimes a lot faster)
 *     - fail:    a fast whirl, the lost tiles pop (confetti), the rest glide home
 *     - success: nothing pops yet — every success is collected at the end,
 *                when all the tiles collapse into the middle together and the
 *                crafted petal appears with its xN (it stays there until you
 *                pick another petal — it's already in your inventory)
 *   Afterwards the top-left shows attempts / crafted / burned.
 *   Leftovers (0-4) stay on the table; click more of the same petal to top
 *   up, or a different petal to swap (leftovers go back to the inventory).
 */

import { localPlayer as player } from '../localPlayer.js';
import { addToCraftHold, returnCraftHold, craftFromHold, getCraftHold } from '../../game/commands.js';
import { PETAL_TYPES }                                     from '../../shared/petalTypes.js';
import { RARITIES, raritySuffix, rarityFill, rarityBorder } from '../../shared/rarities.js';
import { setPetalHover }                                   from './petalTooltip.js';
import { canCraft, getNextTypeId, getChanceLabel }         from '../../game/crafting.js';
import { drawPetalBox, getDragJustEnded, flyPetalTo }      from './hotbar.js';
import { registerCraftingWithInv, markInventoryDirty }     from './inventoryPanel.js';
import { enableDragPan } from './dragPan.js';
import { registerPanel, togglePanel, closePanel }          from './panels.js';

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
const PANEL_W = 420;
const STAGE_H = 164;

(function injectCraftingStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #crafting-btn {
      position: fixed; width: 54px; height: 54px; border-radius: 10px;
      background: #da9b5b; border: 3px solid #986c40;
      cursor: pointer; z-index: 101;
      display: flex; align-items: center; justify-content: center;
      padding: 5px; box-sizing: border-box; user-select: none;
    }
    #crafting-btn:active { transform: scale(0.95); }
    #crafting-btn img { width: 175%; height: 140%; object-fit: contain; display: block; mix-blend-mode: screen; }

    #crafting-panel {
      position: fixed; width: ${PANEL_W}px; display: flex; flex-direction: column;
      background: #da9b5b; border: 3px solid #986c40; border-radius: 14px;
      font-family: 'UbuntuCustom', 'Ubuntu', Arial, sans-serif;
      z-index: 100; user-select: none; opacity: 0; pointer-events: none;
      transform: translateY(calc(100% + 24px)); transform-origin: left bottom;
      transition: opacity 0.22s cubic-bezier(0.22,1,0.36,1), transform 0.22s cubic-bezier(0.22,1,0.36,1);
      overflow: hidden;
    }
    #crafting-panel.open { opacity: 1; pointer-events: auto; transform: translateY(0); }

    #crafting-panel .cr-hdr {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      position: relative; padding: 8px 10px 0;
    }
    #crafting-panel .cr-title {
      color: #fff; font-size: 18px; font-weight: 900; letter-spacing: 1px;
      -webkit-text-stroke: 3px #000; paint-order: stroke fill;
    }
    #crafting-panel .cr-close {
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      background: #c1565e; border: 2px solid #90464b; border-radius: 6px;
      color: #fff; cursor: pointer; font-size: 13px; font-weight: 900;
      width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
      padding: 0; line-height: 1; font-family: inherit; transition: background 0.12s;
    }
    #crafting-panel .cr-close:hover { background: #a03040; }

    /* Crafting table: canvas stage + controls on the right */
    #crafting-panel .cr-craft-area { position: relative; height: ${STAGE_H}px; flex-shrink: 0; }
    #crafting-panel .cr-stage { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    #crafting-panel .cr-side {
      position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
      width: 108px; display: flex; flex-direction: column; align-items: center; gap: 6px;
      pointer-events: none;
    }
    #crafting-panel .cr-craft-btn {
      pointer-events: auto;
      width: 96px; padding: 7px 0; background: #888; border: 3px solid #666;
      border-radius: 7px; color: #fff; font-size: 13px; font-weight: 900; font-family: inherit;
      -webkit-text-stroke: 2.5px #000; paint-order: stroke fill;
      cursor: pointer; transition: filter 0.12s, transform 0.08s;
    }
    #crafting-panel .cr-craft-btn:hover:not(:disabled) { filter: brightness(1.1); }
    #crafting-panel .cr-craft-btn:active:not(:disabled) { transform: scale(0.95); }
    #crafting-panel .cr-craft-btn:disabled { cursor: default; opacity: 0.85; }
    #crafting-panel .cr-hint {
      font-size: 10.5px; font-weight: 900; color: #fff; text-align: center; line-height: 1.25;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }
    #crafting-panel .cr-stats {
      position: absolute; left: 10px; top: 6px; z-index: 2; pointer-events: none;
      font-size: 11px; font-weight: 900; color: #fff; line-height: 1.4;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
      opacity: 0; transform: translateY(-4px); transition: opacity 0.2s, transform 0.2s;
    }
    #crafting-panel .cr-stats.show { opacity: 1; transform: none; }

    #crafting-panel .cr-divider { height: 2px; background: #986c40; margin: 0 10px; }
    #crafting-panel .cr-inv-bar {
      display: flex; align-items: center; justify-content: space-between; padding: 6px 10px 4px 12px;
    }
    #crafting-panel .cr-search {
      width: 150px; box-sizing: border-box; padding: 4px 9px;
      background: #c8874a; border: 2px solid #986c40; border-radius: 7px;
      color: #fff; font-family: inherit; font-size: 11.5px; font-weight: 700; outline: none;
      transition: border-color 0.15s, background 0.15s;
    }
    #crafting-panel .cr-search::placeholder { color: rgba(255,255,255,0.7); }
    #crafting-panel .cr-search:focus { border-color: #fff; }
    #crafting-panel .cr-inv-label {
      font-size: 12px; font-weight: 900; color: #fff;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }

    /* Rarity × petal grid */
    #crafting-panel .cr-grid-area { display: flex; flex-direction: column; padding: 0 0 6px; gap: 2px; }
    #crafting-panel .cr-grid-scroll { height: 240px; overflow-y: auto; overflow-x: hidden; }
    #crafting-panel .cr-grid-scroll { scrollbar-width: none; }
    #crafting-panel .cr-grid-scroll::-webkit-scrollbar { display: none; }
    #crafting-panel .cr-slots {
      position: relative; display: flex; flex-direction: column; gap: 5px;
      padding: 5px 6px 8px 8px; will-change: transform; width: max-content;
    }
    #crafting-panel .cr-row {
      display: grid; grid-template-columns: repeat(${RARITIES.length}, var(--cr-slot-w, 46px));
      gap: 5px; transform-origin: left top;
    }
    #crafting-panel .cr-row-ghosts { position: absolute; left: 8px; top: 0; pointer-events: none; }
    #crafting-panel .cr-row-ghosts .cr-row { transform-origin: left center; }
    #crafting-panel .cr-grid-empty {
      padding: 26px 0; width: 380px; text-align: center; font-size: 12px; font-weight: 900; color: #fff;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }
    #crafting-panel .cr-simple {
      position: absolute; left: 12px; bottom: 8px;
      display: flex; align-items: center; gap: 7px; cursor: pointer;
      font-size: 12px; font-weight: 900; color: #fff;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }
    #crafting-panel .cr-simple-box {
      width: 15px; height: 15px; box-sizing: border-box; border-radius: 4px;
      border: 2px solid #000; background: rgba(0,0,0,0.18);
      transition: background 0.12s;
    }
    #crafting-panel .cr-simple.on .cr-simple-box { background: #fff; }

    #crafting-panel .cr-slot {
      aspect-ratio: 1; background: #986c40; border-radius: 6px;
      overflow: hidden; position: relative; box-sizing: border-box;
      cursor: default; min-width: 0;
    }
    #crafting-panel .cr-slot.craftable { cursor: pointer; }
    #crafting-panel .cr-slot.craftable:hover { filter: brightness(1.08); }
    #crafting-panel .cr-slot.cr-empty  { opacity: 0.35; }
    #crafting-panel .cr-slot canvas    { display: block; width: 100% !important; height: 100% !important; pointer-events: none; }
    #crafting-panel .cr-slot-cnt {
      position: absolute; top: 3px; right: 3px;
      font-size: 9px; font-weight: 900; color: #fff;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
      pointer-events: none; line-height: 1; z-index: 5;
      transform: rotate(15deg); transform-origin: top right;
    }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────────────────────
// Panel state
// ─────────────────────────────────────────────────────────────────────────────
let craftingPanelOpen = false;
let craftingPanel     = null;
let stage = null, sctx = null, stageW = PANEL_W - 6;

export function isCraftingOpen() { return craftingPanelOpen; }

// ─────────────────────────────────────────────────────────────────────────────
// Table layout — ring mostly centred, nudged left of centre
// ─────────────────────────────────────────────────────────────────────────────
const TILE    = 37;
const RING_R  = 46;
const RESULT  = 42;   // crafted petal in the middle
function ringCenter() { return { x: stageW / 2 - 24, y: STAGE_H / 2 + 4 }; }
function homeOf(i) {
  const c = ringCenter(), a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
  return { x: c.x + Math.cos(a) * RING_R, y: c.y + Math.sin(a) * RING_R };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table state (what the stage draws)
// ─────────────────────────────────────────────────────────────────────────────
const table = {
  typeId: null,     // petal on the table
  pool:   0,        // how many are shown on the table
  slots: Array.from({ length: 5 }, (_, i) => ({
    count: 0, x: 0, y: 0, scale: 0, spinT: 1, bounceT: 1, mode: 'home',
  })),
  result: null,     // { typeId, count, popT, bounceT } — last crafted petal, stays until unselected
  crafting: false,  // a craft is being played back
  orbit: { angle: 0, radius: 1 },
  holderAlpha: 1,   // the empty holders fade out while a craft plays
  holders: [1, 1, 1, 1, 1],   // per holder: 1 = in place, 0 = tucked away behind the middle
  simpleView: false,          // after a Simple craft: only the tile holding leftovers shows
  summary: null,    // { attempts, crafted, burned } of the last craft
};
const particles = [];
let muteFx = false;   // true while skipping to the end of a craft

// "Simple Crafting": one quick spin, everything resolved at once
const LS_SIMPLE = 'simpleCrafting';
let simpleCrafting = false;
try { simpleCrafting = localStorage.getItem(LS_SIMPLE) === '1'; } catch {}

// Petals flying from the table back to the grid — counted when they land
const gridIncoming = new Map();

function distribute(pool) {
  // Simple view: all leftovers sit together in one tile
  if (table.simpleView) return [pool, 0, 0, 0, 0];
  // Spread the pool over the 5 tiles; the odd ones out go to tiles that are
  // already showing, so survivors keep their spot instead of hopping around.
  const base = Math.floor(pool / 5), extra = pool % 5;
  const order = table.slots.map((s, i) => i)
    .sort((a, b) => (table.slots[b].count > 0) - (table.slots[a].count > 0) || a - b);
  const counts = new Array(5).fill(base);
  for (let k = 0; k < extra; k++) counts[order[k]]++;
  return counts;
}

/** Shows `pool` petals on the tiles. A tile that wasn't showing spins in
 *  (box and all) to fill its holder; a tile that was just gets its xN bounce. */
function setPool(pool, { spin = true } = {}) {
  table.pool = pool;
  const counts = distribute(pool);
  table.slots.forEach((s, i) => {
    const was = s.count;
    s.count = counts[i];
    if (s.count > 0 && (was === 0 || s.scale < 0.05)) {
      const h = homeOf(i);
      Object.assign(s, { x: h.x, y: h.y, scale: 1, mode: 'home', spinT: spin ? 0 : 1 });
    } else if (s.count > 0 && s.count !== was) {
      s.bounceT = 0;
    }
  });
}

function resetSlotsHome() {
  table.slots.forEach((s, i) => { const h = homeOf(i); s.x = h.x; s.y = h.y; s.mode = 'home'; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Confetti
// ─────────────────────────────────────────────────────────────────────────────
function burst(x, y, color, n = 14, power = 1) {
  if (muteFx) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = (90 + Math.random() * 170) * power;
    particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 18,
      w: 3 + Math.random() * 4, h: 2 + Math.random() * 3,
      color, life: 0, maxLife: 420 + Math.random() * 320,
    });
  }
}

function stepParticles(dt) {
  const s = dt / 1000;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
    p.vx *= Math.pow(0.08, s); p.vy = p.vy * Math.pow(0.08, s) + 380 * s;
    p.x += p.vx * s; p.y += p.vy * s; p.rot += p.vr * s;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Craft playback — a queue of timed steps
// ─────────────────────────────────────────────────────────────────────────────
let steps = [];          // [{ dur, tick(t), end() }]
let stepT = 0;
let orbitSpeed = 0;      // rad/s while orbiting

function queue(dur, tick = null, end = null) { steps.push({ dur, tick, end }); }

function runSteps(dt) {
  let left = dt;
  while (steps.length && left > 0) {
    const st = steps[0];
    const use = Math.min(left, st.dur - stepT);
    stepT += use; left -= use;
    st.tick?.(st.dur ? Math.min(1, stepT / st.dur) : 1, use);
    if (stepT >= st.dur) { steps.shift(); stepT = 0; st.end?.(); }
    else break;
  }
}

const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

function playCraft(res) {
  if (simpleCrafting) return playCraftSimple(res);
  table.crafting = true;
  table.summary  = null;
  const srcColor = rarityFill(PETAL_TYPES[res.typeId].rarity);
  const outColor = res.nextTypeId ? rarityFill(PETAL_TYPES[res.nextTypeId].rarity) : '#fff';
  // The tiles keep showing the petals of successful attempts until the end,
  // so they only lose what failures burn.
  let shown = res.startCount;

  const orbitRound = (speed) => {
    const d = ms => Math.max(40, ms / speed);
    const w = Math.PI * 2 * 1.1 * speed;   // rad/s
    queue(d(260), t => {
      orbitSpeed = w * easeInOut(t);
      table.orbit.radius = 1 - 0.2 * easeInOut(t);
      table.slots.forEach(s => { if (s.count > 0) s.mode = 'orbit'; });
    });
    queue(d(900), () => { orbitSpeed = w; });
    return { d, w };
  };

  res.rounds.forEach((round, r) => {
    // Faster every round; now and then a round goes really fast
    const turbo = Math.random() < 0.22 ? 2.4 : 1;
    const speed = Math.min(8, (1 + 0.18 * r) * turbo);
    const { d, w } = orbitRound(speed);

    if (!round.success) {
      // Fail: a fast whirl, the lost tiles pop, the rest glide back home
      queue(d(380), t => { orbitSpeed = w * (1 + 2.6 * t); });
      queue(0, null, () => {
        const filled = table.slots.map((s, i) => i).filter(i => table.slots[i].count > 0);
        const lostIdx = filled.sort(() => Math.random() - 0.5).slice(0, round.lost);
        for (const i of lostIdx) {
          const s = table.slots[i];
          burst(s.x, s.y, srcColor, 14);
          s.scale = 0; s.count = 0;
        }
        shown -= round.lost;
      });
    } else {
      queue(d(200), t => { orbitSpeed = w * (1 + t); });
    }
    queue(0, null, () => {
      orbitSpeed = 0; table.orbit.radius = 1;
      table.slots.forEach(s => { s.mode = 'home'; });   // glide back (see stepSlots)
    });
    queue(d(320), null, () => { table.orbit.angle = 0; setPool(shown); });
    queue(d(200));
  });

  // Every success at once: all tiles collapse into the middle together
  if (res.successCount > 0) {
    const { d, w } = orbitRound(Math.min(8, 1 + 0.18 * res.rounds.length));
    queue(d(300), t => { table.orbit.radius = 0.8 * (1 - easeInOut(t)); orbitSpeed = w * (1 + t); }, () => {
      const c = ringCenter();
      table.slots.forEach(s => {
        if (s.count > 0 && s.scale > 0.05) burst(s.x, s.y, srcColor, 10);
        s.scale = 0; s.count = 0; s.mode = 'home';
      });
      burst(c.x, c.y, outColor, 30, 1.25);
      table.result = { typeId: res.nextTypeId, count: res.successCount, popT: 0, bounceT: 0 };
      orbitSpeed = 0; table.orbit.radius = 1; table.orbit.angle = 0;
      resetSlotsHome();
      table.pool = 0;
    });
    queue(250);
  }

  queue(0, null, () => {
    table.crafting = false;
    table.typeId = res.left > 0 ? res.typeId : null;
    setPool(res.left);   // leftovers spin back into their holders
    table.summary = { attempts: res.rounds.length, crafted: res.successCount, burned: res.lostTotal };
    updateSide();
    renderCraftingInv();
  });
}

/** Simple Crafting: one quick spin, then every loss and every success at once. */
function playCraftSimple(res) {
  table.crafting = true;
  table.summary  = null;
  const srcColor = rarityFill(PETAL_TYPES[res.typeId].rarity);
  const outColor = res.nextTypeId ? rarityFill(PETAL_TYPES[res.nextTypeId].rarity) : '#fff';
  const speed = Math.random() < 0.22 ? 2.4 : 1.4;
  const d = ms => Math.max(40, ms / speed);
  const w = Math.PI * 2 * 1.1 * speed;

  queue(d(220), t => {
    orbitSpeed = w * easeInOut(t);
    table.orbit.radius = 1 - 0.2 * easeInOut(t);
    table.slots.forEach(s => { if (s.count > 0) s.mode = 'orbit'; });
  });
  queue(d(600), () => { orbitSpeed = w; });
  queue(d(300), t => {
    orbitSpeed = w * (1 + 2.6 * t);
    if (res.successCount > 0) table.orbit.radius = 0.8 * (1 - easeInOut(t));
  }, () => {
    const c = ringCenter();
    if (res.successCount > 0) {
      // Success: everything collapses into the crafted petal
      table.slots.forEach(s => {
        if (s.count > 0 && s.scale > 0.05) burst(s.x, s.y, srcColor, 12);
        s.scale = 0; s.count = 0; s.mode = 'home';
      });
      burst(c.x, c.y, outColor, 30, 1.25);
      table.result = { typeId: res.nextTypeId, count: res.successCount, popT: 0, bounceT: 0 };
      resetSlotsHome();
    } else {
      // Fail: 1-4 tiles survive with one petal each and glide back to their
      // spots; the rest pop
      const filled = table.slots.map((s, i) => i).filter(i => table.slots[i].count > 0)
        .sort(() => Math.random() - 0.5);
      filled.forEach((i, k) => {
        const s = table.slots[i];
        if (k < res.left) { if (s.count !== 1) s.bounceT = 0; s.count = 1; }
        else { burst(s.x, s.y, srcColor, 12); s.scale = 0; s.count = 0; }
        s.mode = 'home';
      });
    }
    orbitSpeed = 0; table.orbit.radius = 1; table.orbit.angle = 0;
    table.pool = res.successCount > 0 ? 0 : res.left;
  });
  queue(d(260));
  queue(0, null, () => {
    // On a success the leftovers don't come back as tiles — they go straight home,
    // and the holders tuck away behind the crafted petal
    let left = res.left;
    if (res.successCount > 0 && left > 0) { returnCraftHold(player); left = 0; markInventoryDirty(); }
    table.simpleView = res.successCount > 0;
    table.crafting = false;
    table.typeId = left > 0 ? res.typeId : null;
    setPool(left);
    table.summary = { attempts: res.rounds.length, crafted: res.successCount, burned: res.lostTotal };
    updateSide();
    renderCraftingInv();
  });
}

/** Leaves the Simple view: every holder slides back into place. */
function exitSimpleView() {
  if (!table.simpleView) return;
  table.simpleView = false;
}

/** Jumps a running playback to its end (Skip, or closing the panel). */
function finishPlayback() {
  if (!steps.length) return;
  muteFx = true;
  while (steps.length) { const st = steps.shift(); stepT = 0; st.end?.(); }
  muteFx = false;
  orbitSpeed = 0; table.orbit.radius = 1; table.orbit.angle = 0;
  resetSlotsHome();
  table.slots.forEach(s => { if (s.count > 0) { s.scale = 1; s.spinT = 1; } });
  table.holderAlpha = 1;
  if (table.result) table.result.popT = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage drawing
// ─────────────────────────────────────────────────────────────────────────────
let rafId = null, lastT = 0;

function stepSlots(dt) {
  const k = 1 - Math.pow(1 - 0.22, dt / 16.67);
  table.orbit.angle += orbitSpeed * dt / 1000;
  const c = ringCenter();
  table.slots.forEach((s, i) => {
    if (s.mode === 'orbit') {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 5) + table.orbit.angle;
      s.x = c.x + Math.cos(a) * RING_R * table.orbit.radius;
      s.y = c.y + Math.sin(a) * RING_R * table.orbit.radius;
    } else {
      const h = homeOf(i);
      s.x += (h.x - s.x) * k; s.y += (h.y - s.y) * k;
    }
    if (s.spinT < 1)   s.spinT   = Math.min(1, s.spinT + dt / 420);
    if (s.bounceT < 1) s.bounceT = Math.min(1, s.bounceT + dt / 260);
  });
  const ha = table.crafting ? 0 : 1;
  table.holderAlpha += (ha - table.holderAlpha) * k;
  const kh = 1 - Math.pow(1 - 0.16, dt / 16.67);
  table.holders.forEach((h, i) => {
    const want = table.simpleView ? (table.slots[i].count > 0 ? 1 : 0) : 1;
    table.holders[i] = h + (want - h) * kh;
  });
  const r = table.result;
  if (r) {
    if (r.popT < 1)    r.popT    = Math.min(1, r.popT + dt / 380);
    if (r.bounceT < 1) r.bounceT = Math.min(1, r.bounceT + dt / 260);
  }
}

function drawBadge(ctx, x, y, text, size, bounceT) {
  if (size < 3) return;
  const b = bounceT < 1 ? 1 + 0.45 * Math.sin(bounceT * Math.PI) : 1;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(0.26); ctx.scale(b, b);
  ctx.font = `900 ${size}px "UbuntuCustom","Ubuntu",Arial,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000'; ctx.lineWidth = size * 0.28; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** A petal tile (box + art), optionally rotated as a whole. */
function drawTile(ctx, typeId, x, y, size, rot = 0) {
  if (!PETAL_TYPES[typeId] || size < 10) return;   // too small to draw the art (mid-pop)
  ctx.save();
  ctx.translate(x, y);
  if (rot) ctx.rotate(rot);
  drawPetalBox(ctx, -size / 2, -size / 2, size, typeId, 0, 0);
  ctx.restore();
}

function drawStage(dt) {
  if (!sctx) return;
  const ctx = sctx;
  ctx.clearRect(0, 0, stageW, STAGE_H);

  // Holders — the tiles petals sit in; hidden while a craft plays, tucked
  // behind the middle in the Simple view and sliding back out afterwards
  if (table.holderAlpha > 0.01) {
    const c = ringCenter();
    ctx.save();
    for (let i = 0; i < 5; i++) {
      const t = table.holders[i];
      if (t < 0.02) continue;
      const e = 1 - Math.pow(1 - t, 3);
      const h = homeOf(i);
      const hs = (TILE + 6) * (0.4 + 0.6 * e);
      const x = c.x + (h.x - c.x) * e, y = c.y + (h.y - c.y) * e;
      ctx.globalAlpha = table.holderAlpha * Math.min(1, t * 1.4);
      ctx.beginPath(); ctx.roundRect(x - hs / 2, y - hs / 2, hs, hs, 8);
      ctx.fillStyle = '#b17f49'; ctx.fill();
    }
    ctx.restore();
  }

  // Crafted result in the middle
  const r = table.result;
  if (r) {
    const c = ringCenter();
    const p = r.popT, over = p < 1 ? 1 + Math.sin(p * Math.PI) * 0.25 : 1;
    const size = RESULT * Math.min(1, p * 1.6) * over;
    if (size > 1) {
      const sz = size * (1 + 0.045 * Math.sin(performance.now() / 280));   // gentle breathing
      drawTile(ctx, r.typeId, c.x, c.y, sz, 0.14);
      // the xN grows, shrinks and breathes with the tile
      if (r.count > 1) drawBadge(ctx, c.x + sz * 0.4, c.y - sz * 0.4, 'x' + r.count, 11 * sz / RESULT, r.bounceT);
    }
  }

  // Tiles on the table
  if (table.typeId) {
    table.slots.forEach(s => {
      if (s.count <= 0 || s.scale < 0.02) return;
      // Spin-in: the whole tile turns while growing to fill its holder
      const e = s.spinT < 1 ? 1 - Math.pow(1 - s.spinT, 3) : 1;
      const size = TILE * s.scale * e;
      drawTile(ctx, table.typeId, s.x, s.y, size, (e - 1) * Math.PI * 2);
      if (s.count > 1) drawBadge(ctx, s.x + size * 0.42, s.y - size * 0.42, 'x' + s.count, 10 * size / TILE, s.bounceT);
    });
  }

  // Confetti
  for (const p of particles) {
    const a = 1 - p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a * 1.6);
    ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
}

function frame(now) {
  const dt = Math.min(50, now - (lastT || now));
  lastT = now;
  try {
    runSteps(dt);
    stepSlots(dt);
    stepParticles(dt);
    drawStage(dt);
    stepGridScroll(dt);
  } finally {
    // keep animating even if one frame throws, so a craft can never get stuck
    rafId = craftingPanelOpen ? requestAnimationFrame(frame) : null;
  }
}

function sizeStage() {
  if (!stage) return;
  const dpr = window.devicePixelRatio || 1;
  stageW = stage.clientWidth || (PANEL_W - 6);
  stage.width = Math.round(stageW * dpr); stage.height = Math.round(STAGE_H * dpr);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Positioning
// ─────────────────────────────────────────────────────────────────────────────
export function positionCraftingButton() {
  const btn    = document.getElementById('crafting-btn');
  const invBtn = document.getElementById('inv-toggle-btn');
  if (!btn || !invBtn) return;
  const invRect = invBtn.getBoundingClientRect();
  btn.style.left = invRect.left + 'px';
  btn.style.top  = Math.round(invRect.bottom + 10) + 'px';
}

export function positionCraftingPanel() {
  if (!craftingPanel) return;
  const btn = document.getElementById('crafting-btn');
  if (!btn) return;
  const btnRect = btn.getBoundingClientRect();
  const panelH  = craftingPanel.offsetHeight;
  const screenH = window.innerHeight;
  let panelTop  = btnRect.top;
  if (panelTop + panelH > screenH - 8) panelTop = screenH - 8 - panelH;
  if (panelTop < 8) panelTop = 8;
  craftingPanel.style.left = Math.round(btnRect.right + 10) + 'px';
  craftingPanel.style.top  = Math.round(panelTop)  + 'px';
}

// ─────────────────────────────────────────────────────────────────────────────
// Open / close (called by the panel registry — use togglePanel('crafting'))
// ─────────────────────────────────────────────────────────────────────────────
export function toggleCraftingPanel() { togglePanel('crafting'); }

function openCraftingPanel() {
  craftingPanelOpen = true;
  craftingPanel.classList.add('open');
  positionCraftingPanel();
  requestAnimationFrame(() => {
    sizeStage();
    syncTableFromGame();
    renderCraftingPanel();
    if (!rafId) { lastT = 0; rafId = requestAnimationFrame(frame); }
  });
}

export function closeCraftingPanel() {
  craftingPanelOpen = false;
  if (craftingPanel) craftingPanel.classList.remove('open');
  setPetalHover(null, null);
  // Finish any playback and hand leftovers back to the inventory
  finishPlayback();
  particles.length = 0;
  if (getCraftHold(player).count > 0) returnCraftHold(player);
  if (table.result) releaseCrafted(table.result.typeId, table.result.count);
  table.typeId = null; table.result = null; table.summary = null;
  table.simpleView = false; table.holders.fill(1);
  setPool(0, { spin: false });
  markInventoryDirty();
}

/** Makes the table match what the game has on it (e.g. after reopening). */
function syncTableFromGame() {
  if (table.crafting) return;
  const hold = getCraftHold(player);
  table.typeId = hold.count > 0 ? hold.typeId : null;
  if (hold.count !== table.pool) setPool(hold.count);
}

// ─────────────────────────────────────────────────────────────────────────────
// Putting petals on the table
// ─────────────────────────────────────────────────────────────────────────────
function onGridPetalClick(e, typeId) {
  if (getDragJustEnded() || table.crafting) return;
  const avail = player.inventory[typeId] ?? 0;
  if (avail < 1 || !canCraft(typeId)) return;

  // A different petal: leftovers go back, the old result is dismissed
  if (table.typeId && table.typeId !== typeId) returnTableToGrid();
  if (table.result && table.result.typeId !== typeId) dismissResult();
  table.summary = null;

  exitSimpleView();
  // Click adds a set of 5 (or what's left); Shift+click adds everything
  const want  = e.shiftKey ? avail : Math.min(5, avail);
  const moved = addToCraftHold(player, typeId, want);
  if (!moved) return;
  table.typeId = typeId;
  setPool(getCraftHold(player).count);   // new tiles spin in, counts bounce
  markInventoryDirty();
  renderCraftingPanel();
}

/** Clicking the table: a tile takes everything back, the result dismisses itself. */
function onStageClick(e) {
  if (table.crafting) { finishPlayback(); return; }
  const rect = stage.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  const hit = table.slots.some(s => s.count > 0 && Math.abs(x - s.x) <= TILE / 2 && Math.abs(y - s.y) <= TILE / 2);
  if (hit && table.typeId) {
    returnTableToGrid();
    table.summary = null;
    markInventoryDirty();
    renderCraftingPanel();
    return;
  }
  const c = ringCenter();
  if (table.result && Math.abs(x - c.x) <= RESULT / 2 && Math.abs(y - c.y) <= RESULT / 2) {
    dismissResult();
    table.summary = null;
    renderCraftingPanel();
  }
}

/** Where a petal flying back lands: its tile in the grid (or the grid itself if scrolled away). */
function gridTargetRect(typeId) {
  const scroll = craftingPanel?.querySelector('.cr-grid-scroll');
  if (!scroll) return { x: 0, y: 0, size: 0, alpha: 0 };
  const sr = scroll.getBoundingClientRect();
  const el = scroll.querySelector(`.cr-slot[data-type-id="${typeId}"]`);
  if (el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx >= sr.left && cx <= sr.right && cy >= sr.top && cy <= sr.bottom) return { x: cx, y: cy, size: r.width };
  }
  return { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2, size: 24, alpha: 0 };
}

/** Screen-space tiles currently showing on the table (for flights). */
function visibleTableTiles() {
  const rect = stage.getBoundingClientRect();
  return table.slots
    .filter(s => s.count > 0 && s.scale > 0.05)
    .map(s => ({ x: rect.left + s.x, y: rect.top + s.y, size: TILE * s.scale, n: s.count }));
}

/** Takes everything off the table: each tile spins back into its grid tile. */
function returnTableToGrid() {
  const typeId = table.typeId;
  exitSimpleView();
  if (!typeId) return;
  const tiles = visibleTableTiles();
  const total = getCraftHold(player).count;
  if (craftingPanelOpen && total > 0) gridIncoming.set(typeId, (gridIncoming.get(typeId) ?? 0) + total);
  returnCraftHold(player);
  table.typeId = null;
  setPool(0, { spin: false });
  if (!craftingPanelOpen || total <= 0) return;
  let landed = 0;
  tiles.forEach((t, i) => {
    flyPetalTo(typeId, t, () => gridTargetRect(typeId), {
      dur: 420, delay: i * 45, spin: 1, count: t.n,
      onLand: () => {
        const n = i === tiles.length - 1 ? total - landed : t.n;
        landed += n;
        const v = (gridIncoming.get(typeId) ?? 0) - n;
        if (v > 0) gridIncoming.set(typeId, v); else gridIncoming.delete(typeId);
        renderCraftingInv();
      },
    });
  });
  if (!tiles.length) { gridIncoming.delete(typeId); renderCraftingInv(); }
}

/** Unselects the crafted petal: it spins into its grid tile. */
function dismissResult() {
  const r = table.result;
  if (!r) return;
  table.result = null;
  exitSimpleView();
  const release = () => { releaseCrafted(r.typeId, r.count); renderCraftingInv(); };
  if (!craftingPanelOpen || r.popT < 0.5) { release(); return; }
  const rect = stage.getBoundingClientRect(), c = ringCenter();
  flyPetalTo(r.typeId, { x: rect.left + c.x, y: rect.top + c.y, size: RESULT }, () => gridTargetRect(r.typeId),
    { dur: 440, spin: 1, count: r.count, onLand: release });
}

/** Crafted petals are held out of the grid while they're the result in the middle. */
function holdCrafted(typeId, n) {
  if (typeId && n > 0) gridIncoming.set(typeId, (gridIncoming.get(typeId) ?? 0) + n);
}
function releaseCrafted(typeId, n) {
  const v = (gridIncoming.get(typeId) ?? 0) - n;
  if (v > 0) gridIncoming.set(typeId, v); else gridIncoming.delete(typeId);
}

function onCraftClick() {
  if (table.crafting) { finishPlayback(); return; }
  if (!table.typeId || table.pool < 5) return;
  exitSimpleView();
  table.crafting = true;   // before the game resolves it, so the table isn't re-synced mid-way
  // A result still showing from the last craft is replaced — let it go first
  if (table.result) { releaseCrafted(table.result.typeId, table.result.count); table.result = null; }
  const res = craftFromHold(player);
  if (!res) { table.crafting = false; return; }
  holdCrafted(res.nextTypeId, res.successCount);   // hidden in the grid until taken out
  renderCraftingInv();
  markInventoryDirty();
  playCraft(res);
  updateSide();
}

// ─────────────────────────────────────────────────────────────────────────────
// Right-hand controls
// ─────────────────────────────────────────────────────────────────────────────
function updateSide() {
  const btn   = craftingPanel?.querySelector('.cr-craft-btn');
  const hints = craftingPanel?.querySelectorAll('.cr-hint');
  const stats = craftingPanel?.querySelector('.cr-stats');
  if (!btn || !hints) return;

  const grey = () => { btn.style.background = '#888'; btn.style.borderColor = '#666'; };

  // Stats of the last craft — until petals are added or taken off the table
  const sm = !table.crafting && table.summary;
  stats.classList.toggle('show', !!sm);
  if (sm) {
    stats.innerHTML = `Attempts: ${sm.attempts}<br>Petals crafted: ${sm.crafted}<br>Petals burned: ${sm.burned}`;
  }

  if (table.crafting) {
    btn.disabled = false; btn.textContent = 'Skip'; grey();
    hints[0].textContent = 'Crafting…';
    hints[1].textContent = '';
    return;
  }
  btn.textContent = 'Craft';

  if (!table.typeId) {
    btn.disabled = true; grey();
    hints[0].textContent = table.summary ? '' : 'Click a petal to add it';
    hints[1].textContent = '';
    return;
  }

  const nextId = getNextTypeId(table.typeId);
  const ready  = table.pool >= 5;
  btn.disabled = !ready;
  if (ready && nextId) {
    const r = PETAL_TYPES[nextId].rarity;
    btn.style.background = rarityFill(r); btn.style.borderColor = rarityBorder(r);
  } else grey();
  hints[0].textContent = `${table.pool} petal${table.pool === 1 ? '' : 's'}`;
  hints[1].textContent = getChanceLabel(player, table.typeId) + ' success';
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid — one row per petal (A–Z), one column per rarity. Rows are built once
// and updated in place; the search box filters rows with the same slide/pop
// animation as the inventory. Scrolling (both ways) glides instead of jumping.
// ─────────────────────────────────────────────────────────────────────────────
const GRID_COLS = 8;       // rarity columns visible at once
const EASE_OUT = 'cubic-bezier(0.22,1,0.36,1)';
const EASE_POP = 'cubic-bezier(0.34,1.56,0.64,1)';

let gridX = 0, gridXTarget = 0;        // horizontal offset in px (animated → target)
let gridY = null, gridYTarget = 0;     // vertical wheel glide (null = not gliding)
let gridSearch = '';
const rows = new Map();                // baseId → { el, name, cells[] }
let rowOrder = [];                     // baseIds A–Z
let rowsPlaced = false;

function getCraftGridPetals() {
  const baseIds = new Map();
  for (const [typeId, pt] of Object.entries(PETAL_TYPES)) {
    if (!pt || pt.tier !== 0) continue;
    baseIds.set(pt.name, typeId);
  }
  return Array.from(baseIds.entries())
    .map(([name, baseId]) => ({ name, baseId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getTypeIdForBaseTier(baseId, tier) {
  const id = tier === 0 ? baseId : baseId + '_' + raritySuffix(tier);
  return PETAL_TYPES[id] ? id : null;
}

function getSlotCSS() { return Math.floor((PANEL_W - 6 - 8 - 6 - 7 * 5) / 8); }
function colStep()    { return getSlotCSS() + 5; }
function maxGridX()   { return Math.max(0, RARITIES.length - GRID_COLS) * colStep(); }

function gridEls() {
  return {
    slotsEl: craftingPanel?.querySelector('.cr-slots'),
    ghosts:  craftingPanel?.querySelector('.cr-row-ghosts'),
    scroll:  craftingPanel?.querySelector('.cr-grid-scroll'),
  };
}

function buildRows() {
  if (rows.size) return;
  for (const { name, baseId } of getCraftGridPetals()) {
    const el = document.createElement('div');
    el.className = 'cr-row';
    const cells = [];
    for (let tier = 0; tier < RARITIES.length; tier++) {
      const cell = document.createElement('div');
      const typeId = getTypeIdForBaseTier(baseId, tier);
      cell.className = 'cr-slot cr-empty';
      if (typeId) cell.dataset.typeId = typeId;
      el.appendChild(cell);
      cells.push({ el: cell, typeId, count: -1, cv: null, cnt: null });
    }
    rows.set(baseId, { el, name: name.toLowerCase(), cells });
    rowOrder.push(baseId);
  }
}

/** Updates every cell's petal/count in place (only redraws what changed). */
function updateCells() {
  const dpr = window.devicePixelRatio || 1, slotCSS = getSlotCSS();
  for (const row of rows.values()) {
    for (const c of row.cells) {
      const count = c.typeId ? Math.max(0, (player.inventory[c.typeId] ?? 0) - (gridIncoming.get(c.typeId) ?? 0)) : 0;
      if (count === c.count) continue;
      const had = c.count > 0;
      c.count = count;
      const craftable = count > 0 && canCraft(c.typeId);
      c.el.className = 'cr-slot' + (craftable ? ' craftable' : '') + (count === 0 ? ' cr-empty' : '');
      if (count > 0 && !c.cv) {
        c.cv = document.createElement('canvas');
        c.cv.width = c.cv.height = Math.round(slotCSS * dpr);
        const c2 = c.cv.getContext('2d');
        c2.scale(dpr, dpr);
        drawPetalBox(c2, 0, 0, slotCSS, c.typeId, 0, 0);
        c.el.appendChild(c.cv);
        if (had === false && c.el.isConnected) {
          c.cv.animate([{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
            { duration: 240, easing: EASE_POP });
        }
      } else if (count === 0 && c.cv) {
        c.cv.remove(); c.cv = null;
      }
      if (count > 1) {
        if (!c.cnt) { c.cnt = document.createElement('div'); c.cnt.className = 'cr-slot-cnt'; c.el.appendChild(c.cnt); }
        c.cnt.textContent = 'x' + count;
      } else if (c.cnt) { c.cnt.remove(); c.cnt = null; }
    }
  }
}

/** Shows the rows matching the search, animating rows in, out and into place. */
function syncRows(animate) {
  const { slotsEl, ghosts } = gridEls();
  if (!slotsEl) return;
  const wanted = rowOrder.filter(id => !gridSearch || rows.get(id).name.includes(gridSearch));
  const wantedSet = new Set(wanted);

  const before = new Map();
  if (animate) for (const [id, r] of rows) if (r.el.isConnected) before.set(id, r.el.offsetTop);

  // Rows leaving: a copy shrinks away where the row was
  for (const [id, r] of rows) {
    if (wantedSet.has(id) || !r.el.isConnected) continue;
    const top = r.el.offsetTop;
    r.el.remove();
    if (!animate) continue;
    const ghost = r.el.cloneNode(true);
    ghost.style.cssText = `position:absolute;left:0;top:${top}px;`;
    ghosts.appendChild(ghost);
    ghost.animate([{ opacity: 1, transform: 'scaleY(1)' }, { opacity: 0, transform: 'scaleY(0.4)' }],
      { duration: 180, easing: 'ease-in', fill: 'forwards' }).onfinish = () => ghost.remove();
  }

  // Put the wanted rows in order
  let prev = null;
  const fresh = [];
  for (const id of wanted) {
    const el = rows.get(id).el;
    if (!el.isConnected) fresh.push(id);
    const ref = prev ? prev.nextSibling : slotsEl.firstChild;
    if (ref !== el) slotsEl.insertBefore(el, ref);
    prev = el;
  }
  let empty = slotsEl.querySelector('.cr-grid-empty');
  if (!wanted.length) {
    if (!empty) { empty = document.createElement('div'); empty.className = 'cr-grid-empty'; slotsEl.appendChild(empty); }
    empty.textContent = 'No petals match';
  } else empty?.remove();

  if (!animate) return;
  fresh.forEach((id, i) => {
    rows.get(id).el.animate(
      [{ opacity: 0, transform: 'translateY(-6px) scaleY(0.6)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: EASE_POP, delay: Math.min(i * 22, 220), fill: 'backwards' });
  });
  for (const [id, top] of before) {
    const el = rows.get(id).el;
    if (!el.isConnected) continue;
    const dy = top - el.offsetTop;
    if (Math.abs(dy) > 0.5) {
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 260, easing: EASE_OUT });
    }
  }
}

function renderCraftingInv() {
  const { slotsEl } = gridEls();
  if (!slotsEl) return;
  buildRows();
  updateCells();
  if (!rowsPlaced) { rowsPlaced = true; syncRows(false); }
  slotsEl.style.setProperty('--cr-slot-w', getSlotCSS() + 'px');
}

/** Per-frame glide for both scroll directions. */
function stepGridScroll(dt) {
  const { slotsEl, scroll } = gridEls();
  if (!slotsEl) return;
  const k = 1 - Math.pow(1 - 0.2, dt / 16.67);

  gridXTarget = Math.max(0, Math.min(maxGridX(), gridXTarget));
  if (Math.abs(gridXTarget - gridX) > 0.3) {
    gridX += (gridXTarget - gridX) * k;
  } else gridX = gridXTarget;
  slotsEl.style.transform = `translateX(${-gridX}px)`;

  if (gridY !== null && scroll) {
    const maxY = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    gridYTarget = Math.max(0, Math.min(maxY, gridYTarget));
    gridY += (gridYTarget - gridY) * k;
    if (Math.abs(gridYTarget - gridY) < 0.5) gridY = gridYTarget;
    scroll.scrollTop = gridY;
    if (gridY === gridYTarget) gridY = null;
  }
}

function wireGridInput() {
  const { slotsEl, scroll } = gridEls();

  // No scrollbars: wheel (Shift / trackpad for sideways) or click-and-drag
  let panFrom = null;
  enableDragPan(scroll, {
    start: () => { panFrom = { x: gridXTarget, y: scroll.scrollTop }; gridY = scroll.scrollTop; },
    move: (dx, dy) => { gridXTarget = panFrom.x - dx; gridYTarget = panFrom.y - dy; if (gridY === null) gridY = scroll.scrollTop; },
  });

  scroll.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroll.clientHeight : 1;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    if (horizontal) {
      gridXTarget += (e.shiftKey ? e.deltaY : e.deltaX) * unit;
    } else {
      if (gridY === null) { gridY = scroll.scrollTop; gridYTarget = scroll.scrollTop; }
      gridYTarget += e.deltaY * unit;
    }
  }, { passive: false });

  slotsEl.addEventListener('click', e => {
    const cell = e.target.closest('.cr-slot.craftable');
    if (cell?.dataset.typeId) onGridPetalClick(e, cell.dataset.typeId);
  });

  const search = craftingPanel.querySelector('.cr-search');
  search.addEventListener('input', () => {
    gridSearch = search.value.trim().toLowerCase();
    gridY = null;
    syncRows(true);
  });
  search.addEventListener('keydown', e => { if (e.key === 'Escape') search.blur(); });
}

// ─────────────────────────────────────────────────────────────────────────────
// Full panel re-render (grid + controls; the stage draws itself every frame)
// ─────────────────────────────────────────────────────────────────────────────
export function renderCraftingPanel() {
  if (!table.crafting) syncTableFromGame();
  renderCraftingInv();
  updateSide();
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function ensureCraftingDOM() {
  if (craftingPanel) return;

  const btn = document.createElement('div');
  btn.id = 'crafting-btn';
  const img = document.createElement('img');
  img.src = './public/icons/crafting.png'; img.draggable = false;
  btn.appendChild(img);
  document.body.appendChild(btn);
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('click', () => togglePanel('crafting'));

  craftingPanel = document.createElement('div');
  craftingPanel.id = 'crafting-panel';
  craftingPanel.innerHTML = `
    <div class="cr-stats"></div>
    <div class="cr-hdr">
      <span class="cr-title">Craft</span>
      <button class="cr-close">✕</button>
    </div>
    <div class="cr-craft-area">
      <canvas class="cr-stage"></canvas>
      <label class="cr-simple"><span class="cr-simple-box"></span>Simple Crafting</label>
      <div class="cr-side">
        <button class="cr-craft-btn" disabled>Craft</button>
        <span class="cr-hint">Click a petal to add it</span>
        <span class="cr-hint"></span>
      </div>
    </div>
    <div class="cr-divider"></div>
    <div class="cr-inv-bar">
      <span class="cr-inv-label">Inventory</span>
      <input class="cr-search" type="text" placeholder="Search petals…" autocomplete="off" spellcheck="false"/>
    </div>
    <div class="cr-grid-area">
      <div class="cr-grid-scroll"><div class="cr-slots"><div class="cr-row-ghosts"></div></div></div>
    </div>
  `;
  document.body.appendChild(craftingPanel);
  craftingPanel.addEventListener('mousedown', e => e.stopPropagation());
  craftingPanel.querySelector('.cr-close').addEventListener('click', () => closePanel('crafting'));
  craftingPanel.querySelector('.cr-craft-btn').addEventListener('click', onCraftClick);
  const simpleEl = craftingPanel.querySelector('.cr-simple');
  simpleEl.classList.toggle('on', simpleCrafting);
  simpleEl.addEventListener('click', e => {
    e.preventDefault();
    simpleCrafting = !simpleCrafting;
    simpleEl.classList.toggle('on', simpleCrafting);
    try { localStorage.setItem(LS_SIMPLE, simpleCrafting ? '1' : '0'); } catch {}
  });

  wireGridInput();

  stage = craftingPanel.querySelector('.cr-stage');
  sctx  = stage.getContext('2d');
  stage.addEventListener('click', onStageClick);

  // Tooltips for petals on the table / the crafted result, shown right of the panel
  let stageHover = false;
  stage.addEventListener('mousemove', e => {
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const c = ringCenter();
    let typeId = null, cy = 0, h = 0;
    if (table.result && table.result.popT > 0.5 &&
        Math.abs(x - c.x) <= RESULT / 2 && Math.abs(y - c.y) <= RESULT / 2) {
      typeId = table.result.typeId; cy = c.y; h = RESULT;
    } else if (table.typeId) {
      const s = table.slots.find(s => s.count > 0 && s.scale > 0.5 &&
        Math.abs(x - s.x) <= TILE / 2 && Math.abs(y - s.y) <= TILE / 2);
      if (s) { typeId = table.typeId; cy = s.y; h = TILE; }
    }
    if (typeId) {
      const pr = craftingPanel.getBoundingClientRect();
      setPetalHover(typeId, { x: pr.right, y: rect.top + cy - h / 2, w: 0, h });
      stageHover = true;
    } else if (stageHover) {
      setPetalHover(null, null); stageHover = false;
    }
  });
  stage.addEventListener('mouseleave', () => { if (stageHover) { setPetalHover(null, null); stageHover = false; } });

  // Grid tooltips
  const crScroll = craftingPanel.querySelector('.cr-grid-scroll');
  crScroll.addEventListener('mousemove', e => {
    const slot = e.target.closest('.cr-slot');
    if (!slot?.dataset.typeId || !slot.querySelector('canvas')) { setPetalHover(null, null); return; }
    const panelRect = craftingPanel.getBoundingClientRect();
    const slotRect  = slot.getBoundingClientRect();
    setPetalHover(slot.dataset.typeId, { x: panelRect.right, y: slotRect.top, w: 0, h: slotRect.height });
  });
  crScroll.addEventListener('mouseleave', () => setPetalHover(null, null));

  registerPanel('crafting', {
    open: openCraftingPanel, close: closeCraftingPanel, isOpen: () => craftingPanelOpen,
    rootIds: ['crafting-panel', 'crafting-btn'],
  });

  positionCraftingButton();
  positionCraftingPanel();

  registerCraftingWithInv({
    isCraftingOpen: () => craftingPanelOpen,
    positionPanel:  positionCraftingPanel,
    renderPanel:    renderCraftingPanel,
  });
}
