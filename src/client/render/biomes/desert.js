// Drawing for the Desert biome: floor/wall colours, the decorative
// texture shapes, and drawMap. Map data (tiles, zones, collision) lives in
// shared/biomes/desert.js — this file only reads it.
import { MAP_W, MAP_H, TILE_SIZE, GRID_W, GRID_H, isOpenTile } from '../../../shared/biomes/desert.js';
import { buildShapeSet, drawShapeSet, pathSoftDiamond, pathSoftHexagon } from '../mapTexture.js';

const MAP_WALL_COLOR = '#3a2408';
const FLOOR_COLOR = '#d4a843';

// ── Decorative ground/wall texture ────────────────────────────────────────────
// Desert's own take on the same texture system Garden uses: floor gets soft
// rounded diamonds (reads as sand mounds/dunes), walls get soft rounded
// hexagons — distinct silhouettes from Garden's triangles/squircles, but the
// same simple, no-sharp-edges family, tinted from this biome's own colors
// rather than borrowed from another biome.
const DIAMOND_RADIUS = 42;
const DIAMOND_SPACING = 250;
const DIAMOND_COLOR = 'rgba(0,0,0,0.10)'; // subtle darkening of the sand floor

const HEX_RADIUS = 38;
const HEX_SPACING = 250;
const HEX_COLOR = '#e8bd5c'; // lighter tint of this biome's own wall brown (#3a2408 base -> warm sandstone highlight)

const SIZE_VARIANCE_MIN = 0.65;
const SIZE_VARIANCE_MAX = 1.5;

const _floorDiamonds = buildShapeSet({
  mapW: MAP_W, mapH: MAP_H, tileSize: TILE_SIZE, isOpenTile,
  radius: DIAMOND_RADIUS, minSpacing: DIAMOND_SPACING,
  seed: 0xD35E27, surface: 'floor', maxRadius: DIAMOND_RADIUS * SIZE_VARIANCE_MAX,
});
for (const t of _floorDiamonds) {
  t.rot = t.seed * Math.PI * 2;
  t.r   = t.r * (SIZE_VARIANCE_MIN + (t.seed * 17 % 1) * (SIZE_VARIANCE_MAX - SIZE_VARIANCE_MIN));
}

const _wallHexes = buildShapeSet({
  mapW: MAP_W, mapH: MAP_H, tileSize: TILE_SIZE, isOpenTile,
  radius: HEX_RADIUS, minSpacing: HEX_SPACING,
  seed: 0x4E5A11, surface: 'wall', maxRadius: HEX_RADIUS * SIZE_VARIANCE_MAX,
});
for (const s of _wallHexes) {
  s.rot = s.seed * Math.PI * 2;
  s.r   = s.r * (SIZE_VARIANCE_MIN + (s.seed * 19 % 1) * (SIZE_VARIANCE_MAX - SIZE_VARIANCE_MIN));
}

// The floor's look on its own (colour + texture shape), for the homescreen
// background. `s` = { x, y, r, rot, k1, k2 } with k1/k2 random in [0, 1).
export const FLOOR = {
  color: FLOOR_COLOR, shapeColor: DIAMOND_COLOR, radius: DIAMOND_RADIUS,
  sizeMin: SIZE_VARIANCE_MIN, sizeMax: SIZE_VARIANCE_MAX,
  path: (c, s) => pathSoftDiamond(c, s.x, s.y, s.r, s.rot),
};

export function drawMap(ctx, cameraX, cameraY, canvasW, canvasH, zoomV = 1) {
  const hw = canvasW / 2, hh = canvasH / 2;
  const wx2sx = wx => (wx - cameraX) * zoomV + hw;
  const wy2sy = wy => (wy - cameraY) * zoomV + hh;

  ctx.fillStyle = '#120c04';
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

  // ── Decorative texture: floor diamonds, then wall hexagons ────────────────
  drawShapeSet(ctx, _floorDiamonds, {
    worldLeft, worldRight, worldTop, worldBottom,
    wx2sx, wy2sy, zoomV, tileSize: TILE_SIZE, isOpenTile,
    surface: 'floor', color: DIAMOND_COLOR,
    drawShape: (c, s) => pathSoftDiamond(c, s.x, s.y, s.r, s.rot),
  });
  drawShapeSet(ctx, _wallHexes, {
    worldLeft, worldRight, worldTop, worldBottom,
    wx2sx, wy2sy, zoomV, tileSize: TILE_SIZE, isOpenTile,
    surface: 'wall', color: HEX_COLOR,
    drawShape: (c, s) => pathSoftHexagon(c, s.x, s.y, s.r, s.rot),
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
