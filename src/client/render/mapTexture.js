// mapTexture.js — shared decorative-shape placement/rendering for biome maps.
//
// Used for two kinds of ground texture:
//   - FLOOR shapes (e.g. Garden's soft triangles) — placed only on open tiles,
//     fully clipped away wherever they'd cross into a wall.
//   - WALL shapes (e.g. Garden's circles/squircles) — placed only on wall
//     tiles, fully clipped away wherever they'd cross into open floor.
//
// Both share the same placement rules:
//   1. Every shape is the same size (radius passed in by the caller).
//   2. Shapes never touch or overlap each other (Poisson-disc style spacing).
//   3. A shape is never placed with its center inside the "wrong" surface
//      (floor shapes need center-on-floor, wall shapes need center-on-wall).
//   4. A shape near the floor/wall boundary is clipped exactly at that
//      boundary, so it only ever paints over its own surface type.
//   5. Density is capped by the minimum-spacing rule itself — spacing is
//      set well above 2x the shape radius, so shapes read as scattered
//      texture rather than a solid tiled mat.
//
// Placement is computed once per biome (deterministic seed, so reloading the
// same biome always regenerates the same layout) and cached — this is a
// texture, not a simulation, so nothing here runs per frame except the draw
// of whichever shapes are currently on screen.

// ── Deterministic RNG (same pattern as homescreen.js's seededRng) ───────────
function seededRng(seed) {
  let s = seed | 0;
  return () => { s = Math.imul(1664525, s) + 1013904223 | 0; return (s >>> 0) / 0xFFFFFFFF; };
}

