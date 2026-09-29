// ── Mob tiles (pop icons, mob gallery, …) ────────────────────────────────────
// THE one way a mob is shown as a square tile: rarity box, mob art, name
// along the bottom, count badge in the top-right corner. The in-game pop
// icons (stat boxes) and the mob gallery both call drawMobTile(), so they
// always look identical — any future mob tile should use it too.
//
// The mob art itself comes from mobIcons.js (drawMobIconInBox); the box
// colours from shared/rarities.js.
import { drawMobIconInBox } from './mobIcons.js';
import { drawRarityBox, rarityBorderWidth } from '../../shared/rarities.js';

/** How much of the free space above the name the mob fills (1 = edge to edge). */
export const MOB_ICON_SCALE = 0.84;

const DISPLAY_NAMES = {
  centipede_head:        'Centipede',
  desert_centipede_head: 'Desert Centipede',
  soldier_ant:           'Soldier Ant',
  worker_ant:            'Worker Ant',
  baby_ant:              'Baby Ant',
  queen_ant:             'Queen Ant',
  ant_egg:               'Ant Egg',
  ant_hole:              'Ant Hole',
  fire_soldier_ant:      'Fire Soldier Ant',
  fire_worker_ant:       'Fire Worker Ant',
  fire_baby_ant:         'Fire Baby Ant',
  fire_queen_ant:        'Fire Queen Ant',
  fire_ant_egg:          'Fire Ant Egg',
  fire_ant_hole:         'Fire Ant Hole',
  queen_bee:             'Queen Bee',
  mummified_beetle:      'Mummified Beetle',
  sea_cave:              'Sea Cave',
  spider_egg:            'Spider Egg',
  queen_bee_egg:         'Bee Egg',
  queen_hornet_egg:      'Hornet Egg',
  ladybug_rose:          'Rose',
};

/** Display name for a mob type id ('fire_worker_ant' → 'Fire Worker Ant'). */
export function mobDisplayName(typeId) {
  return DISPLAY_NAMES[typeId]
    ?? typeId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1e4) return Math.floor(n / 1e3) + 'k';
  return String(n);
}

const FONT = '"UbuntuCustom", "Ubuntu", Arial, sans-serif';

// Fitted name font size per (name, tile size) — measuring is the costly part
// of a tile, and live views (the gallery) redraw every frame.
const _nameSizeCache = new Map();
function fitNameSize(ctx, name, S, maxNameW) {
  const key = name + '|' + Math.round(S * 2);
  let sz = _nameSizeCache.get(key);
  if (sz === undefined) {
    sz = Math.max(6, S * 0.165);
    ctx.font = `bold ${sz}px ${FONT}`;
    while (sz > 4 && ctx.measureText(name).width > maxNameW) {
      sz -= 0.25;
      ctx.font = `bold ${sz}px ${FONT}`;
    }
    if (_nameSizeCache.size > 4000) _nameSizeCache.clear();
    _nameSizeCache.set(key, sz);
  }
  ctx.font = `bold ${sz}px ${FONT}`;
  return sz;
}

/**
 * Draws one mob tile centred on (cx, cy).
 * @param {object}  o
 * @param {string}  o.typeId
 * @param {string}  o.rarity
 * @param {number}  o.size             tile size in px
 * @param {number}  [o.count=0]        badge shows when > 1
 * @param {number}  [o.countBounce=1]  0→1 pop animation of the badge (1 = settled)
 * @param {boolean} [o.isBoss=false]   red outline + "Boss" name prefix
 * @param {number}  [o.rotation=0]
 * @param {number}  [o.alpha=1]
 * @param {number}  [o.time]           animation clock for the mob art
 * @param {boolean} [o.live=false]     extra idle motion (gallery): the art
 *                                     sways/bobs and wings, legs and
 *                                     mandibles move
 */
export function drawMobTile(ctx, cx, cy, o) {
  const S = o.size;
  if (S < 1) return;
  const half = S / 2;
  const cr   = S * 0.16;
  const bw   = rarityBorderWidth(S);

  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.translate(cx, cy);
  if (o.rotation) ctx.rotate(o.rotation);

  // ── Box ────────────────────────────────────────────────────────────────────
  drawRarityBox(ctx, o.rarity, -half, -half, S, S, cr, bw);
  if (o.isBoss) {
    ctx.beginPath();
    ctx.roundRect(-half, -half, S, S, cr);
    ctx.strokeStyle = '#ff2222';
    ctx.lineWidth   = Math.max(2.5, S * 0.06);
    ctx.stroke();
  }

  // ── Name — measured first so the art gets exactly the space above it ──────
  const name     = o.isBoss ? `Boss ${mobDisplayName(o.typeId)}` : mobDisplayName(o.typeId);
  const inset    = bw + S * 0.04;
  const maxNameW = S - inset * 2;
  const nameSz   = fitNameSize(ctx, name, S, maxNameW);
  const nameY   = half - S * 0.12;            // alphabetic baseline
  const nameTop = nameY - nameSz * 0.8;

  // ── Mob art — fitted into the area above the name, then scaled down ───────
  const areaX = -half + inset, areaY = -half + inset;
  const areaW = S - inset * 2, areaH = (nameTop - S * 0.03) - areaY;
  const artW  = areaW * MOB_ICON_SCALE, artH = areaH * MOB_ICON_SCALE;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-half + bw, -half + bw, S - bw * 2, S - bw * 2, Math.max(0, cr - bw * 0.7));
  ctx.clip();
  if (o.live) {
    const t = o.time ?? Date.now();
    ctx.translate(0, Math.sin(t / 520) * S * 0.018);
    ctx.rotate(Math.sin(t / 830) * 0.06);
  }
  drawMobIconInBox(ctx, o.typeId,
    areaX + (areaW - artW) / 2, areaY + (areaH - artH) / 2, artW, artH, o.time, o.live);
  ctx.restore();

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin     = 'round';
  ctx.strokeStyle  = 'rgba(0,0,0,0.9)';
  ctx.lineWidth    = nameSz * 0.22;
  ctx.strokeText(name, 0, nameY);
  ctx.fillStyle    = '#ffffff';
  ctx.fillText(name, 0, nameY);

  // ── Count badge — top-right corner, tilted north-east ─────────────────────
  const count = o.count ?? 0;
  if (count > 1) {
    const t = o.countBounce ?? 1;
    const bounce = t < 1 ? 1 + 0.55 * Math.sin(t * Math.PI) * Math.pow(1 - t, 0.5) : 1;
    const fsz = Math.max(7, S * 0.2);
    ctx.save();
    ctx.translate(half - 5, -half + 5);
    ctx.rotate(Math.PI / 4);
    ctx.scale(bounce, bounce);
    ctx.font         = `bold ${fsz}px ${FONT}`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle  = 'rgba(0,0,0,0.85)';
    ctx.lineWidth    = fsz * 0.2;
    const label = 'x' + fmtCount(count);
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle    = '#ffffff';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}
