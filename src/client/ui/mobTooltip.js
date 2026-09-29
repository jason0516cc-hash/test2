// ── Mob Icon Tooltip ──────────────────────────────────────────────────────────
// Shows a stat card when the player hovers a mob icon box in the HUD.

import { getMobStats }                       from '../../shared/mobTypes.js';
import { getMobDropTable }                   from '../../game/combat.js';
import { rarityBorder, rarityText, rarityTier, drawRarityBox } from '../../shared/rarities.js';
import { drawInventoryIcon }                 from '../render/petalDrawing.js';
import { PETAL_TYPES }                       from '../../shared/petalTypes.js';
import { mobXpValue }                        from '../../shared/leveling.js';

// ── Mouse state ───────────────────────────────────────────────────────────────
const mouse = { x: -9999, y: -9999 };

// ── Fade state ────────────────────────────────────────────────────────────────
let tooltipAlpha   = 0;
let lastHoveredKey = null;
let lastHoveredBox = null;   // snapshot of the last hovered card, drawn during fade-out
const FADE_IN_MS   = 320;
const FADE_OUT_MS  = 240;

export function initTooltip(canvas) {
  // The game canvas has pointer-events:none so we track on window instead.
  window.addEventListener('mousemove', e => {
    const r  = canvas.getBoundingClientRect();
    mouse.x  = e.clientX - r.left;
    mouse.y  = e.clientY - r.top;
  });
  window.addEventListener('mouseleave', () => {
    mouse.x = -9999;
    mouse.y = -9999;
  });
}

// ── Number formatting ─────────────────────────────────────────────────────────
function fmt(n) {
  n = Math.max(0, n);
  if (n >= 1e15) return (n / 1e15).toFixed(1).replace(/\.0$/, '') + 'Q';
  if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
  if (n >= 1e9)  return (n / 1e9 ).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6)  return (n / 1e6 ).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4)  return (n / 1e3 ).toFixed(1).replace(/\.0$/, '') + 'k';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// ── Layout constants ──────────────────────────────────────────────────────────
const PAD           = 14;
const RADIUS        = 8;
const MIN_W         = 260;
const MAX_W         = 520;
const LINE_H        = 16;

const DROP_ICON_SZ  = 38;   // icon square size
const DROP_ICON_GAP = 4;    // gap between icons within a slot row
const DROP_ROW_H    = DROP_ICON_SZ + 16;  // icon + % label
const DROP_ROW_GAP  = 6;    // gap between slot rows

const STAT_ROWS = [
  { key: 'hp',         label: 'HP',          color: '#6EE86E' },
  { key: 'damage',     label: 'DMG',         color: '#FF5555' },
  { key: 'speed',      label: 'Speed',       color: '#55AAFF' },
  { key: 'mass',       label: 'Mass',        color: '#AAAAAA' },
  { key: 'aggroRange', label: 'Aggro Range', color: '#FFCC44' },
  { key: '_xp',        label: 'XP',          color: '#e2eb67' },
];

