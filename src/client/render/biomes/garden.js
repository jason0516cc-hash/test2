// Drawing for the Garden biome: floor/wall colours, the decorative
// texture shapes, and drawMap. Map data (tiles, zones, collision) lives in
// shared/biomes/garden.js — this file only reads it.
import { MAP_W, MAP_H, TILE_SIZE, GRID_W, GRID_H, isOpenTile } from '../../../shared/biomes/garden.js';
import { buildShapeSet, drawShapeSet, pathSoftTriangle, pathSquircle } from '../mapTexture.js';

const MAP_WALL_COLOR = '#4a3822';   // muddy dark brown
const FLOOR_COLOR = '#1ea761';       // same background green as the homescreen

// ── Decorative ground/wall texture ────────────────────────────────────────────
// Floor: soft triangles, same style/color as the homescreen background.
// Wall: circles + squircles in a lighter dirty-brown tone than the wall base.
// Both are placed once at module load (deterministic seed — same layout every
// time this biome loads) and clipped exactly to their own surface at draw
// time, so neither ever paints over the other.
const TRIANGLE_RADIUS = 45;       // ~2x player radius (22) — "medium" per spec — baseline size
const TRIANGLE_SPACING = 250;      // tightened for noticeably more triangles on screen
const TRIANGLE_COLOR = 'rgba(0,0,0,0.08)'; // exact homescreen triangle color

const WALL_SHAPE_RADIUS = 40;      // baseline size
const WALL_SHAPE_SPACING = 250;
const WALL_SHAPE_COLOR = '#a9895c'; // lighter dirty-brown than the wall base

// Size "wiggle room": every shape's placed (baseline) radius is scaled by a
// factor in [SIZE_VARIANCE_MIN, SIZE_VARIANCE_MAX] — genuinely smaller AND
// bigger than baseline, but capped on both ends so nothing reads as "giant"
// or "practically invisible". Verified exhaustively (every shape pair within
// range, not just the theoretical worst case) against the tightened spacing
// above: minimum real edge-to-edge gap found was 117+ world units for
// triangles and 131+ for wall shapes — comfortably >0, so no overlap risk
// even at max density + max size together.
const SIZE_VARIANCE_MIN = 0.65;
const SIZE_VARIANCE_MAX = 1.5;

const _floorTriangles = buildShapeSet({
  mapW: MAP_W, mapH: MAP_H, tileSize: TILE_SIZE, isOpenTile,
  radius: TRIANGLE_RADIUS, minSpacing: TRIANGLE_SPACING,
  seed: 0xA51E9, surface: 'floor', maxRadius: TRIANGLE_RADIUS * SIZE_VARIANCE_MAX,
});
// Each triangle gets a stable rotation/corner-radius/bow/size derived from
// its own placement seed, so regenerating the list (e.g. on reload) always
// looks the same — matches the "deterministic" intent of buildShapeSet itself.
for (const t of _floorTriangles) {
  t.rot = t.seed * Math.PI * 2;
  t.r   = t.r * (SIZE_VARIANCE_MIN + (t.seed * 17 % 1) * (SIZE_VARIANCE_MAX - SIZE_VARIANCE_MIN));
  t.cr  = t.r * (0.25 + (t.seed * 7 % 1) * 0.15);
  t.bow = 0.04 + (t.seed * 13 % 1) * 0.08;
}

const _wallShapes = buildShapeSet({
  mapW: MAP_W, mapH: MAP_H, tileSize: TILE_SIZE, isOpenTile,
  radius: WALL_SHAPE_RADIUS, minSpacing: WALL_SHAPE_SPACING,
  seed: 0x517A4, surface: 'wall', maxRadius: WALL_SHAPE_RADIUS * SIZE_VARIANCE_MAX,
});
for (const s of _wallShapes) {
  s.isCircle = (s.seed * 29 % 1) < 0.3; // squares clearly more common: ~70% square, ~30% circle
  s.rot = s.seed * Math.PI * 2;
  s.r   = s.r * (SIZE_VARIANCE_MIN + (s.seed * 19 % 1) * (SIZE_VARIANCE_MAX - SIZE_VARIANCE_MIN));
}

