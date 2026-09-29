/**
 * client/ui/mobGallery.js
 *
 * Mob Gallery:
 *   - One row per mob type (A-Z), one column per rarity tier; each row is
 *     its own canvas of tiles. No scrollbars: wheel, Shift/trackpad for
 *     sideways, or click-and-drag.
 *   - Discovered tiles use the shared mob tile (render/mobTile.js) in "live"
 *     mode, so the mobs idle-animate; only rows/columns on screen are drawn.
 *     Undiscovered tiles are dim "?" boxes.
 *   - Search (client/ui/mobSearch.js): mob names, drops ("stinger" → every mob
 *     that drops Stinger), rarities, biomes, found/missing, exclusions and
 *     either-or. Matching rows animate in, out and into
 *     place per row (like the crafting grid); tiles that don't match the
 *     rarity/drop part of the search dim.
 *   - Hovering a tile shows the full mob card to the right of the panel.
 *   - Kills while open bounce the count; a new discovery pops its tile in.
 *   - centipede_body is merged into the centipede_head row.
 *   - Kill data persisted in localStorage.
 */

import { RARITIES, rarityFill, rarityBorder, rarityContrastText } from '../../shared/rarities.js';
import { drawMobTile, mobDisplayName } from '../render/mobTile.js';
import { getMobDropTable }  from '../../game/combat.js';
import { getMobStats, MOB_DEFS } from '../../shared/mobTypes.js';
import { drawPetalBox }      from './hotbar.js';
import { PETAL_TYPES }       from '../../shared/petalTypes.js';
import { onGameEvent }       from '../../game/events.js';
import { registerPanel, togglePanel, closePanel } from './panels.js';
import { buildMobIndex, searchMobs, didYouMean } from './mobSearch.js';
import { enableDragPan } from './dragPan.js';

// ─────────────────────────────────────────────────────────────────────────────
// All gallery mob types — A-Z order, centipede_body excluded (merged with head)
// ─────────────────────────────────────────────────────────────────────────────
const GALLERY_TYPES = [
  'alligator', 'ant_egg', 'ant_hole', 'baby_ant', 'bee', 'beetle', 'beekeeper', 'beehive',
  'bubble', 'cactus',
  'centipede_head',          // renders head+body together
  'crab', 'dandelion', 'debris',
  'desert_centipede_head',   // renders head+body together
  'digger', 'fire_ant_egg', 'fire_ant_hole', 'fire_baby_ant', 'fire_queen_ant',
  'fire_soldier_ant', 'fire_worker_ant', 'hornet', 'jellyfish', 'ladybug', 'leech',
  'mummified_beetle', 'pyramid', 'queen_ant', 'queen_bee', 'rock', 'sandstorm', 'scorpion',
  'sea_cave', 'shell', 'soldier_ant', 'sponge', 'spider', 'squid', 'starfish', 'worker_ant',
];

// Where each mob is found — the biome spawn tables (game/mobs.js) plus the
// minions their nests release. Search uses it for "garden", "desert", "ocean".
const MOB_BIOMES = {
  garden: ['bee', 'ladybug', 'spider', 'hornet', 'centipede_head', 'ant_hole', 'beehive', 'rock',
           'dandelion', 'ant_egg', 'baby_ant', 'worker_ant', 'soldier_ant', 'queen_ant', 'queen_bee',
           'digger', 'beekeeper'],
  desert: ['beetle', 'sandstorm', 'scorpion', 'cactus', 'desert_centipede_head', 'fire_ant_hole',
           'fire_ant_egg', 'fire_baby_ant', 'fire_worker_ant', 'fire_soldier_ant', 'fire_queen_ant',
           'pyramid', 'mummified_beetle'],
  ocean:  ['jellyfish', 'squid', 'crab', 'alligator', 'starfish', 'shell', 'sponge', 'leech',
           'bubble', 'sea_cave', 'debris'],
};
const BIOME_OF = {};
for (const [b, ids] of Object.entries(MOB_BIOMES)) for (const id of ids) BIOME_OF[id] = b;

const COLS = RARITIES.length;

// ─────────────────────────────────────────────────────────────────────────────
// Kill data — localStorage: { [typeId]: { [tier]: count } }
// centipede_body kills are credited to centipede_head
// ─────────────────────────────────────────────────────────────────────────────
const LS_KEY = 'mobGalleryKills';

function loadKills() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
  catch { return {}; }
}
function saveKills(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}

let killData = loadKills();

const killsOf = (typeId, tier) => killData[typeId]?.[tier] ?? 0;
const discoveredOf = typeId => RARITIES.map((_, t) => killsOf(typeId, t) > 0);

export function clearMobGallery() {
  killData = {};
  saveKills(killData);
  onKillDataChanged(true);
}

/** Unlocks every mob at every rarity tier — used by /fullindex. Sets a
 *  nonzero kill count for each so the discovery check (count > 0) passes
 *  and every tile renders fully revealed, same as if the player had
 *  actually killed one of each. */
export function fillMobGallery() {
  for (const typeId of GALLERY_TYPES) {
    if (!killData[typeId]) killData[typeId] = {};
    for (let tier = 0; tier < COLS; tier++) {
      killData[typeId][tier] = killData[typeId][tier] || 1;
    }
  }
  saveKills(killData);
  onKillDataChanged(true);
}

