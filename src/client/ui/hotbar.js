/**
 * hotbar.js
 *
 * Canvas-drawn hotbar + bench rows, and every petal that moves between
 * slots or to/from the inventory.
 *
 * Nothing teleports: every change of place is a "flight" — the petal glides
 * (and resizes) from where it was to where it's going, and the destination
 * slot shows empty until it lands:
 *   - swapping (click or 1–0 / R): both petals fly into each other's slot
 *   - dropping a dragged petal: it glides from the cursor into the slot
 *   - unequipping / cancelled drags: the petal flies into the inventory
 *     (its tile/count only updates when it arrives)
 *   - equipping from the inventory: it flies from its tile to the slot
 *   - Shift+click a slot, or the "Clear" button: petals fly into the inventory
 *
 * Also owns the shared petal-box painter (drawPetalBox) with the HP and
 * reload overlays, and the layout/hit-test helpers.
 */

import { localPlayer as player } from '../localPlayer.js';
import { equipFromInventory, moveSlot, unequipToInventory, swapWithBench } from '../../game/commands.js';
import { PETAL_TYPES }           from '../../shared/petalTypes.js';
import { drawRarityBox, rarityBorderWidth } from '../../shared/rarities.js';
import { drawInventoryIcon, isAnimatedIcon } from '../render/petalDrawing.js';
import { setPetalHover }         from './petalTooltip.js';

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────
export const SLOT_SIZE     = 58;
export const SLOT_GAP      = 7;
export const BENCH_SIZE    = 46;
export const BENCH_GAP     = 7;
export const BENCH_ROW_GAP = 9;
const HB_PAD_B    = 34;
const DRAG_THRESH = 8;

// Homescreen-specific larger slot sizes
export const HS_SLOT_SIZE     = 74;
export const HS_SLOT_GAP      = 9;
export const HS_BENCH_SIZE    = 58;
export const HS_BENCH_GAP     = 9;
export const HS_BENCH_ROW_GAP = 11;

// Motion
const FLIGHT_MS      = 260;   // slot ↔ slot
const FLIGHT_INV_MS  = 340;   // slot ↔ inventory
const GHOST_FOLLOW   = 0.32;  // per-60fps-frame catch-up of the dragged petal
const HOVER_SCALE    = 1.06;

// When true, updateHotbar draws the bigger homescreen hotbar positioned below center
export let homescreenMode = false;
export function setHomescreenMode(v) { homescreenMode = v; }

// Vertical offset (px, positive = slide down off-screen) applied to hotbar canvas drawing
export let hotbarSlideOffset = 0;
export function setHotbarSlideOffset(v) { hotbarSlideOffset = v; }

// On the homescreen the hotbar is drawn as if the screen were `homescreenH`
// tall, which puts it just under the name box (main.js computes it each frame).
let homescreenH = 0;
export function setHomescreenHotbarH(h) { homescreenH = h; }

/** The H the hotbar is laid out against — use this for any hit-testing. */
export function hotbarCanvasH() {
  return homescreenMode && homescreenH > 0 ? homescreenH : window.innerHeight;
}

function slotSize()  { return homescreenMode ? HS_SLOT_SIZE     : SLOT_SIZE; }
function slotGap()   { return homescreenMode ? HS_SLOT_GAP      : SLOT_GAP; }
function benchSize() { return homescreenMode ? HS_BENCH_SIZE    : BENCH_SIZE; }
function benchGap()  { return homescreenMode ? HS_BENCH_GAP     : BENCH_GAP; }
function benchRowGap() { return homescreenMode ? HS_BENCH_ROW_GAP : BENCH_ROW_GAP; }

/** Screen-space centre and size of a hotbar ('hotbar') or bench slot. */
export function slotCenter(row, idx) {
  const W = window.innerWidth, H = hotbarCanvasH();
  if (row === 'bench') {
    const bs = benchSize();
    return { x: benchLeft(W) + idx * (bs + benchGap()) + bs / 2, y: benchTop(H) + bs / 2, size: bs };
  }
  const ss = slotSize();
  return { x: hbLeft(W) + idx * (ss + slotGap()) + ss / 2, y: hbTop(H) + ss / 2, size: ss };
}

