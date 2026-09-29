// ── Death / break pops ────────────────────────────────────────────────────────
// When a mob dies or a petal breaks, it doesn't just vanish: it swells up and
// fades out where it was — the same pop pollen does when it expires. Mobs
// also burst into a few small dots in their rarity's colour.
//
// Driven by the game's 'mobDied' and 'petalBroken' events; everything here
// lives in world coordinates, so the effects stay put while the camera moves.
import { toScreen, zoomState } from '../camera.js';
import { onGameEvent } from '../../game/events.js';
import { drawMob, drawStingerMissile } from './mobDrawing.js';
import { drawPetalShape, drawPieceShape } from './petalDrawing.js';
import { rarityFill, rarityBorder } from '../../shared/rarities.js';
import { PETAL_TYPES } from '../../shared/petalTypes.js';

const MOB_POP_MS   = 300;
const PETAL_POP_MS = 260;
const SWELL        = 0.35;   // grows 35% as it fades, like pollen

const mobPops   = [];   // { mob, t0 }
const petalPops = [];   // { typeId, x, y, radius, isPiece, pieceAngle, t0 }
const dots      = [];   // { x, y, vx, vy, r, life, age, fill, stroke }

const easeOut = t => 1 - Math.pow(1 - t, 2);
const fadeAfter = (t, from) => (t < from ? 1 : Math.max(0, 1 - (t - from) / (1 - from)));

onGameEvent('mobDied', ({ mob }) => {
  if (!mob) return;
  const now = performance.now();
  mobPops.push({ mob, t0: now });

  // Dots: more (and bigger) for bigger mobs
  const R = Math.max(mob.radius ?? 10, mob.drawRadius ?? 0);
  const n = Math.max(6, Math.min(22, Math.round(6 + R * 0.12)));
  const fill = mob.rarity ? rarityFill(mob.rarity) : '#ffffff';
  const stroke = mob.rarity ? rarityBorder(mob.rarity) : '#cccccc';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const sp = (0.08 + Math.random() * 0.14) * Math.sqrt(Math.max(1, R / 18));
    dots.push({
      x: mob.x + Math.cos(a) * R * 0.5, y: mob.y + Math.sin(a) * R * 0.5,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      r: Math.max(2.5, Math.min(12, R * (0.09 + Math.random() * 0.06))),
      life: 420 + Math.random() * 280, age: 0, fill, stroke,
    });
  }
});

// Destroyed missiles pop the same way (hornet/scorpion stingers)
const missilePops = [];   // { x, y, angle, size, t0 }
onGameEvent('missileDied', e => { missilePops.push({ ...e, t0: performance.now() }); });

onGameEvent('petalBroken', e => {
  if (!PETAL_TYPES[e.typeId]) return;
  petalPops.push({ ...e, t0: performance.now() });
});

/** Dying mobs (swell + fade) and their dots — draw after the living mobs. */
export function drawMobDeaths(ctx, W, H, dt) {
  const now = performance.now();
  const z = zoomState.v;

  for (let i = mobPops.length - 1; i >= 0; i--) {
    const { mob, t0 } = mobPops[i];
    const t = (now - t0) / MOB_POP_MS;
    if (t >= 1) { mobPops.splice(i, 1); continue; }
    const tt = Math.max(0, t);
    const { sx, sy } = toScreen(mob.x, mob.y, W, H);
    const r = (mob.drawRadius ?? mob.radius) * z * (1 + SWELL * easeOut(tt));
    if (r < 0.5) continue;
    ctx.save();
    ctx.globalAlpha = fadeAfter(tt, 0.35);
    try {
      if (mob.typeId === 'leech' && mob.trail?.length >= 2) {
        const trail = mob.trail.map(p => { const s = toScreen(p.x, p.y, W, H); return { x: s.sx, y: s.sy }; });
        drawMob(ctx, mob, sx, sy, r, trail);
      } else {
        drawMob(ctx, mob, sx, sy, r);
      }
    } catch (_) { /* a half-torn-down mob shouldn't take the frame with it */ }
    ctx.restore();
  }

  const k = Math.pow(0.9, dt / 16.67);   // friction
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    d.age += dt;
    if (d.age >= d.life) { dots.splice(i, 1); continue; }
    d.x += d.vx * dt; d.y += d.vy * dt;
    d.vx *= k; d.vy *= k;
    const t = d.age / d.life;
    const { sx, sy } = toScreen(d.x, d.y, W, H);
    const r = d.r * z * (1 - 0.5 * t);
    if (r < 0.4) continue;
    ctx.save();
    ctx.globalAlpha = fadeAfter(t, 0.45);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = d.fill;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.3);
    ctx.strokeStyle = d.stroke;
    ctx.stroke();
    ctx.restore();
  }
}

/** Broken petals and destroyed missiles (swell + fade) — draw after the live petals. */
export function drawPetalBreaks(ctx, W, H) {
  const now = performance.now();
  for (let i = missilePops.length - 1; i >= 0; i--) {
    const p = missilePops[i];
    const t = (now - p.t0) / PETAL_POP_MS;
    if (t >= 1) { missilePops.splice(i, 1); continue; }
    const tt = Math.max(0, t);
    const { sx, sy } = toScreen(p.x, p.y, W, H);
    ctx.save();
    ctx.globalAlpha = fadeAfter(tt, 0.3);
    drawStingerMissile(ctx, sx, sy, p.size * zoomState.v * (1 + SWELL * easeOut(tt)), p.angle);
    ctx.restore();
  }
  for (let i = petalPops.length - 1; i >= 0; i--) {
    const p = petalPops[i];
    const t = (now - p.t0) / PETAL_POP_MS;
    if (t >= 1) { petalPops.splice(i, 1); continue; }
    const tt = Math.max(0, t);
    const { sx, sy } = toScreen(p.x, p.y, W, H);
    const r = p.radius * zoomState.v * (1 + SWELL * easeOut(tt));
    if (r < 0.5) continue;
    ctx.save();
    ctx.globalAlpha = fadeAfter(tt, 0.3);
    if (PETAL_TYPES[p.typeId]?.pieceShape === 'stinger') ctx._stingerAngle = p.pieceAngle * Math.PI / 180;
    try {
      if (p.isPiece) drawPieceShape(ctx, p.typeId, sx, sy, r);
      else drawPetalShape(ctx, p.typeId, sx, sy, r);
    } catch (_) {}
    ctx._stingerAngle = undefined;
    ctx.restore();
  }
}