export function recordMobKill(typeId, tier) {
  // Centipede body → credit head
  const key = typeId === 'centipede_body' ? 'centipede_head'
            : typeId === 'desert_centipede_body' ? 'desert_centipede_head'
            : typeId;
  const t   = tier ?? 0;
  if (!killData[key]) killData[key] = {};
  const isNew = !killData[key][t];
  killData[key][t] = (killData[key][t] || 0) + 1;
  saveKills(killData);
  if (mobGalOpen) {
    tileFx.set(`${key}:${t}`, { kind: isNew ? 'pop' : 'bounce', at: performance.now() });
  }
  onKillDataChanged(isNew);
}

onGameEvent('mobKilled', e => recordMobKill(e.typeId, e.tier));

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip — drawn on a separate overlay canvas to the right of the panel
// ─────────────────────────────────────────────────────────────────────────────

// Number formatter (same as mobTooltip.js)
function fmt(n) {
  n = Math.max(0, n);
  if (n >= 1e15) return (n/1e15).toFixed(1).replace(/\.0$/,'')+' Q';
  if (n >= 1e12) return (n/1e12).toFixed(1).replace(/\.0$/,'')+' T';
  if (n >= 1e9)  return (n/1e9).toFixed(1).replace(/\.0$/,'')+ ' B';
  if (n >= 1e6)  return (n/1e6).toFixed(1).replace(/\.0$/,'')+ ' M';
  if (n >= 1e4)  return (n/1e3).toFixed(1).replace(/\.0$/,'')+ 'k';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/,'');
}

const FONT         = '"UbuntuCustom","Ubuntu",Arial,sans-serif';
const PAD          = 14;
const RADIUS_TIP   = 8;
const MIN_TIP_W    = 240;
const MAX_TIP_W    = 420;
const LINE_H       = 16;
const DROP_ICON_SZ = 34;
const DROP_GAP     = 4;
const DROP_ROW_H   = DROP_ICON_SZ + 14;
const DROP_ROW_GAP = 5;
const STAT_ROWS_TIP = [
  { key:'hp',         label:'HP',          color:'#6EE86E' },
  { key:'damage',     label:'DMG',         color:'#FF5555' },
  { key:'speed',      label:'Speed',       color:'#55AAFF' },
  { key:'mass',       label:'Mass',        color:'#AAAAAA' },
  { key:'aggroRange', label:'Aggro Range', color:'#FFCC44' },
];

function aggroText(typeId, stats) {
  if (typeId === 'baby_ant') return 'Always passive';
  if (['bee','centipede_head','worker_ant','desert_centipede_head'].includes(typeId)) return 'Passive (until hit)';
  if (['cactus','ant_hole','beehive','rock','dandelion'].includes(typeId)) return 'Static (always hostile)';
  return fmt(stats.aggroRange);
}

const iconCanvasCache = new Map();
function getPetalIcon(typeId, size) {
  const k = `${typeId}__${size}`;
  if (iconCanvasCache.has(k)) return iconCanvasCache.get(k);
  const cv = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  cv.width  = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  cv.style.width  = size + 'px';
  cv.style.height = size + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // drawPetalBox draws the rarity-coloured box + the petal icon inside
  drawPetalBox(ctx, 0, 0, size, typeId, 0, 0);
  iconCanvasCache.set(k, cv);
  return cv;
}