/** True if (x, y) is over any hotbar or bench slot (or the Clear button). */
export function isPointOnHotbar(x, y) {
  const W = window.innerWidth, H = hotbarCanvasH();
  return slotAtPoint(x, y, W, H) !== -1 || benchSlotAtPoint(x, y, W, H) !== -1 || isOnClearButton(x, y, W, H);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inv-slot CSS size — written by the inventory, used for the drag ghost size
// ─────────────────────────────────────────────────────────────────────────────
export let invSlotCSS = 50;
export function setInvSlotCSS(v) { invSlotCSS = v; }

// ─────────────────────────────────────────────────────────────────────────────
// Inventory hooks (registered by inventoryPanel.js — avoids a circular import)
// ─────────────────────────────────────────────────────────────────────────────
let _inv = {
  markDirty:     () => {},
  onDragCommit:  () => {},        // a petal is being dragged out of the inventory
  onDragEnd:     () => {},        // …and was dropped (equipped or cancelled)
  addIncoming:   () => {},        // (typeId, ±1) petals still flying INTO the inventory
  getTargetRect: () => null,      // (typeId) → {x, y, size} of where it lands, or null
};
export function registerInvAccess(cbs) { Object.assign(_inv, cbs); }

// ─────────────────────────────────────────────────────────────────────────────
// Icon cache
// ─────────────────────────────────────────────────────────────────────────────
const iconCache = new Map();
export function getIcon(typeId, physSize) {
  // Animated icons (see isAnimatedIcon in petalDrawing.js) redraw every call.
  if (isAnimatedIcon(typeId)) {
    const cv = document.createElement('canvas');
    cv.width = physSize; cv.height = physSize;
    drawInventoryIcon(cv, typeId);
    return cv;
  }
  const key = `${typeId}__${physSize}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = physSize; cv.height = physSize;
  drawInventoryIcon(cv, typeId);
  iconCache.set(key, cv);
  return cv;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag state
// ─────────────────────────────────────────────────────────────────────────────
export const drag = {
  active: false, committed: false,
  slotIdx: -1, fromInv: false, fromBench: false,
  typeId: null, x: 0, y: 0, startX: 0, startY: 0,
  srcRect: null,   // optional {x, y, size} the ghost starts from (inventory tile)
};

// Guard so crafting/inventory clicks don't fire right after a drag-release
let _dragJustEnded = false;
export function getDragJustEnded() { return _dragJustEnded; }

// The dragged petal as drawn: follows the cursor smoothly (no snapping)
const ghost = { x: 0, y: 0, size: 50, rot: 0, init: false };

// ─────────────────────────────────────────────────────────────────────────────
// Overlay canvas — drag ghost + flights, above every panel
// ─────────────────────────────────────────────────────────────────────────────
let oc = null;
export let octx = null;

export function ensureOverlay() {
  if (oc) return;
  oc = document.createElement('canvas');
  oc.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:500;';
  document.body.appendChild(oc);
  octx = oc.getContext('2d');
  _resizeOverlay();
  window.addEventListener('resize', _resizeOverlay);
}
function _resizeOverlay() {
  if (!oc) return;
  const dpr = window.devicePixelRatio || 1;
  oc.width  = Math.round(window.innerWidth  * dpr);
  oc.height = Math.round(window.innerHeight * dpr);
  oc.style.width  = window.innerWidth  + 'px';
  oc.style.height = window.innerHeight + 'px';
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────
export function hbLeft(W) {
  const ss = slotSize(), sg = slotGap();
  return W / 2 - (player.hotbar.length * ss + (player.hotbar.length - 1) * sg) / 2;
}
export function benchLeft(W) {
  const bs = benchSize(), bg = benchGap();
  return W / 2 - (player.hotbar.length * bs + (player.hotbar.length - 1) * bg) / 2;
}
export function hbTop(H)    { return H - HB_PAD_B - slotSize() - benchRowGap() - benchSize(); }
export function benchTop(H) { return H - HB_PAD_B - benchSize(); }

export function slotAtPoint(x, y, W, H) {
  const ss = slotSize(), sg = slotGap();
  const ox = hbLeft(W), oy = hbTop(H);
  for (let i = 0; i < player.hotbar.length; i++) {
    const sx = ox + i * (ss + sg);
    if (x >= sx && x < sx + ss && y >= oy && y < oy + ss) return i;
  }
  return -1;
}
export function benchSlotAtPoint(x, y, W, H) {
  const bs = benchSize(), bg = benchGap();
  const ox = benchLeft(W), oy = benchTop(H);
  for (let i = 0; i < player.hotbar.length; i++) {
    const sx = ox + i * (bs + bg);
    if (x >= sx && x < sx + bs && y >= oy && y < oy + bs) return i;
  }
  return -1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Petal box painter (hotbar, crafting, tooltips, flights…)
// ─────────────────────────────────────────────────────────────────────────────
function smoothstep(t) {
  const a = t * t, b = 1 - (1 - t) * (1 - t);
  return a + (b - a) * t;
}

/**
 * Draws a petal in its rarity box.
 * @param {number} reloadProgress  0→1 while the petal is reloading (0 = none)
 * @param {number} wobbleRad       rotation around the box centre
 * @param {{hp?: number, maxHp?: number, reloadAngle?: number}} [opts]
 *   hp/maxHp       — a translucent shade creeps down from the top as HP drops
 *   reloadAngle    — start angle of the reload sweep (varies per slot)
 */
export function drawPetalBox(ctx, x, y, size, typeId, reloadProgress = 0, wobbleRad = 0, opts = {}) {
  const pt = typeId ? PETAL_TYPES[typeId] : null;
  const cr = size * 0.16;
  const dpr = window.devicePixelRatio || 1;

  ctx.save();
  if (wobbleRad) {
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate(wobbleRad);
    x = -size / 2; y = -size / 2;
  }

  if (!pt) {
    ctx.beginPath(); ctx.roundRect(x, y, size, size, cr);
    ctx.fillStyle = '#181c2a'; ctx.fill();
    ctx.restore();
    return;
  }

  const bw = rarityBorderWidth(size);
  drawRarityBox(ctx, pt.rarity, x, y, size, size, cr, bw);

  // Overlays sit on the fill, under the petal art, inside the border
  const ix = x + bw, iy = y + bw, is = size - bw * 2, icr = Math.max(0, cr - bw * 0.7);
  const remaining = reloadProgress > 0 ? 1 - reloadProgress : 0;
  if (remaining > 0.001 && remaining < 0.999) {
    // Reload: a translucent wedge that spins and shrinks away as it finishes
    ctx.save();
    ctx.beginPath(); ctx.roundRect(ix, iy, is, is, icr); ctx.clip();
    ctx.globalAlpha *= 0.3;
    ctx.lineCap = 'butt';
    const offset = (1 - Math.pow(remaining, 0.7)) * Math.PI * 6 + (opts.reloadAngle ?? 0);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.arc(x + size / 2, y + size / 2, size / 2, offset - Math.PI * 2 * smoothstep(remaining), offset);
    ctx.stroke();
    ctx.restore();
  } else if (opts.hp != null && opts.maxHp > 0 && opts.hp < opts.maxHp) {
    // HP: shade creeps down from the top as the petal loses health
    const frac = 1 - Math.max(0, Math.min(1, opts.hp / opts.maxHp));
    if (frac > 0.001) {
      ctx.save();
      ctx.beginPath(); ctx.roundRect(ix, iy, is, is, icr); ctx.clip();
      ctx.globalAlpha *= 0.3;
      ctx.fillStyle = '#000';
      ctx.fillRect(ix, iy, is, is * frac);
      ctx.restore();
    }
  }

  // Petal art + name, kept inside the border so names never spill out
  ctx.drawImage(getIcon(typeId, Math.round(is * dpr)), ix, iy, is, is);
  ctx.restore();
}

/** "xN" on a flying stack, turning and scaling with it. */
function drawFlightCount(ctx, pos, count) {
  const fs = pos.size * 0.26;
  if (fs < 4) return;
  ctx.save();
  ctx.translate(pos.x, pos.y); ctx.rotate(pos.rot);
  ctx.translate(pos.size * 0.4, -pos.size * 0.4); ctx.rotate(0.26);
  ctx.font = `900 ${fs}px "UbuntuCustom","Ubuntu",Arial,sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000'; ctx.lineWidth = fs * 0.28; ctx.strokeText('x' + count, 0, 0);
  ctx.fillStyle = '#fff'; ctx.fillText('x' + count, 0, 0);
  ctx.restore();
}

export function drawEmptySlot(ctx, x, y, size) {
  const cr = size * 0.16;
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, size, size, cr);
  ctx.fillStyle = '#11151f'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.restore();
}

