// Drawing for the Ocean biome: floor/wall colours, the decorative
// texture shapes, and drawMap. Map data (tiles, zones, collision) lives in
// shared/biomes/ocean.js — this file only reads it.
import { MAP_W, MAP_H, TILE_SIZE, GRID_W, GRID_H, isOpenTile } from '../../../shared/biomes/ocean.js';
import { buildShapeSet, drawShapeSet, pathSoftBlob, pathSoftTriangleReef } from '../mapTexture.js';

const MAP_WALL_COLOR = '#0a2438';
const FLOOR_COLOR = '#3fa9c9';

// ── Decorative ground/wall texture ────────────────────────────────────────────
// Ocean's own take on the same texture system: floor gets soft rounded
// blob/pebble shapes (reads as coral or smooth rocks underwater), walls get
// soft rounded triangles (reef-like) — distinct silhouettes from Garden's
// and Desert's, same simple no-sharp-edges family, tinted from Ocean's own
// palette.
const BLOB_RADIUS = 44;
const BLOB_SPACING = 250;
const BLOB_COLOR = 'rgba(0,0,0,0.08)'; // subtle darkening of the water floor

const REEF_RADIUS = 40;
const REEF_SPACING = 250;
const REEF_COLOR = '#3f6d8a'; // lighter tint of this biome's own wall blue (#0a2438 base)

const SIZE_VARIANCE_MIN = 0.65;
const SIZE_VARIANCE_MAX = 1.5;

const _floorBlobs = buildShapeSet({
  mapW: MAP_W, mapH: MAP_H, tileSize: TILE_SIZE, isOpenTile,
  radius: BLOB_RADIUS, minSpacing: BLOB_SPACING,
  seed: 0x0CEA71, surface: 'floor', maxRadius: BLOB_RADIUS * SIZE_VARIANCE_MAX,
});
for (const t of _floorBlobs) {
  t.rot = t.seed * Math.PI * 2;
  t.wobble = 0.5 + (t.seed * 23 % 1) * 0.6; // varied pebble irregularity, always mild
  t.r   = t.r * (SIZE_VARIANCE_MIN + (t.seed * 17 % 1) * (SIZE_VARIANCE_MAX - SIZE_VARIANCE_MIN));
}

const _wallReefs = buildShapeSet({
  mapW: MAP_W, mapH: MAP_H, tileSize: TILE_SIZE, isOpenTile,
  radius: REEF_RADIUS, minSpacing: REEF_SPACING,
  seed: 0x8EEF02, surface: 'wall', maxRadius: REEF_RADIUS * SIZE_VARIANCE_MAX,
});
for (const s of _wallReefs) {
  s.rot = s.seed * Math.PI * 2;
  s.r   = s.r * (SIZE_VARIANCE_MIN + (s.seed * 19 % 1) * (SIZE_VARIANCE_MAX - SIZE_VARIANCE_MIN));
}

// The floor's look on its own (colour + texture shape), for the homescreen
// background. `s` = { x, y, r, rot, k1, k2 } with k1/k2 random in [0, 1).
export const FLOOR = {
  color: FLOOR_COLOR, shapeColor: BLOB_COLOR, radius: BLOB_RADIUS,
  sizeMin: SIZE_VARIANCE_MIN, sizeMax: SIZE_VARIANCE_MAX,
  path: (c, s) => pathSoftBlob(c, s.x, s.y, s.r, s.rot, 0.5 + s.k1 * 0.6),
};

export function drawMap(ctx, cameraX, cameraY, canvasW, canvasH, zoomV = 1) {
  const hw = canvasW / 2, hh = canvasH / 2;
  const wx2sx = wx => (wx - cameraX) * zoomV + hw;
  const wy2sy = wy => (wy - cameraY) * zoomV + hh;

  ctx.fillStyle = '#050a10';
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

  // ── Decorative texture: floor blobs/pebbles, then wall reef triangles ─────
  drawShapeSet(ctx, _floorBlobs, {
    worldLeft, worldRight, worldTop, worldBottom,
    wx2sx, wy2sy, zoomV, tileSize: TILE_SIZE, isOpenTile,
    surface: 'floor', color: BLOB_COLOR,
    drawShape: (c, s) => pathSoftBlob(c, s.x, s.y, s.r, s.rot, s.wobble),
  });
  drawShapeSet(ctx, _wallReefs, {
    worldLeft, worldRight, worldTop, worldBottom,
    wx2sx, wy2sy, zoomV, tileSize: TILE_SIZE, isOpenTile,
    surface: 'wall', color: REEF_COLOR,
    drawShape: (c, s) => pathSoftTriangleReef(c, s.x, s.y, s.r, s.rot),
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