function wrapText(ctx, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line+' '+w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function measureTip(ctx, stats, hov, slots) {
  const textW = MAX_TIP_W - PAD*2;
  ctx.font = `bold 18px ${FONT}`;
  const nw = ctx.measureText(stats.name).width;
  ctx.font = `bold 13px ${FONT}`;
  const rw = ctx.measureText(hov.rarity).width;
  ctx.font = `13px ${FONT}`;
  let msw = 0;
  for (const row of STAT_ROWS_TIP) {
    const v = row.key === 'aggroRange' ? aggroText(hov.typeId, stats) : fmt(stats[row.key]);
    msw = Math.max(msw, ctx.measureText(row.label+':  '+v).width);
  }
  if (stats.poisonTotal!=null) msw=Math.max(msw,ctx.measureText('Poison:  '+fmt(stats.poisonTotal)+' ('+fmt(Math.round(stats.poisonTotal/3))+'/s)').width);
  let mdw=0;
  for(const s of slots) mdw=Math.max(mdw, s.variants.length*(DROP_ICON_SZ+DROP_GAP));
  const cw=Math.min(MAX_TIP_W,Math.max(MIN_TIP_W,Math.max(nw,rw,msw,mdw)+PAD*2));
  const tw2=Math.min(textW, cw-PAD*2);
  let h=PAD+22+8+16+10;
  let descLines=[];
  if(stats.description){ctx.font=`12px ${FONT}`;descLines=wrapText(ctx,stats.description,tw2);h+=descLines.length*LINE_H+10;}
  h+=STAT_ROWS_TIP.length*20;
  if(stats.poisonTotal!=null) h+=20;
  if(slots.length>0){h+=12+14+6+slots.length*DROP_ROW_H+(slots.length-1)*DROP_ROW_GAP+6;}
  h+=PAD;
  return {cw,ch:h,descLines};
}

function drawTooltipOnCanvas(ctx, W, H, hov, now) {
  if (!hov) return;
  const stats = getMobStats(hov.typeId, hov.tier);
  if (!stats) return;
  const slots = getMobDropTable(hov.typeId, hov.tier ?? 0) ?? [];
  const {cw,ch,descLines} = measureTip(ctx, stats, hov, slots);

  // Position: to the right of the mob gallery panel, vertically centred on the hovered tile
  const panelRect = mobGalPanel?.getBoundingClientRect();
  let tx = panelRect ? panelRect.right + 10 : hov.screenX + hov.tileSize/2 + 10;
  let ty = hov.screenY - ch/2;
  if (tx+cw > W-8) tx = panelRect ? panelRect.left - cw - 10 : hov.screenX - cw - 10;
  if (ty+ch > H-8) ty = H-8-ch;
  if (ty < 8) ty = 8;

  // Card bg
  ctx.save();
  ctx.beginPath(); ctx.roundRect(tx,ty,cw,ch,RADIUS_TIP);
  ctx.fillStyle='rgba(10,10,20,0.94)'; ctx.fill();
  ctx.beginPath(); ctx.roundRect(tx,ty,cw,ch,RADIUS_TIP);
  ctx.strokeStyle=rarityBorder(hov.rarity);
  ctx.lineWidth=2; ctx.stroke();

  let cy2=ty+PAD;

  // Name
  ctx.font=`bold 18px ${FONT}`;
  ctx.textAlign='left'; ctx.textBaseline='top';
  ctx.fillStyle='#ffffff'; ctx.fillText(stats.name,tx+PAD,cy2);
  // Kill count, right-aligned on the name line
  ctx.font=`bold 12px ${FONT}`;
  ctx.textAlign='right'; ctx.fillStyle='rgba(200,200,200,0.7)';
  const kills = killsOf(hov.typeId, hov.tier);
  ctx.fillText(`${kills.toLocaleString()} kill${kills === 1 ? '' : 's'}`, tx+cw-PAD, cy2+4);
  ctx.textAlign='left';
  cy2+=22+8;

  // Rarity badge
  const rbg=rarityFill(hov.rarity);
  const rbord=rarityBorder(hov.rarity);
  ctx.font=`bold 12px ${FONT}`;
  const rw2=ctx.measureText(hov.rarity).width;
  ctx.beginPath(); ctx.roundRect(tx+PAD,cy2,rw2+12,18,4);
  ctx.fillStyle=rbg; ctx.fill();
  ctx.strokeStyle=rbord; ctx.lineWidth=1.5; ctx.stroke();
  ctx.fillStyle=rarityContrastText(hov.rarity); ctx.textBaseline='middle';
  ctx.fillText(hov.rarity,tx+PAD+6,cy2+9);
  cy2+=16+10;

  // Description
  if(stats.description && descLines.length>0){
    ctx.font=`12px ${FONT}`;
    ctx.fillStyle='rgba(200,200,200,0.80)'; ctx.textBaseline='top';
    for(const ln of descLines){ctx.fillText(ln,tx+PAD,cy2);cy2+=LINE_H;}
    cy2+=10;
  }

  // Stats
  ctx.font=`13px ${FONT}`;
  ctx.textBaseline='top';
  for(const row of STAT_ROWS_TIP){
    const v = row.key === 'aggroRange' ? aggroText(hov.typeId, stats) : fmt(stats[row.key]);
    ctx.fillStyle='rgba(200,200,200,0.70)'; ctx.textAlign='left';
    ctx.fillText(row.label+':',tx+PAD,cy2);
    ctx.fillStyle=row.color; ctx.textAlign='right';
    ctx.fillText(v,tx+cw-PAD,cy2);
    cy2+=20;
  }
  if(stats.poisonTotal!=null){
    const pv=fmt(stats.poisonTotal)+' ('+fmt(Math.round(stats.poisonTotal/3))+'/s)';
    ctx.fillStyle='rgba(200,200,200,0.70)'; ctx.textAlign='left';
    ctx.fillText('Poison:',tx+PAD,cy2);
    ctx.fillStyle='#6a0bbd'; ctx.textAlign='right';
    ctx.fillText(pv,tx+cw-PAD,cy2);
    cy2+=20;
  }

  // Drops — ones the search matched get a pulsing white ring
  if(slots.length>0){
    cy2+=12;
    ctx.font=`bold 12px ${FONT}`;
    ctx.fillStyle='rgba(200,200,200,0.60)'; ctx.textAlign='left'; ctx.textBaseline='top';
    ctx.fillText('Drops:',tx+PAD,cy2); cy2+=14+6;
    const pulse = 0.65 + 0.35 * Math.sin(now / 180);
    for(const slot of slots){
      let sx=tx+PAD;
      for(const v of slot.variants){
        const ic=getPetalIcon(v.typeId,DROP_ICON_SZ);
        ctx.drawImage(ic,sx,cy2,DROP_ICON_SZ,DROP_ICON_SZ);
        if (hov.drops?.has(PETAL_TYPES[v.typeId]?.name)) {
          ctx.beginPath(); ctx.roundRect(sx-2.5,cy2-2.5,DROP_ICON_SZ+5,DROP_ICON_SZ+5,7);
          ctx.strokeStyle=`rgba(255,255,255,${pulse})`; ctx.lineWidth=2; ctx.stroke();
        }
        const pct=v.chance<1?`${Math.round(v.chance*100)}%`:'—';
        ctx.font=`bold 10px ${FONT}`;
        ctx.fillStyle='rgba(200,200,200,0.75)'; ctx.textAlign='center'; ctx.textBaseline='top';
        ctx.fillText(pct,sx+DROP_ICON_SZ/2,cy2+DROP_ICON_SZ+2);
        sx+=DROP_ICON_SZ+DROP_GAP;
      }
      cy2+=DROP_ROW_H+DROP_ROW_GAP;
    }
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────
const PANEL_W   = 540;
const TILE      = 58;                     // px
const GAP       = 6;
const LIFT      = 3;                      // canvas margin so hovered tiles can grow
const COL_STEP  = TILE + GAP;
const CV_W      = COLS * TILE + (COLS - 1) * GAP + LIFT * 2;
const CV_H      = TILE + LIFT * 2;
const HOVER_SCALE = 1.08;
const DIM_ALPHA   = 0.22;
const EASE_OUT  = 'cubic-bezier(0.22,1,0.36,1)';
const EASE_POP  = 'cubic-bezier(0.34,1.56,0.64,1)';

// ─────────────────────────────────────────────────────────────────────────────
// Panel state
// ─────────────────────────────────────────────────────────────────────────────
let mobGalOpen   = false;
let mobGalPanel  = null;
let tipOverlay   = null;
let els          = {};         // scroll, list, ghosts, search, clear, progress…

const rows      = new Map();   // typeId → row (see buildRows)
const tileFx    = new Map();   // `${typeId}:${tier}` → { kind: 'pop'|'bounce', at }
let index       = null;        // search index (built on first open)
let query       = '';
let search      = null;        // last searchMobs() result
let hovered     = null;        // { row, tier } under the mouse
let mouse       = null;        // last client mouse position over the scroll area
let loopRaf     = null;
let lastFrame   = 0;
let glideX = null, glideXT = 0, glideY = null, glideYT = 0;

// Hover state for the tooltip overlay
let hoveredEntry = null;       // { typeId, tier, rarity, screenX, screenY, tileSize, drops }

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
export function isMobGalOpen()  { return mobGalOpen; }

export function closeMobGal() {
  mobGalOpen = false;
  if (mobGalPanel) mobGalPanel.classList.remove('open');
  els.search?.blur();
  hovered = null; mouse = null;
  hideTooltipNow();   // no lingering fade once the panel is gone
  if (loopRaf != null) { cancelAnimationFrame(loopRaf); loopRaf = null; }
}

export function openMobGal() {
  mobGalOpen = true;
  if (!mobGalPanel) return;
  ensureIndex();
  buildRows();
  positionMobGalPanel();
  runSearch(false);
  refreshMeta();
  mobGalPanel.classList.add('open');
  introRows();
  lastFrame = performance.now();
  if (loopRaf == null) loopRaf = requestAnimationFrame(frame);
}

export function toggleMobGal() {
  togglePanel('mobGallery');
}

function onKillDataChanged(discoveryChanged) {
  if (!mobGalOpen) return;
  refreshMeta();
  // found / missing / complete searches depend on what's discovered
  if (discoveryChanged && /\b(found|discovered|unlocked|killed|missing|undiscovered|locked|unfound|complete|completed)\b/.test(query)) {
    runSearch(true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Search index
// ─────────────────────────────────────────────────────────────────────────────
function ensureIndex() {
  if (index) return;
  index = buildMobIndex(GALLERY_TYPES, {
    rarities: RARITIES,
    nameOf: mobDisplayName,
    altNamesOf: id => [MOB_DEFS[id]?.name].filter(Boolean),
    dropsOf: (id, tier) => {
      const names = [];
      for (const slot of getMobDropTable(id, tier) ?? []) {
        for (const v of slot.variants) {
          const n = PETAL_TYPES[v.typeId]?.name;
          if (n && !names.includes(n)) names.push(n);
        }
      }
      return names;
    },
    biomeOf: id => BIOME_OF[id] ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────
function buildRows() {
  if (rows.size) return;
  const dpr = window.devicePixelRatio || 1;
  for (const typeId of GALLERY_TYPES) {
    const el = document.createElement('div');
    el.className = 'mg-row';
    el.dataset.typeId = typeId;
    const cv = document.createElement('canvas');
    cv.className = 'mg-row-cv';
    cv.width = Math.round(CV_W * dpr); cv.height = Math.round(CV_H * dpr);
    cv.style.width = CV_W + 'px'; cv.style.height = CV_H + 'px';
    el.appendChild(cv);
    const ctx = cv.getContext('2d');
    rows.set(typeId, {
      typeId, el, cv, ctx, dpr,
      alpha: new Float32Array(COLS).fill(1),   // eased towards the search mask
      hover: new Float32Array(COLS),           // eased 0→1 hover lift
      phase: Math.random() * 10000,            // desync the idle animations
      result: null,
    });
  }
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Title progress bar. */
function refreshMeta() {
  let found = 0;
  for (const id of GALLERY_TYPES) for (let t = 0; t < COLS; t++) if (killsOf(id, t) > 0) found++;
  const total = GALLERY_TYPES.length * COLS;
  if (els.progressText) els.progressText.textContent = `${found} / ${total}`;
  if (els.progressFill) els.progressFill.style.width = (found / total * 100).toFixed(2) + '%';
}

function runSearch(animate) {
  ensureIndex();
  search = searchMobs(index, query, discoveredOf);
  for (const [id, row] of rows) row.result = search.results.get(id) ?? null;
  syncRows(animate);
}

/** Shows the rows the search kept, animating rows in, out and into place. */
function syncRows(animate) {
  const { list, ghosts } = els;
  if (!list) return;
  const wanted = search.order;
  const wantedSet = new Set(wanted);

  const before = new Map();
  for (const [id, r] of rows) if (r.el.isConnected) before.set(id, r.el.offsetTop);

  // Rows leaving: a copy (with its canvas pixels) shrinks away where it was
  for (const [id, r] of rows) {
    if (wantedSet.has(id) || !r.el.isConnected) continue;
    const top = before.get(id);
    before.delete(id);
    r.el.remove();
    if (!animate) continue;
    const ghost = r.el.cloneNode(true);
    ghost.querySelector('canvas').getContext('2d').drawImage(r.cv, 0, 0);
    ghost.style.cssText = `position:absolute;left:0;top:${top}px;`;
    ghosts.appendChild(ghost);
    ghost.animate([{ opacity: 1, transform: 'scaleY(1)' }, { opacity: 0, transform: 'scaleY(0.4)' }],
      { duration: 180, easing: 'ease-in', fill: 'forwards' }).onfinish = () => ghost.remove();
  }

  // Put the wanted rows in order
  let prev = null;
  const fresh = [];
  for (const id of wanted) {
    const row = rows.get(id);
    if (!row.el.isConnected) {
      fresh.push(id);
      for (let t = 0; t < COLS; t++) row.alpha[t] = row.result.mask[t] ? 1 : DIM_ALPHA;
    }
    const ref = prev ? prev.nextSibling : list.firstChild;
    if (ref !== row.el) list.insertBefore(row.el, ref);
    prev = row.el;
  }

  let empty = list.querySelector('.mg-empty');
  if (!wanted.length) {
    if (!empty) {
      empty = document.createElement('div'); empty.className = 'mg-empty';
      list.appendChild(empty);
      if (animate) empty.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
    }
    const guess = didYouMean(index, query);
    empty.innerHTML = `No mobs match <b>“${escapeHtml(query.trim())}”</b>` +
      (guess ? `<br><span class="mg-guess">Did you mean <u>${escapeHtml(guess)}</u>?</span>` : '');
    empty.dataset.guess = guess ?? '';
  } else empty?.remove();
  if (ghosts !== list.lastChild) list.appendChild(ghosts);

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

/** Opening the panel: the rows in view slide in one after another. */
function introRows() {
  const { scroll, list } = els;
  let i = 0;
  for (const id of search.order) {
    const el = rows.get(id).el;
    const top = list.offsetTop + el.offsetTop;
    if (top > scroll.scrollTop + scroll.clientHeight) break;
    if (top + el.offsetHeight < scroll.scrollTop) continue;
    el.animate([{ opacity: 0, transform: 'translateX(-14px)' }, { opacity: 1, transform: 'none' }],
      { duration: 300, easing: EASE_OUT, delay: 60 + i++ * 35, fill: 'backwards' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-frame drawing (only while open, only rows/columns on screen)
// ─────────────────────────────────────────────────────────────────────────────
const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
function backOut(t) { const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

function frame(now) {
  loopRaf = null;
  if (!mobGalOpen) return;
  const dt = Math.max(0, Math.min(100, now - lastFrame));
  lastFrame = now;
  stepGlide(dt);

  const { scroll, list } = els;
  const viewTop = scroll.scrollTop, viewH = scroll.clientHeight;
  const viewLeft = scroll.scrollLeft, viewW = scroll.clientWidth;
  const listTop = list.offsetTop;
  const kA = 1 - Math.pow(1 - 0.18, dt / 16.67);
  const kH = 1 - Math.pow(1 - 0.28, dt / 16.67);
  const c0 = Math.max(0, Math.floor((viewLeft - 12) / COL_STEP) - 1);
  const c1 = Math.min(COLS - 1, Math.ceil((viewLeft + viewW) / COL_STEP) + 1);

  for (const row of rows.values()) {
    if (!row.el.isConnected || !row.result) continue;
    const top = listTop + row.el.offsetTop;
    const onScreen = top + row.el.offsetHeight > viewTop - 60 && top < viewTop + viewH + 60;
    for (let t = 0; t < COLS; t++) {
      const aT = row.result.mask[t] ? 1 : DIM_ALPHA;
      row.alpha[t] += (aT - row.alpha[t]) * kA;
      const hT = hovered?.row === row && hovered.tier === t ? 1 : 0;
      row.hover[t] += (hT - row.hover[t]) * kH;
    }
    if (onScreen) drawRow(row, now, c0, c1);
  }

  if (tipShown || hoveredEntry) drawTooltipOverlay(now);
  loopRaf = requestAnimationFrame(frame);
}

function drawRow(row, now, c0, c1) {
  const { ctx, dpr, typeId } = row;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CV_W, CV_H);
  for (let tier = c0; tier <= c1; tier++) {
    const cx = LIFT + tier * COL_STEP + TILE / 2;
    const cy = LIFT + TILE / 2;
    const count = killsOf(typeId, tier);
    const alpha = row.alpha[tier];
    let scale = 1 + (HOVER_SCALE - 1) * easeOutCubic(row.hover[tier]);
    let countBounce = 1;
    const fx = tileFx.get(`${typeId}:${tier}`);
    if (fx) {
      const p = (now - fx.at) / (fx.kind === 'pop' ? 460 : 450);
      if (p >= 1) tileFx.delete(`${typeId}:${tier}`);
      else if (fx.kind === 'pop') scale *= Math.max(0, backOut(Math.max(0, p)));
      else countBounce = Math.max(0, p);
    }

    if (count > 0) {
      drawMobTile(ctx, cx, cy, {
        typeId, rarity: RARITIES[tier], size: TILE * scale, count, countBounce,
        time: now + row.phase + tier * 137, live: true, alpha,
      });
    } else {
      // Undiscovered — muted box with a faint "?"
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.roundRect(cx - TILE / 2, cy - TILE / 2, TILE, TILE, TILE * 0.16);
      ctx.fillStyle = '#8f8b1f'; ctx.fill();
      ctx.font = `900 ${TILE * 0.42}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillText('?', cx, cy + 1);
      ctx.restore();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Smooth wheel scrolling (both directions)
// ─────────────────────────────────────────────────────────────────────────────
function stepGlide(dt) {
  const { scroll } = els;
  const k = 1 - Math.pow(1 - 0.2, dt / 16.67);
  if (glideY !== null) {
    glideYT = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, glideYT));
    glideY += (glideYT - glideY) * k;
    if (Math.abs(glideYT - glideY) < 0.5) glideY = glideYT;
    scroll.scrollTop = glideY;
    if (glideY === glideYT) glideY = null;
  }
  if (glideX !== null) {
    glideXT = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, glideXT));
    glideX += (glideXT - glideX) * k;
    if (Math.abs(glideXT - glideX) < 0.5) glideX = glideXT;
    scroll.scrollLeft = glideX;
    if (glideX === glideXT) glideX = null;
  }
}

function glideTo(y) {
  glideY = els.scroll.scrollTop; glideYT = y;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip overlay canvas — fades in/out like the hotbar petal tooltips
// ─────────────────────────────────────────────────────────────────────────────
const TIP_FADE_IN_MS  = 280;
const TIP_FADE_OUT_MS = 200;
let tipAlpha   = 0;
let tipShown   = null;   // entry currently drawn (kept during fade-out)
let tipLastT   = 0;

function hideTooltipNow() {
  hoveredEntry = null; tipShown = null; tipAlpha = 0;
  drawTooltipOverlay(performance.now());
}

function drawTooltipOverlay(now) {
  const ov = tipOverlay;
  if (!ov) return;
  const dt = Math.max(0, Math.min(100, now - tipLastT));
  tipLastT = now;
  if (hoveredEntry) {
    tipShown = hoveredEntry;
    tipAlpha = Math.min(1, tipAlpha + dt / TIP_FADE_IN_MS);
  } else {
    tipAlpha = Math.max(0, tipAlpha - dt / TIP_FADE_OUT_MS);
    if (tipAlpha <= 0) tipShown = null;   // only forget it once fully faded out
  }

  const dpr = window.devicePixelRatio || 1;
  const W   = window.innerWidth;
  const H   = window.innerHeight;
  if (ov.width !== Math.round(W*dpr) || ov.height !== Math.round(H*dpr)) {
    ov.width  = Math.round(W*dpr);
    ov.height = Math.round(H*dpr);
    ov.style.width  = W+'px';
    ov.style.height = H+'px';
  }
  const ctx = ov.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (tipShown && tipAlpha > 0) {
    ctx.globalAlpha = tipAlpha;
    drawTooltipOnCanvas(ctx, W, H, tipShown, now);
    ctx.globalAlpha = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Hover
// ─────────────────────────────────────────────────────────────────────────────
function updateHover() {
  hovered = null;
  let entry = null;
  if (mouse) {
    const el = document.elementFromPoint(mouse.x, mouse.y);
    const rowEl = el?.closest?.('.mg-row');
    const row = rowEl && !rowEl.parentElement?.classList.contains('mg-ghosts') ? rows.get(rowEl.dataset.typeId) : null;
    if (row && el === row.cv) {
      const rect = row.cv.getBoundingClientRect();
      const x = mouse.x - rect.left - LIFT, y = mouse.y - rect.top - LIFT;
      const tier = Math.floor(x / COL_STEP);
      const inTile = tier >= 0 && tier < COLS && x - tier * COL_STEP <= TILE && y >= 0 && y <= TILE;
      if (inTile && killsOf(row.typeId, tier) > 0) {
        hovered = { row, tier };
        entry = {
          typeId: row.typeId, tier, rarity: RARITIES[tier],
          screenX: rect.left + LIFT + tier * COL_STEP + TILE / 2,
          screenY: rect.top + LIFT + TILE / 2,
          tileSize: TILE,
          drops: row.result?.drops,
        };
      }
    }
  }
  if (entry?.typeId !== hoveredEntry?.typeId || entry?.tier !== hoveredEntry?.tier) {
    if (!hoveredEntry && entry) tipLastT = performance.now();
  }
  hoveredEntry = entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search input
// ─────────────────────────────────────────────────────────────────────────────
function onQueryInput() {
  query = els.search.value;
  els.clear.classList.toggle('show', query.length > 0);
  runSearch(true);
  glideTo(0);
  updateHover();
}

// ─────────────────────────────────────────────────────────────────────────────
// Positioning
// ─────────────────────────────────────────────────────────────────────────────
export function positionMobGalButton() {
  const btn      = document.getElementById('mobgal-btn');
  const craftBtn = document.getElementById('crafting-btn');
  if (!btn || !craftBtn) return;
  const r = craftBtn.getBoundingClientRect();
  btn.style.left = r.left + 'px';
  btn.style.top  = Math.round(r.bottom + 10) + 'px';
}

export function positionMobGalPanel() {
  if (!mobGalPanel) return;
  const settingsBtn = document.getElementById('settings-btn');
  if (!settingsBtn) return;
  const sr      = settingsBtn.getBoundingClientRect();
  const screenH = window.innerHeight;
  const screenW = window.innerWidth;
  const panelW  = Math.min(PANEL_W, screenW - 16);
  mobGalPanel.style.width = panelW + 'px';
  let   top     = Math.round(sr.bottom + 10);
  let   left    = sr.left;

  // Cap panel height so it doesn't overlap the inventory button
  const invBtn = document.getElementById('inv-toggle-btn');
  let maxBottom = screenH - 8;
  if (invBtn) {
    const ir = invBtn.getBoundingClientRect();
    maxBottom = Math.min(maxBottom, ir.top - 8);
  }
  if (els.scroll) {
    const chrome = els.titlebar.offsetHeight + els.searchbar.offsetHeight + 10;
    const h = Math.max(150, Math.min(560, maxBottom - top - chrome));
    els.scroll.style.height = h + 'px';
    mobGalPanel.style.setProperty('--mg-view-w', ((els.scroll.clientWidth || panelW - 22) - 12) + 'px');
  }

  const panelH = mobGalPanel.offsetHeight;
  if (top + panelH > maxBottom) top = maxBottom - panelH;
  if (top < 8) top = 8;
  if (left + panelW > screenW - 8) left = screenW - 8 - panelW;
  mobGalPanel.style.left = Math.round(left) + 'px';
  mobGalPanel.style.top  = Math.round(top)  + 'px';
}

// ─────────────────────────────────────────────────────────────────────────────
// Inject styles
// ─────────────────────────────────────────────────────────────────────────────
(function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #mobgal-btn {
      position: fixed; width: 54px; height: 54px; border-radius: 10px;
      background: #DBD74D; border: 3px solid #A8A41A;
      cursor: pointer; z-index: 101;
      display: flex; align-items: center; justify-content: center;
      padding: 5px; box-sizing: border-box;
      transition: background 0.12s; user-select: none;
    }
    #mobgal-btn:hover  { background: #E8E455; }
    #mobgal-btn:active { transform: scale(0.95); }
    #mobgal-btn img    { width: 140%; height: 140%; object-fit: contain; display: block; }

    #mobgal-panel {
      position: fixed; width: ${PANEL_W}px;
      background: #DBD74D; border: 3px solid #A8A41A; border-radius: 12px;
      font-family: 'UbuntuCustom','Ubuntu',Arial,sans-serif;
      z-index: 100; user-select: none; box-sizing: border-box;
      opacity: 0; pointer-events: none;
      transform: translateX(calc(-100% - 32px));
      transition: opacity 0.20s cubic-bezier(0.22,1,0.36,1),
                  transform 0.22s cubic-bezier(0.22,1,0.36,1);
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0,0,0,0.25);
    }
    #mobgal-panel.open { opacity: 1; pointer-events: auto; transform: translateX(0); }

    /* Title */
    #mobgal-panel .mg-titlebar {
      display: flex; align-items: center; position: relative; padding: 8px 38px 4px 12px;
    }
    #mobgal-panel .mg-title {
      font-size: 17px; font-weight: 900; color: #fff; letter-spacing: 0.3px;
      -webkit-text-stroke: 3px #000; paint-order: stroke fill;
    }
    #mobgal-panel .mg-close {
      position: absolute; right: 8px; top: 8px;
      background: #c1565e; border: 2px solid #90464b; border-radius: 6px;
      color: #eee; font-size: 12px; font-weight: 900;
      width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
      cursor: pointer; padding: 0; line-height: 1; font-family: inherit;
      transition: background 0.12s, transform 0.12s;
    }
    #mobgal-panel .mg-close:hover { background: #a03040; transform: scale(1.08); }

    /* Discovery progress (left) + search (right) */
    #mobgal-panel .mg-searchbar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 2px 12px 8px;
    }
    #mobgal-panel .mg-progress { display: flex; align-items: center; gap: 7px; }
    #mobgal-panel .mg-progress-bar {
      width: 110px; height: 8px; border-radius: 6px; background: #A8A41A; overflow: hidden;
    }
    #mobgal-panel .mg-progress-fill {
      height: 100%; width: 0; background: #fff; border-radius: 6px;
      transition: width 0.5s cubic-bezier(0.22,1,0.36,1);
    }
    #mobgal-panel .mg-progress-text {
      font-size: 11px; font-weight: 900; color: #fff;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }
    #mobgal-panel .mg-search-wrap { position: relative; width: 190px; }
    #mobgal-panel .mg-search-icon {
      position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
      width: 12px; height: 12px; pointer-events: none; opacity: 0.8;
    }
    #mobgal-panel .mg-search {
      width: 100%; box-sizing: border-box; padding: 4px 24px 4px 26px;
      background: #F4F1A6; border: 2px solid #A8A41A; border-radius: 7px;
      color: #2c2a00; font-family: inherit; font-size: 11.5px; font-weight: 700; outline: none;
      transition: border-color 0.15s, background 0.15s;
    }
    #mobgal-panel .mg-search::placeholder { color: #8d8a3a; }
    #mobgal-panel .mg-search:focus { border-color: #6b6614; background: #FAF8C8; }
    #mobgal-panel .mg-search-clear {
      position: absolute; right: 5px; top: 50%; transform: translateY(-50%) scale(0.6);
      width: 15px; height: 15px; border-radius: 50%; border: none; padding: 0;
      background: #A8A41A; color: #fff; font-size: 8.5px; font-weight: 900; font-family: inherit;
      cursor: pointer; opacity: 0; pointer-events: none;
      transition: opacity 0.15s, transform 0.18s cubic-bezier(0.34,1.56,0.64,1), background 0.12s;
    }
    #mobgal-panel .mg-search-clear.show { opacity: 1; pointer-events: auto; transform: translateY(-50%) scale(1); }
    #mobgal-panel .mg-search-clear:hover { background: #6b6614; }

    /* Grid — an inset box, no scrollbars (wheel / drag to scroll) */
    #mobgal-panel .mg-scroll {
      position: relative; margin: 0 8px 8px; border-radius: 9px;
      background: #C8C43A; overflow: auto; scrollbar-width: none;
      box-shadow: inset 0 0 0 2px #B5B12C;
    }
    #mobgal-panel .mg-scroll::-webkit-scrollbar { display: none; }
    #mobgal-panel .mg-rows { width: max-content; padding: 5px 5px; }
    #mobgal-panel .mg-list { position: relative; }
    #mobgal-panel .mg-row { transform-origin: left top; }
    #mobgal-panel .mg-row-cv { display: block; }
    #mobgal-panel .mg-ghosts { position: absolute; left: 0; top: 0; pointer-events: none; }
    #mobgal-panel .mg-ghosts .mg-row { transform-origin: left center; }
    #mobgal-panel .mg-empty {
      position: sticky; left: 5px; width: var(--mg-view-w, 500px);
      padding: 38px 0; text-align: center; font-size: 13px; font-weight: 900; color: #fff; line-height: 1.7;
      -webkit-text-stroke: 2px #000; paint-order: stroke fill;
    }
    #mobgal-panel .mg-guess u { cursor: pointer; color: #FFE94A; }

    /* Tooltip overlay — full-viewport, pointer-events none, above everything */
    .mg-tooltip-overlay {
      position: fixed; inset: 0; z-index: 9999;
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function ensureMobGalDOM() {
  if (document.getElementById('mobgal-btn')) return;

  // ── Button ────────────────────────────────────────────────────────────────
  const btn = document.createElement('div');
  btn.id = 'mobgal-btn';
  const img = document.createElement('img');
  img.src = './public/icons/mob-gallery.png'; img.draggable = false;
  btn.appendChild(img);
  document.body.appendChild(btn);
  btn.addEventListener('mousedown', e => e.stopPropagation());

  // ── Tooltip overlay (full-page canvas, sits above the panel) ─────────────
  tipOverlay = document.createElement('canvas');
  tipOverlay.className = 'mg-tooltip-overlay';
  document.body.appendChild(tipOverlay);

  // ── Panel ─────────────────────────────────────────────────────────────────
  mobGalPanel = document.createElement('div');
  mobGalPanel.id = 'mobgal-panel';
  mobGalPanel.innerHTML = `
    <div class="mg-titlebar">
      <span class="mg-title">Mob Gallery</span>
      <button class="mg-close">✕</button>
    </div>
    <div class="mg-searchbar">
      <div class="mg-progress">
        <div class="mg-progress-bar"><div class="mg-progress-fill"></div></div>
        <span class="mg-progress-text"></span>
      </div>
      <div class="mg-search-wrap">
        <svg class="mg-search-icon" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="4.6" fill="none" stroke="#6b6614" stroke-width="2.2"/><path d="M10 10l4 4" stroke="#6b6614" stroke-width="2.4" stroke-linecap="round"/></svg>
        <input class="mg-search" type="text" placeholder="Search" autocomplete="off" spellcheck="false"/>
        <button class="mg-search-clear">✕</button>
      </div>
    </div>
    <div class="mg-scroll">
      <div class="mg-rows">
        <div class="mg-list"><div class="mg-ghosts"></div></div>
      </div>
    </div>
  `;
  document.body.appendChild(mobGalPanel);
  const q = sel => mobGalPanel.querySelector(sel);
  els = {
    titlebar: q('.mg-titlebar'), searchbar: q('.mg-searchbar'),
    scroll: q('.mg-scroll'), list: q('.mg-list'), ghosts: q('.mg-ghosts'),
    search: q('.mg-search'), clear: q('.mg-search-clear'),
    progressText: q('.mg-progress-text'), progressFill: q('.mg-progress-fill'),
  };

  mobGalPanel.addEventListener('mousedown', e => e.stopPropagation());
  q('.mg-close').addEventListener('click', () => closePanel('mobGallery'));

  // ── Search ────────────────────────────────────────────────────────────────
  const input = els.search;
  input.addEventListener('input', onQueryInput);
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); input.blur(); }
  });
  els.clear.addEventListener('click', () => {
    input.value = '';
    onQueryInput();
    input.focus();
  });
  els.list.addEventListener('click', e => {
    const guess = e.target.closest('.mg-guess u') && e.target.closest('.mg-empty')?.dataset.guess;
    if (guess) { input.value = guess.toLowerCase(); onQueryInput(); input.focus(); }
  });

  // ── Grid: smooth wheel, hover ─────────────────────────────────────────────
  const scroll = els.scroll;
  scroll.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroll.clientHeight : 1;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    if (horizontal) {
      if (glideX === null) { glideX = scroll.scrollLeft; glideXT = scroll.scrollLeft; }
      glideXT += (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
    } else {
      if (glideY === null) { glideY = scroll.scrollTop; glideYT = scroll.scrollTop; }
      glideYT += e.deltaY * unit;
    }
  }, { passive: false });
  let panFrom = null;
  enableDragPan(scroll, {
    start: () => {
      panFrom = { x: scroll.scrollLeft, y: scroll.scrollTop };
      glideX = scroll.scrollLeft; glideY = scroll.scrollTop;
    },
    move: (dx, dy) => {
      if (glideX === null) glideX = scroll.scrollLeft;
      if (glideY === null) glideY = scroll.scrollTop;
      glideXT = panFrom.x - dx; glideYT = panFrom.y - dy;
    },
  });
  scroll.addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; updateHover(); });
  scroll.addEventListener('mouseleave', () => { mouse = null; updateHover(); });
  scroll.addEventListener('scroll', () => { if (mouse) updateHover(); });

  // ── Toggle ────────────────────────────────────────────────────────────────
  btn.addEventListener('click', () => togglePanel('mobGallery'));
  registerPanel('mobGallery', {
    open: openMobGal, close: closeMobGal, isOpen: () => mobGalOpen,
    rootIds: ['mobgal-panel', 'mobgal-btn'],
  });

  window.addEventListener('resize', () => {
    positionMobGalPanel();
  });

  requestAnimationFrame(() => {
    positionMobGalButton();
    positionMobGalPanel();
  });
}