export function drawIconOnly(ctx, x, y, size, typeId) {
  if (!typeId) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.drawImage(getIcon(typeId, Math.round(size * dpr)), x, y, size, size);
}

// Each slot's reload sweep starts at its own angle so they don't all look alike
const RELOAD_ANGLES = Array.from({ length: 16 }, () => Math.random() * Math.PI * 2);

// ─────────────────────────────────────────────────────────────────────────────
// Flights — petals moving between places
// ─────────────────────────────────────────────────────────────────────────────
// { typeId, fx, fy, fsize, frot, falpha, dest, target(), t0, dur, arc, onLand }
//   dest: { row, idx } when flying into a slot (that slot shows empty until it lands)
const flights = [];

const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

function flightPos(f, now) {
  const raw = Math.max(0, Math.min(1, (now - f.t0) / f.dur));
  const e   = easeOutCubic(raw);
  const to  = f.target();
  let x = f.fx + (to.x - f.fx) * e;
  let y = f.fy + (to.y - f.fy) * e;
  if (f.arc) {
    // bow sideways so two petals swapping don't pass through each other
    const dx = to.x - f.fx, dy = to.y - f.fy, len = Math.hypot(dx, dy) || 1;
    const bow = Math.sin(raw * Math.PI) * f.arc;
    x += (-dy / len) * bow; y += (dx / len) * bow;
  }
  return {
    raw, x, y,
    size:  f.fsize + (to.size - f.fsize) * e,
    rot:   f.frot * (1 - e) + (f.spin ?? 0) * Math.PI * 2 * (e - 1),
    alpha: f.falpha + ((to.alpha ?? 1) - f.falpha) * e,
  };
}