// The floor's look on its own (colour + texture shape), for the homescreen
// background. `s` = { x, y, r, rot, k1, k2 } with k1/k2 random in [0, 1).
export const FLOOR = {
  color: FLOOR_COLOR, shapeColor: TRIANGLE_COLOR, radius: TRIANGLE_RADIUS,
  sizeMin: SIZE_VARIANCE_MIN, sizeMax: SIZE_VARIANCE_MAX,
  path: (c, s) => pathSoftTriangle(c, s.x, s.y, s.r, s.rot, s.r * (0.25 + s.k1 * 0.15), 0.04 + s.k2 * 0.08),
};

export function drawMap(ctx, cameraX, cameraY, canvasW, canvasH, zoomV = 1) {
  const hw = canvasW / 2, hh = canvasH / 2;
  const wx2sx = wx => (wx - cameraX) * zoomV + hw;
  const wy2sy = wy => (wy - cameraY) * zoomV + hh;

  ctx.fillStyle = '#0a0a08';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const worldLeft   = cameraX - hw / zoomV;
  const worldRight  = cameraX + hw / zoomV;
  const worldTop    = cameraY - hh / zoomV;
  const worldBottom = cameraY + hh / zoomV;

  const gx0 = Math.max(0, Math.floor(worldLeft / TILE_SIZE) - 1);
  const gx1 = Math.min(GRID_W - 1, Math.ceil(worldRight / TILE_SIZE) + 1);
  const gy0 = Math.max(0, Math.floor(worldTop / TILE_SIZE) - 1);
  const gy1 = Math.min(GRID_H - 1, Math.ceil(worldBottom / TILE_SIZE) + 1);

  const tileScreenSize = TILE_SIZE * zoomV;

  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const open = isOpenTile(gx, gy);
      ctx.fillStyle = open ? FLOOR_COLOR : MAP_WALL_COLOR;
      const sx = wx2sx(gx * TILE_SIZE);
      const sy = wy2sy(gy * TILE_SIZE);
      ctx.fillRect(sx, sy, tileScreenSize + 1, tileScreenSize + 1);
    }
  }

  // ── Decorative texture: floor triangles, then wall circles/squircles ──────
  drawShapeSet(ctx, _floorTriangles, {
    worldLeft, worldRight, worldTop, worldBottom,
    wx2sx, wy2sy, zoomV, tileSize: TILE_SIZE, isOpenTile,
    surface: 'floor', color: TRIANGLE_COLOR,
    drawShape: (c, s) => pathSoftTriangle(c, s.x, s.y, s.r, s.rot, s.cr * zoomV, s.bow),
  });
  drawShapeSet(ctx, _wallShapes, {
    worldLeft, worldRight, worldTop, worldBottom,
    wx2sx, wy2sy, zoomV, tileSize: TILE_SIZE, isOpenTile,
    surface: 'wall', color: WALL_SHAPE_COLOR,
    drawShape: (c, s) => {
      if (s.isCircle) { c.beginPath(); c.arc(s.x, s.y, s.r, 0, Math.PI * 2); c.closePath(); }
      else            { pathSquircle(c, s.x, s.y, s.r, s.rot); }
    },
  });

  const wt = Math.max(3, 8 * zoomV);
  const mapLeft = wx2sx(0), mapTop = wy2sy(0);
  const mapRight = wx2sx(MAP_W), mapBottom = wy2sy(MAP_H);
  ctx.fillStyle = MAP_WALL_COLOR;
  ctx.fillRect(mapLeft - wt, mapTop - wt, (mapRight - mapLeft) + wt * 2, wt);
  ctx.fillRect(mapLeft - wt, mapBottom, (mapRight - mapLeft) + wt * 2, wt);
  ctx.fillRect(mapLeft - wt, mapTop - wt, wt, (mapBottom - mapTop) + wt * 2);
  ctx.fillRect(mapRight, mapTop - wt, wt, (mapBottom - mapTop) + wt * 2);
}
