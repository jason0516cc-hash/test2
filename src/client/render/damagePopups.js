// ── Damage numbers ────────────────────────────────────────────────────────────
// Each (target, damage colour) pair gets ONE sticky number while the hits
// keep coming: it rides along with the target, adds every new hit to its
// total, and punches/vibrates on each one. Once that pair has had no damage
// for STICKY_MS it lets go — hops up a little, falls back down and fades.
//
// Emitted by the game simulation as 'damage' events (see game/events.js).
import { toScreen } from '../camera.js';
import { settings } from '../settings.js';
import { onGameEvent } from '../../game/events.js';

const STICKY_MS  = 300;    // no new damage this long → the number flies off
const FLY_MS     = 650;    // hop + fall + fade after letting go
const HOP        = 16;     // px it rises before falling
const FALL       = 30;     // px below the start it ends up
const PUNCH_MS   = 180;    // scale punch + shake after each hit
const FONT       = '"UbuntuCustom", "Ubuntu", Arial, sans-serif';

export const damagePopups = [];

function abbreviateNumber(num) {
  if (num < 1000) return num.toString();
  if (num < 1000000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (num < 1000000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + 'B';
}

export function spawnDamage(x, y, amount, color = '#ff4444', radius = 0, owner = null) {
  if (!isFinite(amount) || amount === 0) return;

  // Still sticking to this target with this colour → just add to it
  if (owner) {
    const live = damagePopups.find(p => p.owner === owner && p.color === color && !p.released);
    if (live) {
      live.value += amount;
      live.text = abbreviateNumber(Math.abs(Math.round(live.value)));
      live.idle = 0;
      live.punch = 0;
      return;
    }
  }

  // Somewhere over the upper half of the target, so it doesn't sit under it
  const a = -Math.PI * (0.15 + Math.random() * 0.7);
  const d = radius * (0.35 + Math.random() * 0.45);
  damagePopups.push({
    x, y, ox: Math.cos(a) * d, oy: Math.sin(a) * d,
    value: amount, text: abbreviateNumber(Math.abs(Math.round(amount))),
    color, owner,
    age: 0,          // ms since it appeared (pop-in)
    idle: 0,         // ms since its last hit
    punch: 0,        // ms since its last hit (drives the punch/shake)
    released: false, flyT: 0, drift: (Math.random() - 0.5) * 16,
    seed: Math.random() * 1000,
  });
}

export function updateDamagePopups(dt) {
  for (let i = damagePopups.length - 1; i >= 0; i--) {
    const p = damagePopups[i];
    p.age += dt;
    p.punch += dt;
    if (!p.released) {
      if (p.owner && !p.owner.dead) { p.x = p.owner.x; p.y = p.owner.y; }
      p.idle += dt;
      // Target died or went quiet → let go where it is
      if (p.idle >= STICKY_MS || (p.owner && p.owner.dead)) p.released = true;
    } else {
      p.flyT += dt;
      if (p.flyT >= FLY_MS) damagePopups.splice(i, 1);
    }
  }
}

// Damage numbers are emitted by the game simulation (see game/events.js).
onGameEvent('damage', e => spawnDamage(e.x, e.y, e.amount, e.color, e.radius, e.target));

// Parabola (in units of the fly time) that peaks HOP px up and ends FALL px down
const HOP_V = 2 * HOP + 2 * Math.sqrt(HOP * (HOP + FALL));
const HOP_G = 2 * (FALL + HOP_V);

const easeOutBack = t => { const c = 2.2; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

export function drawDamagePopups(ctx, W, H) {
  if (!settings.showDamageNumbers) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const p of damagePopups) {
    // offsets are world units around the target, so they follow the zoom
    const { sx, sy } = toScreen(p.x + p.ox, p.y + p.oy, W, H);
    let x = sx, y = sy;

    // Bigger numbers read bigger (gently)
    let size = 15 + Math.min(7, Math.log10(Math.max(1, Math.abs(p.value))) * 1.8);
    let alpha = 1;

    // Pop in
    if (p.age < 160) size *= Math.max(0.2, easeOutBack(p.age / 160));

    if (!p.released) {
      // Punch + vibrate after each hit, a faint hum between hits
      const k = Math.max(0, 1 - p.punch / PUNCH_MS);
      size *= 1 + 0.28 * k * k;
      const amp = 0.6 + 2.6 * k;
      x += Math.sin(p.age * 0.09 + p.seed) * amp;
      y += Math.cos(p.age * 0.113 + p.seed * 1.7) * amp;
    } else {
      // Hop up a little, fall back down past the start, fade out
      const t = p.flyT / FLY_MS;
      y += -HOP_V * t + 0.5 * HOP_G * t * t;
      x += p.drift * t;
      alpha = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;
      size *= 1 - 0.18 * t;
    }
    if (alpha <= 0.01 || size < 2) continue;

    ctx.globalAlpha = alpha;
    ctx.font = `900 ${size.toFixed(1)}px ${FONT}`;
    ctx.lineWidth = Math.max(2, size * 0.2);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(p.text, x, y);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, x, y);
  }
  ctx.restore();
}