function takeFlightInto(row, idx) {
  // If a petal is still flying into this slot, return where it is right now
  // (and drop that flight) so a new move continues from there.
  const now = performance.now();
  const i = flights.findIndex(f => f.dest && f.dest.row === row && f.dest.idx === idx);
  if (i === -1) return null;
  const pos = flightPos(flights[i], now);
  flights.splice(i, 1);
  return pos;
}

function launch(typeId, from, target, { dest = null, dur = FLIGHT_MS, arc = 0, onLand = null, delay = 0, spin = 0, count = 1 } = {}) {
  if (!typeId) return;
  flights.push({
    typeId, dest, target, dur, arc, onLand, spin, count,
    fx: from.x, fy: from.y, fsize: from.size, frot: from.rot ?? 0, falpha: from.alpha ?? 1,
    t0: performance.now() + delay,   // a delayed flight waits where it starts
  });
}

function slotRect(row, idx) {
  return takeFlightInto(row, idx) ?? slotCenter(row, idx);
}

/** Fly `typeId` from a screen rect to wherever `target()` says ({x, y, size, alpha?}).
 *  opts: dur, delay, spin (full turns while flying), count (shows xN), onLand. */
export function flyPetalTo(typeId, from, target, opts = {}) {
  ensureOverlay();
  launch(typeId, from, target, opts);
}

