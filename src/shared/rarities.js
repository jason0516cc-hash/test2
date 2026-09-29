/**
 * shared/rarities.js — THE rarity module. Every rarity name, tier and colour
 * in the game comes from here; nothing else defines rarity colours.
 *
 * Change a colour here and every GUI, tooltip, tile, drop, label and chat
 * badge follows.
 *
 * Each rarity has:
 *   fill   — inner fill of tiles/boxes/badges
 *   border — the darker outline around them
 *   text   — colour when the rarity is written as text (names, labels, chat).
 *            Same as `fill` unless the fill is too dark to read on the game's
 *            dark tooltips/chat, in which case a lighter shade is given.
 *   look   — optional special finish. Voidbound is meant to get a swirly
 *            (later animated) look; for now it paints as a plain fill. When
 *            that's added it goes in rarityPaint() below, and every box and
 *            tile picks it up.
 *
 * Pure data + helpers that take a canvas context — no DOM access, so this
 * stays safe to load on a server.
 */

// ── Tier order (index = tier, 0 = lowest) ────────────────────────────────────
export const RARITIES = [
  'Common',      // 0
  'Unusual',     // 1
  'Rare',        // 2
  'Epic',        // 3
  'Legendary',   // 4
  'Mythic',      // 5
  'Ultra',       // 6
  'Super',       // 7
  'Omega',       // 8
  'Unique',      // 9
  'Runic',       // 10
  'Seraphic',    // 11
  'Imperial',    // 12
  'Voidbound',   // 13
];

// ── Colours ──────────────────────────────────────────────────────────────────
const STYLE = {
  Common:    { fill: '#6FE46B', border: '#178A50' },
  Unusual:   { fill: '#DDDC5D', border: '#B4B74E' },
  Rare:      { fill: '#465ECF', border: '#3950AB' },
  Epic:      { fill: '#7633CB', border: '#612EA7' },
  Legendary: { fill: '#C13328', border: '#9D2E23' },
  Mythic:    { fill: '#1ED3CB', border: '#19AFA7' },
  Ultra:     { fill: '#DD3D72', border: '#B4365F' },
  Super:     { fill: '#2BFFA3', border: '#23CF84' },
  Omega:     { fill: '#F329D9', border: '#C220AD' },
  Unique:    { fill: '#444444', border: '#363636', text: '#8C8C8C' },
  Runic:     { fill: '#6605A3', border: '#2A0044', text: '#AA44FF' },
  Seraphic:  { fill: '#FFFFFF', border: '#AAAAAA' },
  Imperial:  { fill: '#7A1230', border: '#560B21', text: '#C8466C' },   // maroon
  Voidbound: { fill: '#000007', border: '#2F00A1', text: '#6B3DFF', look: 'swirl' },
};

const FALLBACK = { fill: '#888888', border: '#555555' };

function styleOf(rarity) {
  return STYLE[rarity] ?? FALLBACK;
}

// ── Lookups ──────────────────────────────────────────────────────────────────
/** Tier index of a rarity name (unknown → 0). */
export function rarityTier(rarity) {
  const i = RARITIES.indexOf(rarity);
  return i === -1 ? 0 : i;
}

/** Rarity name for a tier index (clamped). */
export function rarityAt(tier) {
  return RARITIES[Math.max(0, Math.min(RARITIES.length - 1, tier | 0))];
}

export function rarityFill(rarity)   { return styleOf(rarity).fill; }
export function rarityBorder(rarity) { return styleOf(rarity).border; }
export function rarityText(rarity)   { const s = styleOf(rarity); return s.text ?? s.fill; }

/** Black or white — whichever reads better ON TOP of the rarity's fill. */
export function rarityContrastText(rarity) {
  const hex = rarityFill(rarity).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111111' : '#FFFFFF';
}

/** Suffix used in petal ids: tier 8 → 'omega' (as in 'basic_omega'). */
export function raritySuffix(tier) {
  return RARITIES[tier].toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// ── Painting (canvas) ────────────────────────────────────────────────────────
/**
 * The fillStyle for a rarity's inner fill over the box (x, y, w, h).
 * Special looks (Voidbound's swirl) will be built here.
 */
export function rarityPaint(ctx, rarity, x, y, w, h) {
  return rarityFill(rarity);
}

/** Border width used for a box of this size — keeps every GUI consistent. */
export function rarityBorderWidth(size) {
  return Math.max(2, Math.round(size * 0.09));
}

/**
 * Draws the standard rarity box: border colour outside, fill inside.
 * Used by hotbar slots, crafting slots, mob gallery tiles, drops, HUD boxes…
 * @param {number} [radius]  corner radius (defaults to 16% of the size)
 * @param {number} [bw]      border width (defaults to rarityBorderWidth)
 */
export function drawRarityBox(ctx, rarity, x, y, w, h, radius = Math.min(w, h) * 0.16, bw = rarityBorderWidth(Math.min(w, h))) {
  if (w <= 0 || h <= 0) return;
  radius = Math.max(0, Math.min(radius, w / 2, h / 2));
  bw = Math.min(bw, w / 3, h / 3);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = rarityBorder(rarity);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x + bw, y + bw, w - bw * 2, h - bw * 2, Math.max(0, radius - bw * 0.7));
  ctx.fillStyle = rarityPaint(ctx, rarity, x + bw, y + bw, w - bw * 2, h - bw * 2);
  ctx.fill();
  ctx.restore();
}

// ── Painting (CSS, for DOM tiles) ────────────────────────────────────────────
/** { background, borderColor } for a DOM element styled as a rarity tile. */
export function rarityCss(rarity) {
  return { background: rarityFill(rarity), borderColor: rarityBorder(rarity) };
}
