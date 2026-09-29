// missiles.js — every mob-fired missile (hornet and scorpion stingers).
//
// One kind of projectile, one set of rules:
//   - fired with fireMissile(shooter, …) from wherever on the shooter it
//     leaves (hornet: its stinger; scorpion: its mandibles);
//   - flies straight at a fixed speed until its lifetime runs out;
//   - has HP (petals chip it down), damage, armor and mass (knockback on what
//     it hits scales with its mass against the target's);
//   - belongs to its shooter's team and passes straight through anything on
//     that team — a hostile hornet's missile flies through other mobs and
//     only collides with the player, their petals, their pets and friendly
//     diggers/beekeepers.
//
// This file owns the data, movement and the team/collision helpers; combat.js
// resolves what a hit does (damage, shields, kills) with collideMissiles().
// The client draws them with drawStingerMissile (render/mobDrawing.js).
import { emitGameEvent } from './events.js';

export const MISSILE_SPEED    = 13;     // world units per tick
export const MISSILE_LIFETIME = 3800;   // ms
const MASS_FRACTION = 0.25;             // a missile weighs this much of its shooter

/** Live missiles. */
export const missiles = [];

/** 'friendly' for the player's side (pets, diggers, beekeepers), else 'hostile'. */
export function teamOf(mob) {
  return (mob.isFriendlyPet || mob.typeId === 'digger' || mob.typeId === 'beekeeper') ? 'friendly' : 'hostile';
}

/**
 * Fires a missile from `shooter`.
 * @param {object} shooter   the mob firing it (team, mass, rarity and tier come from it)
 * @param {object} o
 * @param {number} o.x, o.y  centre of the missile at launch
 * @param {number} o.angle   direction of travel
 * @param {number} o.size    drawn length scale (the shooter's stinger size)
 * @param {number} o.radius  hitbox radius
 * @param {number} o.damage
 * @param {number} o.hp
 * @param {number} [o.armor=0]
 * @param {number} [o.speed=MISSILE_SPEED]
 * @param {number} [o.lifetime=MISSILE_LIFETIME]
 */
export function fireMissile(shooter, o) {
  const speed = o.speed ?? MISSILE_SPEED;
  const m = {
    x: o.x, y: o.y, prevX: o.x, prevY: o.y,
    vx: Math.cos(o.angle) * speed, vy: Math.sin(o.angle) * speed,
    angle: o.angle, speed,
    size: o.size, radius: o.radius,
    hp: o.hp, maxHp: o.hp, damage: o.damage, armor: o.armor ?? 0,
    mass: Math.max(1, (shooter.mass ?? 60) * MASS_FRACTION),
    team: teamOf(shooter),
    fromMobId: shooter.id, rarity: shooter.rarity, tier: shooter.tier ?? 0,
    lifetime: o.lifetime ?? MISSILE_LIFETIME, maxLifetime: o.lifetime ?? MISSILE_LIFETIME,
    dead: false,
  };
  missiles.push(m);
  return m;
}

/** Ends a missile with the client's pop (swell + fade). */
export function destroyMissile(m) {
  if (m.dead) return;
  m.dead = true;
  emitGameEvent('missileDied', { x: m.x, y: m.y, angle: m.angle, size: m.size });
}

/** Moves every missile one tick and retires the spent ones. */
export function updateMissiles(dt) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    if (m.dead) { missiles.splice(i, 1); continue; }
    m.x += m.vx; m.y += m.vy;
    m.lifetime -= dt;
    if (m.hp <= 0) { destroyMissile(m); missiles.splice(i, 1); continue; }
    if (m.lifetime <= 0) { missiles.splice(i, 1); }   // fades out on its own (see drawStingerMissile)
  }
}

/**
 * Calls onHit(missile, target) for every live missile touching a target on
 * the OTHER team. `targets` are { x, y, r, team } circles (anything else on
 * them is passed through untouched). onHit returns true to stop checking that
 * missile against the rest of `targets` this tick (it hit, or was used up).
 */
export function collideMissiles(targets, onHit) {
  for (const m of missiles) {
    if (m.dead) continue;
    for (const t of targets) {
      if (t.team === m.team) continue;               // same team: flies straight through
      const dx = t.x - m.x, dy = t.y - m.y;
      const rr = t.r + m.radius;
      if (dx * dx + dy * dy >= rr * rr) continue;
      if (onHit(m, t)) break;
      if (m.dead) break;
    }
  }
}

/** Knockback speed a missile gives a body of `targetMass` (mass-weighted). */
export function missileImpulse(m, targetMass) {
  return 2 * Math.hypot(m.vx, m.vy) * m.mass / (m.mass + Math.max(1, targetMass));
}

const HIT_COOLDOWN_MS = 300;          // a missile touching something trades damage this often…
export const PLAYER_HIT_COOLDOWN_MS = 200;   // …and a player every 0.2s (per missile)

/** True (and starts the cooldown) if `m` may trade damage with `key` now.
 *  Each missile keeps its own cooldown per target, timed on the missile's
 *  own age so it runs on game time. */
export function missileMayHit(m, key, cooldownMs = HIT_COOLDOWN_MS) {
  const now = m.maxLifetime - m.lifetime;
  m.hits ??= new Map();
  const last = m.hits.get(key);
  if (last != null && now - last < cooldownMs) return false;
  m.hits.set(key, now);
  return true;
}

/**
 * Missiles don't break on the bodies they hit — they bounce off, losing
 * most of their speed the heavier the body is compared to them.
 */
export function bounceMissile(m, t, targetMass) {
  let nx = m.x - t.x, ny = m.y - t.y;
  const d = Math.hypot(nx, ny) || 1;
  nx /= d; ny /= d;
  // Out of the body
  m.x = t.x + nx * (t.r + m.radius + 0.5);
  m.y = t.y + ny * (t.r + m.radius + 0.5);
  // Reflect the part of the velocity going into it, then damp by mass
  const vn = m.vx * nx + m.vy * ny;
  if (vn < 0) { m.vx -= 1.25 * vn * nx; m.vy -= 1.25 * vn * ny; }
  const keep = 0.35 + 0.4 * m.mass / (m.mass + Math.max(1, targetMass));
  m.vx *= keep; m.vy *= keep;
  m.angle = Math.atan2(m.vy, m.vx);
}