/** Fly `typeId` from a screen rect ({x, y, size} = centre + size) into a slot. */
export function flyPetal(typeId, from, row, idx, opts = {}) {
  takeFlightInto(row, idx);
  launch(typeId, from, () => slotCenter(row, idx), { dest: { row, idx }, ...opts });
}

/** Fly `typeId` from a screen rect into the inventory (count updates on arrival). */
function flyToInventory(typeId, from, delay = 0) {
  _inv.addIncoming(typeId, 1);
  launch(typeId, from, () => {
    const r = _inv.getTargetRect(typeId);
    if (r) return { alpha: 0.9, ...r };
    const btn = document.getElementById('inv-toggle-btn')?.getBoundingClientRect();
    return btn
      ? { x: btn.left + btn.width / 2, y: btn.top + btn.height / 2, size: 24, alpha: 0 }
      : { x: from.x, y: from.y, size: 0, alpha: 0 };
  }, {
    dur: FLIGHT_INV_MS, delay,
    onLand: () => { _inv.addIncoming(typeId, -1); _inv.markDirty(); },
  });
}

/** Moves one slot's petal back to the inventory, flying it there. */
function unequipSlot(row, idx, delay = 0) {
  const typeId = (row === 'hotbar' ? player.hotbar : player.bench)[idx];
  if (!typeId) return false;
  const from = slotRect(row, idx);
  if (!unequipToInventory(player, row, idx)) return false;
  flyToInventory(typeId, from, delay);
  return true;
}

/** Unequips every hotbar and bench petal (the "Clear" button). */
export function clearLoadout() {
  let n = 0;
  for (let i = 0; i < player.hotbar.length; i++) if (unequipSlot('hotbar', i, n * 35)) n++;
  for (let i = 0; i < player.bench.length;  i++) if (unequipSlot('bench',  i, n * 35)) n++;
}

// ─────────────────────────────────────────────────────────────────────────────
// "Clear" button — plain text to the left of the hotbar
// ─────────────────────────────────────────────────────────────────────────────
const CLEAR_W = 52, CLEAR_H = 24, CLEAR_GAP = 12;
let clearHovered = false;

function clearButtonRect(W, H) {
  const top = hbTop(H), bottom = benchTop(H) + benchSize();
  return { x: hbLeft(W) - CLEAR_GAP - CLEAR_W, y: (top + bottom) / 2 - CLEAR_H / 2, w: CLEAR_W, h: CLEAR_H };
}