// ── Icon canvas cache ─────────────────────────────────────────────────────────
const iconCache = new Map();
function getIcon(typeId, size) {
  const key = `${typeId}__${size}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  drawInventoryIcon(cv, typeId);
  iconCache.set(key, cv);
  return cv;
}

// ── Word-wrap helper ──────────────────────────────────────────────────────────
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ── Compute the pixel width of one drop slot row ──────────────────────────────
function slotRowWidth(slot) {
  return slot.variants.length * DROP_ICON_SZ + (slot.variants.length - 1) * DROP_ICON_GAP;
}

// ── Measure card dimensions ───────────────────────────────────────────────────
function measureCard(ctx, stats, hovered, slots) {
  const innerW = MAX_W - PAD * 2;

  ctx.font = 'bold 18px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
  const nameW = ctx.measureText(stats.name).width;

  ctx.font = 'bold 13px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
  const rarityW = ctx.measureText(hovered.rarity).width;

  ctx.font = '13px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
  let maxStatW = 0;
  for (const row of STAT_ROWS) {
    let valStr;
    if (row.key === 'aggroRange') {
      if (hovered.typeId === 'baby_ant' || hovered.typeId === 'fire_baby_ant' || hovered.typeId === 'debris' || hovered.typeId === 'bubble') valStr = 'Always passive';
      else if (hovered.typeId === 'bee' || hovered.typeId === 'centipede_head' || hovered.typeId === 'worker_ant' || hovered.typeId === 'desert_centipede_head' || hovered.typeId === 'starfish' || hovered.typeId === 'leech' || hovered.typeId === 'shell') valStr = 'Passive (until hit)';
      else if (hovered.typeId === 'cactus' || hovered.typeId === 'sponge' || hovered.typeId === 'sea_cave' || hovered.typeId === 'rock' || hovered.typeId === 'dandelion') valStr = 'Static';
      else valStr = fmt(stats[row.key]);
    } else {
      valStr = fmt(stats[row.key]);
    }
    const rowW = ctx.measureText(row.label + ':  ' + valStr).width;
    if (rowW > maxStatW) maxStatW = rowW;
  }
  if (stats.poisonTotal != null) {
    const poisonStr = fmt(stats.poisonTotal) + ' (' + fmt(Math.round(stats.poisonTotal / 3)) + '/s)';
    const pW = ctx.measureText('Poison:  ' + poisonStr).width;
    if (pW > maxStatW) maxStatW = pW;
  }

  // Widest drop row
  let maxDropW = 0;
  for (const slot of slots) maxDropW = Math.max(maxDropW, slotRowWidth(slot));

  const contentW = Math.max(nameW, rarityW, maxStatW, maxDropW);
  const cw = Math.min(MAX_W, Math.max(MIN_W, contentW + PAD * 2));
  const textW = cw - PAD * 2;

  let h = PAD;
  h += 22 + 8;    // name + gap
  h += 16 + 10;   // rarity + gap

  let descLines = [];
  if (stats.description) {
    ctx.font = '12px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
    descLines = wrapText(ctx, stats.description, textW);
    h += descLines.length * LINE_H + 10;
  }

  h += STAT_ROWS.length * 20;
  if (stats.poisonTotal != null) h += 20;

  // Drop rows — one per slot, separated by DROP_ROW_GAP
  if (slots.length > 0) {
    h += 12;   // gap before "Drops:" header
    h += 14;   // "Drops:" label height
    h += 6;    // gap after label
    h += slots.length * DROP_ROW_H + (slots.length - 1) * DROP_ROW_GAP;
    h += 6;
  }

  h += PAD;
  return { cw, ch: h, descLines };
}

/**
 * Call once per frame after drawing all HUD boxes.
 */
export function drawMobTooltip(ctx, W, H, hudLive, HUD_BOX, dt = 16) {
  // ── Hit-test boxes ────────────────────────────────────────────────────────
  let hovered = null;
  const half  = HUD_BOX / 2;
  for (const box of hudLive.values()) {
    if (mouse.x >= box.cx - half && mouse.x <= box.cx + half &&
        mouse.y >= box.cy - half && mouse.y <= box.cy + half) {
      hovered = box;
      break;
    }
  }

  // ── Fade ──────────────────────────────────────────────────────────────────
  // Remember the last hovered card (a snapshot, in case the card itself goes
  // away) so the tooltip can keep drawing while it fades out
  if (hovered) {
    lastHoveredKey = `${hovered.typeId}_${hovered.tier}${hovered.isBoss ? '_boss' : ''}`;
    lastHoveredBox = { ...hovered };
  }

  if (hovered) {
    tooltipAlpha = Math.min(1, tooltipAlpha + dt / FADE_IN_MS);
  } else {
    tooltipAlpha = Math.max(0, tooltipAlpha - dt / FADE_OUT_MS);
  }
  if (tooltipAlpha <= 0) return;

  // Keep last-hovered box for fade-out (live box if it still exists, so the
  // tooltip follows it; otherwise the snapshot)
  if (!hovered) {
    for (const box of hudLive.values()) {
      if (`${box.typeId}_${box.tier}${box.isBoss ? '_boss' : ''}` === lastHoveredKey) { hovered = box; break; }
    }
    if (!hovered) hovered = lastHoveredBox;
    if (!hovered) { tooltipAlpha = 0; return; }
  }

  // ── Fetch stats & drops ───────────────────────────────────────────────────
  const stats = getMobStats(hovered.typeId, hovered.tier);
  if (!stats) return;

  // If this card is a boss, scale the displayed stats to match boss multipliers
  if (hovered.isBoss) {
    stats.hp         *= 10;
    stats.damage     *= 2;
    stats.speed      *= 0.9;
    stats.alertSpeed *= 0.9;
    stats.mass        = Math.round(stats.mass * 3);
    if (stats.aggroRange > 0) stats.aggroRange = Math.round(stats.aggroRange * 1.5);
    if (stats.poisonTotal != null) {
      stats.poisonTotal *= 2;
      stats.poisonDps   = Math.round(stats.poisonTotal / 3);
    }
  }

  // Compute XP value and attach to stats for the STAT_ROWS loop
  stats._xp = mobXpValue(rarityTier(hovered.rarity), hovered.isBoss ?? false);

  const slots = getMobDropTable(hovered.typeId, hovered.tier ?? 0);

  // ── Size & position ───────────────────────────────────────────────────────
  const { cw, ch, descLines } = measureCard(ctx, stats, hovered, slots);

  const OFFSET = 6;
  let tx = hovered.cx - cw / 2;
  let ty = hovered.cy + half + OFFSET;
  if (ty + ch > H - 8) ty = hovered.cy - half - OFFSET - ch;
  if (tx + cw > W - 8) tx = W - 8 - cw;
  if (tx < 8)          tx = 8;

  // ── Draw ──────────────────────────────────────────────────────────────────
  ctx.save();
  ctx.globalAlpha = tooltipAlpha;

  // Card bg
  ctx.beginPath();
  ctx.roundRect(tx, ty, cw, ch, RADIUS);
  ctx.fillStyle = 'rgba(10,10,20,0.92)';
  ctx.fill();

  // Rarity border — red for boss, rarity color otherwise
  ctx.beginPath();
  ctx.roundRect(tx, ty, cw, ch, RADIUS);
  if (hovered.isBoss) {
    ctx.strokeStyle = '#ff2222';
    ctx.lineWidth   = 2.5;
  } else {
    ctx.strokeStyle = rarityBorder(hovered.rarity);
    ctx.lineWidth = 2;
  }
  ctx.stroke();

  // ── Text ─────────────────────────────────────────────────────────────────
  const lx = tx + PAD;
  let   ly = ty + PAD + 6;

  // Name — always just the mob's name (no "Boss" prefix here)
  ctx.font = 'bold 18px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  ctx.fillStyle    = 'rgba(0,0,0,0.5)';
  ctx.fillText(stats.name, lx + 0.8, ly + 0.8);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(stats.name, lx, ly);
  ly += 28;

  // Rarity line — "Boss Rare" style for bosses
  ctx.font      = 'bold 13px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
  if (hovered.isBoss) {
    ctx.fillStyle = '#ff3333';
    ctx.fillText('Boss ', lx, ly);
    const bossW = ctx.measureText('Boss ').width;
    ctx.fillStyle = rarityText(hovered.rarity);
    ctx.fillText(hovered.rarity, lx + bossW, ly);
  } else {
    ctx.fillStyle = rarityText(hovered.rarity);
    ctx.fillText(hovered.rarity, lx, ly);
  }
  ly += 26;

  if (descLines.length > 0) {
    ctx.font      = '12px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
    ctx.fillStyle = 'rgba(200,200,220,0.80)';
    for (const line of descLines) { ctx.fillText(line, lx, ly); ly += LINE_H; }
    ly += 10;
  }

  ctx.font = '13px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
  for (const row of STAT_ROWS) {
    let valStr;
    if (row.key === 'aggroRange') {
      if (hovered.typeId === 'baby_ant' || hovered.typeId === 'fire_baby_ant' || hovered.typeId === 'debris' || hovered.typeId === 'bubble') valStr = 'Always passive';
      else if (hovered.typeId === 'bee' || hovered.typeId === 'centipede_head' || hovered.typeId === 'worker_ant' || hovered.typeId === 'desert_centipede_head' || hovered.typeId === 'starfish' || hovered.typeId === 'leech' || hovered.typeId === 'shell') valStr = 'Passive (until hit)';
      else if (hovered.typeId === 'cactus' || hovered.typeId === 'sponge' || hovered.typeId === 'sea_cave' || hovered.typeId === 'rock' || hovered.typeId === 'dandelion') valStr = 'Static';
      else valStr = fmt(stats[row.key]);
    } else {
      valStr = fmt(stats[row.key]);
    }
    ctx.fillStyle = row.color;
    ctx.textAlign = 'left';
    ctx.fillText(row.label + ':', lx, ly);
    ctx.fillStyle = '#e0e0e0';
    ctx.textAlign = 'right';
    ctx.fillText(valStr, tx + cw - PAD, ly);
    ly += 20;
  }

  if (stats.poisonTotal != null) {
    ctx.fillStyle = '#55cc44'; ctx.textAlign = 'left';
    ctx.fillText('Poison:', lx, ly);
    ctx.fillStyle = '#aa44ff'; ctx.textAlign = 'right';
    ctx.fillText(fmt(stats.poisonTotal) + ' (' + fmt(stats.poisonDps) + '/s)', tx + cw - PAD, ly);
    ly += 20;
  }

  // ── Drop slots — one row per slot ─────────────────────────────────────────
  if (slots.length > 0) {
    ly += 12;
    ctx.font      = 'bold 11px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
    ctx.fillStyle = 'rgba(200,200,220,0.60)';
    ctx.textAlign = 'left';
    ctx.fillText('Drops:', lx, ly);
    ly += 20;

    const dpr = window.devicePixelRatio || 1;
    const iconPx = Math.round(DROP_ICON_SZ * dpr / 4) * 4;

    for (let si = 0; si < slots.length; si++) {
      const slot = slots[si];
      const rowY = ly + si * (DROP_ROW_H + DROP_ROW_GAP);

      for (let vi = 0; vi < slot.variants.length; vi++) {
        const { typeId: dTypeId, chance } = slot.variants[vi];
        const pt = PETAL_TYPES[dTypeId];
        if (!pt) continue;

        const ix = lx + vi * (DROP_ICON_SZ + DROP_ICON_GAP);
        const iy = rowY;
        const cr = DROP_ICON_SZ * 0.18;

        drawRarityBox(ctx, pt.rarity, ix, iy, DROP_ICON_SZ, DROP_ICON_SZ, cr);

        const icon = getIcon(dTypeId, Math.max(4, iconPx));
        ctx.drawImage(icon, ix, iy, DROP_ICON_SZ, DROP_ICON_SZ);

        // x3 badge (top-right corner, rotated 45° like inventory counter) for bosses
        if (hovered.isBoss) {
          const bx = ix + DROP_ICON_SZ - 5;
          const by = iy + 5;
          ctx.save();
          ctx.translate(bx, by);
          ctx.rotate(Math.PI / 4); // 45° northeast tilt
          ctx.font         = `bold ${Math.max(7, DROP_ICON_SZ * 0.22)}px "UbuntuCustom", "Ubuntu", Arial, sans-serif`;
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle    = 'rgba(0,0,0,0.85)';
          ctx.fillText('x3', 0.7, 0.7);
          ctx.fillStyle    = '#ffffff';
          ctx.fillText('x3', 0, 0);
          ctx.restore();
        }

        // % label under icon
        const pctStr = chance >= 0.995 ? '100%'
          : (chance * 100).toFixed(chance < 0.01 ? 1 : 0) + '%';
        ctx.font         = 'bold 10px "UbuntuCustom", "Ubuntu", Arial, sans-serif';
        ctx.fillStyle    = rarityText(pt.rarity);
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(pctStr, ix + DROP_ICON_SZ / 2, iy + DROP_ICON_SZ + 2);
      }
    }
  }

  ctx.restore();
}