// ── Poisson-disc-ish placement over a mask ──────────────────────────────────
// surfaceTest(gx, gy) -> true if that integer tile coordinate is the right
// surface type for this shape set (open floor, or wall). worldToTile-style
// conversion and the mask itself are supplied by the caller (per-biome).
//
// Places shapes on a jittered grid sized to the minimum spacing, which keeps
// this fast (no O(n^2) neighbor search) while still guaranteeing the min-gap
// rule: a jittered-grid cell can only ever produce one candidate, and cell
// size >= minSpacing means same-cell and adjacent-cell candidates can never
// violate the spacing on their own — a single distance check against already
//-placed shapes in neighboring cells is enough to confirm it.
function placeShapes({
  mapW, mapH, tileSize, isRightSurface, worldToTile,
  radius, minSpacing, seed, edgeMargin, maxRadius,
}) {
  const rng = seededRng(seed);
  const cell = minSpacing;
  const cols = Math.ceil(mapW / cell);
  const rows = Math.ceil(mapH / cell);

  // How far out (in tiles) a shape's largest possible radius could reach
  // from its own center tile — used below to require every tile the shape
  // could ever cover (at its biggest allowed size) to match the surface,
  // not just the tile its center happens to land on. Without this, a shape
  // placed safely at baseline size could still end up bleeding across the
  // wall/floor boundary once size variance scales it up.
  const reachTiles = Math.ceil((maxRadius ?? radius) / tileSize) + 1;

  const placed = [];
  // Spatial hash for fast neighbor lookups during placement only.
  const grid = new Map(); // "cx,cy" -> array of indices into placed[]
  function gridKey(x, y) { return `${Math.floor(x / cell)},${Math.floor(y / cell)}`; }
  function nearbyTooClose(x, y) {
    const gx0 = Math.floor(x / cell), gy0 = Math.floor(y / cell);
    for (let dgy = -1; dgy <= 1; dgy++) {
      for (let dgx = -1; dgx <= 1; dgx++) {
        const bucket = grid.get(`${gx0 + dgx},${gy0 + dgy}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          const p = placed[idx];
          if (Math.hypot(p.x - x, p.y - y) < minSpacing) return true;
        }
      }
    }
    return false;
  }

  // A candidate is only valid if every tile within reach of its largest
  // possible size also matches the wanted surface — not just its own tile.
  // This is what keeps a wall shape from ever touching/crossing into a
  // floor tile (or a floor shape from touching a wall tile): the check
  // fails the moment ANY nearby tile is the wrong surface, well before the
  // shape's actual drawn edge could get anywhere near that boundary.
  function fullyInsideSurface(cx, cy) {
    const { gx: cgx, gy: cgy } = worldToTile(cx, cy, tileSize);
    for (let dgy = -reachTiles; dgy <= reachTiles; dgy++) {
      for (let dgx = -reachTiles; dgx <= reachTiles; dgx++) {
        // Only check tiles whose nearest point could plausibly fall within
        // maxRadius of this candidate center — a full (2*reachTiles+1)^2
        // square would over-reject candidates near diagonal tiles that are
        // actually farther than maxRadius away.
        const tileCenterX = (cgx + dgx + 0.5) * tileSize;
        const tileCenterY = (cgy + dgy + 0.5) * tileSize;
        const distToTileCenter = Math.hypot(tileCenterX - cx, tileCenterY - cy);
        if (distToTileCenter > (maxRadius ?? radius) + tileSize * 0.75) continue;
        if (!isRightSurface(cgx + dgx, cgy + dgy)) return false;
      }
    }
    return true;
  }

  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      // One jittered candidate per grid cell.
      const cx = (rx + 0.15 + rng() * 0.7) * cell;
      const cy = (ry + 0.15 + rng() * 0.7) * cell;
      if (cx < edgeMargin || cx > mapW - edgeMargin) continue;
      if (cy < edgeMargin || cy > mapH - edgeMargin) continue;

      if (!fullyInsideSurface(cx, cy)) continue;
      if (nearbyTooClose(cx, cy)) continue;

      const idx = placed.length;
      placed.push({ x: cx, y: cy, r: radius, seed: rng() });
      const key = gridKey(cx, cy);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(idx);
    }
  }
  return placed;
}

// ── Public: build a cached shape set for one biome ──────────────────────────
// Call once per biome map module (top-level, so it runs at import time and
// is cached for the lifetime of the page — matches how the mask itself is
// decoded once at import time).
export function buildShapeSet({ mapW, mapH, tileSize, isOpenTile, radius, minSpacing, seed, surface, maxRadius }) {
  const worldToTile = (x, y, ts) => ({ gx: Math.floor(x / ts), gy: Math.floor(y / ts) });
  const isRightSurface = surface === 'floor'
    ? (gx, gy) => isOpenTile(gx, gy)
    : (gx, gy) => !isOpenTile(gx, gy);

  return placeShapes({
    mapW, mapH, tileSize, isRightSurface, worldToTile,
    radius, minSpacing, seed, maxRadius,
    edgeMargin: (maxRadius ?? radius) + tileSize, // keep generation away from the outer map border
  });
}

// ── Drawing: soft triangle (ported from homescreen.js's drawSoftTriangle) ──
export function pathSoftTriangle(ctx, cx, cy, r, rot, cr, bow) {
  const vx = [0, 1, 2].map(i => cx + Math.cos(rot + i * Math.PI * 2 / 3) * r);
  const vy = [0, 1, 2].map(i => cy + Math.sin(rot + i * Math.PI * 2 / 3) * r);

  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const ex = vx[j] - vx[i], ey = vy[j] - vy[i];
    const edgeLen = Math.hypot(ex, ey);
    const ux = ex / edgeLen, uy = ey / edgeLen;
    const nx = -uy, ny = ux;

    const t = Math.min(cr, edgeLen * 0.42);
    const ax = vx[i] + ux * t, ay = vy[i] + uy * t;
    const bx = vx[j] - ux * t, by = vy[j] - uy * t;

    if (i === 0) ctx.moveTo(ax, ay);
    else ctx.lineTo(ax, ay);

    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const cpx = mx + nx * bow * edgeLen;
    const cpy = my + ny * bow * edgeLen;
    ctx.quadraticCurveTo(cpx, cpy, bx, by);

    const nj = (j + 1) % 3;
    const e2x = vx[nj] - vx[j], e2y = vy[nj] - vy[j];
    const e2l = Math.hypot(e2x, e2y);
    const t2 = Math.min(cr, e2l * 0.42);
    ctx.quadraticCurveTo(vx[j], vy[j],
      vx[j] + (e2x / e2l) * t2,
      vy[j] + (e2y / e2l) * t2);
  }
  ctx.closePath();
}

// ── Drawing: squircle (superellipse-ish rounded square) ─────────────────────
export function pathSquircle(ctx, cx, cy, r, rot) {
  const n = 4; // superellipse exponent — 4 gives a classic "squircle" curve
  const steps = 20;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const ct = Math.cos(t), st = Math.sin(t);
    const x = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n) * r;
    const y = Math.sign(st) * Math.pow(Math.abs(st), 2 / n) * r;
    const rx = x * Math.cos(rot) - y * Math.sin(rot) + cx;
    const ry = x * Math.sin(rot) + y * Math.cos(rot) + cy;
    if (i === 0) ctx.moveTo(rx, ry);
    else ctx.lineTo(rx, ry);
  }
  ctx.closePath();
}

// ── Drawing: soft rounded regular polygon (shared base for diamond/hexagon
// below) — an N-sided polygon with every corner rounded off by a quarter-
// circle-ish arc, same rounding spirit as pathSoftTriangle but generalized
// to any vertex count so Desert/Ocean can each get their own simple, no-
// sharp-edges silhouette distinct from Garden's triangle/squircle. ─────────
function pathSoftPolygon(ctx, cx, cy, r, rot, sides, cornerFrac) {
  const verts = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * Math.PI * 2) / sides;
    verts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const [vx, vy] = verts[i];
    const [px, py] = verts[(i - 1 + sides) % sides];
    const [nx, ny] = verts[(i + 1) % sides];
    // Pull each vertex slightly toward both its neighbors, then round the
    // resulting near-corner with a quadratic curve back out to the true
    // vertex — same "cut the corner, curve through it" idea as the soft
    // triangle, just generalized to N sides via each vertex's two neighbors.
    const t = cornerFrac;
    const inX = vx + (px - vx) * t, inY = vy + (py - vy) * t;
    const outX = vx + (nx - vx) * t, outY = vy + (ny - vy) * t;
    if (i === 0) ctx.moveTo(inX, inY);
    else ctx.lineTo(inX, inY);
    ctx.quadraticCurveTo(vx, vy, outX, outY);
  }
  ctx.closePath();
}

// ── Drawing: soft rounded diamond (Desert floor) ────────────────────────────
export function pathSoftDiamond(ctx, cx, cy, r, rot) {
  pathSoftPolygon(ctx, cx, cy, r, rot, 4, 0.32);
}

// ── Drawing: soft rounded hexagon (Desert walls) ────────────────────────────
export function pathSoftHexagon(ctx, cx, cy, r, rot) {
  pathSoftPolygon(ctx, cx, cy, r, rot, 6, 0.28);
}

// ── Drawing: soft rounded blob/pebble (Ocean floor) — an ellipse with a
// gently wobbled radius per angle, so it reads as an organic pebble/coral
// shape rather than a perfect oval, while staying fully rounded. ──────────
export function pathSoftBlob(ctx, cx, cy, r, rot, wobble) {
  const steps = 24;
  ctx.beginPath();
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    // Gentle wobble, kept small relative to r and low-frequency, so the
    // outline stays a soft rounded blob rather than developing points —
    // the curve is smoothed further below by drawing through quadratic
    // midpoints rather than straight lines between these samples.
    const rr = r * (1 + wobble * 0.10 * Math.sin(3 * t + rot * 2) + wobble * 0.05 * Math.sin(5 * t - rot));
    pts.push([cx + Math.cos(t + rot) * rr, cy + Math.sin(t + rot) * rr]);
  }
  // Draw through midpoints with quadraticCurveTo (each sampled vertex acts
  // as a control point, not an on-curve point) — this is what actually
  // guarantees no sharp corners, regardless of how the radius wobbles.
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[steps - 1], pts[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < steps; i++) {
    const next = pts[(i + 1) % steps];
    const m = mid(pts[i], next);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
  }
  ctx.closePath();
}

// ── Drawing: soft rounded triangle, Ocean-wall variant — same rounding
// approach as pathSoftTriangle but with a larger fixed corner radius and no
// bow (flatter edges), so it reads visually distinct from Garden's version
// while staying in the same "simple rounded shape" family. ────────────────
export function pathSoftTriangleReef(ctx, cx, cy, r, rot) {
  pathSoftPolygon(ctx, cx, cy, r, rot, 3, 0.38);
}

// ── Per-tile clip region, in SCREEN space: builds a path covering exactly
// the on-screen rectangles of the tiles matching the wanted surface type
// within a shape's world-space bounding box, so drawing a shape clipped to
// this path can never bleed onto the other surface. Matches this codebase's
// convention (shared/biomes/garden.js's own drawMap) of projecting every point through
// wx2sx/wy2sy rather than using canvas transforms. ──────────────────────────
function clipToSurfaceTilesScreen(ctx, shape, tileSize, isOpenTile, wantOpen, wx2sx, wy2sy, zoomV) {
  const gx0 = Math.floor((shape.x - shape.r) / tileSize);
  const gx1 = Math.floor((shape.x + shape.r) / tileSize);
  const gy0 = Math.floor((shape.y - shape.r) / tileSize);
  const gy1 = Math.floor((shape.y + shape.r) / tileSize);
  const tileScreenSize = tileSize * zoomV;

  ctx.beginPath();
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (isOpenTile(gx, gy) !== wantOpen) continue;
      const sx = wx2sx(gx * tileSize);
      const sy = wy2sy(gy * tileSize);
      // Slight overdraw so adjacent same-surface tiles don't leave a hairline
      // seam at their shared edge (same +1px pattern drawMap itself uses).
      ctx.rect(sx, sy, tileScreenSize + 1, tileScreenSize + 1);
    }
  }
  ctx.clip();
}

// ── Public: wall outline + soft shadow, traced along the real floor/wall
// boundary (not per-tile grid lines). For every visible floor tile touching
// a wall tile, draws a shadow gradient a short distance onto the floor side
// of that edge, then a crisp line exactly on the boundary itself — so the
// silhouette reads as one solid wall mass with a clean edge, never a grid.
export function drawWallOutline(ctx, {
  worldLeft, worldRight, worldTop, worldBottom,
  wx2sx, wy2sy, zoomV, tileSize, isOpenTile,
  shadowDepth = 12, shadowColor = 'rgba(0,0,0,0.34)', lineColor = 'rgba(0,0,0,0.65)', lineWidth = 3.5,
}) {
  const gx0 = Math.max(0, Math.floor(worldLeft / tileSize) - 1);
  const gx1 = Math.ceil(worldRight / tileSize) + 1;
  const gy0 = Math.max(0, Math.floor(worldTop / tileSize) - 1);
  const gy1 = Math.ceil(worldBottom / tileSize) + 1;

  const depth = shadowDepth * zoomV;
  const lw = Math.max(1, lineWidth * zoomV);
  const ts = tileSize * zoomV;

  // ── Curved outline, offset out from the wall into the floor ─────────────
  // Per floor tile touching a wall, stroke ONE rounded path tracing that
  // tile's wall-facing sides, offset outward by `depth` — see
  // buildTileShadowPath for how the rounding itself works (a corner curves
  // with a quarter-circle arc only where two wall-facing edges genuinely
  // meet, so the curve follows the wall's real silhouette rather than every
  // tile corner). This used to be a filled gradient shadow; now it's a
  // stroked line at the shadow's own color/weight, sitting a small, fixed
  // distance out from the wall instead of touching it. Drawing one stroke
  // per floor tile (rather than merging the whole wall's silhouette into a
  // single path) keeps this simple: adjacent tiles' strokes meet exactly at
  // the shared corner since they're built from the same wall-neighbor data,
  // so there's no gap or double-drawn seam between them.
  ctx.strokeStyle = shadowColor;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (!isOpenTile(gx, gy)) continue;
      const walls = tileWallNeighbors(gx, gy, isOpenTile);
      if (!walls.any) continue;
      const sx = wx2sx(gx * tileSize), sy = wy2sy(gy * tileSize);
      buildTileOutlineOffsetPath(ctx, sx, sy, ts, depth, walls);
      ctx.stroke();
    }
  }

  // ── Crisp boundary line — plain, sharp-cornered, sitting exactly on the
  // real floor/wall boundary. This line traces an actual sharp corner where
  // two walls meet, so it stays sharp on purpose; only the shadow (above)
  // rounds off as it fans outward from that same corner. Drawn as one
  // continuous path per edge-direction so line joins between adjacent tiles'
  // edges connect cleanly, without trying to curve the corner itself.
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (!isOpenTile(gx, gy)) continue;
      const sx = wx2sx(gx * tileSize), sy = wy2sy(gy * tileSize);
      if (!isOpenTile(gx, gy - 1)) { ctx.moveTo(sx, sy);         ctx.lineTo(sx + ts, sy); }
      if (!isOpenTile(gx, gy + 1)) { ctx.moveTo(sx, sy + ts);     ctx.lineTo(sx + ts, sy + ts); }
      if (!isOpenTile(gx - 1, gy)) { ctx.moveTo(sx, sy);         ctx.lineTo(sx, sy + ts); }
      if (!isOpenTile(gx + 1, gy)) { ctx.moveTo(sx + ts, sy);     ctx.lineTo(sx + ts, sy + ts); }
    }
  }
  ctx.stroke();
}

function tileWallNeighbors(gx, gy, isOpenTile) {
  const top    = !isOpenTile(gx, gy - 1);
  const bottom = !isOpenTile(gx, gy + 1);
  const left   = !isOpenTile(gx - 1, gy);
  const right  = !isOpenTile(gx + 1, gy);
  return { top, bottom, left, right, any: top || bottom || left || right };
}

// Shared corner-rounding rule used by both the shadow fill and the outline
// stroke: a corner curves only when BOTH edges meeting there face a wall
// (a real wall corner) — a corner touching just one wall-facing edge stays
// a plain right angle, so neither the shadow nor the line ever bulges out
// where there's no wall on the other side.
function cornerCurves(walls) {
  return {
    TL: walls.top && walls.left,
    TR: walls.top && walls.right,
    BR: walls.bottom && walls.right,
    BL: walls.bottom && walls.left,
  };
}

// Builds (does not fill/stroke) one tile's shadow region: the tile's own
// square, expanded outward by `depth` along each wall-facing side, with a
// quarter-circle arc at every real wall corner.
function buildTileShadowPath(ctx, sx, sy, ts, depth, walls) {
  const { top: wallTop, bottom: wallBottom, left: wallLeft, right: wallRight } = walls;
  const { TL: curveTL, TR: curveTR, BR: curveBR, BL: curveBL } = cornerCurves(walls);

  const offTop    = wallTop    ? depth : 0;
  const offBottom = wallBottom ? depth : 0;
  const offLeft   = wallLeft   ? depth : 0;
  const offRight  = wallRight  ? depth : 0;

  const left = sx - offLeft, right = sx + ts + offRight;
  const top  = sy - offTop,  bottom = sy + ts + offBottom;

  ctx.beginPath();
  if (curveTL) ctx.moveTo(sx, top);
  else         ctx.moveTo(left, top);

  if (curveTR) { ctx.lineTo(right - depth, top); ctx.arcTo(right, top, right, sy, depth); }
  else         { ctx.lineTo(right, wallTop ? top : sy); }

  if (curveBR) { ctx.lineTo(right, bottom - depth); ctx.arcTo(right, bottom, right - depth, bottom, depth); }
  else         { ctx.lineTo(wallRight ? right : sx + ts, bottom); }

  if (curveBL) { ctx.lineTo(left + depth, bottom); ctx.arcTo(left, bottom, left, bottom - depth, depth); }
  else         { ctx.lineTo(left, wallBottom ? bottom : sy + ts); }

  if (curveTL) { ctx.lineTo(left, top + depth); ctx.arcTo(left, top, sx, top, depth); }
  else         { ctx.lineTo(left, wallLeft ? top : sy); }

  ctx.closePath();
}

// Builds (does not fill/stroke) one tile's OFFSET OUTLINE path: unlike
// buildTileShadowPath (a filled region — safe to have segments coincide with
// the plain, non-wall-facing tile boundary, since a same-tile fill hides
// them), this is meant to be STROKED, so it must contain ONLY the tile's
// actual wall-facing edges, each pushed outward by `depth`, joined by a
// quarter-circle arc wherever two wall-facing edges meet at a real wall
// corner. Every wall-facing edge that ISN'T adjacent to another wall-facing
// edge starts its own open sub-path (via moveTo) instead of connecting to a
// non-wall corner — so a lone wall-facing edge never grows a stray straight
// segment along the plain tile boundary, which would show up as a visible
// line cutting across open floor with nothing there to justify it.
function buildTileOutlineOffsetPath(ctx, sx, sy, ts, depth, walls) {
  const { top: wallTop, bottom: wallBottom, left: wallLeft, right: wallRight } = walls;
  const { TL: curveTL, TR: curveTR, BR: curveBR, BL: curveBL } = cornerCurves(walls);
  const x0 = sx, y0 = sy, x1 = sx + ts, y1 = sy + ts;
  // Offset INTO the floor tile (toward its center), away from whichever
  // side the wall is on — e.g. wallTop means the wall sits above this floor
  // tile, so the line for that edge moves DOWN (+depth) into the floor, not
  // up into the wall. Previously each of these had its sign backwards,
  // pushing the whole outline into the wall side instead of the floor side.
  const top = y0 + depth, bottom = y1 - depth, left = x0 + depth, right = x1 - depth;

  ctx.beginPath();

  if (wallTop) {
    ctx.moveTo(curveTL ? x0 : left, top);
    ctx.lineTo(curveTR ? x1 : right, top);
    if (curveTR) ctx.arcTo(right, top, right, y0, depth);
  }
  if (wallRight) {
    ctx.moveTo(right, curveTR ? y0 : top);
    ctx.lineTo(right, curveBR ? y1 : bottom);
    if (curveBR) ctx.arcTo(right, bottom, x1, bottom, depth);
  }
  if (wallBottom) {
    ctx.moveTo(curveBR ? x1 : right, bottom);
    ctx.lineTo(curveBL ? x0 : left, bottom);
    if (curveBL) ctx.arcTo(left, bottom, left, y1, depth);
  }
  if (wallLeft) {
    ctx.moveTo(left, curveBL ? y1 : bottom);
    ctx.lineTo(left, curveTL ? y0 : top);
    if (curveTL) ctx.arcTo(left, top, x0, top, depth);
  }
}


// ── Public: draw whichever shapes from a set fall in the visible world rect,
// each clipped exactly to its own surface type. All shape math happens in
// screen space (world coords converted via wx2sx/wy2sy first), matching how
// the rest of this codebase draws — no canvas transforms. ──────────────────
export function drawShapeSet(ctx, shapes, {
  worldLeft, worldRight, worldTop, worldBottom,
  wx2sx, wy2sy, zoomV, tileSize, isOpenTile, surface, color, drawShape,
}) {
  const wantOpen = surface === 'floor';

  for (const shape of shapes) {
    if (shape.x + shape.r < worldLeft || shape.x - shape.r > worldRight) continue;
    if (shape.y + shape.r < worldTop || shape.y - shape.r > worldBottom) continue;

    ctx.save();
    clipToSurfaceTilesScreen(ctx, shape, tileSize, isOpenTile, wantOpen, wx2sx, wy2sy, zoomV);

    const sx = wx2sx(shape.x);
    const sy = wy2sy(shape.y);
    const sr = shape.r * zoomV;

    ctx.fillStyle = color;
    // Pass through every custom property the caller attached to this shape
    // (rot/cr/bow for triangles, isCircle/rot for wall shapes, etc.) — only
    // x/y/r are overridden here with their screen-space equivalents. Losing
    // the spread here previously meant drawShape always received x/y/r/seed
    // only, so callbacks reading shape.rot/cr/bow got undefined -> NaN ->
    // a canvas path with no valid coordinates -> nothing drawn, no error.
    drawShape(ctx, { ...shape, x: sx, y: sy, r: sr });
    ctx.fill();

    ctx.restore();
  }
}