function isOnClearButton(x, y, W, H) {
  const r = clearButtonRect(W, H);
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function drawClearButton(ctx, W, H) {
  const r = clearButtonRect(W, H);
  const hasAny = player.hotbar.some(Boolean) || player.bench.some(Boolean);
  ctx.save();
  if (clearHovered && hasAny) {
    ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fill();
  }
  ctx.globalAlpha = hasAny ? 1 : 0.45;
  ctx.font = '700 13px "UbuntuCustom","Ubuntu",Arial,sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
  ctx.strokeText('Clear', r.x + r.w / 2, r.y + r.h / 2 + 1);
  ctx.fillStyle = '#ffffff';
  ctx.fillText('Clear', r.x + r.w / 2, r.y + r.h / 2 + 1);
  ctx.restore();
}

function isSlotLanding(row, idx) {
  return flights.some(f => f.dest && f.dest.row === row && f.dest.idx === idx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover
// ─────────────────────────────────────────────────────────────────────────────
let hoverSlot = -1;
let hoverRow  = 'top';
let hotbarTip = false;   // the petal tooltip currently showing was opened by the hotbar
const hoverScale = { top: [], bench: [] };   // smoothed per-slot hover lift

function stepHover(row, i, target, k) {
  const arr = hoverScale[row];
  const v = arr[i] ?? 1;
  arr[i] = v + (target - v) * k;
  return arr[i];
}

// ─────────────────────────────────────────────────────────────────────────────
// updateHotbar — called every frame (game loop and homescreen loop)
// ─────────────────────────────────────────────────────────────────────────────
let lastFrame = performance.now();

function drawSlotRow(ctx, row, typeIds, left, top, size, gap, bySlot, k) {
  for (let i = 0; i < player.hotbar.length; i++) {
    const cx = left + i * (size + gap) + size / 2;
    const cy = top + size / 2;
    const isDragSrc = drag.committed && drag.slotIdx === i && !drag.fromInv &&
                      (row === 'bench') === drag.fromBench;
    const typeId  = (isDragSrc || isSlotLanding(row === 'top' ? 'hotbar' : 'bench', i)) ? null : typeIds[i];
    const hovered = !drag.committed && hoverSlot === i && hoverRow === row && !!typeId;
    const s = size * stepHover(row, i, hovered ? HOVER_SCALE : 1, k);

    if (!typeId) { drawEmptySlot(ctx, cx - size / 2, cy - size / 2, size); continue; }

    let reload = 0, opts = { reloadAngle: RELOAD_ANGLES[i % RELOAD_ANGLES.length] };
    if (row === 'top') {
      const p = bySlot[i], pt = PETAL_TYPES[typeId];
      if (p?.state === 'reloading' && pt) reload = Math.max(0.0011, 1 - p.reloadTimer / pt.reloadTime);
      if (p) { opts.hp = p.hp; opts.maxHp = p.maxHp; }
    }
    drawPetalBox(ctx, cx - s / 2, cy - s / 2, s, typeId, reload, 0, opts);
  }
}

export function updateHotbar(ctx, W, H) {
  ensureOverlay();
  const now = performance.now();
  const dt  = Math.min(100, now - lastFrame);
  lastFrame = now;
  const k   = 1 - Math.pow(1 - 0.25, dt / 16.67);

  const bySlot = {};
  for (const p of player.petals) {
    if (bySlot[p.slotIdx] === undefined) bySlot[p.slotIdx] = p;
  }

  // Land finished flights first so their slot never flickers empty for a frame
  for (let i = flights.length - 1; i >= 0; i--) {
    if (now - flights[i].t0 >= flights[i].dur) {
      const f = flights.splice(i, 1)[0];
      f.onLand?.();
    }
  }

  const ss = slotSize(), bs = benchSize();

  ctx.save();
  drawSlotRow(ctx, 'top',   player.hotbar, hbLeft(W),    hbTop(H),    ss, slotGap(),  bySlot, k);
  drawSlotRow(ctx, 'bench', player.bench,  benchLeft(W), benchTop(H), bs, benchGap(), bySlot, k);
  drawClearButton(ctx, W, H);
  ctx.restore();

  // ── Slot numbers under bench row ────────────────────────────────────────────
  if (!homescreenMode) {
    ctx.save();
    ctx.font = '700 11px "UbuntuCustom","Ubuntu",Arial,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    const numY = benchTop(H) + bs + 3;
    for (let i = 0; i < player.hotbar.length; i++) {
      const sx = benchLeft(W) + i * (bs + benchGap()) + bs / 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth   = 2.5;
      ctx.strokeText(String(i + 1), sx, numY);
      ctx.fillStyle = 'rgba(255,255,255,0.80)';
      ctx.fillText(String(i + 1), sx, numY);
    }
    ctx.restore();
  }

  // ── Overlay: flights, then the dragged petal on top ─────────────────────────
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  for (const f of flights) {
    const pos = flightPos(f, now);
    if (pos.size < 1 || pos.alpha <= 0.01) continue;
    octx.save();
    octx.globalAlpha = pos.alpha;
    drawPetalBox(octx, pos.x - pos.size / 2, pos.y - pos.size / 2, pos.size, f.typeId, 0, pos.rot);
    if (f.count > 1) drawFlightCount(octx, pos, f.count);
    octx.restore();
  }

  if (drag.committed && drag.typeId) {
    const baseSize = drag.fromInv ? invSlotCSS : (drag.fromBench ? bs : ss) + 6;
    if (!ghost.init) {
      const src = drag.srcRect
        ?? (drag.fromInv ? { x: drag.startX, y: drag.startY, size: invSlotCSS }
                         : slotCenter(drag.fromBench ? 'bench' : 'hotbar', drag.slotIdx));
      Object.assign(ghost, { x: src.x, y: src.y, size: src.size, rot: 0, init: true });
    }
    const gk = 1 - Math.pow(1 - GHOST_FOLLOW, dt / 16.67);
    ghost.x    += (drag.x - ghost.x) * gk;
    ghost.y    += (drag.y - ghost.y) * gk;
    ghost.size += (baseSize - ghost.size) * gk;
    ghost.rot   = Math.sin(now / 280) * 0.16;
    octx.save();
    octx.globalAlpha = 0.95;
    drawPetalBox(octx, ghost.x - ghost.size / 2, ghost.y - ghost.size / 2, ghost.size, drag.typeId, 0, ghost.rot);
    octx.restore();
  } else {
    ghost.init = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Swapping (click a slot, 1–0 keys, R)
// ─────────────────────────────────────────────────────────────────────────────
export function triggerSwap(slotIdx) {
  const topType = player.hotbar[slotIdx], benchType = player.bench[slotIdx];
  if (!topType && !benchType) return;
  const fromTop   = slotRect('hotbar', slotIdx);
  const fromBench = slotRect('bench',  slotIdx);
  if (!swapWithBench(player, slotIdx)) return;
  // Both petals travel into each other's slot, bowing past one another
  if (topType)   flyPetal(topType,   fromTop,   'bench',  slotIdx, { arc:  14 });
  if (benchType) flyPetal(benchType, fromBench, 'hotbar', slotIdx, { arc:  14 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mouse event handlers
// ─────────────────────────────────────────────────────────────────────────────
export function onHotbarMouseMove(x, y, W, H) {
  drag.x = x; drag.y = y;
  const W_ = W || window.innerWidth, H_ = H || window.innerHeight;
  const topSlot   = slotAtPoint(x, y, W_, H_);
  const benchSlot = benchSlotAtPoint(x, y, W_, H_);

  const overClear = !drag.committed && isOnClearButton(x, y, W_, H_);
  if (overClear !== clearHovered) {
    clearHovered = overClear;
    document.body.style.cursor = overClear ? 'pointer' : '';
  }

  if (topSlot !== -1)        { hoverSlot = topSlot;   hoverRow = 'top'; }
  else if (benchSlot !== -1) { hoverSlot = benchSlot; hoverRow = 'bench'; }
  else                       { hoverSlot = -1; }

  if (hoverSlot !== -1 && hoverRow === 'top' && player.hotbar[hoverSlot] && !drag.committed) {
    const ss = slotSize();
    const sx = hbLeft(W_) + hoverSlot * (ss + slotGap());
    setPetalHover(player.hotbar[hoverSlot], { x: sx, y: hbTop(H_), w: ss, h: ss });
    hotbarTip = true;
  } else if (hoverSlot !== -1 && hoverRow === 'bench' && player.bench[hoverSlot] && !drag.committed) {
    const bs = benchSize();
    const sx = benchLeft(W_) + hoverSlot * (bs + benchGap());
    // Anchor to the top of the whole hotbar so the tooltip sits above both rows
    setPetalHover(player.bench[hoverSlot], { x: sx, y: hbTop(H_), w: bs, h: bs });
    hotbarTip = true;
  } else if (hotbarTip) {
    // only clear a tooltip the hotbar opened (panels manage their own)
    setPetalHover(null, null);
    hotbarTip = false;
  }

  if (drag.active && !drag.committed && Math.hypot(x - drag.startX, y - drag.startY) > DRAG_THRESH) {
    drag.committed = true;
    ghost.init = false;
    setPetalHover(null, null);
    if (drag.fromInv) _inv.onDragCommit(drag.typeId);
  }
}

export function onHotbarMouseDown(x, y, W, H, shiftKey = false) {
  if (isOnClearButton(x, y, W, H)) { clearLoadout(); return true; }

  const topSlot = slotAtPoint(x, y, W, H);
  const benchSlot0 = benchSlotAtPoint(x, y, W, H);

  // Shift+click a filled slot → straight back to the inventory
  if (shiftKey) {
    if (topSlot !== -1 && player.hotbar[topSlot])      { unequipSlot('hotbar', topSlot);   return true; }
    if (benchSlot0 !== -1 && player.bench[benchSlot0]) { unequipSlot('bench', benchSlot0); return true; }
  }

  if (topSlot !== -1 && player.hotbar[topSlot]) {
    Object.assign(drag, { active: true, committed: false, slotIdx: topSlot, fromInv: false, fromBench: false,
      typeId: player.hotbar[topSlot], x, y, startX: x, startY: y, srcRect: null });
    return true;
  }
  const benchSlot = benchSlotAtPoint(x, y, W, H);
  if (benchSlot !== -1) {
    Object.assign(drag, { active: true, committed: false, slotIdx: benchSlot, fromInv: false, fromBench: true,
      typeId: player.bench[benchSlot], x, y, startX: x, startY: y, srcRect: null });
    return true;
  }
  return false;
}

export function onHotbarMouseUp(x, y, W, H) {
  if (!drag.active) return;

  const wasCommitted = drag.committed, wasFromInv = drag.fromInv, wasFromBench = drag.fromBench;
  const typeId = drag.typeId, slotIdx = drag.slotIdx;
  const from = { x: ghost.x, y: ghost.y, size: ghost.size, rot: ghost.rot };
  Object.assign(drag, { active: false, committed: false, slotIdx: -1, fromInv: false, fromBench: false, typeId: null, srcRect: null });
  ghost.init = false;

  if (!wasCommitted) {
    // A click on a slot swaps it with the other row
    if (!wasFromInv && (wasFromBench || typeId)) triggerSwap(slotIdx);
    return;
  }

  _dragJustEnded = true;
  setTimeout(() => { _dragJustEnded = false; }, 50);

  const targetTop   = slotAtPoint(x, y, W, H);
  const targetBench = benchSlotAtPoint(x, y, W, H);
  const targetRow   = targetTop !== -1 ? 'hotbar' : targetBench !== -1 ? 'bench' : null;
  const targetIdx   = targetTop !== -1 ? targetTop : targetBench;

  if (wasFromInv) {
    _inv.onDragEnd(typeId);
    if (targetRow) {
      const displaced = (targetRow === 'hotbar' ? player.hotbar : player.bench)[targetIdx];
      const displacedFrom = displaced ? slotRect(targetRow, targetIdx) : null;
      if (equipFromInventory(player, typeId, targetRow, targetIdx)) {
        flyPetal(typeId, from, targetRow, targetIdx);
        if (displaced) flyToInventory(displaced, displacedFrom);
        return;
      }
    }
    flyToInventory(typeId, from);   // not dropped on a slot → back where it came from
    return;
  }

  const srcRow = wasFromBench ? 'bench' : 'hotbar';
  if (!targetRow) {
    // Dropped off the hotbar → back to the inventory
    if (unequipToInventory(player, srcRow, slotIdx)) flyToInventory(typeId, from);
    return;
  }
  if (targetRow === srcRow && targetIdx === slotIdx) {
    flyPetal(typeId, from, srcRow, slotIdx);   // put back where it was
    return;
  }
  const displaced = (targetRow === 'hotbar' ? player.hotbar : player.bench)[targetIdx];
  const displacedFrom = displaced ? slotRect(targetRow, targetIdx) : null;
  if (moveSlot(player, srcRow, slotIdx, targetRow, targetIdx)) {
    flyPetal(typeId, from, targetRow, targetIdx);
    if (displaced) flyPetal(displaced, displacedFrom, srcRow, slotIdx);
  } else {
    flyPetal(typeId, from, srcRow, slotIdx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keybind helpers
// ─────────────────────────────────────────────────────────────────────────────
export function onSwapKey(slotIdx) {
  if (slotIdx >= 0 && slotIdx < player.hotbar.length) triggerSwap(slotIdx);
}
export function onSwapAll() {
  for (let i = 0; i < player.hotbar.length; i++) triggerSwap(i);
}
