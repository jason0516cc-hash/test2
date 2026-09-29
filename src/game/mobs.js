import { MOB_SAFE_RADIUS, HORNET_PREFERRED_DIST_BASE, AGGRO_TIER_SCALE, MOB_SPEED_SCALE } from '../shared/constants.js';
import { RARITIES, rarityTier } from '../shared/rarities.js';
import { MOB_DEFS, MOB_STATS, RADIUS_SCALE, MASS_SCALE } from '../shared/mobTypes.js';
import { spawnWebField, getWebSlowdownFactor, getPincerSlowFactor, honeycombEntities } from './drops.js';
import { canMoveTo, findOpenSpawnPosition, getMapW, getMapH, getZoneTierAt, getGridW, getGridH, getTileSize, isOpenTile, getSpawnChamberCenter, getActiveBiome as getActiveBiomeId } from './world.js';
import { players, nearestLivingPlayer, getPlayerById } from './player.js';
import { emitGameEvent } from './events.js';
import { missiles, fireMissile, updateMissiles } from './missiles.js';

// ── Removed-systems compatibility shims ───────────────────────────────────────
// Waves mode, the old rarity-zone grid, ant-hole sub-maps, and the NPC have
// all been removed as part of the map rehaul. These shims keep the rest of
// this file (which still calls these names in hundreds of places) working
// against the new flat placeholder map instead of touching every call site.
// isWaveMapMode() always false ⇒ every "if (isWaveMapMode())" branch below
// is permanently inert; the plain-player-target / plain-canMoveTo paths run.
function isWaveMapMode() { return false; }
function getWaveMapW() { return getMapW(); }
function getWaveMapH() { return getMapH(); }
function addTrackedMob(_mobId) { /* no-op: no wave clear-tracking anymore */ }
function onWaveMobDied(_mobId) { /* no-op */ }

// ── Rarity spawn zones ────────────────────────────────────────────────────────
// Each biome map (shared/biomes/garden.js / shared/biomes/desert.js / shared/biomes/ocean.js) carries a per-tile
// rarity grid, painted by hand and layered on top of its walkable tiles — see
// "Rarity spawn zones" in those files. Here a "zone" is simply one rarity:
// zone id === rarity tier (0 = Common ... 13 = Voidbound), so the 15
// zoneStates slots below give every rarity its own mob cap, spawn state and
// per-zone structure counters, the same way the old 15-cell grid did.
//
// getZoneId(x, y) returns the tier of the zone under a world position; it
// falls back to 0 for a position in a wall / off the map (e.g. a mob knocked
// against a wall edge) so callers never see an out-of-range id.
const ZONE_NAMES = RARITIES;
const ZONE_CONFIG = RARITIES.map((rarity, tier) => ({ name: rarity, rarity, tier, floor: '#4db85c', tint: 'rgba(0,0,0,0)' }));
function getZoneId(x, y) {
  const t = getZoneTierAt(x, y);
  return t < 0 ? 0 : t;
}
function getZoneTier(zoneId) {
  return (zoneId != null && zoneId >= 0 && zoneId < RARITIES.length) ? zoneId : 99;
}
// Whole-map bounds — activation is decided by the tier under the player (see
// updateZoneSpawning), not by a rectangle, so every zone reports the full map.
function getZoneBounds(_zoneId) { return { x0: 0, y0: 0, x1: getMapW(), y1: getMapH() }; }
// A mob spawned in zone N is rarity N — the zone IS the rarity.
function pickSpawnRarity(zoneTier, RARITIES_LOCAL) { return RARITIES_LOCAL[zoneTier] ?? RARITIES_LOCAL[0]; }

// Picks a random walkable, mob-clear spot whose painted zone matches zoneId.
// Tries near the player first (so spawns actually appear around them), then
// falls back to anywhere on the map that belongs to the zone.
function findSpawnInZone(zoneId, radius, playerX, playerY, existingMobs, safeRadius) {
  const gw = getGridW(), gh = getGridH(), ts = getTileSize();
  const clearOf = (x, y) => {
    if (existingMobs) {
      for (const m of existingMobs) {
        if (m.dead) continue;
        if (Math.hypot(x - m.x, y - m.y) < radius + m.radius + 12) return false;
      }
    }
    return true;
  };
  const hasPlayer = playerX !== undefined && playerY !== undefined;
  const ok = (x, y) => {
    if (getZoneTierAt(x, y) !== zoneId) return false;
    if (!canMoveTo(x, y, radius)) return false;
    if (hasPlayer && Math.hypot(x - playerX, y - playerY) < (safeRadius ?? 0)) return false;
    return clearOf(x, y);
  };
  // Pass 1: a ring around the player, so a zone the player is in fills up
  // around them instead of far across the map.
  if (hasPlayer) {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = (safeRadius ?? 0) + Math.random() * 2600;
      const x = playerX + Math.cos(a) * d, y = playerY + Math.sin(a) * d;
      if (ok(x, y)) return { x, y };
    }
  }
  // Pass 2: anywhere on the map that belongs to this zone.
  for (let i = 0; i < 120; i++) {
    const gx = Math.floor(Math.random() * gw), gy = Math.floor(Math.random() * gh);
    const x = (gx + 0.5) * ts, y = (gy + 0.5) * ts;
    if (ok(x, y)) return { x, y };
  }
  return null;
}
function findWaveMobSpawn(radius, existingMobs) { return findOpenSpawnPosition(radius, existingMobs, 60); }

// Ant-hole sub-map: dormant along with the boss-entry flow in main.js (kept
// for reuse, not currently reachable — nothing calls getBossAntHoleAtPoint's
// caller anymore). These constants/getter just keep this file self-consistent.
const ANT_HOLE_OFFSET_X = 200_000;
const ANT_HOLE_OFFSET_Y = 0;
function getAntHoleSubMapW() { return Math.round(getMapW() * 1.6); }
function getAntHoleSubMapH() { return Math.round(getMapW() * 1.6); }
function getAntHoleCircleCenter() {
  const W = getAntHoleSubMapW();
  return { cx: ANT_HOLE_OFFSET_X + W / 2, cy: ANT_HOLE_OFFSET_Y + W / 2, r: W / 2 };
}

// ── Wave mode NPC target ──────────────────────────────────────────────────────
let _npcTarget = null;
export function setWaveNPCTarget(npc) { _npcTarget = npc; }
export function clearWaveNPCTarget()   { _npcTarget = null; }

// Mob aggro target in wave mode: whichever of the player or the NPC is
// currently closer, no bias toward either — aggroRange still gates whether a
// mob wakes up and starts chasing at all (see callers below); this only
// decides WHICH of the two a mob that's already alerted (or just entered
// aggro range) goes after. Replaces the old NPC-biased design where mobs
// always defaulted to the NPC and only switched to the player within a
// short radius; every wave-mode targeting site in this file now goes
// through this one function instead of re-deriving the choice locally.
function pickWaveTarget(mob, mobX, mobY, playerX, playerY) {
  const dPlayer = Math.hypot(playerX - mobX, playerY - mobY);
  if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
    const dNpc = Math.hypot(_npcTarget.x - mobX, _npcTarget.y - mobY);
    if (dNpc < dPlayer) {
      return { targetX: _npcTarget.x, targetY: _npcTarget.y, dist: dNpc, kind: 'npc' };
    }
  }
  return { targetX: playerX, targetY: playerY, dist: dPlayer, kind: 'player' };
}

// Bubble pop push-distance curve — piecewise, anchored at specific named
// rarities per an explicit design request rather than one flat linear scale:
// subtle rise Common(0)->Epic(3), a noticeable jump into Legendary(4), another
// noticeable jump into Mythic(5), a much bigger jump into Ultra(6), then a
// smaller step into Super(7), a steady "decent" climb across Super(7)->
// Imperial(12), and a final decent bump into Voidbound(13). Linearly
// interpolates between these named anchor points rather than the tiers in
// between having their own explicit values, so each labeled span reads as a
// single smooth ramp of the described intensity.
const BUBBLE_PUSH_ANCHORS = [
  [0,   150],  // Common
  [3,   190],  // Epic — end of the "subtle" span
  [4,   320],  // Legendary — first "noticeable" jump
  [5,   480],  // Mythic — second "noticeable" jump
  [6,   820],  // Ultra — "a lot more" jump
  [7,   900],  // Super — smaller step down from the Ultra jump
  [12, 1150],  // Imperial — end of the "decent" climb from Super
  [13, 1350],  // Voidbound — final "decent" increase
];
function bubblePushDistanceForTier(tier) {
  const t = Math.max(0, Math.min(13, tier));
  for (let i = 0; i < BUBBLE_PUSH_ANCHORS.length - 1; i++) {
    const [t0, v0] = BUBBLE_PUSH_ANCHORS[i];
    const [t1, v1] = BUBBLE_PUSH_ANCHORS[i + 1];
    if (t >= t0 && t <= t1) {
      if (t1 === t0) return v0;
      const frac = (t - t0) / (t1 - t0);
      return v0 + frac * (v1 - v0);
    }
  }
  return BUBBLE_PUSH_ANCHORS[BUBBLE_PUSH_ANCHORS.length - 1][1];
}

// ── Which player a mob acts toward ──────────────────────────────────────────
/**
 * The player a mob reacts to this tick: its owner for friendly pets, otherwise
 * the nearest living player — or, if everyone is dead, the nearest player at
 * all, so the AI math always has a position to work with.
 */
function targetPlayerFor(mob) {
  if (mob.isFriendlyPet && mob.ownerId != null) {
    const owner = getPlayerById(mob.ownerId);
    if (owner) return owner;
  }
  const living = nearestLivingPlayer(mob.x, mob.y);
  if (living) return living;
  let best = players[0], bestD = Infinity;
  for (const p of players) {
    const d = (p.x - mob.x) ** 2 + (p.y - mob.y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** True if any player is within `radius` of (x, y). */
function isNearAnyPlayer(x, y, radius) {
  const r2 = radius * radius;
  for (const p of players) if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r2) return true;
  return false;
}

// ── Snake-body trail + capsule hitbox system ────────────────────────────────
// Generic, reusable infrastructure — not leech-specific by construction, even
// though leech is the only current user. Any future non-circular mob can
// reuse getMobHitCapsules/pointHitsMob the same way. A capsule here means a
// line segment plus a radius (the simplest non-circle primitive there is —
// distance from a point to a capsule is just distance to the nearest point
// on the segment, clamped to the segment's ends). The mob's TRAIL of past
// positions is chopped into consecutive short segments, each one becoming
// its own small capsule — so the hitbox follows the actual curved body
// shape as it moves and turns, not a single straight stand-in for it.
const TRAIL_MAX_POINTS = 46; // targets a ~99-unit visible/hittable body length at Common (tier 0) — 1.5x the earlier 66-unit length. No exclusion-zone overhead needed, since the fangs are excluded from collision by simply having no hit-shape of their own (see getLeechBodyCapsules/drawLeech), not by reserving trail distance
// How far (in world units, scaled by the mob's own drawRadius) the leech must
// move before a new trail point gets recorded — see the trail-recording
// block in updateMobs for why this replaced simple once-per-tick recording.
// Solved so tier 0's body length still lands on the original 99-unit target:
// 99 / (TRAIL_MAX_POINTS-1) / drawRadius(tier0)=12 = 11/60.
const LEECH_TRAIL_MIN_STEP_MULT = 11/60;

/** Point-to-capsule distance: distance from (px,py) to the capsule defined
 *  by the segment (ax,ay)-(bx,by), MINUS the capsule's own radius. Negative
 *  or zero means the point is inside/touching the capsule. */
function pointToCapsulePenetration(px, py, ax, ay, bx, by, capRadius) {
  const abx = bx - ax, aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  let t = 0;
  if (abLenSq > 1e-9) {
    t = ((px - ax) * abx + (py - ay) * aby) / abLenSq;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy) - capRadius;
}

/** Builds the leech's current body capsules from its trail buffer — one
 *  capsule per consecutive pair of trail points, oldest (tail) to newest
 *  (head). Deliberately STOPS short of the very newest point(s) so the
 *  fangs/head region is excluded from the hitbox, per the design ask that
 *  "the body is the hitbox except the fangs" — only the body should be
 *  hittable, not the mouth. Returns [] if there isn't enough trail yet
 *  (e.g. the instant after spawning) so callers can safely fall back. */
// (fangs are excluded from collision entirely differently now — see
// getLeechBodyCapsules — so there is no longer a head-exclusion point count
// here at all.)
function getLeechBodyCapsules(mob) {
  const trail = mob.trail;
  if (!trail || trail.length < 2) return [];
  // Matches drawLeech's own visible outer-border half-width EXACTLY: that
  // function uses bodyWidthOuter = 41 * s where s = r/20, i.e. r * 2.05 — so
  // the hitbox's edge lands exactly on the visible black border the player
  // sees, not somewhere well inside it.
  //
  // Covers the ENTIRE trail, right up to the head — no distance-based
  // exclusion zone. Excluding whole trail points ate into a large fraction
  // of the visible body (a real, measured bug: ~32% of the body was
  // non-hittable, not just "the fangs" as intended), because a distance-based
  // cutoff scales with how far apart trail points are, which has nothing to
  // do with how big the fangs themselves are. The fangs are excluded from
  // collision a completely different way instead — they simply have no
  // collision shape of their own at all (see drawLeech: they're drawn, never
  // tested against) — so there's no longer any reason to sacrifice body
  // length just to keep them clear.
  const bodyRadius = (mob.drawRadius ?? mob.radius ?? 20) * 2.05;
  const usable = trail;
  const capsules = [];
  for (let i = 0; i < usable.length - 1; i++) {
    capsules.push({ ax: usable[i].x, ay: usable[i].y, bx: usable[i + 1].x, by: usable[i + 1].y, r: bodyRadius });
  }
  return capsules;
}

/** True if a query circle (px,py,testRadius) overlaps the mob. Capsule-aware
 *  for leech (tests against every body-segment capsule, taking the closest);
 *  every other mob type falls through to the exact same offset-rotated
 *  circle math used in combat.js's main petal-vs-mob loop (mobHitX/mobHitY),
 *  reproduced here byte-for-byte so behavior for every existing mob is
 *  completely unchanged. */
export function pointHitsMob(mob, px, py, testRadius) {
  if (mob.typeId === 'leech') {
    const capsules = getLeechBodyCapsules(mob);
    if (capsules.length > 0) {
      for (const c of capsules) {
        if (pointToCapsulePenetration(px, py, c.ax, c.ay, c.bx, c.by, c.r) < testRadius) return true;
      }
      return false;
    }
    // Not enough trail yet (just spawned) — fall through to the normal
    // circle check below so it's never hit-less in the first instant.
  }
  const hAngle = (mob.facing || 0) + Math.PI / 2;
  const swayX = mob.swayHitX || 0;
  const hOx = ((mob.hitOffsetX || 0) + swayX) * Math.cos(hAngle) - (mob.hitOffsetY || 0) * Math.sin(hAngle);
  const hOy = ((mob.hitOffsetX || 0) + swayX) * Math.sin(hAngle) + (mob.hitOffsetY || 0) * Math.cos(hAngle);
  const dx = px - (mob.x + hOx), dy = py - (mob.y + hOy);
  return Math.hypot(dx, dy) < testRadius + mob.radius;
}

// Mob-mob pushing filters (see "Mob-mob pushing" in updateMobs).
// Structures only collide with friendly pets; these types never collide with any mob.
const MOB_STRUCTURE_TYPES = new Set(['ant_hole','beehive','fire_ant_hole','pyramid','shell','sponge','sea_cave','debris','rock','dandelion']);
const NO_MOB_COLLISION_TYPES = new Set(['ant_egg','spider_egg','fire_ant_egg']);

const MOB_TYPE_IDS = ['bee','ladybug','spider','hornet','beetle','sandstorm','desert_centipede_head','cactus'];  // Diggers/beekeepers only spawn from special events

const ZONE_CHECK_INTERVAL=5*60*1000; // legacy, kept so initMobs' reset of zoneStates still has its value

// Mob cap per zone — high-tier zones spawn fewer but tougher mobs
function getZoneMobMax(zoneId) {
  const cfg = ZONE_CONFIG[zoneId];
  if (!cfg) return 25;
  if (cfg.tier >= 13) return 8;   // Voidbound
  if (cfg.tier >= 12) return 12;  // Imperial
  if (cfg.tier >= 10) return 18;  // Runic / Seraphic
  return 25;
}

// Death trigger = half the zone cap (so zones always can refill naturally)
function getDeathTrigger(zoneId) {
  return Math.max(3, Math.floor(getZoneMobMax(zoneId) / 2));
}

export const zoneStates = Array.from({length:15},(_,zoneId)=>({
  zoneId, mobIds:new Set(), deaths:0, spawning:false, spawnAccum:0, checkTimer:ZONE_CHECK_INTERVAL, activated:false,
  centipedeCount:0, antHoleCount:0, beehiveCount:0, fireAntHoleCount:0,
}));

let nextMobId=0, nextChainId=0, _bossStingerNextId=0;
export const mobs=[];
export { missiles } from './missiles.js';   // hornet/scorpion missiles — see missiles.js
export const bossStingers=[];  // orbiting stingers spawned by boss bee ability
export const bossPeas=[];      // pea projectiles shot by boss centipede segments
export const bossRoses=[];     // rose minions spawned by boss ladybug
export const queenBeeEggs=[];  // bee eggs laid by boss queen bee
export const queenBeePollenOrbit=[]; // pollen orbiting boss queen bee before launch
export const jellyfishBolts=[]; // fading lightning-strike visuals — see updateJellyfishBolts
export const explosionEffects=[]; // fading blast-radius rings — see the decay loop near jellyfishBolts' own
export const popEffects=[]; // small expand+fade pop visuals (e.g. Bubble breaking) — same decay pattern
/** Queue of jellyfish zap decisions made this frame in updateMobs, drained
 *  and resolved (real damage applied) by combat.js's updateCombat right
 *  after — see the jellyfish AI block below for why damage isn't applied
 *  directly here. Each entry: { jellyfishId, fromX, fromY, targetKind,
 *  targetX, targetY, damage, chainMobId, chainX, chainY }. */
export const pendingJellyfishZaps=[];
const centipedeChains=new Map();
const desertCentipedeChains=new Map();

function generateSpots(radius) {
  const spots=[], count=3+Math.floor(Math.random()*4);
  for(let i=0;i<count;i++){
    const angle=(Math.PI*0.3)+Math.random()*(Math.PI*1.4);
    const dist=Math.random()*radius*0.58, r=radius*(0.1+Math.random()*0.16);
    spots.push({ox:Math.cos(angle)*dist,oy:Math.sin(angle)*dist,r});
  }
  return spots;
}

function spawnMob(typeId,x,y,homeZoneId,tier=0) {
  const d=MOB_DEFS[typeId], stats=MOB_STATS[typeId];
  const t=Math.max(0,Math.min(13,tier));
  const maxHp=stats?stats.hp[t]:50, damage=stats?stats.dmg[t]:10, armor=stats?stats.armor[t]:0;
  const contactDps=damage*(d.dpsFactor??1.0), rarity=RARITIES[t];
  const xp=Math.ceil(d.xp*(1+t*3));
  const scale=RADIUS_SCALE[t]??1;
  const baseRadius=Math.max(1,Math.round(d.radius*scale));
  // For mobs with an oval body, hitbox circle is sized to match body front-to-back extent
  const hitFactor=d.hitRadiusFactor??1.0;
  const radius=Math.max(1,Math.round(baseRadius*hitFactor));
  const drawRadius=baseRadius;  // visual drawing size is always the base
  const mass=Math.max(1,Math.round(d.mass*(MASS_SCALE[t]??1)));
  const mob={
    id:nextMobId++, typeId, name:d.name, rarity, homeZoneId, x, y,
    radius, drawRadius, hp:maxHp, maxHp, damage, contactDps, armor,
    // Speed is the same at every rarity — no per-tier speed increase
    baseSpeed:d.speed*MOB_SPEED_SCALE, speed:d.speed*MOB_SPEED_SCALE, alertSpeed:(d.alertSpeed||d.speed)*MOB_SPEED_SCALE,
    color:d.color, border:d.border, xp,
    aggroRange: d.aggroRange>0 ? Math.max(radius*2, Math.round(d.aggroRange * (1 + t * AGGRO_TIER_SCALE))) : 0,
    mass,
    hitOffsetX: (d.hitOffsetX || 0) * scale,
    hitOffsetY: (d.hitOffsetY || 0) * scale,
    wanderAngle:Math.random()*Math.PI*2, wanderTimer:Math.random()*2000,
    webTimer:1500, alerted:false, dead:false,
    facing:Math.random()*Math.PI*2, targetFacing:0,
    legPhase:0, wobblePhase:0,
    tentaclePhase:Math.random()*Math.PI*2, tailPhase:0,
    hitArm:0, hitPhase:0,
    spots:typeId==='ladybug'?generateSpots(d.radius):[],
    chainId:null, segIndex:null, isCentipede:false,
    tier:t,
    hurtFlash: 0,   // ms remaining of red damage flash
  };
  // ── Hornet-specific state ──────────────────────────────────────────────────
  if (typeId==='hornet') {
    mob.shootState    = 'idle';   // 'idle' | 'approach' | 'aim' | 'fire' | 'reset'
    mob.shootTimer    = 0;
    mob.stingerProgress = 1;      // 1 = full stinger, 0 = just fired (regrowing)
  }
  // ── Ant colony specific state ──────────────────────────────────────────────
  if (typeId==='ant_hole') {
    mob.nextMilestoneHp = Math.round(maxHp * 0.85);  // first milestone at 85% HP
    mob.isAntHole = true;
  }
  if (typeId==='baby_ant') {
    mob.nextMilestoneHp = Math.round(maxHp * 0.75);  // first milestone at 75% HP (every 25%)
  }
  if (typeId==='beehive') {
    mob.nextMilestoneHp = Math.round(maxHp * 0.75);  // first milestone at 75% HP (25% intervals)
    mob.isBeehive = true;
  }
  if (typeId==='pyramid') {
    mob.nextMilestoneHp = Math.round(maxHp * 0.85);  // first milestone at 85% HP (every 15%)
    mob.isPyramid = true;
  }
  if (typeId==='leech') {
    // Explicitly start with a single-point trail (== spawn position) rather
    // than leaving it undefined for the movement loop to lazily create.
    // Guarantees the body always starts short (a lone point renders as the
    // small fallback dot in drawLeech, since its "trail.length>=2" check
    // fails) and grows naturally to full length over its first ~40 ticks of
    // movement, instead of any chance of appearing already fully stretched
    // out the instant it spawns.
    mob.trail = [{ x, y }];
  }
  if (typeId==='queen_ant') {
    mob.queenLayTimer = 5000;
    mob.queenLayState = 'moving';   // 'moving' | 'pausing'
    mob.queenLayPause = 0;
  }
  if (typeId==='ant_egg') {
    mob.eggHatchTimer = 3500;  // hatches into soldier ant after 3.5s
  }
  if (['soldier_ant','worker_ant','baby_ant','queen_ant','ant_egg','ant_hole'].includes(typeId)) {
    mob.pincerPhase = 0;
    mob.wingPhase   = 0;
    mob.isAntMob    = true;
  }
  // ── Fire Ant colony specific state ────────────────────────────────────────
  if (typeId==='fire_ant_hole') {
    mob.nextMilestoneHp = Math.round(maxHp * 0.85);
    mob.isFireAntHole = true;
  }
  if (typeId==='fire_queen_ant') {
    mob.queenLayTimer = 5000;
    mob.queenLayState = 'moving';
    mob.queenLayPause = 0;
  }
  if (typeId==='fire_ant_egg') {
    mob.eggHatchTimer = 3500;
  }
  if (['fire_soldier_ant','fire_worker_ant','fire_queen_ant','fire_ant_egg','fire_ant_hole'].includes(typeId)) {
    mob.pincerPhase = 0;
    mob.wingPhase   = 0;
    mob.isFireAntMob = true;
  }
  if (typeId === 'beetle' || typeId === 'mummified_beetle') {
    mob.pincerPhase = 0;
  }
  if (typeId === 'sandstorm') {
    // Starting rotations match the sketch: outer slightly CCW, mid strongly CW, inner slightly CW
    mob.hexRotations = [-0.033, 0.365, 0.0];  // radians: outer, mid, inner (SVG tilts baked in)
    mob.hexRotSpeeds = [-0.00225, -0.006, 0.00525];  // all rings spin 25% slower than before (-0.003/-0.008/0.007)
    mob.driftVx = (Math.random() - 0.5) * 0.8;  // gentle drift velocity
    mob.driftVy = (Math.random() - 0.5) * 0.8;
    mob.driftTimer = 1000 + Math.random() * 2000;
    mob.ramTimer = 0;      // cooldown before next ram
    mob.ramVx = 0;
    mob.ramVy = 0;
    mob.isRamming = false;
  }
  if (typeId==='digger') {
    mob.state = 'neutral';  // 'neutral' | 'sad' | 'angry'
    mob.cutterRot = 0;
    mob.eyeAngle = 0;
    mob.browT = 0;          // 0 = no eyebrows, 1 = full angry eyebrows
    // Animation state for smooth transitions
    mob.animPdx = 0;
    mob.animPdy = 0;
    mob.animCpOffset = mob.drawRadius * 0.14; // Start with neutral smile (world units)
  }
  if (typeId==='beekeeper') {
    mob.state = 'neutral';  // 'neutral' | 'sad' | 'angry'
    mob.cutterRot = 0;
    mob.eyeAngle = 0;
    mob.browT = 0;          // 0 = neutral mouth (circle), 1 = angry mouth (frown)
    mob.animPdx = 0;
    mob.animPdy = 0;
  }
  mobs.push(mob);
  return mob;
}

function spawnCentipede(x,y,homeZoneId,tier,isBossSpawn=false) {
  const segCount=4+Math.floor(Math.random()*7);  // 4–10 body segments (not counting head)
  const chainId=nextChainId++;
  const chainArr=[];
  const initAngle=Math.random()*Math.PI*2;

  const head=spawnMob('centipede_head',x,y,homeZoneId,tier);
  head.chainId=chainId; head.segIndex=0; head.isCentipede=true;
  head.facing=initAngle; head.wanderAngle=initAngle;
  chainArr.push(head);
  if (zoneStates[homeZoneId]) zoneStates[homeZoneId].mobIds.add(head.id);

  const segSpacing=head.radius*2.05;
  // Place each segment behind the previous one, stepping in small increments
  // to avoid clipping through walls — if blocked, try adjacent angles
  let prevX=x, prevY=y;
  for(let i=0;i<segCount;i++){
    let placed=false;
    // Try the natural trailing direction first, then small angle offsets
    for(let attempt=0;attempt<12;attempt++){
      const tryAngle = initAngle + Math.PI + (attempt===0?0:(attempt%2===0?1:-1)*Math.ceil(attempt/2)*0.25);
      const bx=prevX+Math.cos(tryAngle)*segSpacing;
      const by=prevY+Math.sin(tryAngle)*segSpacing;
      if(canMoveTo(bx,by,head.radius)){
        const body=spawnMob('centipede_body',bx,by,homeZoneId,tier);
        body.chainId=chainId; body.segIndex=i+1; body.isCentipede=true;
        body.facing=initAngle;
        // If this is a boss spawn, immediately mark segments as boss so stats
        // can be applied correctly by applyBossStatsToCentipedeChain
        if (isBossSpawn) body.isBoss = true;
        chainArr.push(body);
        prevX=bx; prevY=by;
        placed=true;
        break;
      }
    }
    if(!placed) break; // can't fit more segments — stop early
  }
  centipedeChains.set(chainId,{id:chainId,mobs:chainArr,alerted:false});
  const headZoneState = zoneStates[homeZoneId];
  if(headZoneState) headZoneState.centipedeCount = (headZoneState.centipedeCount||0)+1;
  return head;
}

function spawnDesertCentipede(x,y,homeZoneId,tier) {
  const segCount=4+Math.floor(Math.random()*7);  // 4–10 body segments
  const chainId=nextChainId++;
  const chainArr=[];
  const initAngle=Math.random()*Math.PI*2;

  const head=spawnMob('desert_centipede_head',x,y,homeZoneId,tier);
  head.chainId=chainId; head.segIndex=0; head.isDesertCentipede=true;
  head.facing=initAngle; head.wanderAngle=initAngle;
  chainArr.push(head);
  if (zoneStates[homeZoneId]) zoneStates[homeZoneId].mobIds.add(head.id);

  const segSpacing=head.radius*2.05;
  let prevX=x, prevY=y;
  for(let i=0;i<segCount;i++){
    let placed=false;
    for(let attempt=0;attempt<12;attempt++){
      const tryAngle = initAngle + Math.PI + (attempt===0?0:(attempt%2===0?1:-1)*Math.ceil(attempt/2)*0.25);
      const bx=prevX+Math.cos(tryAngle)*segSpacing;
      const by=prevY+Math.sin(tryAngle)*segSpacing;
      if(canMoveTo(bx,by,head.radius)){
        const body=spawnMob('desert_centipede_body',bx,by,homeZoneId,tier);
        body.chainId=chainId; body.segIndex=i+1; body.isDesertCentipede=true;
        body.facing=initAngle;
        chainArr.push(body);
        prevX=bx; prevY=by;
        placed=true;
        break;
      }
    }
    if(!placed) break;
  }
  desertCentipedeChains.set(chainId,{id:chainId,mobs:chainArr,alerted:false});
  if(zoneStates[homeZoneId]) zoneStates[homeZoneId].mobIds.add(head.id);
  return head;
}

function triggerZoneDeath(mob) {
  const state=zoneStates[mob.homeZoneId];
  if(!state) return;
  state.mobIds.delete(mob.id);
  state.deaths++;
  if(state.deaths>=getDeathTrigger(mob.homeZoneId)&&!state.spawning){
    state.spawning=true; state.spawnAccum=0; state.deaths=0;
  }
}

// Apply boss stat multipliers to a mob (mirrors bossManager._applyBossStats)
function _applyBossStatsToMob(mob) {
  mob.isBoss      = true;
  mob.maxHp      *= 10;
  mob.hp          = mob.maxHp;
  mob.damage     *= 2;
  mob.contactDps *= 2;
  // Scale drawRadius and radius independently so hitRadiusFactor (bee/hornet oval hitbox) is preserved.
  // Boss is always exactly 1.5x the size of the regular mob at that tier.
  const preDraw    = mob.drawRadius;
  const hitFactor  = mob.radius / mob.drawRadius;
  mob.drawRadius   = Math.round(preDraw * 1.5);
  mob.radius       = Math.round(mob.drawRadius * hitFactor);
  const actualScale = 1.5;
  mob.mass        = Math.round(mob.mass * 3);
  mob.baseSpeed  *= 0.9;
  mob.speed      *= 0.9;
  mob.alertSpeed *= 0.9;
  mob.hitOffsetX  = (mob.hitOffsetX || 0) * actualScale;
  mob.hitOffsetY  = (mob.hitOffsetY || 0) * actualScale;
  if (mob.aggroRange > 0) mob.aggroRange = Math.round(mob.aggroRange * 1.5);
}

// Spawn an ant minion near a position, NOT tracked by the zone mob cap
function spawnAntMinion(typeId, nearX, nearY, homeX, homeY, zoneId, tier) {
  const def=MOB_DEFS[typeId];
  if(!def) return null;
  let mx=nearX, my=nearY;
  for(let attempt=0;attempt<16;attempt++){
    const angle=Math.random()*Math.PI*2;
    const dist=50+Math.random()*130;
    const tx=nearX+Math.cos(angle)*dist, ty=nearY+Math.sin(angle)*dist;
    if(canMoveTo(tx,ty,def.radius)){mx=tx;my=ty;break;}
  }
  const mob=spawnMob(typeId,mx,my,zoneId,tier);
  // homeX/homeY still set for mobs whose AI leashes back to a point (ants, bees).
  // isZoneTracked defaults to true now — these are enemy minions, not player pets
  // (real player pets are spawned separately via spawnFriendly*Pet and opt out
  // themselves), so they should count toward the zone cap and run their own
  // type-specific onMobDied handler like any other mob.
  mob.homeX=homeX; mob.homeY=homeY; mob.isZoneTracked=true;
  return mob;
}

// Spawn ant hole initial minions
function spawnAntHoleMinions(holeX, holeY, zoneId, tier, isBossHole = false) {
  if (isBossHole) {
    // Boss ant hole initial minions: 1 boss soldier ant + 1 boss worker ant (wave-tracked)
    const s = spawnAntMinion('soldier_ant', holeX, holeY, holeX, holeY, zoneId, tier);
    const w = spawnAntMinion('worker_ant',  holeX, holeY, holeX, holeY, zoneId, tier);
    if (s) { _applyBossStatsToMob(s); if (isWaveMapMode()) { s.waveTarget = 'npc'; s.alerted = true; addTrackedMob(s.id); } }
    if (w) { _applyBossStatsToMob(w); if (isWaveMapMode()) { w.waveTarget = 'npc'; w.alerted = true; addTrackedMob(w.id); } }
  } else {
    spawnAntMinion('soldier_ant', holeX, holeY, holeX, holeY, zoneId, tier);
    spawnAntMinion('worker_ant',  holeX, holeY, holeX, holeY, zoneId, tier);
    spawnAntMinion('baby_ant',    holeX, holeY, holeX, holeY, zoneId, tier);
  }
}

// Spawn a fire ant minion near a position, NOT tracked by the zone mob cap
function spawnFireAntMinion(typeId, nearX, nearY, homeX, homeY, zoneId, tier) {
  const def = MOB_DEFS[typeId];
  if (!def) return null;
  let mx = nearX, my = nearY;
  for (let attempt = 0; attempt < 16; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 50 + Math.random() * 130;
    const tx = nearX + Math.cos(angle) * dist, ty = nearY + Math.sin(angle) * dist;
    if (canMoveTo(tx, ty, def.radius)) { mx = tx; my = ty; break; }
  }
  const mob = spawnMob(typeId, mx, my, zoneId, tier);
  mob.homeX = homeX; mob.homeY = homeY; mob.isZoneTracked = false;
  return mob;
}

// Spawn fire ant hole initial minions
function spawnFireAntHoleMinions(holeX, holeY, zoneId, tier) {
  spawnFireAntMinion('fire_soldier_ant', holeX, holeY, holeX, holeY, zoneId, tier);
  spawnFireAntMinion('fire_worker_ant',  holeX, holeY, holeX, holeY, zoneId, tier);
  spawnFireAntMinion('fire_baby_ant',    holeX, holeY, holeX, holeY, zoneId, tier);
}

// Spawn a mob near the sea cave, NOT zone-tracked (these are periodic bonus
// spawns triggered by the cave taking damage, not initial zone population —
// same "not tracked" convention as spawnFireAntMinion). Same position-finding
// as spawnAntMinion: try nearby random angles/distances, fall back to the
// cave's own position if every attempt is blocked.
function spawnSeaCaveMinion(typeId, nearX, nearY, zoneId, tier) {
  const def = MOB_DEFS[typeId];
  if (!def) return null;
  let mx = nearX, my = nearY;
  for (let attempt = 0; attempt < 16; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 50 + Math.random() * 130;
    const tx = nearX + Math.cos(angle) * dist, ty = nearY + Math.sin(angle) * dist;
    if (canMoveTo(tx, ty, def.radius)) { mx = tx; my = ty; break; }
  }
  const mob = spawnMob(typeId, mx, my, zoneId, tier);
  mob.isZoneTracked = false;
  return mob;
}

// Sea cave's every-15%-HP-lost spawn wave: one crab AND one jellyfish always,
// each of those two spawn events independently rolling a 12% chance for a
// bonus mob — bubble by default, flipped to leech 50% of the time when that
// 12% hits. "Each... independently" means up to 2 bonus mobs total (one
// attached to the crab spawn, one to the jellyfish spawn), not one shared
// roll for the pair.
const SEA_CAVE_BONUS_CHANCE = 0.12;
const SEA_CAVE_BONUS_LEECH_CHANCE = 0.5; // of the bonus mobs that do spawn, half are leech instead of bubble
function spawnSeaCaveWave(caveX, caveY, zoneId, tier) {
  spawnSeaCaveMinion('crab', caveX, caveY, zoneId, tier);
  if (Math.random() < SEA_CAVE_BONUS_CHANCE) {
    const bonusType = Math.random() < SEA_CAVE_BONUS_LEECH_CHANCE ? 'leech' : 'bubble';
    spawnSeaCaveMinion(bonusType, caveX, caveY, zoneId, tier);
  }
  spawnSeaCaveMinion('jellyfish', caveX, caveY, zoneId, tier);
  if (Math.random() < SEA_CAVE_BONUS_CHANCE) {
    const bonusType = Math.random() < SEA_CAVE_BONUS_LEECH_CHANCE ? 'leech' : 'bubble';
    spawnSeaCaveMinion(bonusType, caveX, caveY, zoneId, tier);
  }
}

// Sea cave's on-death wave: always one jellyfish, one crab, AND one debris —
// distinct from spawnSeaCaveWave above (the periodic every-15%-HP-lost
// wave, which spawns crab+jellyfish only, no debris). Also rolls the same
// 12% bonus-mob chance, once, using the same bubble/leech split — reuses
// SEA_CAVE_BONUS_CHANCE/SEA_CAVE_BONUS_LEECH_CHANCE above rather than
// introducing separate constants, since it's the same "bonus mob" concept.
function spawnSeaCaveDeathWave(caveX, caveY, zoneId, tier) {
  spawnSeaCaveMinion('jellyfish', caveX, caveY, zoneId, tier);
  spawnSeaCaveMinion('crab', caveX, caveY, zoneId, tier);
  spawnSeaCaveMinion('debris', caveX, caveY, zoneId, tier);
  if (Math.random() < SEA_CAVE_BONUS_CHANCE) {
    const bonusType = Math.random() < SEA_CAVE_BONUS_LEECH_CHANCE ? 'leech' : 'bubble';
    spawnSeaCaveMinion(bonusType, caveX, caveY, zoneId, tier);
  }
}

function handleCentipedeSegmentDeath(deadMob) {
  const chain=centipedeChains.get(deadMob.chainId);
  if(!chain) return;
  const idx=chain.mobs.indexOf(deadMob);
  if(idx===-1) return;
  chain.mobs.splice(idx,1);

  if(chain.mobs.length===0){
    centipedeChains.delete(deadMob.chainId);
    triggerZoneDeath(deadMob); // dead was the head, is in mobIds
    const st=zoneStates[deadMob.homeZoneId];
    if(st) st.centipedeCount=Math.max(0,(st.centipedeCount||1)-1);
    return;
  }

  if(idx===0){
    // Head died — promote next segment as chain leader, but keep its body drawing
    const newHead=chain.mobs[0];
    newHead.isChainHead=true;       // AI treats this as head
    newHead.isCentipede=true;
    newHead.alerted=chain.alerted;
    newHead.segIndex=0;
    newHead.aggroRange=MOB_DEFS.centipede_head.aggroRange;
    // typeId stays 'centipede_body' — drawing does NOT change
    // Update remaining body segment indices
    for(let i=1;i<chain.mobs.length;i++) chain.mobs[i].segIndex=i;
    const state=zoneStates[deadMob.homeZoneId];
    if(state){ state.mobIds.delete(deadMob.id); state.mobIds.add(newHead.id); }
  } else if(idx<chain.mobs.length){
    // Middle segment died — split into two chains
    const rightMobs=chain.mobs.splice(idx);
    if(rightMobs.length>0){
      const newChainId=nextChainId++;
      // First right-side segment becomes chain leader — body drawing stays
      const newHead=rightMobs[0];
      newHead.isChainHead=true;
      newHead.isCentipede=true;
      newHead.alerted=chain.alerted;
      newHead.segIndex=0;
      newHead.aggroRange=MOB_DEFS.centipede_head.aggroRange;
      // Ensure all right-side segments are body type
      for(let i=0;i<rightMobs.length;i++){
        rightMobs[i].segIndex=i;
        rightMobs[i].typeId='centipede_body';
        rightMobs[i].isChainHead=(i===0);
      }
      const newChain={id:newChainId,mobs:rightMobs,alerted:chain.alerted};
      centipedeChains.set(newChainId,newChain);
      for(const m of rightMobs) m.chainId=newChainId;
      const state=zoneStates[newHead.homeZoneId];
      if(state) { state.mobIds.add(newHead.id); state.centipedeCount=(state.centipedeCount||1)+1; }
      // Fix left-side segment indices
      for(let i=0;i<chain.mobs.length;i++) chain.mobs[i].segIndex=i;
    }
  }
  // tail died: nothing extra needed
}

function handleDesertCentipedeSegmentDeath(deadMob) {
  const chain=desertCentipedeChains.get(deadMob.chainId);
  if(!chain) return;
  const idx=chain.mobs.indexOf(deadMob);
  if(idx===-1) return;
  chain.mobs.splice(idx,1);

  if(chain.mobs.length===0){
    desertCentipedeChains.delete(deadMob.chainId);
    triggerZoneDeath(deadMob);
    const st=zoneStates[deadMob.homeZoneId];
    if(st) st.desertCentipedeCount=Math.max(0,(st.desertCentipedeCount||1)-1);
    return;
  }

  if(idx===0){
    const newHead=chain.mobs[0];
    newHead.isDesertCentipede=true;
    newHead.alerted=chain.alerted;
    newHead.segIndex=0;
    newHead.aggroRange=MOB_DEFS.desert_centipede_head.aggroRange;
    for(let i=1;i<chain.mobs.length;i++) chain.mobs[i].segIndex=i;
    const state=zoneStates[deadMob.homeZoneId];
    if(state){ state.mobIds.delete(deadMob.id); state.mobIds.add(newHead.id); }
  } else if(idx<chain.mobs.length){
    const rightMobs=chain.mobs.splice(idx);
    if(rightMobs.length>0){
      const newChainId=nextChainId++;
      const newHead=rightMobs[0];
      newHead.isDesertCentipede=true;
      newHead.alerted=chain.alerted;
      newHead.segIndex=0;
      newHead.aggroRange=MOB_DEFS.desert_centipede_head.aggroRange;
      for(let i=0;i<rightMobs.length;i++){
        rightMobs[i].segIndex=i;
        rightMobs[i].typeId='desert_centipede_body';
        rightMobs[i].isDesertCentipede=true;
      }
      const newChain={id:newChainId,mobs:rightMobs,alerted:chain.alerted};
      desertCentipedeChains.set(newChainId,newChain);
      for(const m of rightMobs) m.chainId=newChainId;
      const state=zoneStates[newHead.homeZoneId];
      if(state){ state.mobIds.add(newHead.id); state.desertCentipedeCount=(state.desertCentipedeCount||1)+1; }
      for(let i=0;i<chain.mobs.length;i++) chain.mobs[i].segIndex=i;
    }
  }
}

// ── Respawn of killed zone mobs ────────────────────────────────────────────────
// The old drip-spawner refilled zones as mobs died. Now a killed zone mob's
// ORIGINAL record goes back into the dormant pool after a delay, so the zone
// slowly refills at the same density without ever holding more than it started with.
const RESPAWN_DELAY_MS = 60000;
const _respawnQueue = [];   // { rec, at }
function _scheduleRespawn(mob){
  const rec=mob._origin;
  if(!rec||mob._respawnScheduled) return;
  // For a chain, only its head schedules (the chain is ONE spawn group).
  if((mob.isCentipede||mob.isDesertCentipede)&&mob.segIndex!==0&&mob.typeId.endsWith('_body')) return;
  // Minions of a structure share their structure's record — only the structure itself respawns it.
  if(rec.entry.kind==='structure'&&mob.typeId!==rec.entry.typeId) return;
  if(rec.entry.kind==='single'&&mob.typeId!==rec.entry.typeId) return;
  for(const q of _respawnQueue) if(q.rec===rec) return;   // already queued for this record
  mob._respawnScheduled=true;
  _respawnQueue.push({ rec:{ entry:rec.entry, zone:rec.zone, x:rec.x, y:rec.y }, at:performance.now()+RESPAWN_DELAY_MS });
}
function _processRespawns(){
  if(!_respawnQueue.length) return;
  const now=performance.now();
  for(let i=_respawnQueue.length-1;i>=0;i--){
    if(_respawnQueue[i].at<=now){ _dormantAdd(_respawnQueue[i].rec); _respawnQueue.splice(i,1); }
  }
}

function onMobDied(mob) {
  // A mob that was merely put back to sleep (see streamZoneMobs) did not die:
  // no bubble pop, no death wave, no zone-death bookkeeping. Its dormant
  // record already holds it.
  if (mob._streamedOut) return;
  emitGameEvent('mobDied', { mob });   // client: death pop + rarity-coloured dots
  _scheduleRespawn(mob);   // genuinely killed: refill its original spot later
  // Notify wave manager so it can clear tracked mob IDs
  if (isWaveMapMode()) onWaveMobDied(mob.id);

  // ── Sea cave death wave: always spawns one jellyfish, one crab, and one
  // debris right where it died, plus the same 12% bonus-mob roll used by
  // its periodic every-15%-HP-lost wave (see spawnSeaCaveDeathWave). This
  // is a separate, one-time event from that periodic wave — dying doesn't
  // ALSO trigger the 100%-HP-lost periodic wave, since sea cave's HP-
  // threshold tracking only fires from the per-frame HP check further
  // down, and a mob that just died is removed before that check runs again.
  if (mob.typeId === 'sea_cave') {
    spawnSeaCaveDeathWave(mob.x, mob.y, mob.homeZoneId, rarityTier(mob.rarity));
  }

  // ── Bubble pop: pushes the player and any nearby friendly pets outward from
  // where it died. Push distance is derived from the bubble's own mass (i.e.
  // its rarity tier — a max-rarity bubble gives a noticeably strong shove,
  // scaled up 4x from an earlier pass, but linear-with-tier stays well clear
  // of a map-spanning launch (max push below is 1200 of the map's 6000-unit
  // width — 20%, still short of "a quarter of the map"). Player uses the
  // existing knockback velocity system (vx/vy + a dedicated cap, see
  // BUBBLE_MAX_KB below); pets have no velocity system at all, so they get a
  // direct one-time position nudge instead, clamped to valid ground via
  // canMoveTo exactly like every other mob repositioning in this file.
  if (mob.typeId === 'bubble') {
    const BLAST_RADIUS = (mob.drawRadius ?? mob.radius ?? 16) * 5; // scales mildly with the bubble's own size
    // Push distance follows a piecewise curve anchored at specific rarities
    // (see bubblePushDistanceForTier) rather than one flat linear scale —
    // subtle through Epic, noticeable jumps into Legendary and Mythic, a much
    // bigger jump into Ultra, then a steady decent climb from Super to Imperial
    // and a final decent bump into Voidbound. Tops out at 1350 units —
    // 22.5% of the 6000-unit map width, still short of "a quarter of the map."
    const tier = rarityTier(mob.rarity);
    const pushDist = bubblePushDistanceForTier(tier);

    for (const player of players) {
    const pdx = player.x - mob.x, pdy = player.y - mob.y, pdist = Math.hypot(pdx, pdy);
    if (!player.dead && pdist < BLAST_RADIUS && pdist > 0.001) {
      const nx = pdx / pdist, ny = pdy / pdist;
      // Convert the target push distance into a velocity impulse. pushDist
      // above (150-1350) is calibrated for the PET position-nudge below,
      // which is a direct one-time displacement in world units — safe at
      // that scale relative to the 6000-unit map. Applying that same
      // magnitude directly as PLAYER VELOCITY was a real bug (fixed here):
      // player.speed is only ~4.2/frame, so even the lowest tier's old
      // impulse was ~20x normal movement speed in one frame. Rescaled to a
      // sane range instead (~6 at Common up to ~55 at Voidbound,
      // matching the player's own movement scale and the rest of the
      // game's existing knockback magnitudes).
      const PLAYER_PUSH_LO = 6, PLAYER_PUSH_HI = 55;
      const CURVE_LO = 150, CURVE_HI = 1350; // bubblePushDistanceForTier's own range
      const curveNorm = Math.max(0, Math.min(1, (pushDist - CURVE_LO) / (CURVE_HI - CURVE_LO)));
      const impulse = PLAYER_PUSH_LO + curveNorm * (PLAYER_PUSH_HI - PLAYER_PUSH_LO);
      // Second real bug, also fixed here: a plain player.vx += only ADDS to
      // whatever velocity the player already has. If they were already
      // moving opposite the push (very plausible — e.g. still carrying
      // knockback velocity from something else, up to 14-16 elsewhere in
      // this game), the add could partially or fully cancel out, so the pop
      // sometimes did nothing at low tiers where the impulse was smaller
      // than realistic opposing velocity. Fixed by first stripping out any
      // velocity component that opposes the push direction (parallel
      // component only — perpendicular motion is left untouched, so it
      // still feels like a knockback and not a hard velocity override),
      // THEN adding the full impulse — guaranteeing the pop always applies
      // its full intended strength regardless of what the player was doing.
      const parallel = player.vx * nx + player.vy * ny;
      if (parallel < 0) { player.vx -= parallel * nx; player.vy -= parallel * ny; }
      player.vx += nx * impulse;
      player.vy += ny * impulse;
      const BUBBLE_MAX_KB = 58; // just above the true max (55) — a safety ceiling, not an active clamp
      const speed = Math.hypot(player.vx, player.vy);
      if (speed > BUBBLE_MAX_KB) { player.vx = (player.vx / speed) * BUBBLE_MAX_KB; player.vy = (player.vy / speed) * BUBBLE_MAX_KB; }
    }
    }
    for (const pet of mobs) {
      if (pet.dead || !pet.isFriendlyPet) continue;
      const dx = pet.x - mob.x, dy = pet.y - mob.y, dist = Math.hypot(dx, dy);
      if (dist >= BLAST_RADIUS || dist <= 0.001) continue;
      const nx = dx / dist, ny = dy / dist;
      const nxPos = pet.x + nx * pushDist, nyPos = pet.y + ny * pushDist;
      if (canMoveTo(nxPos, nyPos, pet.radius)) { pet.x = nxPos; pet.y = nyPos; }
      else if (canMoveTo(nxPos, pet.y, pet.radius)) { pet.x = nxPos; }
      else if (canMoveTo(pet.x, nyPos, pet.radius)) { pet.y = nyPos; }
    }
  }

  // ── Boss baby ant death → spawns 1 queen ant at one tier lower ─────────────
  if(mob.typeId === 'baby_ant' && mob.isBoss){
    const zid = mob.homeZoneId ?? -1;
    const t   = Math.max(0, (mob.tier ?? 0) - 1);
    const q = spawnAntMinion('queen_ant', mob.x, mob.y, mob.x, mob.y, zid, t);
    if(q && isWaveMapMode()){ q.waveTarget = 'npc'; q.alerted = true; addTrackedMob(q.id); }
  }

  // Kill any orbiting stingers belonging to this boss (bee and cactus both use bossStingers)
  if (mob.isBoss && (mob.typeId === 'bee' || mob.typeId === 'cactus')) {
    for (const s of bossStingers) { if (s.ownerId === mob.id) s.dead = true; }
  }
  // Kill any roses belonging to this ladybug boss
  if (mob.isBoss && mob.typeId === 'ladybug') {
    for (const r of bossRoses) { if (r.ownerId === mob.id) r.dead = true; }
  }
  // Kill queen bee eggs and pollen orbits belonging to this queen bee boss
  if (mob.isBoss && mob.typeId === 'queen_bee') {
    for (const e of queenBeeEggs) { if (e.ownerId === mob.id) e.dead = true; }
    for (const p of queenBeePollenOrbit) { if (p.ownerId === mob.id) p.dead = true; }
  }

  if(mob.homeZoneId==null) return;
  if(mob.isCentipede){ handleCentipedeSegmentDeath(mob); return; }
  if(mob.isDesertCentipede){ handleDesertCentipedeSegmentDeath(mob); return; }
  // Ant minions not tracked by zone cap — no zone bookkeeping needed
  if(mob.isZoneTracked===false) return;

  // ── Ant hole death wave — fire regardless of zone state (covers wave mode) ──
  if(mob.isAntHole){
    // Death wave: different for boss and normal holes.
    // Boss holes killed via interior victory skip the death wave (the interior fight IS the event).
    const zid = mob.homeZoneId;
    if(mob.isBoss){
      if(!mob.clearedByInterior){
        // Killed externally: spawn boss queen + boss soldier as a death wave
        const bq=spawnAntMinion('queen_ant',  mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        const bs=spawnAntMinion('soldier_ant',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(bq){ _applyBossStatsToMob(bq); if(isWaveMapMode()){ bq.waveTarget='npc'; bq.alerted=true; addTrackedMob(bq.id); } }
        if(bs){ _applyBossStatsToMob(bs); if(isWaveMapMode()){ bs.waveTarget='npc'; bs.alerted=true; addTrackedMob(bs.id); } }
        if(Math.random()<0.15) spawnAntMinion('digger',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
      }
    } else {
      // Normal ant hole death wave: 3 soldiers, 3 workers, 1 queen, 15% digger
      for(let i=0;i<3;i++){
        const ds=spawnAntMinion('soldier_ant',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(ds&&isWaveMapMode()){ ds.waveTarget='npc'; ds.alerted=true; addTrackedMob(ds.id); }
      }
      for(let i=0;i<3;i++){
        const dw=spawnAntMinion('worker_ant',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(dw&&isWaveMapMode()){ dw.waveTarget='npc'; dw.alerted=true; addTrackedMob(dw.id); }
      }
      const dq=spawnAntMinion('queen_ant',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
      if(dq&&isWaveMapMode()){ dq.waveTarget='npc'; dq.alerted=true; addTrackedMob(dq.id); }
      if(Math.random()<0.15) spawnAntMinion('digger',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
    }
    // Zone bookkeeping (only when zone state exists)
    const state=zoneStates[zid];
    if(state){
      state.mobIds.delete(mob.id);
      state.antHoleCount=Math.max(0,(state.antHoleCount||1)-1);
      state.deaths++;
      if(state.deaths>=getDeathTrigger(zid)&&!state.spawning){
        state.spawning=true; state.spawnAccum=0; state.deaths=0;
      }
    }
    return;
  }
  // ── Fire Ant Hole death wave ───────────────────────────────────────────────
  if (mob.isFireAntHole) {
    const zid = mob.homeZoneId;
    // Death wave: 3 fire soldiers, 3 fire workers, 1 fire queen
    for (let i = 0; i < 3; i++) {
      const ds = spawnFireAntMinion('fire_soldier_ant', mob.x, mob.y, mob.x, mob.y, zid, mob.tier);
      if (ds && isWaveMapMode()) { ds.waveTarget = 'npc'; ds.alerted = true; addTrackedMob(ds.id); }
    }
    for (let i = 0; i < 3; i++) {
      const dw = spawnFireAntMinion('fire_worker_ant', mob.x, mob.y, mob.x, mob.y, zid, mob.tier);
      if (dw && isWaveMapMode()) { dw.waveTarget = 'npc'; dw.alerted = true; addTrackedMob(dw.id); }
    }
    const dq = spawnFireAntMinion('fire_queen_ant', mob.x, mob.y, mob.x, mob.y, zid, mob.tier);
    if (dq && isWaveMapMode()) { dq.waveTarget = 'npc'; dq.alerted = true; addTrackedMob(dq.id); }
    // Zone bookkeeping
    const state = zoneStates[zid];
    if (state) {
      state.mobIds.delete(mob.id);
      state.fireAntHoleCount = Math.max(0, (state.fireAntHoleCount || 1) - 1);
      state.deaths++;
      if (state.deaths >= getDeathTrigger(zid) && !state.spawning) {
        state.spawning = true; state.spawnAccum = 0; state.deaths = 0;
      }
    }
    return;
  }
  // ── Beehive death swarm — fire regardless of zone state (covers wave mode) ──
  if(mob.isBeehive){
    const zid = mob.homeZoneId;
    if(mob.isBoss) {
      // Boss beehive death: spawn 1 boss queen bee at same tier
      const bossQueenBee = spawnAntMinion('queen_bee',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
      if(bossQueenBee) _applyBossStatsToMob(bossQueenBee);
      // Add to wave tracking if in wave mode
      if(isWaveMapMode() && bossQueenBee) {
        bossQueenBee.waveTarget = 'npc'; bossQueenBee.alerted = true; addTrackedMob(bossQueenBee.id);
      }
      // 5% chance for boss beekeeper like normal hive
      if(Math.random()<0.05) {
        const bossBeekeeper = spawnAntMinion('beekeeper',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(bossBeekeeper) _applyBossStatsToMob(bossBeekeeper);
        // Add to wave tracking if in wave mode
        if(isWaveMapMode() && bossBeekeeper) {
          bossBeekeeper.waveTarget = 'npc'; bossBeekeeper.alerted = true; addTrackedMob(bossBeekeeper.id);
        }
      }
    } else {
      // Normal beehive death swarm: 3 bees, 2 hornets, 1 queen bee, 5% chance for beekeeper
      for(let i=0;i<3;i++){
        const db=spawnAntMinion('bee',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(db&&isWaveMapMode()){ db.waveTarget='npc'; db.alerted=true; addTrackedMob(db.id); }
      }
      for(let i=0;i<2;i++){
        const dh=spawnAntMinion('hornet',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(dh&&isWaveMapMode()){ dh.waveTarget='npc'; dh.alerted=true; addTrackedMob(dh.id); }
      }
      const dqb=spawnAntMinion('queen_bee',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
      if(dqb&&isWaveMapMode()){ dqb.waveTarget='npc'; dqb.alerted=true; addTrackedMob(dqb.id); }
      if(Math.random()<0.05){
        const dbk=spawnAntMinion('beekeeper',mob.x,mob.y,mob.x,mob.y,zid,mob.tier);
        if(dbk&&isWaveMapMode()){ dbk.waveTarget='npc'; dbk.alerted=true; addTrackedMob(dbk.id); }
      }
    }
    // Zone bookkeeping (only when zone state exists)
    const state=zoneStates[zid];
    if(state){
      state.mobIds.delete(mob.id);
      state.beehiveCount=Math.max(0,(state.beehiveCount||1)-1);
      state.deaths++;
      if(state.deaths>=getDeathTrigger(zid)&&!state.spawning){
        state.spawning=true; state.spawnAccum=0; state.deaths=0;
      }
    }
    return;
  }

  const state=zoneStates[mob.homeZoneId];
  // Wave mobs have homeZoneId=-1 and no zone state — skip zone bookkeeping
  if(!state) return;
  state.mobIds.delete(mob.id);
  state.deaths++;
  if(state.deaths>=getDeathTrigger(mob.homeZoneId)&&!state.spawning){
    state.spawning=true; state.spawnAccum=0; state.deaths=0;
  }
}

// ── Friendly ant pet spawner (called by petals.js ant egg logic) ──────────────
// Pets stay near their owner and may roam a limited number of map tiles away
// (chasing or wandering) before they break off and follow the player again.
// The distance grows with the pet's rarity: 4 tiles at Common, +0.5 tile per
// rarity above that (10.5 tiles at Voidbound).
export const PET_LEASH_BASE_TILES     = 4;
export const PET_LEASH_TILES_PER_TIER = 0.5;
export function getPetLeashTiles(tier) {
  const t = Math.max(0, Math.min(13, tier ?? 0));
  return PET_LEASH_BASE_TILES + PET_LEASH_TILES_PER_TIER * t;
}
export function getPetLeashDist(tier) {
  return getPetLeashTiles(tier) * getTileSize();
}
/** How much of a pet↔player distance is just their two bodies: every pet
 *  distance (leash, follow, return) is measured edge to edge by adding this,
 *  so a big high-rarity pet isn't stuck forever "too far" from the player
 *  when it's actually touching them. */
export function petBodySpan(mob, player) {
  return Math.max(mob.radius ?? 0, mob.drawRadius ?? 0) + (player?.radius ?? 0);
}

/** True if (x, y) — with an optional radius r — is inside the screen area the
 *  player can currently see (their view box centred on cx/cy, which defaults to
 *  the player). Zooming in shrinks the box, so fewer mobs count as visible. */
export function isInPlayerView(player, x, y, r = 0, cx = player.x, cy = player.y) {
  const halfW = player.input?.viewHalfW ?? 800;
  const halfH = player.input?.viewHalfH ?? 450;
  return Math.abs(x - cx) - r <= halfW && Math.abs(y - cy) - r <= halfH;
}

/**
 * Apply boss stat multipliers to every body segment in the centipede chain whose
 * head has the given id.  The head itself is already patched by bossManager, so
 * we skip it here to avoid double-scaling.
 */
export function applyBossStatsToCentipedeChain(headId) {
  const head = mobs.find(m => m.id === headId);
  if (!head || head.chainId == null) return; // chainId can legitimately be 0 — check for null/undefined, not falsy
  const chain = centipedeChains.get(head.chainId);
  if (!chain) return;
  for (const seg of chain.mobs) {
    if (seg.id === headId) continue; // head already patched by bossManager — skip to avoid double-scaling
    _applyBossStatsToMob(seg);
  }
}

export function applyBossStatsToDesertCentipedeChain(headId) {
  const head = mobs.find(m => m.id === headId);
  if (!head || head.chainId == null) return; // chainId can legitimately be 0 — check for null/undefined, not falsy
  const chain = desertCentipedeChains.get(head.chainId);
  if (!chain) return;
  for (const seg of chain.mobs) {
    if (seg.id === headId) continue; // head already patched by bossManager — skip to avoid double-scaling
    _applyBossStatsToMob(seg);
  }
}

// ── Chat-command spawn helper ───────────────────────────────────────────────
/**
 * Spawns a mob near a given point (used by the /spawn chat command).
 * Handles centipede chains and optional boss stat scaling, mirroring the
 * logic spawnWaveMob uses for wave mode, but works in any mode and doesn't
 * require the wave map spawn-finder.
 *
 * @param {string} typeId   - key into MOB_DEFS (underscored form, e.g. 'baby_ant')
 * @param {number} tier     - rarity tier index (0-13)
 * @param {boolean} isBoss  - apply boss stat multipliers
 * @param {number} nearX    - world x to spawn around
 * @param {number} nearY    - world y to spawn around
 * @returns {number|null} the id of the spawned mob (head, for centipedes), or null if the typeId is invalid
 */
export function spawnMobByCommand(typeId, tier, isBoss, nearX, nearY) {
  // Centipede body pieces never spawn on their own — asking for one spawns the whole chain.
  if (typeId === 'centipede_body') typeId = 'centipede_head';
  if (typeId === 'desert_centipede_body') typeId = 'desert_centipede_head';
  const def = MOB_DEFS[typeId];
  if (!def) return null;

  // Find a nearby open spot so the mob doesn't spawn stacked on top of the player.
  let pos = null;
  for (let i = 0; i < 40; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist  = 60 + Math.random() * 120;
    const tx = nearX + Math.cos(angle) * dist;
    const ty = nearY + Math.sin(angle) * dist;
    if (canMoveTo(tx, ty, def.radius)) { pos = { x: tx, y: ty }; break; }
  }
  if (!pos) pos = { x: nearX, y: nearY };

  // Use the real zone at the spawn position, not -1 — homeZoneId=-1 reads as
  // zone tier 99 in the despawn check (getZoneTier's "unknown" fallback), so
  // a command-spawned mob would get marked dead on the very next tick unless
  // the player happened to be standing in an actual tier-99 zone.
  const zoneId = getZoneId(pos.x, pos.y);

  if (typeId === 'centipede_head') {
    const head = spawnCentipede(pos.x, pos.y, zoneId, tier, isBoss);
    if (!head) return null;
    head.alerted = true;
    const chain = centipedeChains.get(head.chainId);
    if (chain) chain.alerted = true;
    if (isBoss) {
      _applyBossStatsToMob(head);
      applyBossStatsToCentipedeChain(head.id);
    }
    return head.id;
  }

  if (typeId === 'desert_centipede_head') {
    const head = spawnDesertCentipede(pos.x, pos.y, zoneId, tier);
    if (!head) return null;
    head.alerted = true;
    const chain = desertCentipedeChains.get(head.chainId);
    if (chain) chain.alerted = true;
    if (isBoss) {
      _applyBossStatsToMob(head);
      for (const seg of chain.mobs) { if (seg.id !== head.id) _applyBossStatsToMob(seg); }
    }
    return head.id;
  }

  const mob = spawnMob(typeId, pos.x, pos.y, zoneId, tier);
  mob.alerted = true;

  if (typeId === 'ant_hole') spawnAntHoleMinions(pos.x, pos.y, zoneId, tier, isBoss);
  if (typeId === 'beehive' && !isBoss) {
    for (let i = 0; i < 2; i++) spawnAntMinion('bee', pos.x, pos.y, pos.x, pos.y, zoneId, tier);
  }
  if (typeId === 'beehive' && isBoss) {
    const bossBee    = spawnAntMinion('bee', pos.x, pos.y, pos.x, pos.y, zoneId, tier);
    const bossHornet = spawnAntMinion('hornet', pos.x, pos.y, pos.x, pos.y, zoneId, tier);
    if (bossBee)    _applyBossStatsToMob(bossBee);
    if (bossHornet) _applyBossStatsToMob(bossHornet);
  }

  if (isBoss) _applyBossStatsToMob(mob);

  return mob.id;
}

// Called by combat.js when a centipede segment takes damage — immediately alerts
// the whole chain so the propagation doesn't have to wait until next tick.
export function alertChainByMob(mob) {
  if (!mob.chainId) return;
  const chain = centipedeChains.get(mob.chainId) || desertCentipedeChains.get(mob.chainId);
  if (!chain || chain.alerted) return;
  chain.alerted = true;
  for (const m of chain.mobs) { m.alerted = true; }
}

const MAX_FRIENDLY_PETS = 20;
function countLivingPets() {
  return mobs.filter(m => !m.dead && m.isFriendlyPet).length;
}
function countLivingPetsOfType(typeId) {
  return mobs.filter(m => !m.dead && m.isFriendlyPet && m.typeId === typeId).length;
}

// ── Boss ant hole player-collision detection ──────────────────────────────────
/**
 * Returns the living boss ant_hole mob whose hitbox overlaps the given circle,
 * or null if none. Used to trigger the "enter sub-map" teleport.
 */
export function getBossAntHoleAtPoint(px, py, pr) {
  for (const mob of mobs) {
    if (mob.dead || !mob.isBoss || mob.typeId !== 'ant_hole') continue;
    const dx = px - mob.x, dy = py - mob.y;
    if (Math.hypot(dx, dy) < pr + mob.radius) return mob;
  }
  return null;
}

// ── Interior mob spawning (ant hole sub-map) ──────────────────────────────────
/**
 * Spawns the interior mobs for the boss ant hole sub-map.
 * All mobs are placed randomly inside the sub-map at ANT_HOLE_OFFSET coords.
 * Returns an array of mob IDs for the caller to track.
 * @param {number} tier - mob tier matching the boss ant hole
 * @returns {number[]} array of spawned mob IDs
 */
export function spawnAntHoleInteriorMobs(tier, playerSpawnX, playerSpawnY) {
  const { cx, cy, r: arenaR } = getAntHoleCircleCenter();
  const ids = [];
  // Keep mobs this far from the player's entry point so they don't insta-contact
  const PLAYER_CLEAR = 250;

  /** Place a mob at a random interior position inside the circular arena. */
  function _placeInteriorMob(typeId, isDigger = false) {
    const margin = 80;
    const safeR = arenaR - margin;
    let x = cx, y = cy;
    let placed = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = Math.random() * safeR;
      const cx2 = cx + Math.cos(angle) * dist;
      const cy2 = cy + Math.sin(angle) * dist;
      if (playerSpawnX !== undefined &&
          Math.hypot(cx2 - playerSpawnX, cy2 - playerSpawnY) < PLAYER_CLEAR) continue;
      x = cx2; y = cy2; placed = true; break;
    }
    if (!placed) {
      // Fallback: place on the far side of the arena from the player
      const awayAngle = playerSpawnX !== undefined
        ? Math.atan2(cy - playerSpawnY, cx - playerSpawnX)
        : Math.random() * Math.PI * 2;
      x = cx + Math.cos(awayAngle) * safeR * 0.8;
      y = cy + Math.sin(awayAngle) * safeR * 0.8;
    }
    const m = spawnAntMinion(typeId, x, y, x, y, -1, tier);
    if (!m) return;
    if (!isDigger) {
      _applyBossStatsToMob(m);
      // Target player (not NPC — NPC is far away in overworld)
      m.waveTarget = 'player';
      m.alerted    = true;
      ids.push(m.id);
    }
    // Diggers stay friendly — no boss stats, no id tracking
  }

  // 6 boss soldier ants
  for (let i = 0; i < 6; i++) _placeInteriorMob('soldier_ant');
  // 3 boss worker ants
  for (let i = 0; i < 3; i++) _placeInteriorMob('worker_ant');
  // 1 boss queen ant
  _placeInteriorMob('queen_ant');
  // 1 boss baby ant
  _placeInteriorMob('baby_ant');
  // 15% chance for a friendly digger inside
  if (Math.random() < 0.15) _placeInteriorMob('digger', true);

  return ids;
}

export function spawnFriendlyAntPet(tier, x, y, slotIdx, pieceIdx) {
  if (countLivingPets() >= MAX_FRIENDLY_PETS) return null;
  const zoneId = getZoneId(x, y);  // use the actual zone the player is in, not hardcoded 0
  const mob = spawnMob('soldier_ant', x, y, zoneId, tier);
  mob.isFriendlyPet        = true;
  mob.isZoneTracked        = false;
  mob.linkedPieceSlotIdx   = slotIdx;
  mob.linkedPieceIdx       = pieceIdx;
  mob.homeX                = undefined;
  mob.homeY                = undefined;
  mob.border               = '#22cc55';  // green border — visually friendly
  return mob;
}

export function spawnFriendlyBeePet(tier, x, y, slotIdx, pieceIdx) {
  if (countLivingPets() >= MAX_FRIENDLY_PETS) return null;
  const zoneId = getZoneId(x, y);
  const mob = spawnMob('bee', x, y, zoneId, tier);
  mob.isFriendlyPet        = true;
  mob.isZoneTracked        = false;
  mob.linkedPieceSlotIdx   = slotIdx;
  mob.linkedPieceIdx       = pieceIdx;
  mob.homeX                = undefined;
  mob.homeY                = undefined;
  mob.border               = '#22cc55';  // green border — visually friendly
  return mob;
}

export function spawnFriendlyBeetlePet(tier, x, y, slotIdx, pieceIdx) {
  if (countLivingPets() >= MAX_FRIENDLY_PETS) return null;
  const zoneId = getZoneId(x, y);
  const mob = spawnMob('beetle', x, y, zoneId, tier);
  mob.isFriendlyPet        = true;
  mob.isZoneTracked        = false;
  mob.linkedPieceSlotIdx   = slotIdx;
  mob.linkedPieceIdx       = pieceIdx;
  mob.homeX                = undefined;
  mob.homeY                = undefined;
  mob.border               = '#22cc55';  // green border — visually friendly
  return mob;
}

export function spawnFriendlyJellyfishPet(tier, x, y, slotIdx, pieceIdx) {
  if (countLivingPets() >= MAX_FRIENDLY_PETS) return null;
  const zoneId = getZoneId(x, y);
  const mob = spawnMob('jellyfish', x, y, zoneId, tier);
  mob.isFriendlyPet        = true;
  mob.isZoneTracked        = false;
  mob.linkedPieceSlotIdx   = slotIdx;
  mob.linkedPieceIdx       = pieceIdx;
  mob.homeX                = undefined;
  mob.homeY                = undefined;
  mob.border               = '#22cc55';  // green border — visually friendly
  return mob;
}

export function spawnFriendlyDiggerPet(tier, x, y, slotIdx, pieceIdx, bodyColor) {
  if (countLivingPets() >= MAX_FRIENDLY_PETS) return null;
  const zoneId = getZoneId(x, y);
  const mob = spawnMob('digger', x, y, zoneId, tier);
  mob.isFriendlyPet        = true;
  mob.isZoneTracked        = false;
  mob.linkedPieceSlotIdx   = slotIdx;
  mob.linkedPieceIdx       = pieceIdx;
  mob.homeX                = undefined;
  mob.homeY                = undefined;
  mob.border               = '#22cc55';  // green border — visually friendly
  mob.bodyColor            = bodyColor;  // player's inner color
  return mob;
}

const STICK_MAX_SANDSTORM_PETS = 9; // overall safety ceiling across every Stick combined — per-Stick cap of 3 is enforced in petals.js
export function spawnFriendlySandstormPet(tier, x, y, slotIdx, pieceIdx) {
  if (countLivingPets() >= MAX_FRIENDLY_PETS) return null;
  if (countLivingPetsOfType('sandstorm') >= STICK_MAX_SANDSTORM_PETS) return null;
  const zoneId = getZoneId(x, y);
  const mob = spawnMob('sandstorm', x, y, zoneId, tier);
  mob.isFriendlyPet        = true;
  mob.isZoneTracked        = false;
  mob.linkedPieceSlotIdx   = slotIdx;
  mob.linkedPieceIdx       = pieceIdx;
  mob.homeX                = undefined;
  mob.homeY                = undefined;
  mob.border               = '#22cc55';  // green border — visually friendly
  // Pet sandstorms are 20% smaller than a normal sandstorm of the same rarity
  const PET_SANDSTORM_SIZE = 0.8;
  mob.radius     = Math.max(1, Math.round(mob.radius * PET_SANDSTORM_SIZE));
  mob.drawRadius = Math.max(1, Math.round(mob.drawRadius * PET_SANDSTORM_SIZE));
  mob.hitOffsetX = (mob.hitOffsetX || 0) * PET_SANDSTORM_SIZE;
  mob.hitOffsetY = (mob.hitOffsetY || 0) * PET_SANDSTORM_SIZE;
  return mob;
}

export function initMobs() {
  mobs.length=0; missiles.length=0; bossStingers.length=0; bossPeas.length=0; bossRoses.length=0; queenBeeEggs.length=0; queenBeePollenOrbit.length=0; centipedeChains.clear(); desertCentipedeChains.clear(); nextMobId=0; nextChainId=0; _bossStingerNextId=0;
  for(const state of zoneStates){
    state.mobIds.clear(); state.deaths=0; state.spawning=false;
    state.spawnAccum=0; state.checkTimer=ZONE_CHECK_INTERVAL; state.centipedeCount=0; state.antHoleCount=0; state.beehiveCount=0; state.fireAntHoleCount=0;
    state.activated=false;
  }
  // Dormant zone population is rebuilt lazily by updateZoneSpawning for whichever
  // biome is active — clear it so a new run (or a different biome) starts clean.
  dormantBuckets.clear(); _dormantCount=0; _streamTimer=0; _populatedBiome=null; _respawnQueue.length=0;
}

// ── Wave-mode mob spawning ────────────────────────────────────────────────────
/**
 * Spawn a mob for wave mode.  Returns the mob's id (for tracking) or null.
 * @param {string}  typeId      - mob type key
 * @param {number}  tier        - RARITIES index (0=Common … 13=Voidbound)
 * @param {boolean} isStructure - if true, allows ant_hole / beehive
 */
export function spawnWaveMob(typeId, tier, isStructure, spawnAtCenter = false) {
  const def = MOB_DEFS[typeId];
  if (!def) return null;

  let pos;
  if (spawnAtCenter) {
    pos = { x: getWaveMapW() / 2, y: getWaveMapH() / 2 };
  } else {
    pos = findWaveMobSpawn(def.radius, mobs);
  }
  if (!pos) return null;

  // Centipede: spawn the full chain
  if (typeId === 'centipede_head') {
    const head = spawnCentipede(pos.x, pos.y, -1, tier, !!spawnAtCenter); // homeZoneId = -1 (wave, no zone); boss if spawnAtCenter
    if (head) {
      head.waveTarget = 'npc';
      if (!spawnAtCenter) {
        // Pre-alert normal mobs so they march; bosses start unalerted (aggro naturally)
        head.alerted = true;
        const chain = centipedeChains.get(head.chainId);
        if (chain) { chain.alerted = true; for (const m of chain.mobs) m.alerted = true; }
      }
      return head.id;
    }
    return null;
  }

  // Desert centipede: spawn the full chain (wanders, turns toward target when nearby)
  if (typeId === 'desert_centipede_head') {
    const head = spawnDesertCentipede(pos.x, pos.y, -1, tier);
    if (head) {
      head.waveTarget = 'npc';
      if (!spawnAtCenter) {
        // Pre-alert normal mobs so they drift toward the NPC; bosses start
        // unalerted and aggro naturally, same as every other boss type.
        head.alerted = true;
        const chain = desertCentipedeChains.get(head.chainId);
        if (chain) { chain.alerted = true; for (const m of chain.mobs) m.alerted = true; }
      }
      return head.id;
    }
    return null;
  }

  const mob = spawnMob(typeId, pos.x, pos.y, -1, tier);
  mob.waveTarget = 'npc';
  if (!spawnAtCenter && typeId !== 'cactus' && typeId !== 'shell') {
    mob.alerted = true; // Pre-alert normal mobs: march toward NPC immediately
  }
  // Boss (spawnAtCenter=true) starts un-alerted — aggros naturally when player/NPC gets close
  // Cactus and shell are static-until-hit — never pre-alerted, they just sit there

  // Ant hole — also spawn initial minions but they DON'T count toward wave total
  if (typeId === 'ant_hole') spawnAntHoleMinions(pos.x, pos.y, -1, tier, !!mob.isBoss);
  // Beehive — spawn 2 guard bees (not wave-counted), but NOT for boss beehives
  if (typeId === 'beehive' && !mob.isBoss) {
    for (let i = 0; i < 2; i++) spawnAntMinion('bee', pos.x, pos.y, pos.x, pos.y, -1, tier);
  }
  // Boss beehive — spawn 1 boss bee and 1 boss hornet at same tier
  if (typeId === 'beehive' && mob.isBoss) {
    const bossBee = spawnAntMinion('bee', pos.x, pos.y, pos.x, pos.y, -1, tier);
    const bossHornet = spawnAntMinion('hornet', pos.x, pos.y, pos.x, pos.y, -1, tier);
    if (bossBee) _applyBossStatsToMob(bossBee);
    if (bossHornet) _applyBossStatsToMob(bossHornet);
    // Add to wave tracking if in wave mode
    if (isWaveMapMode()) {
      if (bossBee) { bossBee.waveTarget = 'npc'; bossBee.alerted = true; addTrackedMob(bossBee.id); }
      if (bossHornet) { bossHornet.waveTarget = 'npc'; bossHornet.alerted = true; addTrackedMob(bossHornet.id); }
    }
  }

  return mob.id;
}

// ══════════════════════════════════════════════════════════════════════════════
// Rarity-zone population — biome-aware, whole-zone, streamed
// ══════════════════════════════════════════════════════════════════════════════
// Each biome (garden / desert / ocean) has its OWN list of mobs that may spawn
// in it, so a Garden map only ever holds garden mobs, and likewise for the
// others. A mob's rarity is the painted zone under it (zone id === tier).
//
// Every rarity zone is populated across its ENTIRE painted area as soon as a
// biome is entered — not just where the player happens to be standing. To make
// that affordable, mobs far from the player are not real entries in `mobs[]`:
// each is a tiny "dormant spawn" record (type, tier, position). Only records
// within STREAM_IN_RADIUS of the player are turned into real mobs, and real
// mobs that end up beyond STREAM_OUT_RADIUS (and are calm, undamaged, and not
// mid-chain) are folded back into a dormant record. The heavy per-frame AI /
// collision / rendering therefore only ever runs on mobs near the player,
// which is what keeps the game smooth no matter how many mobs the zones hold.

// ── What can spawn where. weight = relative chance among the "single" mobs. ──
// kind 'single'  : one plain mob        kind 'centipede' / 'desert_centipede': a chain
// kind 'structure': static nest that owns minions, e.g. ant hole / beehive / sea cave
const BIOME_SPAWN_TABLES = {
  garden: [
    { kind:'single',    typeId:'bee',       weight:16 },
    { kind:'single',    typeId:'ladybug',   weight:16 },
    { kind:'single',    typeId:'spider',    weight:16 },
    { kind:'single',    typeId:'hornet',    weight:12 },
    { kind:'centipede',                     weight:9  },
    { kind:'structure', typeId:'ant_hole',  weight:7  },
    { kind:'structure', typeId:'beehive',   weight:7  },
    { kind:'single',    typeId:'rock',      weight:6  },
    { kind:'single',    typeId:'dandelion', weight:6  },
  ],
  desert: [
    { kind:'single',    typeId:'beetle',     weight:16 },
    { kind:'single',    typeId:'sandstorm',  weight:16 },
    { kind:'single',    typeId:'scorpion',   weight:14 },
    { kind:'single',    typeId:'cactus',     weight:12 },
    { kind:'desert_centipede',               weight:10 },
    { kind:'structure', typeId:'fire_ant_hole', weight:9 },
  ],
  ocean: [
    { kind:'single',    typeId:'jellyfish', weight:16 },
    { kind:'single',    typeId:'squid',     weight:14 },
    { kind:'single',    typeId:'crab',      weight:14 },
    { kind:'single',    typeId:'alligator', weight:10 },
    { kind:'single',    typeId:'starfish',  weight:10 },
    { kind:'single',    typeId:'shell',     weight:8  },
    { kind:'single',    typeId:'sponge',    weight:8  },
    { kind:'single',    typeId:'leech',     weight:6  },
    { kind:'single',    typeId:'bubble',    weight:6  },
    { kind:'structure', typeId:'sea_cave',  weight:8  },
  ],
};
// Only mob types that actually have a stat block/definition can be spawned —
// guards against a table entry naming a mob the game doesn't define.
function _tableFor(biome){
  return (BIOME_SPAWN_TABLES[biome]||[]).filter(e=>e.kind==='centipede'||e.kind==='desert_centipede'||MOB_DEFS[e.typeId]);
}

// ── Density: how many spawn "groups" a zone gets, scaled by its painted area ──
// One group per DENSITY_TILES_PER_GROUP tiles, clamped so tiny zones still get
// something and enormous ones don't explode. Higher rarities are sparser and
// tougher, matching the old per-tier caps (fewer, stronger mobs up top).
const DENSITY_TILES_PER_GROUP = 90;
const MIN_GROUPS_PER_ZONE = 4;
const MAX_GROUPS_PER_ZONE = 420;
function _tierDensityMult(tier){
  if(tier>=13) return 0.35;   // Voidbound
  if(tier>=12) return 0.45;   // Imperial
  if(tier>=10) return 0.7;    // Runic / Seraphic
  return 1;
}

// ── Streaming radii (world units). IN < OUT so mobs don't flicker at the edge. ──
const STREAM_IN_RADIUS  = 4200;   // dormant record -> real mob inside this
const STREAM_OUT_RADIUS = 5600;   // calm real mob -> dormant record beyond this
const STREAM_STEP_MS    = 250;    // how often the player-vs-records scan runs
const STREAM_MAX_IN_PER_STEP = 24; // cap real spawns per scan so a fast trip can't hitch a frame
let _streamTimer = 0;
let _populatedBiome = null;

// Dormant records, bucketed on a coarse grid so "what is near the player" is a
// handful of bucket lookups instead of a scan over every record.
const DORMANT_BUCKET = 3000;
const dormantBuckets = new Map();   // "bx,by" -> array of records
let _dormantCount = 0;
function _bKey(x,y){ return Math.floor(x/DORMANT_BUCKET)+','+Math.floor(y/DORMANT_BUCKET); }
function _dormantAdd(rec){
  const k=_bKey(rec.x,rec.y);
  let arr=dormantBuckets.get(k);
  if(!arr){ arr=[]; dormantBuckets.set(k,arr); }
  arr.push(rec); _dormantCount++;
}
export function getDormantSpawnCount(){ return _dormantCount; }
/** Read-only snapshot: how many dormant spawn groups each rarity zone currently holds (debug/verification). */
export function getDormantCountsByZone(){
  const out=new Array(RARITIES.length).fill(0);
  for(const arr of dormantBuckets.values()) for(const r of arr) out[r.zone]++;
  return out;
}

function _pickEntry(table){
  let total=0; for(const e of table) total+=e.weight;
  let r=Math.random()*total;
  for(const e of table){ r-=e.weight; if(r<=0) return e; }
  return table[table.length-1];
}
function _entryRadius(e){
  if(e.kind==='centipede'||e.kind==='desert_centipede') return 500;   // full chain length
  return MOB_DEFS[e.typeId]?.radius ?? 40;
}

/** Fill every rarity zone of `biome` with dormant spawn records. Called once per biome entry. */
function populateAllZones(biome){
  dormantBuckets.clear(); _dormantCount=0; _streamTimer=0; _populatedBiome=biome;
  const table=_tableFor(biome);
  if(!table.length) return;
  const gw=getGridW(), gh=getGridH(), ts=getTileSize();

  // Collect the tiles of each zone once.
  const tilesByZone=Array.from({length:RARITIES.length},()=>[]);
  for(let gy=0;gy<gh;gy++){
    for(let gx=0;gx<gw;gx++){
      const t=getZoneTierAt((gx+0.5)*ts,(gy+0.5)*ts);
      if(t>=0) tilesByZone[t].push(gy*gw+gx);
    }
  }

  const placed=[];   // {x,y,r} of everything placed so far, to keep spawns from overlapping
  const placedGrid=new Map();
  const pKey=(x,y)=>Math.floor(x/600)+','+Math.floor(y/600);
  const addPlaced=(x,y,r)=>{ const k=pKey(x,y); let a=placedGrid.get(k); if(!a){a=[];placedGrid.set(k,a);} a.push({x,y,r}); };
  const clearOfPlaced=(x,y,r)=>{
    const bx=Math.floor(x/600), by=Math.floor(y/600);
    for(let ox=-1;ox<=1;ox++) for(let oy=-1;oy<=1;oy++){
      const a=placedGrid.get((bx+ox)+','+(by+oy)); if(!a) continue;
      for(const p of a) if(Math.hypot(x-p.x,y-p.y)<r+p.r+30) return false;
    }
    return true;
  };

  // Spawn-chamber protection: never place anything inside the player's safe area.
  const chamber=getSpawnChamberCenter();

  for(let zone=0;zone<RARITIES.length;zone++){
    const tiles=tilesByZone[zone];
    if(!tiles.length) continue;
    let groups=Math.round(tiles.length/DENSITY_TILES_PER_GROUP*_tierDensityMult(zone));
    groups=Math.max(MIN_GROUPS_PER_ZONE,Math.min(MAX_GROUPS_PER_ZONE,groups));

    for(let g=0;g<groups;g++){
      const entry=_pickEntry(table);
      const r=_entryRadius(entry);
      let pos=null;
      for(let attempt=0;attempt<40&&!pos;attempt++){
        const idx=tiles[Math.floor(Math.random()*tiles.length)];
        const gx=idx%gw, gy=(idx/gw)|0;
        const x=(gx+0.2+Math.random()*0.6)*ts, y=(gy+0.2+Math.random()*0.6)*ts;
        if(getZoneTierAt(x,y)!==zone) continue;          // must be inside this exact zone
        if(!canMoveTo(x,y,r)) continue;                   // walkable with the mob's full body
        if(chamber && Math.hypot(x-chamber.x,y-chamber.y)<MOB_SAFE_RADIUS*2) continue;
        if(!clearOfPlaced(x,y,r)) continue;
        pos={x,y};
      }
      if(!pos) continue;
      addPlaced(pos.x,pos.y,r);
      _dormantAdd({ entry, zone, x:pos.x, y:pos.y });
    }
  }
}

// Bookkeeping so per-zone counters used by the rest of the file stay honest.
function _bumpZoneCounter(zone,key,d){ const st=zoneStates[zone]; if(st) st[key]=Math.max(0,(st[key]||0)+d); }

/** Turn one dormant record into real mob(s). Returns true if something was spawned. */
function wakeDormant(rec){
  const before=mobs.length;
  const ok=_wakeDormantInner(rec);
  // Remember the origin on EVERY mob this wake produced (plain mobs, chain heads
  // and segments, structures) so that when the player later KILLS one, its
  // original spot can be repopulated (see _scheduleRespawn).
  if(ok){
    for(let i=before;i<mobs.length;i++){
      if(mobs[i]._origin===undefined) mobs[i]._origin=rec;
    }
    // A nest (ant hole / beehive / fire ant hole / sea cave) and the minions it
    // spawned form one unit: remember the members on the record so the whole
    // nest can be put back to sleep together once the player is far away.
    if(rec.entry.kind==='structure'){
      rec._nest=[];
      for(let i=before;i<mobs.length;i++) rec._nest.push(mobs[i]);
    }
  }
  // Tag only the PLAIN single mobs so they can be folded back later. Chains,
  // structures and their minions are never tagged, so they are never put back
  // to sleep mid-life (they own other mobs and are linked to each other).
  if(ok&&rec.entry.kind==='single'){
    for(let i=before;i<mobs.length;i++){
      const m=mobs[i];
      if(m.typeId===rec.entry.typeId) m._streamRec={ entry:rec.entry, zone:rec.zone, x:rec.x, y:rec.y };
    }
  }
  return ok;
}
function _wakeDormantInner(rec){
  const {entry,zone,x,y}=rec;
  const tier=zone;
  const st=zoneStates[zone];
  switch(entry.kind){
    case 'centipede': {
      const head=spawnCentipede(x,y,zone,tier);
      if(!head) return false;
      _bumpZoneCounter(zone,'centipedeCount',1);
      return true;
    }
    case 'desert_centipede': {
      const head=spawnDesertCentipede(x,y,zone,tier);
      if(!head) return false;
      _bumpZoneCounter(zone,'desertCentipedeCount',1);
      return true;
    }
    case 'structure': {
      const id=entry.typeId;
      const mob=spawnMob(id,x,y,zone,tier);
      if(!mob) return false;
      if(st) st.mobIds.add(mob.id);
      if(id==='ant_hole'){ _bumpZoneCounter(zone,'antHoleCount',1); spawnAntHoleMinions(x,y,zone,tier); }
      else if(id==='beehive'){
        _bumpZoneCounter(zone,'beehiveCount',1);
        if(!mob.isBoss) for(let i=0;i<2;i++) spawnAntMinion('bee',x,y,x,y,zone,tier);
      }
      else if(id==='fire_ant_hole'){ _bumpZoneCounter(zone,'fireAntHoleCount',1); spawnFireAntHoleMinions(x,y,zone,tier); }
      // sea_cave spawns its crab/jellyfish waves itself when damaged — nothing extra now.
      return true;
    }
    default: {
      const mob=spawnMob(entry.typeId,x,y,zone,tier);
      if(!mob) return false;
      if(st) st.mobIds.add(mob.id);
      if(entry.typeId==='cactus') _bumpZoneCounter(zone,'cactusCount',1);
      if(entry.typeId==='rock') _bumpZoneCounter(zone,'rockCount',1);
      if(entry.typeId==='dandelion') _bumpZoneCounter(zone,'dandelionCount',1);
      return true;
    }
  }
}

/** Stream dormant records in/out around the player. Cheap: bucket lookups + a scan of live mobs. */
function streamZoneMobs(dt){
  _streamTimer-=dt;
  if(_streamTimer>0) return;
  _streamTimer=STREAM_STEP_MS;

  // Wake dormant spawns that are now close to any player.
  const reach=Math.ceil(STREAM_IN_RADIUS/DORMANT_BUCKET);
  let woken=0;
  for(const { x: playerX, y: playerY } of players){
  const pbx=Math.floor(playerX/DORMANT_BUCKET), pby=Math.floor(playerY/DORMANT_BUCKET);
  for(let ox=-reach;ox<=reach&&woken<STREAM_MAX_IN_PER_STEP;ox++){
    for(let oy=-reach;oy<=reach&&woken<STREAM_MAX_IN_PER_STEP;oy++){
      const k=(pbx+ox)+','+(pby+oy);
      const arr=dormantBuckets.get(k);
      if(!arr||!arr.length) continue;
      for(let i=arr.length-1;i>=0&&woken<STREAM_MAX_IN_PER_STEP;i--){
        const rec=arr[i];
        if(Math.hypot(rec.x-playerX,rec.y-playerY)>STREAM_IN_RADIUS) continue;
        arr.splice(i,1); _dormantCount--;
        if(wakeDormant(rec)) woken++;
      }
      if(!arr.length) dormantBuckets.delete(k);
    }
  }
  }

  // Put calm, far-away real mobs back to sleep (only plain, undisturbed ones).
  for(const mob of mobs){
    if(mob.dead||!mob._streamRec) continue;
    if(mob.alerted||mob.hp<mob.maxHp||mob.isBoss||mob.isFriendlyPet) continue;
    if(mob.chainId!=null||mob.isCentipede||mob.isDesertCentipede) continue;
    if(mob.isAntHole||mob.isBeehive||mob.isSeaCave) continue;
    if(isNearAnyPlayer(mob.x,mob.y,STREAM_OUT_RADIUS)) continue;
    // Fold it back into a record at its CURRENT spot, if that's still inside its own zone.
    const back={ entry:mob._streamRec.entry, zone:mob._streamRec.zone, x:mob.x, y:mob.y };
    if(getZoneTierAt(back.x,back.y)!==back.zone){ back.x=mob._streamRec.x; back.y=mob._streamRec.y; }
    mob.dead=true; mob._streamedOut=true;
    const st=zoneStates[mob.homeZoneId]; if(st) st.mobIds.delete(mob.id);
    _dormantAdd(back);
  }

  // Put whole calm nests back to sleep. A nest sleeps only when the structure is
  // far from the player AND every member (structure + minions) is undisturbed and
  // also far away. Anything hurt, alerted or chasing keeps the nest awake.
  const seenNests=new Set();
  for(const mob of mobs){
    if(mob.dead) continue;
    const rec=mob._origin;
    if(!rec||!rec._nest||seenNests.has(rec)) continue;
    seenNests.add(rec);
    if(rec.entry.kind!=='structure') continue;
    const recorded=rec._nest.filter(m=>!m.dead);
    if(!recorded.length) continue;
    const structure=recorded.find(m=>m.typeId===rec.entry.typeId);
    if(!structure||structure.isBoss) continue;
    if(structure.hp<structure.maxHp) continue;
    if(isNearAnyPlayer(structure.x,structure.y,STREAM_OUT_RADIUS)) continue;

    // Gather EVERY live mob anchored to this nest — including ones added after the
    // nest woke (hatched eggs, replacement queens…), which were never in rec._nest.
    // Anything anchored here that we did not create means the nest has changed, so
    // it stays awake rather than silently deleting mobs the player might care about.
    const members=[];
    const recordedSet=new Set(recorded);
    let grown=false;
    for(const m of mobs){
      if(m.dead||m.homeX!==rec.x&&m.homeX!==structure.x) continue;
      if(m.homeY!==rec.y&&m.homeY!==structure.y) continue;
      if(m===structure) continue;
      members.push(m);
      if(!recordedSet.has(m)) grown=true;
    }
    if(grown) continue;
    members.unshift(structure);
    let calm=true;
    for(const m of members){
      if(m.alerted||m.isBoss||m.isFriendlyPet||m.hp<m.maxHp||isNearAnyPlayer(m.x,m.y,STREAM_OUT_RADIUS)){ calm=false; break; }
    }
    if(!calm) continue;
    // Sleep it: silently remove every member, re-add ONE record for the structure.
    for(const m of members){
      m.dead=true; m._streamedOut=true;
      const st=zoneStates[m.homeZoneId]; if(st) st.mobIds.delete(m.id);
    }
    // give the counters their slot back so the next wake bumps them again
    if(rec.entry.typeId==='ant_hole')      _bumpZoneCounter(rec.zone,'antHoleCount',-1);
    if(rec.entry.typeId==='beehive')       _bumpZoneCounter(rec.zone,'beehiveCount',-1);
    if(rec.entry.typeId==='fire_ant_hole') _bumpZoneCounter(rec.zone,'fireAntHoleCount',-1);
    rec._nest=null;
    _dormantAdd({ entry:rec.entry, zone:rec.zone, x:rec.x, y:rec.y });
  }
}

/** Per-frame entry point (replaces the old drip-spawner). */
function updateZoneSpawning(dt){
  const biome=getActiveBiomeId();
  if(biome!==_populatedBiome){ _respawnQueue.length=0; populateAllZones(biome); }
  _processRespawns();
  streamZoneMobs(dt);
}

// While every player is dead, hostile mobs drop aggro and can't pick it back
// up: each tick they're de-alerted and their aggro range is suppressed for the
// duration of the AI pass (restored afterwards, so nothing is lost on respawn).
const NO_AGGRO_RANGE = 1e-6;   // > 0 so `aggroRange||fallback` checks don't fall back
export function updateMobs(dt) {
  if (!players.length) return;
  const allPlayersDead = players.every(p => p.dead);
  const suppressed = [];
  if (allPlayersDead) {
    for (const mob of mobs) {
      if (mob.dead || mob.isFriendlyPet) continue;
      mob.alerted = false;
      if (mob.aggroRange > 0) { suppressed.push([mob, mob.aggroRange]); mob.aggroRange = NO_AGGRO_RANGE; }
    }
    for (const [, chain] of centipedeChains) chain.alerted = false;
    for (const [, chain] of desertCentipedeChains) chain.alerted = false;
  }
  try {
    _updateMobsInner(dt);
    idleAnimate();
  } finally {
    for (const [mob, range] of suppressed) {
      if (mob.aggroRange === NO_AGGRO_RANGE) mob.aggroRange = range;
    }
  }
}

// ── Idle animation ──────────────────────────────────────────────────────────
// Most AI loops only advance legs/mandibles/wings while the mob is actually
// moving, so a mob standing still (speed 0, holding position, blocked…) froze
// mid-pose. After the AI pass, any of these phases that didn't advance this
// tick is nudged forward slowly, so every mob keeps animating at rest.
const IDLE_ANIM_RATES = { legPhase: 0.05, pincerPhase: 0.06, wingPhase: 0.05 };
const IDLE_ANIM_RATE_OVERRIDES = {
  beetle:           { pincerPhase: 0.03 },
  mummified_beetle: { pincerPhase: 0.03 },
};
function idleAnimate() {
  for (const mob of mobs) {
    if (mob.dead) continue;
    const prev = mob._animPrev || (mob._animPrev = {});
    const over = IDLE_ANIM_RATE_OVERRIDES[mob.typeId];
    for (const key in IDLE_ANIM_RATES) {
      const cur = mob[key] ?? 0;
      if (prev[key] === cur) mob[key] = cur + (over?.[key] ?? IDLE_ANIM_RATES[key]);
      prev[key] = mob[key] ?? 0;
    }
  }
}

function _updateMobsInner(dt) {
  const AI_CULL_DIST=9000;

  // ── Push mobs out of walls ────────────────────────────────────────────────
  // Any mob whose center is inside a wall gets nudged outward so it can move again.
  for (const mob of mobs) {
    if (mob.dead) continue;
    if (!canMoveTo(mob.x, mob.y, mob.radius)) {
      if (isWaveMapMode()) {
        // Wave map: directly clamp to valid area — instant teleport out of walls.
        // The radial nudge (max step 80) fails for mobs spawned far outside bounds.
        const W = getWaveMapW(), H = getWaveMapH(), r = mob.radius;
        mob.x = Math.max(r, Math.min(W - r, mob.x));
        mob.y = Math.max(r, Math.min(H - r, mob.y));
      } else {
        // Zone map: try nudging in 16 directions to find the nearest clear spot
        let pushed = false;
        for (let step = 4; step <= 80; step += 4) {
          for (let a = 0; a < 16; a++) {
            const angle = (a / 16) * Math.PI * 2;
            const nx = mob.x + Math.cos(angle) * step;
            const ny = mob.y + Math.sin(angle) * step;
            if (canMoveTo(nx, ny, mob.radius)) {
              mob.x = nx; mob.y = ny;
              pushed = true;
              break;
            }
          }
          if (pushed) break;
        }
      }
    }
  }

  // Despawn check: a mob that has wandered 2+ rarity tiers away from the zone it
  // was born in is removed (e.g. chased far from its home into a much deeper
  // zone). Mobs that were just put back to sleep are exempt — they are already
  // gone. Skipped entirely for friendly pets and bosses, which follow the player.
  if (!isWaveMapMode()) {
    for(const mob of mobs){
      if(mob.dead||mob.isFriendlyPet||mob.isBoss) continue;
      if(mob.homeZoneId==null||mob.homeZoneId<0) continue;
      if(Math.abs(getZoneTier(mob.homeZoneId)-getZoneTier(getZoneId(mob.x,mob.y)))>=2){
        mob.dead=true; mob._streamedOut=true;      // vanishes silently: not a kill, no drops/XP/pop
        const st=zoneStates[mob.homeZoneId]; if(st) st.mobIds.delete(mob.id);
      }
    }
  }

  // ── Centipede chain AI ────────────────────────────────────────────────────
  const DEAGGRO_DIST = 1200; // player must get this far away to lose aggro
  // Collect live diggers once — used by centipede AI and other mob AI loops
  const diggers = mobs.filter(m => !m.dead && (m.typeId === 'digger' || m.typeId === 'beekeeper' || m.isFriendlyPet));
  // No PET_VIEW_RADIUS cap — enemy mobs aggro to friendly pets at any distance
  for(const [,chain] of centipedeChains){
    if(chain.mobs.length===0) continue;
    // Propagate alerted state
    if(!chain.alerted&&chain.mobs.some(m=>m.alerted)){
      chain.alerted=true; for(const m of chain.mobs) m.alerted=true;
    }
    const head=chain.mobs[0];
    if(!head||head.dead) continue;
    const player = targetPlayerFor(head), playerX = player.x, playerY = player.y;

    // Pick nearest target: player, NPC (wave mode — whichever is closer), or any live digger
    let chainTargetX=playerX,chainTargetY=playerY;
    let chainBestDist=Math.hypot(playerX-head.x,playerY-head.y);

    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const pick = pickWaveTarget(head, head.x, head.y, playerX, playerY);
      chainTargetX = pick.targetX; chainTargetY = pick.targetY; chainBestDist = pick.dist;
      if (head.waveTarget !== pick.kind) {
        head.waveTarget = pick.kind;
        // Sync all segments to the same target
        const ch = centipedeChains.get(head.chainId);
        if (ch) for (const m of ch.mobs) m.waveTarget = pick.kind;
      }
    } else {
      for(const dg of diggers){const dd=Math.hypot(dg.x-head.x,dg.y-head.y);if(dd<chainBestDist){chainTargetX=dg.x;chainTargetY=dg.y;chainBestDist=dd;}}
    }

    const dx=chainTargetX-head.x, dy=chainTargetY-head.y, dist=Math.hypot(dx,dy);

    // Auto-aggro if any chain segment is within range of the target
    if(!chain.alerted){
      const aggroR=head.aggroRange||280;
      for(const seg of chain.mobs){
        if(Math.hypot(chainTargetX-seg.x,chainTargetY-seg.y)<aggroR){
          chain.alerted=true; for(const m of chain.mobs) m.alerted=true; break;
        }
      }
    }

    // De-aggro if player escapes leash distance
    const isWaveCentiNPCChase = isWaveMapMode() && head.waveTarget !== 'player';
    if(chain.alerted && dist>DEAGGRO_DIST && !isWaveCentiNPCChase){
      chain.alerted=false; for(const m of chain.mobs){ m.alerted=false; m.wanderAngle=m.facing; m.wanderTimer=800; }
    }

    if(dist<=AI_CULL_DIST){
      const chasing=chain.alerted&&dist>0.01;
      head.speed=chasing?head.alertSpeed:head.baseSpeed;
      
      // Apply web slowdown
      const slowFactorC = Math.max(getWebSlowdownFactor(head.x, head.y), getPincerSlowFactor(head.id));
      head.speed *= (1 - slowFactorC);
      
      let newX=head.x, newY=head.y;

      // Max turn per frame — prevents head from doing U-turns into its own body
      const MAX_TURN=2.7;

      if(chasing){
        let wantFacing=Math.atan2(dy,dx);
        let tdiff=wantFacing-head.facing;
        if(tdiff>Math.PI) tdiff-=Math.PI*2; if(tdiff<-Math.PI) tdiff+=Math.PI*2;
        tdiff=Math.max(-MAX_TURN,Math.min(MAX_TURN,tdiff));
        head.targetFacing=head.facing+tdiff;
        newX=head.x+Math.cos(head.targetFacing)*head.speed;
        newY=head.y+Math.sin(head.targetFacing)*head.speed;
      } else {
        head.wanderTimer-=dt;
        if(head.wanderTimer<=0){
          // New wander direction: at most 90° turn from current facing to prevent U-turns
          const turn=(Math.random()-0.5)*Math.PI*0.9;
          head.wanderAngle=head.facing+turn;
          head.wanderTimer=1200+Math.random()*2500;
        }
        head.targetFacing=head.wanderAngle;
        newX=head.x+Math.cos(head.wanderAngle)*head.speed*0.45;
        newY=head.y+Math.sin(head.wanderAngle)*head.speed*0.45;
      }
      if(canMoveTo(newX,newY,head.radius)){ head.x=newX; head.y=newY; }
      else {
        // Head hit a wall — pick a new wander direction away from it
        head.wanderAngle=head.facing+Math.PI*(0.5+Math.random());
        head.wanderTimer=600+Math.random()*800;
      }

      // Smooth head facing
      let diff=head.targetFacing-head.facing;
      if(diff>Math.PI) diff-=Math.PI*2; if(diff<-Math.PI) diff+=Math.PI*2;
      head.facing+=diff*0.08;
      const legSpeed = chasing ? 0.14 : 0.06;
      head.legPhase=(head.legPhase||0)+legSpeed;

      // Body following — segments smoothly follow their parent
      for(let i=1;i<chain.mobs.length;i++){
        const seg=chain.mobs[i], parent=chain.mobs[i-1];
        if(!seg||seg.dead||!parent||parent.dead) continue;
        const ddx=parent.x-seg.x, ddy=parent.y-seg.y, ddist=Math.hypot(ddx,ddy);
        const desired=(parent.radius+seg.radius)*1.05;
        const prevX=seg.x, prevY=seg.y;
        if(ddist>desired&&ddist>0.001){
          const excess=ddist-desired;
          const nx=ddx/ddist, ny=ddy/ddist;
          const tx=seg.x+nx*excess, ty=seg.y+ny*excess;
          // Only move if the new position is valid (not in a wall)
          if(canMoveTo(tx,ty,seg.radius)){ seg.x=tx; seg.y=ty; }
          else {
            // Try moving only on x or y axis to slide along walls
            if(canMoveTo(tx,seg.y,seg.radius)) seg.x=tx;
            else if(canMoveTo(seg.x,ty,seg.radius)) seg.y=ty;
          }
          // Smoothly rotate toward travel direction
          const wantFacing=Math.atan2(ddy,ddx);
          let fd=wantFacing-seg.facing;
          if(fd>Math.PI) fd-=Math.PI*2; if(fd<-Math.PI) fd+=Math.PI*2;
          seg.facing+=fd*0.18;
        }
        seg.targetFacing=seg.facing;
        // Only animate legs if this segment actually moved this frame
        const moved=Math.hypot(seg.x-prevX,seg.y-prevY)>0.05;
        if(moved) seg.legPhase=(seg.legPhase||0)+legSpeed;

        // Soft collision: head (i=0) and segment 1 — prevent full overlap without flinging
        if(i===1){
          const hx=head.x-seg.x, hy=head.y-seg.y, hd=Math.hypot(hx,hy);
          const minSep=head.radius+seg.radius;
          if(hd<minSep&&hd>0.001){
            // Gently push segment away from head (soft, low-strength)
            const overlap=(minSep-hd)*0.3;
            const nx=hx/hd, ny=hy/hd;
            const tx=seg.x-nx*overlap, ty=seg.y-ny*overlap;
            if(canMoveTo(tx,ty,seg.radius)){ seg.x=tx; seg.y=ty; }
          }
        }
      }
    }
  }

  // ── Centipede boss — per-segment pea shooting ─────────────────────────────
  const CENTI_PEA_INTERVAL = 7000; // ms between shots per segment (4s + 3s extra)
  const CENTI_PEA_SPEED    = 6;    // px per ms tick
  const CENTI_PEA_LIFETIME = 10000;// ms before despawn
  const CENTI_PEA_SQUISH_DUR = 180;// ms for shoot squish anim
  const CENTI_PEA_MAX      = 20;   // global cap — wait until ≤10 alive before shooting again

  for(const mob of mobs){
    if(mob.dead || !mob.isCentipede || !mob.isBoss) continue;

    // Random initial delay 1-10s before first shot
    if(mob.peaShootTimer === undefined){
      mob.peaShootTimer = 1000 + Math.random() * 9000;
      mob.peaSquishTimer = 0;
      mob.peaSquishPhase = 0; // 0=none 1=shrink 2=grow 3=done
    }
    mob.peaShootTimer -= dt;

    // Squish animation state
    if(mob.peaSquishPhase > 0){
      mob.peaSquishTimer -= dt;
      if(mob.peaSquishTimer <= 0){
        if(mob.peaSquishPhase === 1){ mob.peaSquishPhase = 2; mob.peaSquishTimer = CENTI_PEA_SQUISH_DUR; }
        else if(mob.peaSquishPhase === 2){ mob.peaSquishPhase = 3; mob.peaSquishTimer = CENTI_PEA_SQUISH_DUR; }
        else { mob.peaSquishPhase = 0; mob.drawRadius = mob._baseDrawRadius ?? mob.drawRadius; mob.radius = mob._baseRadius ?? mob.radius; }
      }
      const baseR = mob._baseDrawRadius ?? mob.drawRadius;
      if(mob.peaSquishPhase === 1) mob.drawRadius = baseR * (0.78 + 0.22 * (mob.peaSquishTimer / CENTI_PEA_SQUISH_DUR));
      else if(mob.peaSquishPhase === 2) mob.drawRadius = baseR * (0.78 + 0.30 * (1 - mob.peaSquishTimer / CENTI_PEA_SQUISH_DUR));
      else if(mob.peaSquishPhase === 3) mob.drawRadius = baseR * (1.08 - 0.08 * (1 - mob.peaSquishTimer / CENTI_PEA_SQUISH_DUR));
      mob.radius = Math.round(mob.drawRadius * (mob.hitRadiusFactor ?? 1));
    }

    if(mob.peaShootTimer <= 0){
      // Don't shoot if 10+ peas already alive (wait until count drops below 10)
      const livePeas = bossPeas.filter(p => !p.dead).length;
      if(livePeas >= 10){
        // Keep timer at 0 so we shoot immediately once count drops
        mob.peaShootTimer = 0;
      } else if(livePeas < CENTI_PEA_MAX){
        mob.peaShootTimer = CENTI_PEA_INTERVAL;
        // Cache base size for squish
        if(!mob._baseDrawRadius){ mob._baseDrawRadius = mob.drawRadius; mob._baseRadius = mob.radius; }
        // Start squish
        mob.peaSquishPhase = 1; mob.peaSquishTimer = CENTI_PEA_SQUISH_DUR;

        // Fire pea outward perpendicular to segment facing
        const t = mob.tier ?? 0;
        const cStats = MOB_STATS.centipede_head;
        const peaHp  = Math.round(cStats.hp[t] * 0.5);
        const peaDmg = cStats.dmg[t] * 1.5;
        const peaR   = Math.max(5, Math.round((mob.drawRadius ?? mob.radius) * 0.38));
        // Shoot sideways from segment (perpendicular to its facing)
        const fireAngle = (mob.facing ?? 0) + Math.PI * 0.5 * (Math.random() < 0.5 ? 1 : -1);
        bossPeas.push({
          id: ++_bossStingerNextId,
          x: mob.x, y: mob.y,
          vx: Math.cos(fireAngle) * CENTI_PEA_SPEED,
          vy: Math.sin(fireAngle) * CENTI_PEA_SPEED,
          radius: peaR,
          hp: peaHp, maxHp: peaHp,
          damage: peaDmg,
          lifetime: CENTI_PEA_LIFETIME,
          dead: false,
          fromMobId: mob.id,
          tier: t,
          color: '#66bb6a',
          border: '#2e7d32',
          hurtFlash: 0,
        });
      }
    }
  }

  // ── Boss pea physics — bounce off walls, move each tick ───────────────────
  for(let i = bossPeas.length - 1; i >= 0; i--){
    const p = bossPeas[i];
    if(p.dead){ bossPeas.splice(i,1); continue; }
    p.lifetime -= dt;
    if(p.lifetime <= 0){ p.dead = true; bossPeas.splice(i,1); continue; }

    const nx = p.x + p.vx * dt;
    const ny = p.y + p.vy * dt;
    // Bounce off walls using canMoveTo
    const canX = canMoveTo(nx, p.y, p.radius);
    const canY = canMoveTo(p.x, ny, p.radius);
    if(canX) p.x = nx; else p.vx = -p.vx;
    if(canY) p.y = ny; else p.vy = -p.vy;
  }

  // ── Regular mob AI ───────────────────────────────────────────────────────-

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.isCentipede) continue;
    if(mob.typeId==='hornet') continue;  // handled below
    if(mob.typeId==='digger'||mob.typeId==='beekeeper') continue;  // friendly mobs handled separately
    if(mob.isAntMob) continue;  // ants handled in dedicated section below
    if(mob.isFireAntMob) continue;  // fire ants handled in dedicated section below
    if(mob.typeId==='beehive') continue;  // static, no AI needed
    if(mob.typeId==='queen_bee') continue;  // handled in dedicated section below
    if(mob.isFriendlyPet) continue;  // friendly pets handled in dedicated section below
    if(mob.typeId==='sandstorm') continue;  // handled in dedicated section below
    if(mob.isDesertCentipede) continue;  // handled in dedicated section below
    if(mob.typeId==='cactus') continue;  // static, no AI needed
    if(mob.typeId==='rock') continue;  // static, no AI needed
    if(mob.typeId==='dandelion') continue;  // static, no AI needed
    if(mob.typeId==='scorpion') continue;  // handled in dedicated section below
    if(mob.typeId==='pyramid') continue;  // static, no AI needed
    if(mob.typeId==='sponge'||mob.typeId==='sea_cave') continue;  // static ocean scenery, no AI needed
    if(mob.typeId==='shell') continue;  // motionless until hit, then periodic push-toward-target — handled in its own dedicated AI loop below
    if(mob.typeId==='debris') continue;  // drifts only, handled in dedicated section below — never aggros/chases
    if(mob.typeId==='bubble') continue;  // drifts only, handled in dedicated section below — never aggros/chases, even after being hit
    if(mob.typeId==='starfish') continue;  // handled in dedicated section below
    if(mob.typeId==='crab') continue;  // handled in dedicated section below, scorpion-style stand-and-dodge
    // Honeycomb override: if attracted to a honeycomb entity, target it instead
    if (mob.honeycombTargetId != null) {
      const hc = honeycombEntities.find(e => e.id === mob.honeycombTargetId && !e.dead);
      if (hc) {
        const hcDx = hc.x - mob.x, hcDy = hc.y - mob.y;
        const hcDist = Math.hypot(hcDx, hcDy);
        mob.alerted = true;
        mob.speed   = mob.alertSpeed || mob.baseSpeed;
        const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
        mob.speed *= (1 - slowFactor);
        mob.targetFacing = Math.atan2(hcDy, hcDx);
        if (hcDist > mob.radius + hc.radius && hcDist > 0.001) {
          const nx = hcDx / hcDist, ny = hcDy / hcDist;
          const nx2 = mob.x + nx * mob.speed, ny2 = mob.y + ny * mob.speed;
          if (canMoveTo(nx2, ny2, mob.radius)) { mob.x = nx2; mob.y = ny2; }
        }
        continue;
      } else {
      }
    }
    // Pick nearest target: player, NPC (wave mode — whichever is closer, no
    // bias), or any live digger (non-wave mode).
    let targetX=playerX,targetY=playerY;
    let tDist2=Math.hypot(playerX-mob.x,playerY-mob.y);

    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const pick = pickWaveTarget(mob, mob.x, mob.y, playerX, playerY);
      targetX = pick.targetX; targetY = pick.targetY; tDist2 = pick.dist;
      mob.waveTarget = pick.kind;
    } else if (!isWaveMapMode()) {
      for(const dg of diggers){const dd=Math.hypot(dg.x-mob.x,dg.y-mob.y);if(dd<tDist2){targetX=dg.x;targetY=dg.y;tDist2=dd;}}
    }
    const dx=targetX-mob.x, dy=targetY-mob.y, dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;

    // De-aggro if the current target gets far enough away
    // Wave mobs targeting the NPC never de-aggro (NPC is always far away)
    const isWaveNPCChase = isWaveMapMode() && mob.waveTarget !== 'player';
    if(mob.alerted && dist>DEAGGRO_DIST && !isWaveNPCChase){
      mob.alerted=false; mob.wanderAngle=mob.facing; mob.wanderTimer=800;
    }

    let chasing=false;
    if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else mob.speed=mob.baseSpeed;
    
    // Apply web slowdown
    const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactor);
    
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    if(mob.typeId==='spider'&&chasing){
      mob.webTimer-=dt;
      if(mob.webTimer<=0){
        // Spawn a web slightly smaller than the spider's visible body
        spawnWebField(mob.x, mob.y, mob.tier ?? 0, (mob.drawRadius ?? mob.radius) * 0.65);
        mob.webTimer += 1500;
      }

      // ── Boss spider egg-laying ──────────────────────────────────────────
      if(mob.isBoss){
        mob.spiderEggTimer = (mob.spiderEggTimer ?? 4000) - dt;
        if(mob.spiderEggTimer <= 0){
          mob.spiderEggTimer = 4000;
          const eggRadius = Math.max(6, Math.round((mob.drawRadius ?? mob.radius) * 0.5));
          const t = mob.tier ?? 0;
          const aeStats = MOB_STATS.ant_egg;
          const spiderEgg = {
            id: ++nextMobId,
            typeId: 'spider_egg',
            name: 'Spider Egg',
            x: mob.x, y: mob.y,
            homeZoneId: mob.homeZoneId,
            tier: t,
            rarity: mob.rarity,
            radius: eggRadius,
            drawRadius: eggRadius,
            hitRadiusFactor: 1.0,
            hitOffsetX: 0, hitOffsetY: 0,
            hp: aeStats.hp[t],
            maxHp: aeStats.hp[t],
            damage: aeStats.dmg[t],
            contactDps: aeStats.dmg[t],
            armor: aeStats.armor[t] ?? 0,
            speed: 0, baseSpeed: 0, alertSpeed: 0,
            aggroRange: 0,
            mass: 120,
            facing: 0, targetFacing: 0,
            alerted: false,
            dead: false,
            isBoss: false,
            isZoneTracked: false,
            spiderEggHatchTimer: 4000,
            ownerTier: t,
            ownerRarity: mob.rarity,
          };
          mobs.push(spiderEgg);
        }
      }
      // ───────────────────────────────────────────────────────────────────
    }

    // ── Boss Beetle: dash (same telegraph/lunge as boss Soldier Ant) + periodic spawn ──
    if(mob.isBoss && mob.typeId==='beetle'){
      // Same numbers as boss Soldier Ant's lunge (that block declares its own
      // identically-valued consts later in this function, out of scope here).
      const BEETLE_LUNGE_COOLDOWN  = 15000;
      const BEETLE_LUNGE_RANGE     = 600;
      const BEETLE_LUNGE_DIST      = 300;
      const BEETLE_LUNGE_TELEGRAPH = 700;
      const BEETLE_LUNGE_SPEED     = 28;
      const BEETLE_BOSS_LUNGE_MULT = 2.5;
      const bossLungeRange = BEETLE_LUNGE_RANGE * BEETLE_BOSS_LUNGE_MULT;
      const bossLungeDist  = BEETLE_LUNGE_DIST  * BEETLE_BOSS_LUNGE_MULT;
      mob.lungeTimer=(mob.lungeTimer??BEETLE_LUNGE_COOLDOWN) - dt;

      if(mob.lungeState==='telegraphing'){
        mob.targetFacing=mob.lungeAngle??mob.facing;
        mob.lungeWaitTimer=(mob.lungeWaitTimer??0)-dt;
        if(mob.lungeWaitTimer<=0){
          mob.lungeState='lunging';
          mob.lungeStartX=mob.x; mob.lungeStartY=mob.y;
          const la=mob.lungeAngle??mob.facing;
          mob.lungeDestX=mob.x+Math.cos(la)*bossLungeDist;
          mob.lungeDestY=mob.y+Math.sin(la)*bossLungeDist;
        }
      } else if(mob.lungeState==='lunging'){
        const ldx=mob.lungeDestX-mob.x, ldy=mob.lungeDestY-mob.y, ldist=Math.hypot(ldx,ldy);
        if(ldist<BEETLE_LUNGE_SPEED||ldist<2){
          mob.x=mob.lungeDestX; mob.y=mob.lungeDestY;
          mob.lungeState='idle';
          mob.lungeTimer=BEETLE_LUNGE_COOLDOWN;
        } else {
          const lnx=ldx/ldist, lny=ldy/ldist;
          const lnx2=mob.x+lnx*BEETLE_LUNGE_SPEED, lny2=mob.y+lny*BEETLE_LUNGE_SPEED;
          if(canMoveTo(lnx2,lny2,mob.radius)){mob.x=lnx2;mob.y=lny2;}
          else{mob.lungeState='idle';mob.lungeTimer=BEETLE_LUNGE_COOLDOWN;}
        }
      } else if(mob.lungeTimer<=0 && mob.alerted && dist<=bossLungeRange && dist>0.01){
        mob.lungeState='telegraphing';
        mob.lungeAngle=Math.atan2(dy,dx);
        mob.lungeWaitTimer=BEETLE_LUNGE_TELEGRAPH;
      }

      // Every 22s, spawn 2 beetles at the boss's own rarity — independent of the dash timer
      mob.beetleSpawnTimer = (mob.beetleSpawnTimer ?? 22000) - dt;
      if(mob.beetleSpawnTimer <= 0){
        mob.beetleSpawnTimer = 22000;
        for(let i=0;i<2;i++) spawnAntMinion('beetle', mob.x, mob.y, mob.x, mob.y, mob.homeZoneId, mob.tier);
      }

      // Skip normal movement entirely while telegraphing or lunging, same as boss Soldier Ant
      if(mob.lungeState==='telegraphing'||mob.lungeState==='lunging') continue;
    }

    let newX=mob.x, newY=mob.y;
    if(chasing&&dist>0.01){newX=mob.x+(dx/dist)*mob.speed;newY=mob.y+(dy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      newX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      newY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(newX,newY,mob.radius)){mob.x=newX;mob.y=newY;}
    else if(canMoveTo(newX,mob.y,mob.radius)){mob.x=newX;}
    else if(canMoveTo(mob.x,newY,mob.radius)){mob.y=newY;}
    else if(isWaveMapMode()){const W=getWaveMapW(),H=getWaveMapH(),r=mob.radius;mob.x=Math.max(r,Math.min(W-r,newX));mob.y=Math.max(r,Math.min(H-r,newY));}
    // Trail buffer: records the head's own position for any mob whose body
    // needs to visually/physically follow behind it, like a snake --
    // currently just leech. See TRAIL_MAX_POINTS and the leech
    // capsule-hitbox helpers earlier in this file for how this buffer
    // becomes both the drawn body curve and its hitbox.
    //
    // IMPORTANT: only pushes a new point once the mob has moved at least
    // LEECH_TRAIL_MIN_STEP_MULT * drawRadius since the last recorded point,
    // rather than unconditionally once per tick. A fixed-tick recording rate
    // means the body's real-world LENGTH is driven by movement SPEED, which
    // only scales by sqrt(RADIUS_SCALE[tier]) -- but the body's WIDTH scales
    // by the full RADIUS_SCALE[tier] (it's tied to drawRadius directly). Those
    // two different growth rates meant higher-rarity leeches looked
    // progressively shorter and stubbier relative to their own thickness
    // (verified: length/width ratio dropped from 2.2 at Common to 0.51 at
    // max rarity -- the body was literally wider than it was long by then).
    // Scaling the recording step by drawRadius instead keeps length and
    // width growing at the exact same rate, so the ratio (~2.0) now stays
    // constant across every tier.
    if(mob.typeId==='leech'){
      if(!mob.trail) mob.trail=[];
      const minStep=(mob.drawRadius??mob.radius??20)*LEECH_TRAIL_MIN_STEP_MULT;
      const last=mob.trail[mob.trail.length-1];
      if(!last || Math.hypot(mob.x-last.x, mob.y-last.y)>=minStep){
        mob.trail.push({x:mob.x,y:mob.y});
        if(mob.trail.length>TRAIL_MAX_POINTS) mob.trail.shift();
      }
    }
  }

  // ── Sandstorm AI — drifts around fast; when it has a target it doesn't chase
  // it directly, it keeps drifting near it and every 10 seconds rams:
  // for SANDSTORM_RAM_DURATION it homes in on the target at 1.35× its speed.
  // Shared by hostile sandstorms and friendly pet sandstorms (sandstormMove).
  const SANDSTORM_RAM_SPEED_MULT = 1.35; // ram = 1.35× normal move speed
  const SANDSTORM_RAM_DURATION   = 600;  // ms the ram (and its chase) lasts
  const SANDSTORM_RAM_COOLDOWN   = 10000; // ms between rams (one ram every 10s)
  const SANDSTORM_HOVER_DIST     = 220;  // with a target, drift freely inside this range, get nudged back in outside it
  // Normal movement speed — much faster than the old lazy drift (baseSpeed×0.38)
  const sandstormSpeed = mob => mob.alertSpeed || mob.baseSpeed;
  const steerToward = (mob, angle, amt) => {
    let d = angle - mob.wanderAngle;
    if(d>Math.PI) d-=Math.PI*2; if(d<-Math.PI) d+=Math.PI*2;
    mob.wanderAngle += d * amt;
  };
  /** One tick of sandstorm movement. target: {x,y} or null. leash (optional):
   *  {x, y, dist} — wandering is bent back toward (x,y) beyond dist.
   *  Returns the desired new position; the caller applies slow + walls. */
  function sandstormMove(mob, dt, target, leash = null){
    const spd = sandstormSpeed(mob);
    if(mob.ramTimer > 0) mob.ramTimer -= dt;
    if(target && !mob.isRamming && mob.ramTimer <= 0){
      mob.isRamming = true;
      mob.ramDuration = SANDSTORM_RAM_DURATION;
    }
    if(mob.isRamming){
      mob.ramDuration -= dt;
      if(!target || mob.ramDuration <= 0){
        mob.isRamming = false;
        mob.ramTimer = SANDSTORM_RAM_COOLDOWN;
        mob.ramVx = 0; mob.ramVy = 0;
        mob.driftTimer = 400;
        mob.wanderAngle = mob.facing;
      } else {
        // Ram: chase the target at 1.35× speed for the ram's duration
        const dx = target.x - mob.x, dy = target.y - mob.y, d = Math.hypot(dx, dy) || 1;
        const rs = spd * SANDSTORM_RAM_SPEED_MULT;
        mob.ramVx = (dx / d) * rs; mob.ramVy = (dy / d) * rs;
        mob.targetFacing = Math.atan2(dy, dx);
        return { x: mob.x + mob.ramVx, y: mob.y + mob.ramVy };
      }
    }
    // Drift: fast wander with random direction changes
    mob.driftTimer -= dt;
    if(mob.driftTimer <= 0){
      mob.wanderAngle = Math.random() * Math.PI * 2;
      mob.driftVx = Math.cos(mob.wanderAngle) * (0.3 + Math.random() * 0.5);
      mob.driftVy = Math.sin(mob.wanderAngle) * (0.3 + Math.random() * 0.5);
      mob.driftTimer = (target ? 600 : 1500) + Math.random() * (target ? 900 : 2500);
    }
    // With a target, stay loosely around it instead of heading straight at it
    if(target && Math.hypot(target.x - mob.x, target.y - mob.y) > SANDSTORM_HOVER_DIST){
      steerToward(mob, Math.atan2(target.y - mob.y, target.x - mob.x), 0.06);
    }
    if(leash && Math.hypot(leash.x - mob.x, leash.y - mob.y) > leash.dist){
      steerToward(mob, Math.atan2(leash.y - mob.y, leash.x - mob.x), 0.15);
    }
    mob.targetFacing = mob.wanderAngle;
    return {
      x: mob.x + Math.cos(mob.wanderAngle) * spd + (mob.driftVx || 0) * 0.12,
      y: mob.y + Math.sin(mob.wanderAngle) * spd + (mob.driftVy || 0) * 0.12,
    };
  }
  const SANDSTORM_PELLET_SPEED = 2.5;  // boss pellet speed — about half Centi's pea speed (6)
  const SANDSTORM_PULL_DURATION = 7500; // ms the boss pull effect lasts once triggered (was 2500, +5s)

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead || mob.typeId !== 'sandstorm') continue;

    // Friendly sandstorm pets (Stick petal) are driven entirely by the pet
    // sandstorm block further down, hex spin included (spinning them here too
    // made pets spin twice as fast as a normal sandstorm).
    if(mob.isFriendlyPet) continue;

    // ── Boss Sandstorm: pellet burst (every 12s) + pull (every 30s) ──────────
    // Both timers run regardless of AI_CULL_DIST, since the pull is unlimited
    // range and should trigger even if the boss itself is far off-screen.
    if(mob.isBoss){
      // Pellet burst — 15 shots over ~2s, random directions, half Centi's pea speed
      mob.sandPelletBurstTimer = (mob.sandPelletBurstTimer ?? 12000) - dt;
      if(mob.sandPelletBurstTimer <= 0 && (mob.sandPelletsFired ?? 0) === 0){
        mob.sandPelletsFired = 15;
        mob.sandPelletShotTimer = 0;
      }
      if((mob.sandPelletsFired ?? 0) > 0){
        mob.sandPelletShotTimer -= dt;
        if(mob.sandPelletShotTimer <= 0){
          mob.sandPelletShotTimer = 140; // ~15 shots over ~2.1s
          mob.sandPelletsFired--;
          const t = mob.tier ?? 0;
          const sStats = MOB_STATS.sandstorm;
          const pelletHp  = Math.round(sStats.hp[t] * 0.5);
          const pelletDmg = sStats.dmg[t] * 1.5;
          const pelletR   = Math.max(5, Math.round((mob.drawRadius ?? mob.radius) * 0.32));
          const fireAngle = Math.random() * Math.PI * 2; // fully random direction, unlike Centi's perpendicular-to-facing
          bossPeas.push({
            id: ++_bossStingerNextId,
            x: mob.x, y: mob.y,
            vx: Math.cos(fireAngle) * SANDSTORM_PELLET_SPEED,
            vy: Math.sin(fireAngle) * SANDSTORM_PELLET_SPEED,
            radius: pelletR,
            hp: pelletHp, maxHp: pelletHp,
            damage: pelletDmg,
            lifetime: CENTI_PEA_LIFETIME,
            dead: false,
            fromMobId: mob.id,
            tier: t,
            color: '#ffdc00',
            border: '#d6b700',
            hurtFlash: 0,
          });
          if(mob.sandPelletsFired <= 0) mob.sandPelletBurstTimer = 12000;
        }
      }

      // Pull — every 30s, drags the player and every friendly pet toward the
      // boss for a few seconds. Actual velocity application happens in
      // combat.js (player.vx/vy + pet mob.x/y are updated there each tick);
      // this just owns the timer and the isPulling/pullTimer flag it reads.
      mob.sandstormPullTimer = (mob.sandstormPullTimer ?? 30000) - dt;
      if(mob.sandstormPullTimer <= 0){
        mob.sandstormPullTimer = 30000;
        mob.isPulling = true;
        mob.pullDuration = SANDSTORM_PULL_DURATION;
      }
      if(mob.isPulling){
        mob.pullDuration -= dt;
        if(mob.pullDuration <= 0) mob.isPulling = false;
      }
    }

    const pdist = Math.hypot(playerX - mob.x, playerY - mob.y);
    if(pdist > AI_CULL_DIST) continue;

    // Spin each hex layer every tick — same speed whether wandering or aggroed
    for(let i = 0; i < 3; i++){
      mob.hexRotations[i] = (mob.hexRotations[i] || 0) + mob.hexRotSpeeds[i] * dt;
    }

    // Target selection (player, or NPC in wave mode — whichever is closer)
    let targetX = playerX, targetY = playerY;
    if(isWaveMapMode() && _npcTarget && !_npcTarget.dead){
      const pick = pickWaveTarget(mob, mob.x, mob.y, playerX, playerY);
      targetX = pick.targetX; targetY = pick.targetY; mob.waveTarget = pick.kind;
    }
    const dx = targetX - mob.x, dy = targetY - mob.y;
    const dist = Math.hypot(dx, dy);

    // Aggro detection / de-aggro
    if(!mob.alerted && mob.aggroRange > 0 && dist < mob.aggroRange) mob.alerted = true;
    if(mob.alerted && dist > DEAGGRO_DIST) { mob.alerted = false; mob.wanderAngle = mob.facing; mob.wanderTimer = 800; }

    const step = sandstormMove(mob, dt, mob.alerted ? { x: targetX, y: targetY } : null);
    let newX = step.x, newY = step.y;

    // Smooth facing rotation
    let fDiff = mob.targetFacing - mob.facing;
    if(fDiff > Math.PI) fDiff -= Math.PI * 2;
    if(fDiff < -Math.PI) fDiff += Math.PI * 2;
    mob.facing += fDiff * 0.05;

    const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    if(slowFactor > 0){ newX = mob.x + (newX - mob.x) * (1 - slowFactor); newY = mob.y + (newY - mob.y) * (1 - slowFactor); }

    if(canMoveTo(newX, newY, mob.radius)){ mob.x = newX; mob.y = newY; }
    // Hitting a wall bounces the drift direction so it doesn't grind along it
    else if(canMoveTo(newX, mob.y, mob.radius)){ mob.x = newX; mob.driftVy *= -0.5; if(!mob.isRamming) mob.wanderAngle = -mob.wanderAngle; }
    else if(canMoveTo(mob.x, newY, mob.radius)){ mob.y = newY; mob.driftVx *= -0.5; if(!mob.isRamming) mob.wanderAngle = Math.PI - mob.wanderAngle; }
    else { mob.driftVx = (Math.random() - 0.5) * 1.2; mob.driftVy = (Math.random() - 0.5) * 1.2; mob.driftTimer = 300; if(!mob.isRamming) mob.wanderAngle = Math.random() * Math.PI * 2; }
  }

  // ── Friendly Sandstorm pet AI (Stick petal) ────────────────────────────────
  // Moves exactly like a hostile sandstorm (sandstormMove): drifts around, and
  // with a target in range (a hostile mob the player can see) it hovers near
  // it and rams it every 10 seconds. Stays within a leash of the
  // player so it doesn't wander off entirely. Holding shift
  // (retract) pulls every friendly sandstorm in fast to form a shield around
  // the player, same trigger as normal petal retract.
  const FRIENDLY_SANDSTORM_LEASH = 500;   // wander freely within this radius of the player

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y, isShielding = player.input.defend;
    if(mob.dead||!mob.isFriendlyPet||mob.typeId!=='sandstorm') continue;

    // Spin each hex layer every tick, same as the hostile version
    for(let i = 0; i < 3; i++){
      mob.hexRotations[i] = (mob.hexRotations[i] || 0) + mob.hexRotSpeeds[i] * dt;
    }

    const anchorX = (mob.isNPCPet && _npcTarget && !_npcTarget.dead) ? _npcTarget.x : playerX;
    const anchorY = (mob.isNPCPet && _npcTarget && !_npcTarget.dead) ? _npcTarget.y : playerY;

    // ── Shield mode: rush straight to the player's centre, overriding ram/drift ──
    if(isShielding){
      mob.isRamming = false; mob.ramVx = 0; mob.ramVy = 0; mob.ramTimer = 0;
      const dx = anchorX-mob.x, dy = anchorY-mob.y, dist = Math.hypot(dx,dy);
      let newX = mob.x, newY = mob.y;
      if(dist > 1){
        // Returns at the same pace it moves at normally
        const step = Math.min(dist, sandstormSpeed(mob));
        newX = mob.x + (dx/dist)*step;
        newY = mob.y + (dy/dist)*step;
        mob.targetFacing = Math.atan2(dy,dx);
      }
      let fDiff = mob.targetFacing - mob.facing;
      if(fDiff > Math.PI) fDiff -= Math.PI * 2;
      if(fDiff < -Math.PI) fDiff += Math.PI * 2;
      mob.facing += fDiff * 0.12; // turns a bit snappier than normal while rushing in
      const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
      if(slowFactor > 0){ newX = mob.x + (newX - mob.x) * (1 - slowFactor); newY = mob.y + (newY - mob.y) * (1 - slowFactor); }
      if(canMoveTo(newX, newY, mob.radius)){ mob.x = newX; mob.y = newY; }
      continue;
    }

    // Target: keep the current ram target while it's valid, otherwise the
    // nearest hostile mob inside its aggro range that the player can see —
    // same aggro rules as the hostile sandstorm, just aimed at hostile mobs.
    const canRam = other => !other.dead && other.id!==mob.id && !other.isFriendlyPet &&
      other.typeId!=='digger' && other.typeId!=='beekeeper' &&
      other.typeId!=='ant_egg' && other.typeId!=='spider_egg' && other.typeId!=='fire_ant_egg' &&
      isInPlayerView(player, other.x, other.y, other.radius ?? 0, anchorX, anchorY) &&
      Math.hypot(other.x-mob.x, other.y-mob.y) < (mob.aggroRange || 320);
    let target = mob.petTargetId != null ? mobs.find(m => m.id === mob.petTargetId) : null;
    if(target && !canRam(target)) target = null;
    if(!target){
      let bestDist = Infinity;
      for(const other of mobs){
        if(!canRam(other)) continue;
        const td = Math.hypot(other.x-mob.x, other.y-mob.y);
        if(td < bestDist){ bestDist = td; target = other; }
      }
    }
    mob.petTargetId = target ? target.id : null;
    mob.alerted = !!target;

    const step = sandstormMove(mob, dt, target, { x: anchorX, y: anchorY, dist: FRIENDLY_SANDSTORM_LEASH + petBodySpan(mob, player) });
    let newX = step.x, newY = step.y;

    // Smooth facing rotation
    let fDiff = mob.targetFacing - mob.facing;
    if(fDiff > Math.PI) fDiff -= Math.PI * 2;
    if(fDiff < -Math.PI) fDiff += Math.PI * 2;
    mob.facing += fDiff * 0.05;

    const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    if(slowFactor > 0){ newX = mob.x + (newX - mob.x) * (1 - slowFactor); newY = mob.y + (newY - mob.y) * (1 - slowFactor); }

    if(canMoveTo(newX, newY, mob.radius)){ mob.x = newX; mob.y = newY; }
    // Hitting a wall bounces the drift direction so it doesn't grind along it
    else if(canMoveTo(newX, mob.y, mob.radius)){ mob.x = newX; mob.driftVy *= -0.5; if(!mob.isRamming) mob.wanderAngle = -mob.wanderAngle; }
    else if(canMoveTo(mob.x, newY, mob.radius)){ mob.y = newY; mob.driftVx *= -0.5; if(!mob.isRamming) mob.wanderAngle = Math.PI - mob.wanderAngle; }
    else { mob.driftVx = (Math.random() - 0.5) * 1.2; mob.driftVy = (Math.random() - 0.5) * 1.2; mob.driftTimer = 300; if(!mob.isRamming) mob.wanderAngle = Math.random() * Math.PI * 2; }
  }

  // ── Desert Centipede AI — wanders freely, turns toward target when nearby but never chases ──
  const DESERT_CENTI_TURN_DIST = 280;  // distance at which it starts biasing toward target
  for(const [,chain] of desertCentipedeChains){
    if(chain.mobs.length===0) continue;
    if(!chain.alerted&&chain.mobs.some(m=>m.alerted)){
      chain.alerted=true; for(const m of chain.mobs) m.alerted=true;
    }
    const head=chain.mobs[0];
    if(!head||head.dead) continue;
    const player = targetPlayerFor(head), playerX = player.x, playerY = player.y;

    // ── Boss Desert Centipede: straight-line dash, turns away when it hits a wall ──
    // Completely replaces the normal wander/track-toward-target behavior below —
    // no player-seeking at all, just fast constant travel that avoids walls.
    if(head.isBoss){
      const DESERT_CENTI_BOSS_SPEED_MULT = 2.5;
      if(head.bossDashAngle === undefined) head.bossDashAngle = head.facing;
      const bossSpeed = head.baseSpeed * DESERT_CENTI_BOSS_SPEED_MULT;
      const slowFactorCB = Math.max(getWebSlowdownFactor(head.x, head.y), getPincerSlowFactor(head.id));
      const moveSpeed = bossSpeed * (1 - slowFactorCB);
      const bnx = head.x + Math.cos(head.bossDashAngle) * moveSpeed;
      const bny = head.y + Math.sin(head.bossDashAngle) * moveSpeed;
      if(canMoveTo(bnx, bny, head.radius)){
        head.x = bnx; head.y = bny;
      } else {
        // Blocked — turn to a new direction generally away from the wall it hit,
        // same "roughly-opposite-half" pattern the normal wander fallback uses.
        head.bossDashAngle = head.bossDashAngle + Math.PI * (0.5 + Math.random());
      }
      let bdiff = head.bossDashAngle - head.facing;
      if(bdiff>Math.PI) bdiff-=Math.PI*2; if(bdiff<-Math.PI) bdiff+=Math.PI*2;
      head.facing += bdiff * 0.15;
      head.legPhase = (head.legPhase || 0) + 0.14; // legs scramble faster during the dash

      // Body following — same chain-follow logic as the normal segments below
      for(let i=1;i<chain.mobs.length;i++){
        const seg=chain.mobs[i], parent=chain.mobs[i-1];
        if(!seg||seg.dead||!parent||parent.dead) continue;
        const ddx=parent.x-seg.x, ddy=parent.y-seg.y, ddist=Math.hypot(ddx,ddy);
        const desired=(parent.radius+seg.radius)*1.05;
        if(ddist>desired&&ddist>0.001){
          const excess=ddist-desired;
          const nx=ddx/ddist, ny=ddy/ddist;
          const tx=seg.x+nx*excess, ty=seg.y+ny*excess;
          if(canMoveTo(tx,ty,seg.radius)){ seg.x=tx; seg.y=ty; }
          else if(canMoveTo(tx,seg.y,seg.radius)){ seg.x=tx; }
          else if(canMoveTo(seg.x,ty,seg.radius)){ seg.y=ty; }
        }
        seg.facing=Math.atan2(parent.y-seg.y,parent.x-seg.x);
        seg.legPhase=head.legPhase;
      }
      continue;
    }

    let targetX=playerX,targetY=playerY;
    let targetDist=Math.hypot(playerX-head.x,playerY-head.y);
    for(const dg of diggers){const dd=Math.hypot(dg.x-head.x,dg.y-head.y);if(dd<targetDist){targetX=dg.x;targetY=dg.y;targetDist=dd;}}

    const dx=targetX-head.x, dy=targetY-head.y, dist=Math.hypot(dx,dy);

    // Aggro / de-aggro
    if(!chain.alerted && head.aggroRange>0 && dist<head.aggroRange){
      chain.alerted=true; for(const m of chain.mobs) m.alerted=true;
    }
    if(chain.alerted && dist>DEAGGRO_DIST){
      chain.alerted=false; for(const m of chain.mobs){ m.alerted=false; m.wanderAngle=m.facing; m.wanderTimer=800; }
    }

    if(targetDist<=AI_CULL_DIST){
      const MAX_TURN=2.7;
      head.wanderTimer-=dt;
      if(head.wanderTimer<=0){
        const turn=(Math.random()-0.5)*Math.PI*0.9;
        head.wanderAngle=head.facing+turn;
        head.wanderTimer=1200+Math.random()*2500;
      }

      // When near target, blend wander angle toward target direction
      if(chain.alerted && dist < DESERT_CENTI_TURN_DIST && dist > 0.01){
        const toTarget=Math.atan2(dy,dx);
        let angleDiff=toTarget-head.wanderAngle;
        if(angleDiff>Math.PI) angleDiff-=Math.PI*2;
        if(angleDiff<-Math.PI) angleDiff+=Math.PI*2;
        // Blend strength increases as it gets closer
        const blend=0.3*(1-(dist/DESERT_CENTI_TURN_DIST));
        head.wanderAngle+=angleDiff*blend;
      }

      let wantFacing=head.wanderAngle;
      let tdiff=wantFacing-head.facing;
      if(tdiff>Math.PI) tdiff-=Math.PI*2; if(tdiff<-Math.PI) tdiff+=Math.PI*2;
      tdiff=Math.max(-MAX_TURN,Math.min(MAX_TURN,tdiff));
      head.targetFacing=head.facing+tdiff;

      const slowFactorC = Math.max(getWebSlowdownFactor(head.x, head.y), getPincerSlowFactor(head.id));
      head.speed=head.baseSpeed*(1-slowFactorC);

      let newX=head.x+Math.cos(head.targetFacing)*head.speed*0.55;
      let newY=head.y+Math.sin(head.targetFacing)*head.speed*0.55;

      if(canMoveTo(newX,newY,head.radius)){ head.x=newX; head.y=newY; }
      else { head.wanderAngle=head.facing+Math.PI*(0.5+Math.random()); head.wanderTimer=600+Math.random()*800; }

      let diff=head.targetFacing-head.facing;
      if(diff>Math.PI) diff-=Math.PI*2; if(diff<-Math.PI) diff+=Math.PI*2;
      head.facing+=diff*0.08;
      head.legPhase=(head.legPhase||0)+0.08;

      // Body following
      for(let i=1;i<chain.mobs.length;i++){
        const seg=chain.mobs[i], parent=chain.mobs[i-1];
        if(!seg||seg.dead||!parent||parent.dead) continue;
        const ddx=parent.x-seg.x, ddy=parent.y-seg.y, ddist=Math.hypot(ddx,ddy);
        const desired=(parent.radius+seg.radius)*1.05;
        if(ddist>desired&&ddist>0.001){
          const excess=ddist-desired;
          const nx=ddx/ddist, ny=ddy/ddist;
          const tx=seg.x+nx*excess, ty=seg.y+ny*excess;
          if(canMoveTo(tx,ty,seg.radius)){ seg.x=tx; seg.y=ty; }
          else if(canMoveTo(tx,seg.y,seg.radius)){ seg.x=tx; }
          else if(canMoveTo(seg.x,ty,seg.radius)){ seg.y=ty; }
        }
        const segFacing=Math.atan2(parent.y-seg.y,parent.x-seg.x);
        seg.facing=segFacing;
        seg.legPhase=head.legPhase;
      }
    }
  }

  // ── Desert Centipede: drop segments that despawned (streamed out) ──
  // Segments that were KILLED stay in the chain until onMobDied runs at the end
  // of this tick — handleDesertCentipedeSegmentDeath needs to find them there
  // to promote a new head or split the chain in two (same as Centipede).
  for(const [chainId,chain] of desertCentipedeChains){
    chain.mobs=chain.mobs.filter(m=>!(m.dead&&m._streamedOut));
    if(chain.mobs.length===0) desertCentipedeChains.delete(chainId);
  }

  // Digger AI — friendly to player, targets nearest hostile mob
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='digger'||mob.isFriendlyPet) continue;
    const pdist=Math.hypot(playerX-mob.x,playerY-mob.y);
    if(pdist>AI_CULL_DIST) continue;

    const DIGGER_LEASH = getPetLeashDist(mob.tier) + petBodySpan(mob, player);
    const DIGGER_LEASH_GRACE = DIGGER_LEASH * 1.35;

    // Leash return — overrides everything else if too far from player
    if(pdist > DIGGER_LEASH_GRACE){
      mob.alerted=false;
      const ldx=playerX-mob.x, ldy=playerY-mob.y;
      mob.targetFacing=Math.atan2(ldy,ldx);
      const overleash=Math.min((pdist-DIGGER_LEASH_GRACE)/300,1);
      mob.speed=mob.baseSpeed+(mob.alertSpeed-mob.baseSpeed)*overleash;
      const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
      mob.speed*=(1-slowFactor);
      const excess=pdist-DIGGER_LEASH;
      const step=Math.min(mob.speed,excess);
      const lnx=mob.x+(ldx/pdist)*step, lny=mob.y+(ldy/pdist)*step;
      if(canMoveTo(lnx,lny,mob.radius)){mob.x=lnx;mob.y=lny;}
      mob.eyeAngle=mob.targetFacing;
      const targetPdxL=Math.cos(mob.eyeAngle)*mob.drawRadius*0.09;
      const targetPdyL=Math.sin(mob.eyeAngle)*mob.drawRadius*0.09;
      mob.animPdx=mob.animPdx*0.85+targetPdxL*0.15;
      mob.animPdy=mob.animPdy*0.85+targetPdyL*0.15;
      mob.state='neutral';
      const targetBrowTL=0;
      mob.browT=(mob.browT??0)*0.88+targetBrowTL*0.12;
      const drL=mob.drawRadius;
      mob.animCpOffset=mob.animCpOffset*0.85+(drL*0.14)*0.15;
      mob.cutterRot=(mob.cutterRot||0)+0.03;
      continue;
    }

    // Find nearest non-digger, non-egg mob to chase
    let target=null, targetDist=Infinity;
    for(const other of mobs){
      if(other.dead||other.id===mob.id||other.typeId==='digger'||other.typeId==='beekeeper'||other.typeId==='ant_egg'||other.typeId==='spider_egg'||other.isFriendlyPet) continue;
      const td=Math.hypot(other.x-mob.x,other.y-mob.y);
      if(td<targetDist){targetDist=td;target=other;}
    }

    let chasing=false;
    let tdx=0,tdy=0,dist=0;
    if(target&&targetDist<mob.aggroRange){
      tdx=target.x-mob.x; tdy=target.y-mob.y; dist=targetDist;
      chasing=true; mob.alerted=true; mob.speed=mob.alertSpeed||mob.baseSpeed;
    } else if(mob.alerted&&(!target||targetDist>DEAGGRO_DIST)){
      mob.alerted=false; mob.wanderAngle=mob.facing; mob.wanderTimer=800; mob.state='neutral';
      mob.speed=mob.baseSpeed;
    } else {
      mob.speed=mob.baseSpeed;
    }
    
    // Apply web slowdown
    const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactor);
    
    mob.targetFacing=chasing?Math.atan2(tdy,tdx):mob.wanderAngle;

    // Eye tracking follows movement direction
    const moveX=chasing?tdx/(dist||1):Math.cos(mob.wanderAngle);
    const moveY=chasing?tdy/(dist||1):Math.sin(mob.wanderAngle);
    if(moveX!==0||moveY!==0) mob.eyeAngle=Math.atan2(moveY,moveX);

    // Smooth eye animation
    const targetPdx=Math.cos(mob.eyeAngle)*mob.drawRadius*0.09;
    const targetPdy=Math.sin(mob.eyeAngle)*mob.drawRadius*0.09;
    mob.animPdx=mob.animPdx*0.85+targetPdx*0.15;
    mob.animPdy=mob.animPdy*0.85+targetPdy*0.15;

    // State based on HP + chasing
    const hpPct=mob.hp/mob.maxHp;
    if(hpPct<0.3){ mob.state='sad'; }
    else if(chasing){ mob.state='angry'; }
    else { mob.state='neutral'; }

    // Animate eyebrows (browT: 0=hidden → 1=angry)
    const targetBrowT=mob.state==='angry'?1:0;
    mob.browT=(mob.browT??0)*0.88+targetBrowT*0.12;

    // Smooth mouth animation
    const dr=mob.drawRadius;
    const targetCpOffset=mob.state==='angry'?-dr*0.20:mob.state==='sad'?-dr*0.13:dr*0.14;
    mob.animCpOffset=mob.animCpOffset*0.85+targetCpOffset*0.15;

    // Cutter rotation — faster when chasing
    mob.cutterRot=(mob.cutterRot||0)+(chasing?0.08:0.03);

    let newX=mob.x, newY=mob.y;
    if(chasing&&dist>0.01){newX=mob.x+(tdx/dist)*mob.speed;newY=mob.y+(tdy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      // Soft drift back toward player when outside leash ring
      if(pdist>DIGGER_LEASH){
        const excess=pdist-DIGGER_LEASH;
        const toPlayerAngle=Math.atan2(playerY-mob.y,playerX-mob.x);
        let aDiff=toPlayerAngle-mob.wanderAngle;
        if(aDiff>Math.PI) aDiff-=Math.PI*2; if(aDiff<-Math.PI) aDiff+=Math.PI*2;
        mob.wanderAngle+=aDiff*(0.08+0.12*Math.min(excess/300,1));
      }
      newX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      newY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(newX,newY,mob.radius)){mob.x=newX;mob.y=newY;}
    else if(canMoveTo(newX,mob.y,mob.radius)){mob.x=newX;}
    else if(canMoveTo(mob.x,newY,mob.radius)){mob.y=newY;}
    else if(isWaveMapMode()){const W=getWaveMapW(),H=getWaveMapH(),r=mob.radius;mob.x=Math.max(r,Math.min(W-r,newX));mob.y=Math.max(r,Math.min(H-r,newY));}
  }

  // Beekeeper AI — friendly to player, targets nearest hostile mob (like digger)
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='beekeeper') continue;
    const pdist=Math.hypot(playerX-mob.x,playerY-mob.y);
    if(pdist>AI_CULL_DIST) continue;

    // Find nearest non-beekeeper, non-egg mob to chase
    let target=null, targetDist=Infinity;
    for(const other of mobs){
      if(other.dead||other.id===mob.id||other.typeId==='beekeeper'||other.typeId==='digger'||other.typeId==='ant_egg'||other.typeId==='spider_egg'||other.isFriendlyPet) continue;
      const td=Math.hypot(other.x-mob.x,other.y-mob.y);
      if(td<targetDist){targetDist=td;target=other;}
    }

    let chasing=false;
    let tdx=0,tdy=0,dist=0;
    if(target&&targetDist<mob.aggroRange){
      tdx=target.x-mob.x; tdy=target.y-mob.y; dist=targetDist;
      chasing=true; mob.alerted=true; mob.speed=mob.alertSpeed||mob.baseSpeed;
    } else if(mob.alerted&&(!target||targetDist>DEAGGRO_DIST)){
      mob.alerted=false; mob.wanderAngle=mob.facing; mob.wanderTimer=800; mob.state='neutral';
      mob.speed=mob.baseSpeed;
    } else {
      mob.speed=mob.baseSpeed;
    }
    
    // Apply web slowdown
    const slowFactorBK = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactorBK);
    
    mob.targetFacing=chasing?Math.atan2(tdy,tdx):mob.wanderAngle;

    // Eye tracking follows movement direction
    const moveX=chasing?tdx/(dist||1):Math.cos(mob.wanderAngle);
    const moveY=chasing?tdy/(dist||1):Math.sin(mob.wanderAngle);
    if(moveX!==0||moveY!==0) mob.eyeAngle=Math.atan2(moveY,moveX);

    // Smooth eye animation (pupils drift to edges — 0.15 lets them reach iris edge)
    const targetPdx=Math.cos(mob.eyeAngle)*mob.drawRadius*0.15;
    const targetPdy=Math.sin(mob.eyeAngle)*mob.drawRadius*0.15;
    mob.animPdx=mob.animPdx*0.85+targetPdx*0.15;
    mob.animPdy=mob.animPdy*0.85+targetPdy*0.15;
    const hpPct=mob.hp/mob.maxHp;
    if(hpPct<0.3){ mob.state='sad'; }
    else if(chasing){ mob.state='angry'; }
    else { mob.state='neutral'; }

    // Mouth animation (browT: 0=neutral → 1=frown/angry)
    const targetBrowT=mob.state==='angry'?1:0;
    mob.browT=(mob.browT??0)*0.88+targetBrowT*0.12;

    // Cutter rotation — faster when chasing
    mob.cutterRot=(mob.cutterRot||0)+(chasing?0.08:0.03);

    let newX=mob.x, newY=mob.y;
    if(chasing&&dist>0.01){newX=mob.x+(tdx/dist)*mob.speed;newY=mob.y+(tdy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      newX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      newY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(newX,newY,mob.radius)){mob.x=newX;mob.y=newY;}
    else if(canMoveTo(newX,mob.y,mob.radius)){mob.x=newX;}
    else if(canMoveTo(mob.x,newY,mob.radius)){mob.y=newY;}
    else if(isWaveMapMode()){const W=getWaveMapW(),H=getWaveMapH(),r=mob.radius;mob.x=Math.max(r,Math.min(W-r,newX));mob.y=Math.max(r,Math.min(H-r,newY));}
  }

  // ── Queen Bee AI — hostile to player/beekeeper, heals nearby friendly swarm ──
  // Friendly swarm = bee, hornet, queen_bee (they won't be attacked by her either)
  const QUEEN_BEE_HEAL_INTERVAL = 500; // ms between heal ticks
  const BEE_FRIENDLY_TYPES = new Set(['bee','hornet','queen_bee']);
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='queen_bee') continue;
    const pdist=Math.hypot(playerX-mob.x,playerY-mob.y);
    if(pdist>AI_CULL_DIST) continue;

    // Target: player or beekeeper/digger (whichever is closest)
    let targetX=playerX,targetY=playerY;
    let tDist2q=pdist;
    for(const dg of diggers){const dd=Math.hypot(dg.x-mob.x,dg.y-mob.y);if(dd<tDist2q){targetX=dg.x;targetY=dg.y;tDist2q=dd;}}
    const dx=targetX-mob.x,dy=targetY-mob.y,dist=Math.hypot(dx,dy);

    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}
    let chasing=false;
    if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed;}
    else if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed;}
    else mob.speed=mob.baseSpeed;
    
    // Apply web slowdown
    const slowFactorQ = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactorQ);
    
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;

    let nqX=mob.x,nqY=mob.y;
    if(chasing&&dist>0.01){nqX=mob.x+(dx/dist)*mob.speed;nqY=mob.y+(dy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      nqX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      nqY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(nqX,nqY,mob.radius)){mob.x=nqX;mob.y=nqY;}
    else if(canMoveTo(nqX,mob.y,mob.radius)){mob.x=nqX;}
    else if(canMoveTo(mob.x,nqY,mob.radius)){mob.y=nqY;}
    else if(isWaveMapMode()){const W=getWaveMapW(),H=getWaveMapH(),r=mob.radius;mob.x=Math.max(r,Math.min(W-r,nqX));mob.y=Math.max(r,Math.min(H-r,nqY));}

    // Heal aura: every tick heal nearby friendly swarm mobs
    mob.healTimer=(mob.healTimer??0)-dt;
    if(mob.healTimer<=0){
      mob.healTimer=QUEEN_BEE_HEAL_INTERVAL;
      const healAmt=30*(MOB_STATS.queen_bee.dmg[mob.tier??0]/80)*(QUEEN_BEE_HEAL_INTERVAL/1000);
      for(const other of mobs){
        if(other.dead||other.id===mob.id) continue;
        if(!BEE_FRIENDLY_TYPES.has(other.typeId)) continue;
        const hd=Math.hypot(other.x-mob.x,other.y-mob.y);
        if(hd<mob.aggroRange){
          other.hp=Math.min(other.maxHp,other.hp+healAmt);
        }
      }
    }

    // ── Boss Queen Bee abilities ────────────────────────────────────────────
    if(mob.isBoss){
      // ── Egg laying every 5s ──────────────────────────────────────────────
      if(mob.queenBeeEggTimer === undefined){ mob.queenBeeEggTimer = 5000; mob.queenBeeEggCount = 0; }
      mob.queenBeeEggTimer -= dt;
      if(mob.queenBeeEggTimer <= 0){
        mob.queenBeeEggTimer = 5000;
        mob.queenBeeEggCount = (mob.queenBeeEggCount ?? 0) + 1;
        const isHornetEgg = (mob.queenBeeEggCount % 5 === 0);
        const eggAngle = Math.random() * Math.PI * 2;
        const dr = mob.drawRadius ?? mob.radius;
        const eggR = Math.max(10, Math.round(dr * 0.45));
        const ex = mob.x + Math.cos(eggAngle) * dr * 1.3;
        const ey = mob.y + Math.sin(eggAngle) * dr * 1.3;
        queenBeeEggs.push({
          id: ++_bossStingerNextId,
          x: ex, y: ey,
          radius: eggR,
          hatchTimer: 3000,
          tier: mob.tier ?? 0,
          isHornetEgg,
          ownerId: mob.id,
          dead: false,
          spawnTimer: 0,
        });
      }

      // ── Pollen spin + launch every 20s ───────────────────────────────────
      if(mob.queenBeePollenCooldown === undefined) mob.queenBeePollenCooldown = 20000;
      if(mob.queenBeePollenState === undefined)    mob.queenBeePollenState = 'idle';

      if(mob.queenBeePollenState === 'idle'){
        mob.queenBeePollenCooldown -= dt;
        if(mob.queenBeePollenCooldown <= 0 && mob.alerted){
          mob.queenBeePollenState = 'shake';
          mob.queenBeeShakeTimer = 600;
          mob.queenBeeShakeAmp = 0;
          for(let i=0;i<3;i++){
            queenBeePollenOrbit.push({
              id: ++_bossStingerNextId,
              ownerId: mob.id,
              orbitAngle: (Math.PI * 2 / 3) * i,
              orbitR: (mob.drawRadius ?? mob.radius) * 2.0,
              queenDrawRadius: mob.drawRadius ?? mob.radius, // for scaled rendering
              spinTimer: 5000,
              launched: false,
              x: mob.x, y: mob.y,
              vx: 0, vy: 0,
              dead: false,
            });
          }
        }
      } else if(mob.queenBeePollenState === 'shake'){
        mob.queenBeeShakeTimer -= dt;
        const t01 = 1 - mob.queenBeeShakeTimer / 600;
        mob.queenBeeShakeAmp = Math.sin(t01 * Math.PI) * 4;
        mob.queenBeeShakeOffset = (Math.random() - 0.5) * mob.queenBeeShakeAmp * 2;
        if(mob.queenBeeShakeTimer <= 0){
          mob.queenBeePollenState = 'spinning';
          mob.queenBeeShakeAmp = 0;
        }
      } else if(mob.queenBeePollenState === 'spinning'){
        const hasOrbit = queenBeePollenOrbit.some(p => !p.dead && p.ownerId === mob.id && !p.launched);
        if(!hasOrbit){
          mob.queenBeePollenState = 'idle';
          mob.queenBeePollenCooldown = 20000;
        }
      }
    }
  }

  // ── Ant AI ────────────────────────────────────────────────────────────────
  // Home radius scales with tier and mob size so ants always have room to roam
  function getAntHomeRadius(tier) {
    const scale = RADIUS_SCALE[tier ?? 0] ?? 1;
    return Math.max(500, (350 + (tier ?? 0) * 80) * Math.sqrt(scale));
  }

  // Ant hole: damage milestone check
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='ant_hole') continue;
    // Suppress overworld milestone spawns while the player is fighting inside this hole
    if(mob.interiorActive) continue;
    if(mob.nextMilestoneHp>0 && mob.hp<=mob.nextMilestoneHp){
      if(mob.isBoss){
        // Boss ant hole: every 25% HP loss → 2 boss soldier ants + 1 boss worker ant (all wave-tracked)
        mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.25);
        if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
        for(let i=0;i<2;i++){
          const bs=spawnAntMinion('soldier_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
          if(bs){ _applyBossStatsToMob(bs); if(isWaveMapMode()){ bs.waveTarget='npc'; bs.alerted=true; addTrackedMob(bs.id); } }
        }
        const bw=spawnAntMinion('worker_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
        if(bw){ _applyBossStatsToMob(bw); if(isWaveMapMode()){ bw.waveTarget='npc'; bw.alerted=true; addTrackedMob(bw.id); } }
      } else {
        // Normal ant hole: spawn 3 soldiers every 15% HP lost
        mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.15);
        if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
        for(let i=0;i<3;i++){
          const ms=spawnAntMinion('soldier_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
          if(ms&&isWaveMapMode()){ ms.waveTarget='npc'; ms.alerted=true; addTrackedMob(ms.id); }
        }
      }
    }
  }

  // Fire ant hole: damage milestone check
  for(const mob of mobs){
    if(mob.dead||!mob.isFireAntHole) continue;
    if(mob.nextMilestoneHp>0 && mob.hp<=mob.nextMilestoneHp){
      if(mob.isBoss){
        // Boss fire ant hole: every 25% HP loss → 2 boss fire soldiers + 1 boss fire worker (same escalation as boss ant hole)
        mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.25);
        if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
        for(let i=0;i<2;i++){
          const bs=spawnFireAntMinion('fire_soldier_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
          if(bs){ _applyBossStatsToMob(bs); if(isWaveMapMode()){ bs.waveTarget='npc'; bs.alerted=true; addTrackedMob(bs.id); } }
        }
        const bw=spawnFireAntMinion('fire_worker_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
        if(bw){ _applyBossStatsToMob(bw); if(isWaveMapMode()){ bw.waveTarget='npc'; bw.alerted=true; addTrackedMob(bw.id); } }
      } else {
        // Normal fire ant hole: spawn 3 fire soldiers every 15% HP lost
        mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.15);
        if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
        for(let i=0;i<3;i++){
          const ms=spawnFireAntMinion('fire_soldier_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
          if(ms&&isWaveMapMode()){ ms.waveTarget='npc'; ms.alerted=true; addTrackedMob(ms.id); }
        }
      }
    }
  }

  // Boss baby ant: every 25% HP lost → spawn 1 boss queen ant at same tier
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='baby_ant'||!mob.isBoss) continue;
    if(mob.nextMilestoneHp>0 && mob.hp<=mob.nextMilestoneHp){
      mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.25);
      if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
      const t = mob.tier??0;
      const q = spawnAntMinion('queen_ant',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId??-1,t);
      if(q){ _applyBossStatsToMob(q); if(isWaveMapMode()){ q.waveTarget='npc'; q.alerted=true; addTrackedMob(q.id); } }
    }
  }

  // Pyramid: damage milestone check — spawn 2 beetles + 1 scorpion every 15% HP lost
  for(const mob of mobs){
    if(mob.dead||!mob.isPyramid) continue;
    if(mob.nextMilestoneHp>0 && mob.hp<=mob.nextMilestoneHp){
      mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.15);
      if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
      for(let i=0;i<2;i++){
        const mb=spawnAntMinion('beetle',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
        if(mb&&isWaveMapMode()){ mb.waveTarget='npc'; mb.alerted=true; addTrackedMob(mb.id); }
      }
      const ms=spawnAntMinion('scorpion',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
      if(ms&&isWaveMapMode()){ ms.waveTarget='npc'; ms.alerted=true; addTrackedMob(ms.id); }
    }
  }

  // Beehive: damage milestone check — spawn 2 bees + 1 hornet every 15% HP lost (normal), or 1 boss bee + 1 boss hornet every 25% HP loss (boss)
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='beehive') continue;
    if(mob.nextMilestoneHp>0 && mob.hp<=mob.nextMilestoneHp){
      if(mob.isBoss) {
        // Boss beehive: every 25% HP loss spawns 1 boss bee and 1 boss hornet at its level
        mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.25);
        if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
        const bossBee = spawnAntMinion('bee',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
        const bossHornet = spawnAntMinion('hornet',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
        if(bossBee) _applyBossStatsToMob(bossBee);
        if(bossHornet) _applyBossStatsToMob(bossHornet);
        // Add to wave tracking if in wave mode
        if(isWaveMapMode()) {
          if(bossBee) { bossBee.waveTarget = 'npc'; bossBee.alerted = true; addTrackedMob(bossBee.id); }
          if(bossHornet) { bossHornet.waveTarget = 'npc'; bossHornet.alerted = true; addTrackedMob(bossHornet.id); }
        }
      } else {
        // Normal beehive: spawn 2 bees + 1 hornet every 15% HP lost
        mob.nextMilestoneHp=Math.round(mob.nextMilestoneHp - mob.maxHp*0.15);
        if(mob.nextMilestoneHp<0) mob.nextMilestoneHp=0;
        for(let i=0;i<2;i++){
          const mb=spawnAntMinion('bee',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
          if(mb&&isWaveMapMode()){ mb.waveTarget='npc'; mb.alerted=true; addTrackedMob(mb.id); }
        }
        const mh=spawnAntMinion('hornet',mob.x,mob.y,mob.x,mob.y,mob.homeZoneId,mob.tier);
        if(mh&&isWaveMapMode()){ mh.waveTarget='npc'; mh.alerted=true; addTrackedMob(mh.id); }
      }
    }
  }

  // Baby ant — always passive, slow wandering, idles a lot
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||(mob.typeId!=='baby_ant'&&mob.typeId!=='fire_baby_ant')) continue;
    const dx=playerX-mob.x,dy=playerY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    mob.alerted=false;
    mob.wanderTimer-=dt;
    if(mob.wanderTimer<=0){
      mob.wanderAngle=Math.random()*Math.PI*2;
      mob.wanderTimer=2500+Math.random()*4500;
    }
    if(mob.homeX!==undefined){
      const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
      if(Math.hypot(hdx,hdy)>getAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
    }
    mob.targetFacing=mob.wanderAngle;
    // Apply web slowdown to baby ant
    const slowFactorBaby = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    const slowBabySpeed = mob.speed * (1 - slowFactorBaby);
    const nbX=mob.x+Math.cos(mob.wanderAngle)*slowBabySpeed*0.35;
    const nbY=mob.y+Math.sin(mob.wanderAngle)*slowBabySpeed*0.35;
    if(canMoveTo(nbX,nbY,mob.radius)){mob.x=nbX;mob.y=nbY;}
    else if(canMoveTo(nbX,mob.y,mob.radius)){mob.x=nbX;}
    else if(canMoveTo(mob.x,nbY,mob.radius)){mob.y=nbY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // Soldier / worker ant lunge constants (shared by both mob types)
  const SOLDIER_LUNGE_COOLDOWN  = 15000; // ms between lunge attempts
  const SOLDIER_LUNGE_RANGE     = 600;   // max dist to trigger lunge (normal)
  const SOLDIER_LUNGE_DIST      = 300;   // how far the lunge travels (normal)
  const SOLDIER_LUNGE_TELEGRAPH = 700;   // ms pause before launching
  const SOLDIER_LUNGE_SPEED     = 28;    // px/frame equivalent (applied per-frame)
  const BOSS_LUNGE_MULT         = 2.5;   // boss versions trigger from & travel 2.5x further

  // Worker ant — passive until hit, then chases + boss lunge (same as soldier)
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='worker_ant') continue;
    let targetX=playerX,targetY=playerY;
    let tDist2w=Math.hypot(playerX-mob.x,playerY-mob.y);
    for(const dg of diggers){const dd=Math.hypot(dg.x-mob.x,dg.y-mob.y);if(dd<tDist2w){targetX=dg.x;targetY=dg.y;tDist2w=dd;}}
    const dx=targetX-mob.x,dy=targetY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}
    let chasing=false;
    if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed;}else mob.speed=mob.baseSpeed;

    // ── Boss lunge ability (same as soldier ant; 2.5x trigger range & travel distance) ──
    if(mob.isBoss){
      const bossLungeRange = SOLDIER_LUNGE_RANGE * BOSS_LUNGE_MULT;
      const bossLungeDist  = SOLDIER_LUNGE_DIST  * BOSS_LUNGE_MULT;
      mob.lungeTimer=(mob.lungeTimer??SOLDIER_LUNGE_COOLDOWN) - dt;

      if(mob.lungeState==='telegraphing'){
        mob.targetFacing=mob.lungeAngle??mob.facing;
        mob.lungeWaitTimer=(mob.lungeWaitTimer??0)-dt;
        if(mob.lungeWaitTimer<=0){
          mob.lungeState='lunging';
          mob.lungeStartX=mob.x; mob.lungeStartY=mob.y;
          const la=mob.lungeAngle??mob.facing;
          mob.lungeDestX=mob.x+Math.cos(la)*bossLungeDist;
          mob.lungeDestY=mob.y+Math.sin(la)*bossLungeDist;
        }
        continue;
      }

      if(mob.lungeState==='lunging'){
        const ldx=mob.lungeDestX-mob.x, ldy=mob.lungeDestY-mob.y, ldist=Math.hypot(ldx,ldy);
        if(ldist<SOLDIER_LUNGE_SPEED||ldist<2){
          mob.x=mob.lungeDestX; mob.y=mob.lungeDestY;
          mob.lungeState='idle';
          mob.lungeTimer=SOLDIER_LUNGE_COOLDOWN;
        } else {
          const nx=ldx/ldist, ny=ldy/ldist;
          const nx2=mob.x+nx*SOLDIER_LUNGE_SPEED, ny2=mob.y+ny*SOLDIER_LUNGE_SPEED;
          if(canMoveTo(nx2,ny2,mob.radius)){mob.x=nx2;mob.y=ny2;}
          else{mob.lungeState='idle';mob.lungeTimer=SOLDIER_LUNGE_COOLDOWN;}
        }
        continue;
      }

      if(mob.lungeTimer<=0 && mob.alerted && dist<=bossLungeRange && dist>0.01){
        mob.lungeState='telegraphing';
        mob.lungeAngle=Math.atan2(dy,dx);
        mob.lungeWaitTimer=SOLDIER_LUNGE_TELEGRAPH;
      }
    }
    // ─────────────────────────────────────────────────────────────────────
    
    // Apply web slowdown
    const slowFactorW = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactorW);
    
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    let nwX=mob.x,nwY=mob.y;
    if(chasing&&dist>0.01){nwX=mob.x+(dx/dist)*mob.speed;nwY=mob.y+(dy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      if(mob.homeX!==undefined){
        const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
        if(Math.hypot(hdx,hdy)>getAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
      }
      nwX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      nwY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(nwX,nwY,mob.radius)){mob.x=nwX;mob.y=nwY;}
    else if(canMoveTo(nwX,mob.y,mob.radius)){mob.x=nwX;}
    else if(canMoveTo(mob.x,nwY,mob.radius)){mob.y=nwY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // Soldier ant — aggros at range
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='soldier_ant'||mob.isFriendlyPet) continue;
    let targetX=playerX,targetY=playerY;
    let tDist2s=Math.hypot(playerX-mob.x,playerY-mob.y);
    for(const dg of diggers){const dd=Math.hypot(dg.x-mob.x,dg.y-mob.y);if(dd<tDist2s){targetX=dg.x;targetY=dg.y;tDist2s=dd;}}
    const dx=targetX-mob.x,dy=targetY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}
    let chasing=false;
    if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else mob.speed=mob.baseSpeed;

    // ── Boss lunge ability (2.5x trigger range & travel distance) ────────
    if(mob.isBoss){
      const bossLungeRange = SOLDIER_LUNGE_RANGE * BOSS_LUNGE_MULT;
      const bossLungeDist  = SOLDIER_LUNGE_DIST  * BOSS_LUNGE_MULT;
      mob.lungeTimer=(mob.lungeTimer??SOLDIER_LUNGE_COOLDOWN) - dt;

      if(mob.lungeState==='telegraphing'){
        // Freeze in place during telegraph, face target
        mob.targetFacing=mob.lungeAngle??mob.facing;
        mob.lungeWaitTimer=(mob.lungeWaitTimer??0)-dt;
        if(mob.lungeWaitTimer<=0){
          mob.lungeState='lunging';
          // Lock in launch origin and destination
          mob.lungeStartX=mob.x; mob.lungeStartY=mob.y;
          const la=mob.lungeAngle??mob.facing;
          mob.lungeDestX=mob.x+Math.cos(la)*bossLungeDist;
          mob.lungeDestY=mob.y+Math.sin(la)*bossLungeDist;
        }
        continue; // skip normal movement this tick
      }

      if(mob.lungeState==='lunging'){
        // Rocket toward destination
        const ldx=mob.lungeDestX-mob.x, ldy=mob.lungeDestY-mob.y, ldist=Math.hypot(ldx,ldy);
        if(ldist<SOLDIER_LUNGE_SPEED||ldist<2){
          // Arrived — snap and end lunge
          mob.x=mob.lungeDestX; mob.y=mob.lungeDestY;
          mob.lungeState='idle';
          mob.lungeTimer=SOLDIER_LUNGE_COOLDOWN;
        } else {
          const nx=ldx/ldist, ny=ldy/ldist;
          const nx2=mob.x+nx*SOLDIER_LUNGE_SPEED, ny2=mob.y+ny*SOLDIER_LUNGE_SPEED;
          if(canMoveTo(nx2,ny2,mob.radius)){mob.x=nx2;mob.y=ny2;}
          else{mob.lungeState='idle';mob.lungeTimer=SOLDIER_LUNGE_COOLDOWN;}
        }
        continue; // skip normal movement this tick
      }

      // Ready to lunge?
      if(mob.lungeTimer<=0 && mob.alerted && dist<=bossLungeRange && dist>0.01){
        mob.lungeState='telegraphing';
        mob.lungeAngle=Math.atan2(dy,dx);
        mob.lungeWaitTimer=SOLDIER_LUNGE_TELEGRAPH;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Apply web slowdown
    const slowFactorS = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactorS);

    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    let nsX=mob.x,nsY=mob.y;
    if(chasing&&dist>0.01){nsX=mob.x+(dx/dist)*mob.speed;nsY=mob.y+(dy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      if(mob.homeX!==undefined){
        const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
        if(Math.hypot(hdx,hdy)>getAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
      }
      nsX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      nsY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(nsX,nsY,mob.radius)){mob.x=nsX;mob.y=nsY;}
    else if(canMoveTo(nsX,mob.y,mob.radius)){mob.x=nsX;}
    else if(canMoveTo(mob.x,nsY,mob.radius)){mob.y=nsY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // ── Fire Ant AI ───────────────────────────────────────────────────────────
  function getFireAntHomeRadius(tier) {
    const scale = RADIUS_SCALE[tier ?? 0] ?? 1;
    return Math.max(500, (350 + (tier ?? 0) * 80) * Math.sqrt(scale));
  }

  // Fire worker ant — passive until hit, then chases
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='fire_worker_ant') continue;
    const dx=playerX-mob.x,dy=playerY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}
    let chasing=false;
    if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed;}else mob.speed=mob.baseSpeed;

    // ── Boss lunge ability (same as fire soldier ant / worker ant; 2.5x trigger range & travel distance) ──
    if(mob.isBoss){
      const FW_LUNGE_COOLDOWN  = 15000;
      const FW_LUNGE_RANGE     = 600;
      const FW_LUNGE_DIST      = 300;
      const FW_LUNGE_TELEGRAPH = 700;
      const FW_LUNGE_SPEED     = 28;
      const FW_BOSS_LUNGE_MULT = 2.5;
      const bossLungeRange = FW_LUNGE_RANGE * FW_BOSS_LUNGE_MULT;
      const bossLungeDist  = FW_LUNGE_DIST  * FW_BOSS_LUNGE_MULT;
      mob.lungeTimer=(mob.lungeTimer??FW_LUNGE_COOLDOWN) - dt;

      if(mob.lungeState==='telegraphing'){
        mob.targetFacing=mob.lungeAngle??mob.facing;
        mob.lungeWaitTimer=(mob.lungeWaitTimer??0)-dt;
        if(mob.lungeWaitTimer<=0){
          mob.lungeState='lunging';
          mob.lungeStartX=mob.x; mob.lungeStartY=mob.y;
          const la=mob.lungeAngle??mob.facing;
          mob.lungeDestX=mob.x+Math.cos(la)*bossLungeDist;
          mob.lungeDestY=mob.y+Math.sin(la)*bossLungeDist;
        }
        continue;
      }
      if(mob.lungeState==='lunging'){
        const ldx=mob.lungeDestX-mob.x, ldy=mob.lungeDestY-mob.y, ldist=Math.hypot(ldx,ldy);
        if(ldist<FW_LUNGE_SPEED||ldist<2){
          mob.x=mob.lungeDestX; mob.y=mob.lungeDestY;
          mob.lungeState='idle';
          mob.lungeTimer=FW_LUNGE_COOLDOWN;
        } else {
          const lnx=ldx/ldist, lny=ldy/ldist;
          const lnx2=mob.x+lnx*FW_LUNGE_SPEED, lny2=mob.y+lny*FW_LUNGE_SPEED;
          if(canMoveTo(lnx2,lny2,mob.radius)){mob.x=lnx2;mob.y=lny2;}
          else{mob.lungeState='idle';mob.lungeTimer=FW_LUNGE_COOLDOWN;}
        }
        continue;
      }
      if(mob.lungeTimer<=0 && mob.alerted && dist<=bossLungeRange && dist>0.01){
        mob.lungeState='telegraphing';
        mob.lungeAngle=Math.atan2(dy,dx);
        mob.lungeWaitTimer=FW_LUNGE_TELEGRAPH;
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    const slowFW = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed*=(1-slowFW);
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    let nwX=mob.x,nwY=mob.y;
    if(chasing&&dist>0.01){nwX=mob.x+(dx/dist)*mob.speed;nwY=mob.y+(dy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      if(mob.homeX!==undefined){
        const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
        if(Math.hypot(hdx,hdy)>getFireAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
      }
      nwX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      nwY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(nwX,nwY,mob.radius)){mob.x=nwX;mob.y=nwY;}
    else if(canMoveTo(nwX,mob.y,mob.radius)){mob.x=nwX;}
    else if(canMoveTo(mob.x,nwY,mob.radius)){mob.y=nwY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // Fire soldier ant — aggros at range, chases
  const FIRE_SOLDIER_LUNGE_COOLDOWN  = 15000;
  const FIRE_SOLDIER_LUNGE_RANGE     = 600;
  const FIRE_SOLDIER_LUNGE_DIST      = 300;
  const FIRE_SOLDIER_LUNGE_TELEGRAPH = 700;
  const FIRE_SOLDIER_LUNGE_SPEED     = 28;
  const FIRE_BOSS_LUNGE_MULT         = 2.5;

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='fire_soldier_ant') continue;
    const dx=playerX-mob.x,dy=playerY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}
    let chasing=false;
    if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else mob.speed=mob.baseSpeed;

    if(mob.isBoss){
      const bossLungeRange=FIRE_SOLDIER_LUNGE_RANGE*FIRE_BOSS_LUNGE_MULT;
      const bossLungeDist =FIRE_SOLDIER_LUNGE_DIST *FIRE_BOSS_LUNGE_MULT;
      mob.lungeTimer=(mob.lungeTimer??FIRE_SOLDIER_LUNGE_COOLDOWN)-dt;
      if(mob.lungeState==='telegraphing'){
        mob.targetFacing=mob.lungeAngle??mob.facing;
        mob.lungeWaitTimer=(mob.lungeWaitTimer??0)-dt;
        if(mob.lungeWaitTimer<=0){
          mob.lungeState='lunging';
          mob.lungeStartX=mob.x;mob.lungeStartY=mob.y;
          const la=mob.lungeAngle??mob.facing;
          mob.lungeDestX=mob.x+Math.cos(la)*bossLungeDist;
          mob.lungeDestY=mob.y+Math.sin(la)*bossLungeDist;
        }
        continue;
      }
      if(mob.lungeState==='lunging'){
        const ldx=mob.lungeDestX-mob.x,ldy=mob.lungeDestY-mob.y,ldist=Math.hypot(ldx,ldy);
        if(ldist<FIRE_SOLDIER_LUNGE_SPEED||ldist<2){
          mob.x=mob.lungeDestX;mob.y=mob.lungeDestY;mob.lungeState='idle';mob.lungeTimer=FIRE_SOLDIER_LUNGE_COOLDOWN;
        } else {
          const nx=ldx/ldist,ny=ldy/ldist;
          const nx2=mob.x+nx*FIRE_SOLDIER_LUNGE_SPEED,ny2=mob.y+ny*FIRE_SOLDIER_LUNGE_SPEED;
          if(canMoveTo(nx2,ny2,mob.radius)){mob.x=nx2;mob.y=ny2;}
          else{mob.lungeState='idle';mob.lungeTimer=FIRE_SOLDIER_LUNGE_COOLDOWN;}
        }
        continue;
      }
      if(mob.lungeTimer<=0&&mob.alerted&&dist<=bossLungeRange&&dist>0.01){
        mob.lungeState='telegraphing';mob.lungeAngle=Math.atan2(dy,dx);mob.lungeWaitTimer=FIRE_SOLDIER_LUNGE_TELEGRAPH;
      }
    }

    const slowFS = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed*=(1-slowFS);
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    let nsX=mob.x,nsY=mob.y;
    if(chasing&&dist>0.01){nsX=mob.x+(dx/dist)*mob.speed;nsY=mob.y+(dy/dist)*mob.speed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      if(mob.homeX!==undefined){
        const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
        if(Math.hypot(hdx,hdy)>getFireAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
      }
      nsX=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      nsY=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
    }
    if(canMoveTo(nsX,nsY,mob.radius)){mob.x=nsX;mob.y=nsY;}
    else if(canMoveTo(nsX,mob.y,mob.radius)){mob.x=nsX;}
    else if(canMoveTo(mob.x,nsY,mob.radius)){mob.y=nsY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // Fire queen ant — aggros, stops to lay fire eggs
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='fire_queen_ant') continue;
    const dx=playerX-mob.x,dy=playerY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}

    // ── Boss fire queen ant: spin + egg burst every 15s (same as boss queen ant) ──
    if(mob.isBoss){
      if(mob.queenSpinCooldown === undefined) mob.queenSpinCooldown = 15000;
      mob.queenSpinCooldown -= dt;

      if(mob.queenSpinState === 'spinning'){
        const SPIN_RATE = 0.062;
        mob.facing += SPIN_RATE * (dt / 16.67);
        mob.queenSpinTimer = (mob.queenSpinTimer ?? 0) - dt;
        mob.targetFacing = mob.facing;
        if(mob.queenSpinTimer <= 0){
          mob.queenSpinState = 'done';
          const BOSS_QUEEN_MAX_ANTS = 45;
          const FIRE_ANT_TYPES = new Set(['fire_soldier_ant','fire_worker_ant','fire_queen_ant','fire_ant_egg']);
          const liveAntCount = mobs.filter(m => !m.dead && FIRE_ANT_TYPES.has(m.typeId) && m !== mob).length;
          const slotsAvailable = Math.max(0, BOSS_QUEEN_MAX_ANTS - liveAntCount);
          const EGG_COUNT   = Math.min(25, slotsAvailable);
          const LAUNCH_SPEED = 18;
          const HIGHER_TIER_COUNT = 3;
          const higherIndices = new Set();
          if(EGG_COUNT > 0) {
            while(higherIndices.size < Math.min(HIGHER_TIER_COUNT, EGG_COUNT)) higherIndices.add(Math.floor(Math.random() * EGG_COUNT));
          }
          for(let ei = 0; ei < EGG_COUNT; ei++){
            const angle  = Math.random() * Math.PI * 2;
            const spawnDist = (mob.drawRadius ?? mob.radius) * 1.1;
            const ex = mob.x + Math.cos(angle) * spawnDist;
            const ey = mob.y + Math.sin(angle) * spawnDist;
            const eggTier = mob.tier ?? 0;
            let egg = null;
            if(Math.random() < 0.2){
              egg = spawnMob('fire_ant_egg', mob.x, mob.y, mob.homeZoneId, eggTier);
            } else {
              egg = spawnMob('fire_ant_egg', ex, ey, mob.homeZoneId, eggTier);
            }
            if(egg){
              egg.isZoneTracked = false;
              egg.homeX = mob.homeX ?? mob.x;
              egg.homeY = mob.homeY ?? mob.y;
              egg.isHigherTierEgg = higherIndices.has(ei);
              egg._launchVx = Math.cos(angle) * LAUNCH_SPEED;
              egg._launchVy = Math.sin(angle) * LAUNCH_SPEED;
              if(isWaveMapMode()) addTrackedMob(egg.id);
            }
          }
          mob.queenSpinCooldown = 15000;
        }
        continue;
      }

      if(mob.queenSpinState === 'done') mob.queenSpinState = null;

      if(mob.queenSpinCooldown <= 0 && mob.alerted){
        mob.queenSpinState = 'spinning';
        mob.queenSpinTimer = 600;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    if(mob.queenLayState==='pausing'){
      mob.queenLayPause-=dt;
      if(mob.queenLayPause<=0){
        const egg=spawnMob('fire_ant_egg',mob.x,mob.y,mob.homeZoneId,mob.tier);
        egg.isZoneTracked=false;
        egg.homeX=mob.homeX??mob.x;egg.homeY=mob.homeY??mob.y;
        mob.queenLayState='moving';mob.queenLayTimer=5000;
      }
      mob.targetFacing=mob.facing;
      continue;
    }
    mob.queenLayTimer-=dt;
    if(mob.queenLayTimer<=0&&!mob.alerted){
      mob.queenLayState='pausing';mob.queenLayPause=500;continue;
    }
    let chasing=false;
    if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else mob.speed=mob.baseSpeed;
    const slowFQ = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    const fqEff=mob.speed*(1-slowFQ);
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    let nqX=mob.x,nqY=mob.y;
    if(chasing&&dist>0.01){nqX=mob.x+(dx/dist)*fqEff;nqY=mob.y+(dy/dist)*fqEff;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      if(mob.homeX!==undefined){
        const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
        if(Math.hypot(hdx,hdy)>getFireAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
      }
      nqX=mob.x+Math.cos(mob.wanderAngle)*fqEff*0.45;
      nqY=mob.y+Math.sin(mob.wanderAngle)*fqEff*0.45;
    }
    if(canMoveTo(nqX,nqY,mob.radius)){mob.x=nqX;mob.y=nqY;}
    else if(canMoveTo(nqX,mob.y,mob.radius)){mob.x=nqX;}
    else if(canMoveTo(mob.x,nqY,mob.radius)){mob.y=nqY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // ── Friendly ant pet AI ───────────────────────────────────────────────────────
  // Pets follow the player and hang around close by. They only aggro to hostile
  // mobs the player can actually see on screen (zooming in shrinks that area),
  // and may roam getPetLeashTiles(tier) tiles from the player (more at higher rarity) — chasing or not —
  // before they drop everything and run back to the player.
  // They never attack diggers, beekeepers, or other friendly pets.
  const PET_FOLLOW_DIST   = 220;   // idle pets stay within this radius of the player
  const PET_RETURN_DIST   = 160;   // a returning pet stops running home once this close

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||!mob.isFriendlyPet) continue;
    if(mob.typeId==='sandstorm') continue;  // handled in its own dedicated section below — drifts + rams instead of chasing
    // NPC-owned pets follow the NPC; player pets follow the player
    const anchorX = (mob.isNPCPet && _npcTarget && !_npcTarget.dead) ? _npcTarget.x : playerX;
    const anchorY = (mob.isNPCPet && _npcTarget && !_npcTarget.dead) ? _npcTarget.y : playerY;
    const pdist=Math.hypot(anchorX-mob.x,anchorY-mob.y);

    const span = petBodySpan(mob, player);                 // measured edge to edge, not centre to centre
    const PET_LEASH_DIST = getPetLeashDist(mob.tier) + span;   // 4 tiles at Common, more at higher rarities
    const followDist = PET_FOLLOW_DIST + span;
    const returnDist = PET_RETURN_DIST + span;
    const canTarget = other =>
      !other.dead && other.id!==mob.id && !other.isFriendlyPet &&
      other.typeId!=='digger' && other.typeId!=='beekeeper' &&
      other.typeId!=='ant_egg' && other.typeId!=='spider_egg' && other.typeId!=='fire_ant_egg' &&
      // beehive and ant_hole are valid targets for pets
      isInPlayerView(player, other.x, other.y, other.radius ?? 0, anchorX, anchorY) &&
      Math.hypot(other.x-anchorX, other.y-anchorY) <= PET_LEASH_DIST;

    // Went past the leash → stop everything and head back to the player.
    if(pdist > PET_LEASH_DIST) mob.petReturning = true;

    let target=null;
    if(mob.petReturning){
      mob.petTargetId=null;
      if(pdist <= returnDist) mob.petReturning = false;
    }
    if(!mob.petReturning){
      // Sticky target — keep it while the player can still see it and it's in range
      if(mob.petTargetId!=null){
        const prev=mobs.find(m=>m.id===mob.petTargetId);
        if(prev&&canTarget(prev)) target=prev;
      }
      if(!target){
        let bestDist=Infinity;
        for(const other of mobs){
          if(!canTarget(other)) continue;
          const td=Math.hypot(other.x-mob.x,other.y-mob.y);
          if(td<bestDist){bestDist=td;target=other;}
        }
      }
      mob.petTargetId=target?target.id:null;
    }

    const step = (nx, ny) => {
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;return true;}
      if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;return true;}
      if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;return true;}
      return false;
    };

    if(mob.petReturning){
      // Run back to the player at full speed, no combat on the way
      mob.alerted=false;
      mob.speed=mob.alertSpeed||mob.baseSpeed;
      const dx=anchorX-mob.x,dy=anchorY-mob.y;
      mob.targetFacing=Math.atan2(dy,dx);
      const s=Math.min(mob.speed,Math.max(0,pdist-returnDist*0.5));
      if(pdist>0.001) step(mob.x+(dx/pdist)*s, mob.y+(dy/pdist)*s);
    } else if(target){
      // Chase target
      const dx=target.x-mob.x,dy=target.y-mob.y,dist=Math.hypot(dx,dy);
      mob.alerted=true;
      mob.speed=mob.alertSpeed;
      mob.targetFacing=Math.atan2(dy,dx);
      if(dist>mob.radius+target.radius&&dist>0.001){
        step(mob.x+(dx/dist)*mob.speed, mob.y+(dy/dist)*mob.speed);
      }
    } else {
      mob.alerted=false;
      if(pdist>followDist){
        // Follow the player — speeds up the further behind it is
        const followT=Math.min((pdist-followDist)/400,1);
        const followSpd=mob.alertSpeed||mob.baseSpeed;
        mob.speed=mob.baseSpeed+(followSpd-mob.baseSpeed)*followT;
        const dx=anchorX-mob.x,dy=anchorY-mob.y;
        const toPlayerAngle=Math.atan2(dy,dx);
        let aDiff=toPlayerAngle-mob.wanderAngle;
        if(aDiff>Math.PI) aDiff-=Math.PI*2; if(aDiff<-Math.PI) aDiff+=Math.PI*2;
        mob.wanderAngle+=aDiff*(0.15+0.25*followT);
        mob.targetFacing=mob.wanderAngle;
        const s=Math.min(mob.speed,pdist-followDist*0.6);
        if(!step(mob.x+Math.cos(mob.wanderAngle)*s, mob.y+Math.sin(mob.wanderAngle)*s)){
          mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;
        }
      } else {
        // Close to the player: slow idle wander
        mob.speed=mob.baseSpeed;
        mob.wanderTimer-=dt;
        if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
        mob.targetFacing=mob.wanderAngle;
        if(!step(mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45, mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45)){
          mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;
        }
      }
    }

    // Facing + leg/wing animation
    let facingDiff=mob.targetFacing-mob.facing;
    if(facingDiff>Math.PI) facingDiff-=Math.PI*2; if(facingDiff<-Math.PI) facingDiff+=Math.PI*2;
    mob.facing+=facingDiff*0.08;
    const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
    if(spd>0.05){const sf=Math.min(4.0,spd/mob.baseSpeed*2.5);mob.pincerPhase=(mob.pincerPhase||0)+0.18*sf;mob.wingPhase=(mob.wingPhase||0)+0.14*sf;}
    mob.lastX=mob.x;mob.lastY=mob.y;
  }

  // ── Digger pet animation update — runs after pet AI loop gives movement data ──
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='digger'||!mob.isFriendlyPet) continue;

    const target = mob.petTargetId != null ? mobs.find(m=>m.id===mob.petTargetId&&!m.dead) : null;
    if(target){
      const tdx=target.x-mob.x, tdy=target.y-mob.y;
      const td=Math.hypot(tdx,tdy);
      if(td>0.01){ mob.eyeAngle=Math.atan2(tdy,tdx); }
    } else {
      mob.eyeAngle=mob.facing ?? mob.wanderAngle ?? 0;
    }

    const moveX=Math.cos(mob.eyeAngle), moveY=Math.sin(mob.eyeAngle);
    const targetPdx=moveX*mob.drawRadius*0.09, targetPdy=moveY*mob.drawRadius*0.09;
    mob.animPdx=(mob.animPdx??0)*0.85+targetPdx*0.15;
    mob.animPdy=(mob.animPdy??0)*0.85+targetPdy*0.15;

    const hpPct=mob.hp/mob.maxHp;
    if(hpPct<0.3){ mob.state='sad'; }
    else if(target){ mob.state='angry'; }
    else { mob.state='neutral'; }

    const targetBrowT=mob.state==='angry'?1:0;
    mob.browT=(mob.browT??0)*0.88+targetBrowT*0.12;

    const dr=mob.drawRadius;
    const targetCpOffset=mob.state==='angry'?-dr*0.20:mob.state==='sad'?-dr*0.13:dr*0.14;
    mob.animCpOffset=(mob.animCpOffset??dr*0.14)*0.85+targetCpOffset*0.15;

    mob.cutterRot=(mob.cutterRot??0)+(target?0.08:0.03);
  }

  // Queen ant — aggros at range + stops every ~5 s to lay an egg
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='queen_ant') continue;
    let targetX=playerX,targetY=playerY;
    let tDist2q=Math.hypot(playerX-mob.x,playerY-mob.y);
    for(const dg of diggers){const dd=Math.hypot(dg.x-mob.x,dg.y-mob.y);if(dd<tDist2q){targetX=dg.x;targetY=dg.y;tDist2q=dd;}}
    const dx=targetX-mob.x,dy=targetY-mob.y,dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;
    if(mob.alerted&&dist>DEAGGRO_DIST){mob.alerted=false;mob.wanderAngle=mob.facing;mob.wanderTimer=800;}

    // ── Boss queen ant: spin + egg burst every 15s ──────────────────────────
    if(mob.isBoss){
      if(mob.queenSpinCooldown === undefined) mob.queenSpinCooldown = 15000;
      mob.queenSpinCooldown -= dt;

      if(mob.queenSpinState === 'spinning'){
        // Spin for 600ms (full 360° × ~1.3 so it looks deliberate)
        const SPIN_RATE = 0.062; // rad per ms-tick at 60fps equivalent
        mob.facing += SPIN_RATE * (dt / 16.67);
        mob.queenSpinTimer = (mob.queenSpinTimer ?? 0) - dt;
        mob.targetFacing = mob.facing;
        if(mob.queenSpinTimer <= 0){
          mob.queenSpinState = 'done';
          // Count live ants near this boss queen (max 45 total)
          const BOSS_QUEEN_MAX_ANTS = 45;
          const ANT_TYPES = new Set(['soldier_ant','worker_ant','baby_ant','queen_ant','ant_egg']);
          const liveAntCount = mobs.filter(m => !m.dead && ANT_TYPES.has(m.typeId) && m !== mob).length;
          const slotsAvailable = Math.max(0, BOSS_QUEEN_MAX_ANTS - liveAntCount);
          // Spawn up to 25 ant eggs — but only as many as there are slots
          const EGG_COUNT   = Math.min(25, slotsAvailable);
          const LAUNCH_SPEED = 18; // fast shoot-out speed
          const HIGHER_TIER_COUNT = 3;
          // Pick 3 random indices that will hatch at tier+1 (one tier higher, not two)
          const higherIndices = new Set();
          if(EGG_COUNT > 0) {
            while(higherIndices.size < Math.min(HIGHER_TIER_COUNT, EGG_COUNT)) higherIndices.add(Math.floor(Math.random() * EGG_COUNT));
          }
          for(let ei = 0; ei < EGG_COUNT; ei++){
            const angle  = Math.random() * Math.PI * 2;
            // Spawn right at queen's edge — eggs shoot outward from her
            const spawnDist = (mob.drawRadius ?? mob.radius) * 1.1;
            const ex = mob.x + Math.cos(angle) * spawnDist;
            const ey = mob.y + Math.sin(angle) * spawnDist;
            // All eggs spawn at queen's tier; isHigherTierEgg adds +1 at hatch time
            const eggTier = mob.tier ?? 0;
            // Sometimes let eggs spawn in walls (about 20% chance per egg)
            let egg = null;
            if(Math.random() < 0.2){
              // Force-spawn ignoring wall check by spawning at queen's position
              egg = spawnMob('ant_egg', mob.x, mob.y, mob.homeZoneId, eggTier);
            } else {
              egg = spawnMob('ant_egg', ex, ey, mob.homeZoneId, eggTier);
            }
            if(egg){
              egg.isZoneTracked = false;
              egg.homeX = mob.homeX ?? mob.x;
              egg.homeY = mob.homeY ?? mob.y;
              egg.isHigherTierEgg = higherIndices.has(ei); // flag for hatching at tier+1
              // Shoot egg outward at high speed
              egg._launchVx = Math.cos(angle) * LAUNCH_SPEED;
              egg._launchVy = Math.sin(angle) * LAUNCH_SPEED;
              if(isWaveMapMode()) addTrackedMob(egg.id);
            }
          }
          mob.queenSpinCooldown = 15000;
        }
        continue; // freeze movement during spin
      }

      if(mob.queenSpinState === 'done') mob.queenSpinState = null;

      if(mob.queenSpinCooldown <= 0 && mob.alerted){
        mob.queenSpinState = 'spinning';
        mob.queenSpinTimer = 600;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    if(mob.queenLayState==='pausing'){
      mob.queenLayPause-=dt;
      if(mob.queenLayPause<=0){
        const egg=spawnMob('ant_egg',mob.x,mob.y,mob.homeZoneId,mob.tier);
        egg.isZoneTracked=false;
        // Egg inherits queen's home so hatched soldier knows where the colony is
        egg.homeX=mob.homeX??mob.x; egg.homeY=mob.homeY??mob.y;
        mob.queenLayState='moving';
        mob.queenLayTimer=5000;
      }
      mob.targetFacing=mob.facing;
      continue;
    }

    mob.queenLayTimer-=dt;
    if(mob.queenLayTimer<=0&&!mob.alerted){
      mob.queenLayState='pausing'; mob.queenLayPause=500; continue;
    }

    let chasing=false;
    if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else mob.speed=mob.baseSpeed;
    
    // Apply web slowdown — compute effective speed fresh, never modify permanently
    const slowFactorQA = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    const qaEffSpeed = mob.speed * (1 - slowFactorQA);
    
    mob.targetFacing=chasing?Math.atan2(dy,dx):mob.wanderAngle;
    let nqX=mob.x,nqY=mob.y;
    if(chasing&&dist>0.01){nqX=mob.x+(dx/dist)*qaEffSpeed;nqY=mob.y+(dy/dist)*qaEffSpeed;}
    else{
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=1200+Math.random()*2500;}
      if(mob.homeX!==undefined){
        const hdx=mob.homeX-mob.x,hdy=mob.homeY-mob.y;
        if(Math.hypot(hdx,hdy)>getAntHomeRadius(mob.tier)){mob.wanderAngle=Math.atan2(hdy,hdx);mob.wanderTimer=600;}
      }
      nqX=mob.x+Math.cos(mob.wanderAngle)*qaEffSpeed*0.45;
      nqY=mob.y+Math.sin(mob.wanderAngle)*qaEffSpeed*0.45;
    }
    if(canMoveTo(nqX,nqY,mob.radius)){mob.x=nqX;mob.y=nqY;}
    else if(canMoveTo(nqX,mob.y,mob.radius)){mob.x=nqX;}
    else if(canMoveTo(mob.x,nqY,mob.radius)){mob.y=nqY;}
    else{mob.wanderAngle=Math.random()*Math.PI*2;mob.wanderTimer=400+Math.random()*600;}
  }

  // ── Hornet AI ─────────────────────────────────────────────────────────────
  const HORNET_AIM_HOLD_MS    = 120;    // brief hold at fully-aimed before firing
  const HORNET_REGROW_MS      = 900;    // stinger regrow duration
  const TURN_RATE             = 0.08;  // radians per frame — smooth rotation
  const HORNET_SPIN_COOLDOWN  = 20000; // ms between spin attacks
  const HORNET_SPIN_REVS      = 2;     // full 360s
  const HORNET_SPIN_SHOOT_MS  = 500;   // shoot every 500ms during spin

  /** Fires the hornet's stinger as a missile (missiles.js), from the middle of
   *  the stinger, straight out of its back. */
  function fireHornetMissile(mob) {
    const dr = mob.drawRadius ?? mob.radius;
    const t = mob.tier ?? 0;
    const hs = MOB_STATS.hornet;
    const fireAngle = mob.facing + Math.PI;   // stinger side
    const along = dr * (1.35 + 0.45);          // body edge + half the stinger
    fireMissile(mob, {
      x: mob.x + Math.cos(fireAngle) * along,
      y: mob.y + Math.sin(fireAngle) * along,
      angle: fireAngle,
      size: dr,
      radius: Math.max(4, Math.round(dr * 0.38)),
      damage: hs.missileDmg[t], hp: hs.missileHp[t], armor: hs.armor[t],
    });
    mob.stingerProgress = 0;
  }

  // Wraps an angle difference into [-π, π] however far it has drifted
  const wrapAngle = a => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='hornet') continue;
    mob.facing = wrapAngle(mob.facing);   // keep it bounded (boss spins add up)
    const hornetPreferredDist = (mob.drawRadius ?? 22) * 11;  // always ~11 body-radii away, scales with rarity
    // Hornets target nearest enemy: player, NPC, digger, or beekeeper
    let targetX = playerX, targetY = playerY;
    let dist = Math.hypot(playerX-mob.x, playerY-mob.y);
    // Check NPC as additional target (wave mode)
    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const dnpc = Math.hypot(_npcTarget.x-mob.x, _npcTarget.y-mob.y);
      if (dnpc < dist) { targetX = _npcTarget.x; targetY = _npcTarget.y; dist = dnpc; }
    }
    for(const dg of diggers){const dd=Math.hypot(dg.x-mob.x,dg.y-mob.y); if(dd<dist){targetX=dg.x;targetY=dg.y;dist=dd;} }
    const dx = targetX-mob.x;
    const dy = targetY-mob.y;
    if(dist>AI_CULL_DIST) continue;

    // De-aggro
    if(mob.alerted && dist>DEAGGRO_DIST){
      mob.alerted=false; mob.shootState='idle';
      mob.wanderAngle=mob.facing; mob.wanderTimer=800;
    }
    // Aggro check
    if(!mob.alerted && dist<mob.aggroRange){
      mob.alerted=true; mob.shootState='approach'; mob.shootTimer=0;
    }

    // A missing stinger always grows back, whatever the hornet is doing
    if((mob.stingerProgress ?? 1) < 1){
      mob.stingerProgress = Math.min(1, (mob.stingerProgress ?? 0) + dt / HORNET_REGROW_MS);
    }

    // Apply web slowdown — compute effective speed fresh, never modify baseSpeed/alertSpeed permanently
    const slowFactorH = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    const hEffSpeed = mob.speed * (1 - slowFactorH);

    if(mob.isStationary){
      // Stationary turret hornet (spawned from boss queen bee egg) — stays put, just aims and shoots
      if(!mob.alerted && dist < mob.aggroRange){ mob.alerted = true; mob.shootState = 'aim'; }
      // fall through to shootState machine below (no movement)
    } else if(!mob.alerted){
      // Wander
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){ mob.wanderAngle=Math.random()*Math.PI*2; mob.wanderTimer=1200+Math.random()*2500; }
      const nx=mob.x+Math.cos(mob.wanderAngle)*hEffSpeed*0.45;
      const ny=mob.y+Math.sin(mob.wanderAngle)*hEffSpeed*0.45;
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
      else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
      else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
      const fd=wrapAngle(mob.wanderAngle-mob.facing);
      mob.facing+=Math.sign(fd)*Math.min(Math.abs(fd),TURN_RATE);
      mob.wobblePhase=(mob.wobblePhase||0)+0.12;
      continue;
    }

    // ── Boss spin attack ────────────────────────────────────────────────────
    if(mob.isBoss){
      if(mob.hornetSpinCooldown === undefined) mob.hornetSpinCooldown = HORNET_SPIN_COOLDOWN;
      if(mob.shootState !== 'spin') mob.hornetSpinCooldown -= dt;

      if(mob.shootState === 'spin'){
        // Spin at the normal turn rate but full-throttle every frame
        const SPIN_RATE = 0.08; // same as TURN_RATE
        mob.facing += SPIN_RATE * (dt / 16.67); // framerate-independent
        mob.hornetSpinRotated = (mob.hornetSpinRotated ?? 0) + SPIN_RATE * (dt / 16.67);
        mob.wobblePhase = (mob.wobblePhase || 0) + 0.08;

        // Shoot every 500ms during spin — in direction mob is facing (stinger side)
        mob.hornetSpinShootTimer = (mob.hornetSpinShootTimer ?? 0) - dt;
        if(mob.hornetSpinShootTimer <= 0){
          mob.hornetSpinShootTimer = HORNET_SPIN_SHOOT_MS;
          fireHornetMissile(mob);
        }

        // Done after HORNET_SPIN_REVS full rotations
        if(mob.hornetSpinRotated >= Math.PI * 2 * HORNET_SPIN_REVS){
          mob.shootState = 'reset';
          mob.shootTimer = 0;
          mob.stingerProgress = 0;
          mob.hornetSpinCooldown = HORNET_SPIN_COOLDOWN;
        }
        continue; // skip normal state machine this tick
      }

      // Trigger spin when cooldown elapsed and alerted
      if(mob.hornetSpinCooldown <= 0 && mob.alerted){
        mob.shootState = 'spin';
        mob.hornetSpinRotated = 0;
        mob.hornetSpinShootTimer = 0; // shoot immediately on first frame
        continue;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const angleToTarget=Math.atan2(dy,dx);
    // Stinger toward target → antenna points AWAY → facing = angleToTarget + PI
    const aimFacing=angleToTarget+Math.PI;

    // Helper: fixed-rate rotation toward a target angle, returns remaining error
    function rotateTo(target) {
      const fd=wrapAngle(target-mob.facing);
      mob.facing+=Math.sign(fd)*Math.min(Math.abs(fd),TURN_RATE);
      return Math.abs(fd);
    }

    switch(mob.shootState){
      case 'approach': {
        // Turn to face the target first — a hornet can't fly anywhere while
        // it's still turning around (e.g. right after a shot). Stationary
        // hornets never move.
        const turnErr = rotateTo(mob.isStationary ? aimFacing : angleToTarget);
        if(!mob.isStationary && turnErr < 0.3 && dist>hornetPreferredDist+40){
          const nx=mob.x+(dx/dist)*hEffSpeed;
          const ny=mob.y+(dy/dist)*hEffSpeed;
          if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
          else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
          else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
        }
        mob.wobblePhase=(mob.wobblePhase||0)+0.12;
        if(mob.isStationary || dist<=hornetPreferredDist+40){ mob.shootState='aim'; mob.shootTimer=0; }
        break;
      }
      case 'aim': {
        // Rotate stinger to face player — no moving while aiming
        const err=rotateTo(aimFacing);
        mob.wobblePhase=(mob.wobblePhase||0)+0.06;
        // Target got away: turn back around (reset), then chase (approach)
        if(!mob.isStationary && dist>hornetPreferredDist+80){ mob.shootState='reset'; mob.shootTimer=0; break; }
        // Only count hold time when fully aimed with a full stinger
        if(err<0.03 && mob.stingerProgress>=1){
          mob.shootTimer+=dt;
          if(mob.shootTimer>=HORNET_AIM_HOLD_MS){ mob.shootState='fire'; mob.shootTimer=0; }
        } else {
          mob.shootTimer=0; // keep waiting until truly aimed
        }
        break;
      }
      case 'fire': {
        fireHornetMissile(mob);
        mob.shootState='reset';
        mob.shootTimer=0;
        break;
      }
      case 'reset': {
        // Rotate back to normal facing (antenna toward target) while the
        // stinger regrows — no moving until it has turned back around
        const err=rotateTo(angleToTarget);
        mob.wobblePhase=(mob.wobblePhase||0)+0.05;
        // Must BOTH fully rotate back AND fully regrow before acting again;
        // then it chases if the target drifted off, or aims again
        if(mob.stingerProgress>=1 && err<0.04){
          mob.shootState=(!mob.isStationary && dist>hornetPreferredDist+40)?'approach':'aim';
          mob.shootTimer=0;
        }
        break;
      }
      default: mob.shootState='approach';
    }
  }

  // ── Scorpion AI ───────────────────────────────────────────────────────────
  // Ranged like a hornet (fires the same stinger-style missile), but:
  //  - holds a much closer preferred distance (~140 units, "3 players away")
  //  - never retreats once at range, even if the player closes in further
  //  - fires irregularly rather than on a steady aim/hold/fire cycle
  //  - drifts side-to-side subtly while at range
  //  - occasionally lunges forward unpredictably; a lunge that connects with
  //    the player deals contact damage (contactDps, same as normal mob touch)
  const SCORPION_PREFERRED_DIST_MULT = 6.4;  // ×drawRadius — scales with rarity/size (was a flat 140, wrong for bigger tiers)
  const SCORPION_FIRE_MIN_MS    = 1400;  // irregular fire — min gap between shots
  const SCORPION_FIRE_MAX_MS    = 3600;  // irregular fire — max gap between shots
  const SCORPION_LUNGE_MIN_MS   = 2200;  // min gap between lunges
  const SCORPION_LUNGE_MAX_MS   = 6000;  // max gap between lunges
  const SCORPION_LUNGE_DIST_MULT = 1.15; // lunge reaches 15% further out than the preferred stand-away distance

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='scorpion') continue;

    // ── Boss Scorpion: missile-circle burst every 15s — fires 3 rings, 0.3s
    // apart, while still able to move/act normally the rest of the time (not
    // a blocking state, just a parallel timer checked every tick regardless
    // of what the approach/hold/lunge state machine is doing).
    if(mob.isBoss){
      const SCORPION_CIRCLE_COOLDOWN   = 15000;
      const SCORPION_CIRCLE_COUNT      = 30;
      const SCORPION_CIRCLE_VOLLEYS    = 3;
      const SCORPION_CIRCLE_VOLLEY_GAP = 1000; // ms between each of the 3 rings

      function fireScorpionRing(){
        const dr=mob.drawRadius??mob.radius;
        const t=mob.tier??0;
        const ss=MOB_STATS.scorpion;
        const muzzleDist=dr*0.5; // fired from the body center outward, not the mandible muzzle — it's an all-around burst
        for(let i=0;i<SCORPION_CIRCLE_COUNT;i++){
          const angle=(Math.PI*2/SCORPION_CIRCLE_COUNT)*i;
          const sx=mob.x+Math.cos(angle)*muzzleDist;
          const sy=mob.y+Math.sin(angle)*muzzleDist;
          fireMissile(mob, {
            x: sx, y: sy, angle,
            size: dr * 0.45, radius: Math.max(2.5, Math.round(dr * 0.18)),
            damage: ss.dmg[t], hp: ss.missileHp[t], armor: ss.armor[t],
          });
        }
      }

      if(mob.scorpionCircleTimer === undefined) mob.scorpionCircleTimer = SCORPION_CIRCLE_COOLDOWN;
      if(mob.scorpionCircleVolleysLeft === undefined) mob.scorpionCircleVolleysLeft = 0;

      if(mob.scorpionCircleVolleysLeft > 0){
        // Mid-sequence: count down the gap between rings, independent of the main cooldown
        mob.scorpionCircleVolleyGapTimer -= dt;
        if(mob.scorpionCircleVolleyGapTimer <= 0){
          fireScorpionRing();
          mob.scorpionCircleVolleysLeft--;
          mob.scorpionCircleVolleyGapTimer = SCORPION_CIRCLE_VOLLEY_GAP;
        }
      } else {
        mob.scorpionCircleTimer -= dt;
        if(mob.scorpionCircleTimer <= 0){
          mob.scorpionCircleTimer = SCORPION_CIRCLE_COOLDOWN;
          // Fire the first ring immediately, queue the remaining 2 on the gap timer
          fireScorpionRing();
          mob.scorpionCircleVolleysLeft = SCORPION_CIRCLE_VOLLEYS - 1;
          mob.scorpionCircleVolleyGapTimer = SCORPION_CIRCLE_VOLLEY_GAP;
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    // Scales with the mob's actual drawn size, same pattern as hornetPreferredDist —
    // otherwise a high-rarity (visually much bigger) scorpion ends up standing
    // closer than its own body width, which looked wrong. Bosses get an extra
    // dampening factor here — their drawRadius is already 1.5x bigger, and
    // applying the same multiplier on top of that made them hold so far back
    // it looked like they weren't approaching/chasing normally. Dampened so a
    // boss only stands ~7-8% further than a normal scorpion, not the full 50%.
    const BOSS_PREFERRED_DIST_DAMPEN = 0.7167;
    const scorpionPreferredDist = (mob.drawRadius ?? mob.radius ?? 22) * SCORPION_PREFERRED_DIST_MULT * (mob.isBoss ? BOSS_PREFERRED_DIST_DAMPEN : 1);
    const scorpionLungeDist = scorpionPreferredDist * SCORPION_LUNGE_DIST_MULT;

    let targetX = playerX, targetY = playerY;
    let dist = Math.hypot(playerX-mob.x, playerY-mob.y);
    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const dnpc = Math.hypot(_npcTarget.x-mob.x, _npcTarget.y-mob.y);
      if (dnpc < dist) { targetX = _npcTarget.x; targetY = _npcTarget.y; dist = dnpc; }
    }
    const dx = targetX-mob.x, dy = targetY-mob.y;
    if(dist>9000) continue; // AI_CULL_DIST, matches hornet's culling range

    // De-aggro / aggro, same thresholds as other ranged mobs
    if(mob.alerted && dist>1200){
      mob.alerted=false; mob.scorpionState='idle';
      mob.wanderAngle=mob.facing; mob.wanderTimer=800;
    }
    if(!mob.alerted && dist<mob.aggroRange){
      mob.alerted=true; mob.scorpionState='approach';
      mob.scorpionFireTimer = SCORPION_FIRE_MIN_MS + Math.random()*(SCORPION_FIRE_MAX_MS-SCORPION_FIRE_MIN_MS);
      mob.scorpionLungeTimer = SCORPION_LUNGE_MIN_MS + Math.random()*(SCORPION_LUNGE_MAX_MS-SCORPION_LUNGE_MIN_MS);
    }

    if(!mob.alerted){
      // Wander, matching the generic idle-wander pattern used elsewhere
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){ mob.wanderAngle=Math.random()*Math.PI*2; mob.wanderTimer=1200+Math.random()*2500; }
      const nx=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      const ny=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
      else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
      else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
      let fd=mob.wanderAngle-mob.facing;
      if(fd>Math.PI)fd-=Math.PI*2; if(fd<-Math.PI)fd+=Math.PI*2;
      mob.facing+=Math.sign(fd)*Math.min(Math.abs(fd),0.08);
      continue;
    }

    const angleToTarget=Math.atan2(dy,dx);
    // Mandibles lead: default facing points straight at the target, matching
    // the ant/centipede convention (see drawCentipedeHead's "+x = forward").
    // No separate aim/turn step exists anymore — it fires straight out of
    // whatever direction it's currently facing/moving in.

    function scorpionRotateTo(target){
      let fd=target-mob.facing;
      if(fd>Math.PI)fd-=Math.PI*2; if(fd<-Math.PI)fd+=Math.PI*2;
      mob.facing+=Math.sign(fd)*Math.min(Math.abs(fd),0.08);
      return Math.abs(fd);
    }

    // Mandible chatter runs continuously regardless of state or movement,
    // same as the ants' constant pincer animation.
    mob.pincerPhase=(mob.pincerPhase??0)+0.10;

    // ── Lunge takes priority over everything else while active ────────────────
    if(mob.scorpionState==='lunge'){
      const preLx=mob.x, preLy=mob.y;
      mob.scorpionLungeElapsed=(mob.scorpionLungeElapsed??0)+dt;
      // Walks forward at normal speed until it's covered scorpionLungeDist (15%
      // further than its own stand-away distance), then walks back the same
      // way — a real step, not a fast teleport-lerp, and its reach scales with
      // body size/rarity same as the stand-away distance does.
      // Fully committed once started: facing is locked to the lunge angle for
      // the whole thing, no turning or re-steering mid-lunge.
      mob.scorpionLungeTraveled=(mob.scorpionLungeTraveled??0);
      const movingOut = !mob.scorpionLungeReturning;
      mob.facing=mob.scorpionLungeAngle; // locked, mandibles point the lunge direction throughout
      const stepAngle = movingOut ? mob.scorpionLungeAngle : mob.scorpionLungeAngle+Math.PI;
      const lx=mob.x+Math.cos(stepAngle)*mob.speed;
      const ly=mob.y+Math.sin(stepAngle)*mob.speed;
      // Moving mob.x/y into the player here is enough — the generic mob→player
      // contact-damage pass in combat.js applies contactDps on overlap for any
      // mob, so a connecting lunge already deals damage with no extra wiring.
      const moved = canMoveTo(lx,ly,mob.radius);
      if(moved){ mob.x=lx; mob.y=ly; mob.scorpionLungeTraveled+=mob.speed; }
      else { mob.scorpionLungeTraveled=scorpionLungeDist; } // blocked — treat as having reached the end, don't get stuck
      if(movingOut && mob.scorpionLungeTraveled>=scorpionLungeDist){
        mob.scorpionLungeReturning=true;
        mob.scorpionLungeTraveled=0;
      }
      // Leg speed scales with how fast it's actually moving this tick, same
      // pattern as the ants/beetle (speedFactor off actual displacement).
      {
        const lspd=Math.hypot(mob.x-preLx, mob.y-preLy);
        const speedFactor=Math.min(4.0, lspd/mob.baseSpeed*2.5);
        mob.legPhase=(mob.legPhase??0)+0.24*Math.max(1, speedFactor);
      }
      // Lunge ends once it's walked back the same distance it went out, or as
      // a safety net if something's preventing it from ever completing normally.
      const lungeStuck = mob.scorpionLungeElapsed > 4000;
      if((mob.scorpionLungeReturning && mob.scorpionLungeTraveled>=scorpionLungeDist) || lungeStuck){
        mob.scorpionState='hold';
        mob.scorpionLungeElapsed=0;
        mob.scorpionLungeTraveled=0;
        mob.scorpionLungeReturning=false;
        mob.scorpionLungeTimer = SCORPION_LUNGE_MIN_MS + Math.random()*(SCORPION_LUNGE_MAX_MS-SCORPION_LUNGE_MIN_MS);
      }
      continue;
    }

    switch(mob.scorpionState){
      case 'approach': {
        if(dist>scorpionPreferredDist){
          const preAx=mob.x, preAy=mob.y;
          const nx=mob.x+(dx/dist)*mob.speed;
          const ny=mob.y+(dy/dist)*mob.speed;
          if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
          else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
          else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
          const aspd=Math.hypot(mob.x-preAx, mob.y-preAy);
          const speedFactor=Math.min(4.0, aspd/mob.baseSpeed*2.5);
          mob.legPhase=(mob.legPhase??0)+0.16*Math.max(1, speedFactor);
        }
        scorpionRotateTo(angleToTarget); // mandibles-first while closing distance
        // Once inside preferred range, hold ground permanently — no retreat state exists
        if(dist<=scorpionPreferredDist){ mob.scorpionState='hold'; }
        break;
      }
      case 'hold': {
        // Never approaches or retreats WHILE the player stays within roughly
        // double the preferred distance — but if they get meaningfully
        // further than that, it resumes walking/chasing rather than just
        // standing there relying on the occasional lunge to close distance.
        if(dist > scorpionPreferredDist * 2){
          mob.scorpionState='approach';
          break;
        }
        scorpionRotateTo(angleToTarget);

        // Irregular fire — counts down on its own clock, independent of lunges.
        // Fires immediately from wherever it's currently facing/moving — no
        // reorientation step, so it never stops and turns to aim.
        mob.scorpionFireTimer=(mob.scorpionFireTimer??2000)-dt;
        if(mob.scorpionFireTimer<=0){
          mob.scorpionState='fire';
          mob.scorpionFireTimer=0;
        }

        // Rare random lunge — infrequent, per your "not often"
        mob.scorpionLungeTimer=(mob.scorpionLungeTimer??3000)-dt;
        if(mob.scorpionLungeTimer<=0){
          mob.scorpionState='lunge';
          mob.scorpionLungeElapsed=0;
          // Lunges are semi-random in direction, biased toward the player
          mob.scorpionLungeAngle=angleToTarget+(Math.random()-0.5)*0.9;
        }
        break;
      }
      case 'fire': {
        // Fires from the front of the body (between the mandibles), straight
        // in whatever direction the scorpion currently faces — no aim/turn
        // step, so it keeps standing put right through the shot. Doesn't
        // guarantee a hit; the player has to actually be in front of it.
        const dr=mob.drawRadius??mob.radius;
        const fireAngle=mob.facing;
        const muzzleDist=dr*0.95; // roughly the mandible tips, front-center
        const sx=mob.x+Math.cos(fireAngle)*muzzleDist;
        const sy=mob.y+Math.sin(fireAngle)*muzzleDist;
        const t=mob.tier??0;
        const ss=MOB_STATS.scorpion;
        // Same missile as the hornet's (missiles.js), just smaller
        fireMissile(mob, {
          x: sx, y: sy, angle: fireAngle,
          size: dr * 0.45, radius: Math.max(2.5, Math.round(dr * 0.18)),
          damage: ss.dmg[t], hp: ss.missileHp[t], armor: ss.armor[t],
        });
        mob.scorpionState='hold';
        mob.scorpionFireTimer = SCORPION_FIRE_MIN_MS + Math.random()*(SCORPION_FIRE_MAX_MS-SCORPION_FIRE_MIN_MS);
        break;
      }
      default: mob.scorpionState='approach';
    }
  }

  // ── Starfish AI: passive wander/chase like any normal mob, but once HP
  // drops below 40% it turns and retreats a short distance from its target
  // instead, healing 5% max HP per second until it's back to full (100%)
  // HP. Pulled out of the generic movement loop (see the 'starfish' continue
  // above) purely because that loop has no concept of "flee" — normal
  // movement here otherwise mirrors the generic wander/chase pattern
  // exactly. ─────────────────────────────────────────────────────────────
  const STARFISH_FLEE_HP_FRAC   = 0.40;  // below this fraction of max HP, START fleeing
  const STARFISH_FLEE_HP_RECOVER= 1.00;  // heals all the way to full HP before it STOPS fleeing
  // (a gap between start/stop thresholds — "hysteresis" — so it doesn't
  // flicker in and out of flee state every tick right at the 40% line while
  // its own healing pushes HP back and forth across a single threshold)
  const STARFISH_FLEE_DIST      = 220;   // retreats to roughly this far from its target, then holds
  const STARFISH_HEAL_PCT_PER_S = 0.05;  // 5% of max HP per second while fleeing

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='starfish') continue;

    let targetX=playerX, targetY=playerY;
    let tDist=Math.hypot(playerX-mob.x, playerY-mob.y);
    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const pick = pickWaveTarget(mob, mob.x, mob.y, playerX, playerY);
      targetX = pick.targetX; targetY = pick.targetY; tDist = pick.dist; mob.waveTarget = pick.kind;
    }
    const dx=targetX-mob.x, dy=targetY-mob.y, dist=Math.hypot(dx,dy);
    if(dist>AI_CULL_DIST) continue;

    const isWaveNPCChase = isWaveMapMode() && mob.waveTarget !== 'player';
    if(mob.alerted && dist>DEAGGRO_DIST && !isWaveNPCChase){
      mob.alerted=false; mob.wanderAngle=mob.facing; mob.wanderTimer=800;
      mob.starfishFleeing=false;
    }

    const hpFrac = mob.maxHp>0 ? mob.hp/mob.maxHp : 1;
    // Sticky flee state: once triggered below STARFISH_FLEE_HP_FRAC, stays
    // fleeing until healed back up to STARFISH_FLEE_HP_RECOVER, rather than
    // re-checking the raw threshold every tick (see hysteresis note above).
    if(!mob.starfishFleeing && hpFrac < STARFISH_FLEE_HP_FRAC) mob.starfishFleeing = true;
    else if(mob.starfishFleeing && hpFrac >= STARFISH_FLEE_HP_RECOVER) mob.starfishFleeing = false;
    const fleeing = mob.alerted && mob.starfishFleeing && dist>0.01;

    if(fleeing){
      // Heal while fleeing, same "% of max HP per second" convention used
      // elsewhere (see regen-style effects) — capped at maxHp.
      mob.hp = Math.min(mob.maxHp, mob.hp + mob.maxHp*STARFISH_HEAL_PCT_PER_S*(dt/1000));
      // Retreat directly away from the target until STARFISH_FLEE_DIST clear,
      // then hold that distance (still healing) rather than fleeing forever.
      if(dist < STARFISH_FLEE_DIST){
        const nx=mob.x-(dx/dist)*mob.baseSpeed, ny=mob.y-(dy/dist)*mob.baseSpeed;
        if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
        else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
        else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
      }
      mob.lastX=mob.x; mob.lastY=mob.y;
      continue;
    }

    let chasing=false;
    if(mob.aggroRange>0&&dist<mob.aggroRange&&dist>0.01){chasing=true;mob.alerted=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else if(mob.alerted){chasing=true;mob.speed=mob.alertSpeed||mob.baseSpeed;}
    else mob.speed=mob.baseSpeed;

    const slowFactor = Math.max(getWebSlowdownFactor(mob.x, mob.y), getPincerSlowFactor(mob.id));
    mob.speed *= (1 - slowFactor);

    if(chasing && dist>0.01){
      const nx=mob.x+(dx/dist)*mob.speed, ny=mob.y+(dy/dist)*mob.speed;
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
      else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
      else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
    } else {
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){ mob.wanderAngle=Math.random()*Math.PI*2; mob.wanderTimer=1200+Math.random()*2500; }
      const nx=mob.x+Math.cos(mob.wanderAngle)*mob.speed, ny=mob.y+Math.sin(mob.wanderAngle)*mob.speed;
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
      else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
      else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
    }
    mob.lastX=mob.x; mob.lastY=mob.y;
  }

  // ── Debris AI: pure drift, no aggro, no target, no chase — ever. Picks a
  // random direction, holds it for a while, picks a new one, forever. Spins
  // continuously and slowly the whole time, independent of drift direction
  // (junk tumbling in the current doesn't necessarily face the way it's
  // moving). Deliberately has no aggroRange/alerted/waveTarget handling at
  // all — unlike jellyfish/crab/starfish, which all engage something once
  // in range, debris is inert scenery that merely happens to move. ────────
  const DEBRIS_SPIN_RATE = 0.006; // slow, lazy tumble — about 1 full turn every 1000 ticks
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='debris') continue;
    mob.wanderTimer-=dt;
    if(mob.wanderTimer<=0){ mob.wanderAngle=Math.random()*Math.PI*2; mob.wanderTimer=1500+Math.random()*3000; }
    const nx=mob.x+Math.cos(mob.wanderAngle)*mob.speed, ny=mob.y+Math.sin(mob.wanderAngle)*mob.speed;
    if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
    else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
    else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
    mob.facing=(mob.facing||0)+DEBRIS_SPIN_RATE;
    mob.lastX=mob.x; mob.lastY=mob.y;
  }

  // ── Bubble AI: pure drift, no aggro, no target, no chase — ever, even
  // after being hit. Same "inert scenery that merely happens to move"
  // design as debris above, but noticeably gentler/subtler: slower wander
  // speed, longer holds between direction changes, and no spin at all
  // (a bubble doesn't tumble the way a chunk of junk does). Previously
  // bubble had aggroRange:0 (so it never woke up UNTIL hit) but nothing
  // stopped it from chasing once mob.alerted got set by taking damage —
  // this removes that possibility entirely by never giving it a chasing
  // branch at all, matching "should never aggro, just drift" exactly. ────
  const BUBBLE_DRIFT_SPEED_MULT = 0.5; // drifts at half its already-slow base speed, for a subtler feel
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='bubble') continue;
    mob.wanderTimer-=dt;
    if(mob.wanderTimer<=0){ mob.wanderAngle=Math.random()*Math.PI*2; mob.wanderTimer=2500+Math.random()*4000; }
    const driftSpeed=mob.baseSpeed*BUBBLE_DRIFT_SPEED_MULT;
    const nx=mob.x+Math.cos(mob.wanderAngle)*driftSpeed, ny=mob.y+Math.sin(mob.wanderAngle)*driftSpeed;
    if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
    else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
    else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
    mob.lastX=mob.x; mob.lastY=mob.y;
  }

  // ── Shell AI: sits completely motionless until hit (aggroRange:0, so the
  // generic loop's proximity check never wakes it — only a petal hit setting
  // mob.alerted=true does). Once alerted, every SHELL_PUSH_INTERVAL (measured
  // from the START of one push to the START of the next, not gap-between-
  // pushes) it gets shoved toward its target: a real WALKED burst at
  // alertSpeed for SHELL_PUSH_DURATION, using the same canMoveTo checks
  // every other mob uses, NOT a teleport/position-snap — so it can genuinely
  // be blocked by a wall or held back mid-push, same as any other moving
  // mob. Between pushes it's fully still again, not sliding or drifting.
  // Also rotates to face its target once aggroed, using the same diff*0.08
  // smoothing convergence every other rotating mob (squid, alligator,
  // jellyfish) in this file already uses — this runs every tick it's
  // alerted, not just during the push windows, so it visibly turns to face
  // its target the instant it wakes up, before its first push even fires. ──
  const SHELL_PUSH_INTERVAL = 700;  // ms from one push's start to the next push's start
  const SHELL_PUSH_DURATION = 300;  // ms each push's walked burst lasts — bumped from 200 (+50%) for a "1.5x further per jump" request; same alertSpeed, just held for longer, so it still reads as walking rather than a faster dash
  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='shell') continue;
    if(!mob.alerted) continue; // stays fully motionless until a hit sets this externally

    let targetX=playerX, targetY=playerY;
    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const pick = pickWaveTarget(mob, mob.x, mob.y, playerX, playerY);
      targetX = pick.targetX; targetY = pick.targetY;
    }

    const facingDx=targetX-mob.x, facingDy=targetY-mob.y;
    if(Math.hypot(facingDx,facingDy)>0.01){
      const targetFacing=Math.atan2(facingDy,facingDx);
      let facingDiff=targetFacing-(mob.facing||0);
      if(facingDiff>Math.PI) facingDiff-=Math.PI*2;
      if(facingDiff<-Math.PI) facingDiff+=Math.PI*2;
      mob.facing=(mob.facing||0)+facingDiff*0.08;
    }

    // shellPushTimer counts down continuously (every tick, whether currently
    // pushing or idle) and fires a new push each time it crosses zero — this
    // is what makes SHELL_PUSH_INTERVAL a true "every 0.7s" cadence measured
    // start-to-start, rather than accidentally adding the push's own
    // duration on top of the gap between pushes.
    if(mob.shellPushTimer===undefined) mob.shellPushTimer = SHELL_PUSH_INTERVAL;
    if(mob.shellPushRemaining===undefined) mob.shellPushRemaining = 0;

    mob.shellPushTimer-=dt;
    if(mob.shellPushTimer<=0){
      mob.shellPushTimer+=SHELL_PUSH_INTERVAL; // += (not =) so any overshoot this tick doesn't drift the cadence
      mob.shellPushRemaining=SHELL_PUSH_DURATION;
      const ddx=targetX-mob.x, ddy=targetY-mob.y, ddist=Math.hypot(ddx,ddy);
      if(ddist>0.01){ mob.shellPushDirX=ddx/ddist; mob.shellPushDirY=ddy/ddist; }
      else { mob.shellPushDirX=0; mob.shellPushDirY=0; }
    }

    if(mob.shellPushRemaining>0){
      // Mid-push: walk toward the locked push direction at alertSpeed, same
      // canMoveTo fallback pattern as every other mob — a wall or being
      // otherwise blocked genuinely stops/holds it back, no forced movement.
      const dx=mob.shellPushDirX??0, dy=mob.shellPushDirY??0;
      const nx=mob.x+dx*mob.alertSpeed, ny=mob.y+dy*mob.alertSpeed;
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
      else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
      else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
      mob.shellPushRemaining-=dt;
    }
    mob.lastX=mob.x; mob.lastY=mob.y;
  }

  // ── Crab AI: scorpion-style stand-and-poke, but melee instead of ranged.
  // Approaches to a preferred distance and holds it, juking left-right while
  // it waits (facing stays locked on the target throughout, only the crab's
  // position slides side to side — same silhouette-facing convention as the
  // sideways-skitter its sprite/legPhase animation already implies), then
  // occasionally charges straight forward through the target and back,
  // structurally identical to scorpion's lunge (a real walked step at normal
  // speed, not a lerp/teleport) but melee: connecting relies on the generic
  // mob→player contact-damage pass in combat.js, no missile involved. ──────
  const CRAB_PREFERRED_DIST_MULT = 1.6;   // ×drawRadius — melee range: close enough that the side-to-side dodge stays a real threat, not scorpion's ranged stand-off
  const CRAB_DODGE_MIN_MS  = 700;         // irregular side-to-side dodge — min gap between direction flips
  const CRAB_DODGE_MAX_MS  = 1400;        // irregular side-to-side dodge — max gap between direction flips
  const CRAB_DODGE_SPEED_MULT = 1.6;      // dodge steps are quicker than its normal walk speed
  const CRAB_CHARGE_MIN_MS = 2400;        // min gap between charges
  const CRAB_CHARGE_MAX_MS = 5200;        // max gap between charges
  const CRAB_CHARGE_DIST_MULT = 1.2;      // charge reaches 20% further than the preferred stand-away distance

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='crab') continue;

    const crabPreferredDist = (mob.drawRadius ?? mob.radius ?? 22) * CRAB_PREFERRED_DIST_MULT;
    const crabChargeDist = crabPreferredDist * CRAB_CHARGE_DIST_MULT;

    let targetX=playerX, targetY=playerY;
    let dist=Math.hypot(playerX-mob.x, playerY-mob.y);
    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead) {
      const dnpc=Math.hypot(_npcTarget.x-mob.x, _npcTarget.y-mob.y);
      if(dnpc<dist){ targetX=_npcTarget.x; targetY=_npcTarget.y; dist=dnpc; }
    }
    const dx=targetX-mob.x, dy=targetY-mob.y;
    if(dist>AI_CULL_DIST) continue;

    if(mob.alerted && dist>DEAGGRO_DIST){
      mob.alerted=false; mob.crabState='idle';
      mob.wanderAngle=mob.facing; mob.wanderTimer=800;
    }
    if(!mob.alerted && dist<mob.aggroRange){
      mob.alerted=true; mob.crabState='approach';
      mob.crabDodgeTimer = CRAB_DODGE_MIN_MS + Math.random()*(CRAB_DODGE_MAX_MS-CRAB_DODGE_MIN_MS);
      mob.crabDodgeDir = Math.random()<0.5 ? -1 : 1;
      mob.crabChargeTimer = CRAB_CHARGE_MIN_MS + Math.random()*(CRAB_CHARGE_MAX_MS-CRAB_CHARGE_MIN_MS);
    }

    if(!mob.alerted){
      mob.wanderTimer-=dt;
      if(mob.wanderTimer<=0){ mob.wanderAngle=Math.random()*Math.PI*2; mob.wanderTimer=1200+Math.random()*2500; }
      const preWx=mob.x, preWy=mob.y;
      const nx=mob.x+Math.cos(mob.wanderAngle)*mob.speed*0.45;
      const ny=mob.y+Math.sin(mob.wanderAngle)*mob.speed*0.45;
      if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
      else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
      else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
      let fd=mob.wanderAngle-mob.facing;
      if(fd>Math.PI)fd-=Math.PI*2; if(fd<-Math.PI)fd+=Math.PI*2;
      mob.facing+=Math.sign(fd)*Math.min(Math.abs(fd),0.08);
      // Legs keep shuffling while wandering too, not just while aggroed —
      // same speed-scaled convention used everywhere else in this block.
      const wspd=Math.hypot(mob.x-preWx, mob.y-preWy);
      if(wspd>0.05){
        const speedFactor=Math.min(4.0, wspd/mob.baseSpeed*2.5);
        mob.legPhase=(mob.legPhase??0)+0.20*Math.max(1, speedFactor);
      }
      continue;
    }

    const angleToTarget=Math.atan2(dy,dx);
    function crabRotateTo(target){
      let fd=target-mob.facing;
      if(fd>Math.PI)fd-=Math.PI*2; if(fd<-Math.PI)fd+=Math.PI*2;
      mob.facing+=Math.sign(fd)*Math.min(Math.abs(fd),0.08);
    }

    // ── Charge takes priority over everything else while active ───────────
    if(mob.crabState==='charge'){
      const preCx=mob.x, preCy=mob.y;
      mob.crabChargeElapsed=(mob.crabChargeElapsed??0)+dt;
      mob.crabChargeTraveled=(mob.crabChargeTraveled??0);
      const movingOut = !mob.crabChargeReturning;
      mob.facing=mob.crabChargeAngle; // locked for the whole charge, same as scorpion's lunge
      const stepAngle = movingOut ? mob.crabChargeAngle : mob.crabChargeAngle+Math.PI;
      const lx=mob.x+Math.cos(stepAngle)*mob.speed;
      const ly=mob.y+Math.sin(stepAngle)*mob.speed;
      const moved=canMoveTo(lx,ly,mob.radius);
      if(moved){ mob.x=lx; mob.y=ly; mob.crabChargeTraveled+=mob.speed; }
      else { mob.crabChargeTraveled=crabChargeDist; }
      if(movingOut && mob.crabChargeTraveled>=crabChargeDist){
        mob.crabChargeReturning=true;
        mob.crabChargeTraveled=0;
      }
      {
        const cspd=Math.hypot(mob.x-preCx, mob.y-preCy);
        const speedFactor=Math.min(4.0, cspd/mob.baseSpeed*2.5);
        mob.legPhase=(mob.legPhase??0)+0.24*Math.max(1, speedFactor);
      }
      const chargeStuck = mob.crabChargeElapsed > 4000;
      if((mob.crabChargeReturning && mob.crabChargeTraveled>=crabChargeDist) || chargeStuck){
        mob.crabState='hold';
        mob.crabChargeElapsed=0;
        mob.crabChargeTraveled=0;
        mob.crabChargeReturning=false;
        mob.crabChargeTimer = CRAB_CHARGE_MIN_MS + Math.random()*(CRAB_CHARGE_MAX_MS-CRAB_CHARGE_MIN_MS);
      }
      continue;
    }

    switch(mob.crabState){
      case 'approach': {
        if(dist>crabPreferredDist){
          const preAx=mob.x, preAy=mob.y;
          const nx=mob.x+(dx/dist)*mob.speed, ny=mob.y+(dy/dist)*mob.speed;
          if(canMoveTo(nx,ny,mob.radius)){mob.x=nx;mob.y=ny;}
          else if(canMoveTo(nx,mob.y,mob.radius)){mob.x=nx;}
          else if(canMoveTo(mob.x,ny,mob.radius)){mob.y=ny;}
          const aspd=Math.hypot(mob.x-preAx, mob.y-preAy);
          const speedFactor=Math.min(4.0, aspd/mob.baseSpeed*2.5);
          mob.legPhase=(mob.legPhase??0)+0.20*Math.max(1, speedFactor);
        }
        crabRotateTo(angleToTarget);
        if(dist<=crabPreferredDist){ mob.crabState='hold'; }
        break;
      }
      case 'hold': {
        if(dist > crabPreferredDist * 2){
          mob.crabState='approach';
          break;
        }
        crabRotateTo(angleToTarget);

        // Quick side-to-side dodge while holding ground: steps mostly
        // perpendicular to the facing direction, flipping which way every
        // CRAB_DODGE_MIN/MAX_MS. Also gently corrects toward crabPreferredDist
        // (blended in alongside the perpendicular step, not a separate
        // accept/reject gate) so a charge that comes back slightly off
        // distance — e.g. the target moved mid-charge — self-corrects over
        // the next dodge or two instead of ever getting permanently stuck
        // between the preferred distance and the 2x re-approach threshold.
        mob.crabDodgeTimer=(mob.crabDodgeTimer??1000)-dt;
        if(mob.crabDodgeTimer<=0){
          mob.crabDodgeDir = -(mob.crabDodgeDir ?? 1); // flip direction
          mob.crabDodgeTimer = CRAB_DODGE_MIN_MS + Math.random()*(CRAB_DODGE_MAX_MS-CRAB_DODGE_MIN_MS);
        }
        {
          const perpAngle = mob.facing + Math.PI/2;
          const preDx=mob.x, preDy=mob.y;
          const dodgeSpeed = mob.speed * CRAB_DODGE_SPEED_MULT;
          // Radial correction toward crabPreferredDist, capped at a fraction
          // of the dodge step so it reads as a lateral juke with a slight
          // drift-correction, not a snap back to distance.
          const distErr = dist - crabPreferredDist; // >0 too far, <0 too close
          const radialStep = Math.max(-dodgeSpeed*0.6, Math.min(dodgeSpeed*0.6, distErr*0.15));
          const radialX = dist>0.01 ? (dx/dist)*radialStep : 0;
          const radialY = dist>0.01 ? (dy/dist)*radialStep : 0;
          const nx=mob.x+Math.cos(perpAngle)*mob.crabDodgeDir*dodgeSpeed+radialX;
          const ny=mob.y+Math.sin(perpAngle)*mob.crabDodgeDir*dodgeSpeed+radialY;
          if(canMoveTo(nx,ny,mob.radius)){ mob.x=nx; mob.y=ny; }
          else if(canMoveTo(nx,mob.y,mob.radius)){ mob.x=nx; }
          else if(canMoveTo(mob.x,ny,mob.radius)){ mob.y=ny; }
          const dspd=Math.hypot(mob.x-preDx, mob.y-preDy);
          const speedFactor=Math.min(4.0, dspd/mob.baseSpeed*2.5);
          if(dspd>0.05) mob.legPhase=(mob.legPhase??0)+0.20*Math.max(1, speedFactor);
        }

        // Occasional forward charge, biased toward the target like scorpion's lunge
        mob.crabChargeTimer=(mob.crabChargeTimer??3000)-dt;
        if(mob.crabChargeTimer<=0){
          mob.crabState='charge';
          mob.crabChargeElapsed=0;
          mob.crabChargeAngle=angleToTarget+(Math.random()-0.5)*0.5;
        }
        break;
      }
      default: mob.crabState='approach';
    }
  }

  // ── Jellyfish AI: fires an instant lightning zap at whatever it's aggroed
  // to once in range — can fire while drifting/moving (unlike scorpion, no
  // need to hold still first). Movement itself is still handled entirely by
  // the generic wander/chase loop above; this only layers a ranged attack on
  // top, so jellyfish is not excluded from that loop the way crab/starfish
  // are. Damage is NOT applied directly here — mobs.js has no existing path
  // that touches player.hp/npc.hp/pet.hp, and preserving that boundary means
  // invincibility/disc-block/game-over all stay handled in one place. Instead
  // this just queues the strike; combat.js's updateCombat (which runs right
  // after updateMobs, same frame — see main.js) resolves it and applies the
  // real damage, exactly like every other player-damage path already does.
  //
  // Fires on a fixed 0.5s cadence (no randomized gap, unlike scorpion/crab).
  // Zap and chain range both scale off mob.aggroRange, which is already
  // tier-scaled by AGGRO_TIER_SCALE in spawnMob — so a higher-rarity
  // jellyfish naturally reaches further with both its initial strike and its
  // chain, in the same proportion its aggro range grows. Ratios below match
  // the original fixed values at tier 0 (aggroRange 300): 260/300 for zap,
  // 140/300 for chain. ──────────────────────────────────────────────────
  const JELLYFISH_ZAP_INTERVAL_MS = 500;   // fixed cadence — fires every 0.5s once in range
  const JELLYFISH_ZAP_RANGE_FRAC   = 260/300; // × mob.aggroRange
  const JELLYFISH_CHAIN_RANGE_FRAC = 140/300; // × mob.aggroRange — a friendly pet within this range of the PRIMARY target also gets zapped

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead||mob.typeId!=='jellyfish'||!mob.alerted) continue;
    // Friendly jellyfish pets never zap players — their own zap (combat.js)
    // only ever targets hostile mobs.
    if(mob.isFriendlyPet) continue;
    // Never queue a zap while the player is dead — combat.js's updateCombat
    // (the only place that drains pendingJellyfishZaps) is skipped entirely
    // while player.dead, so without this guard the queue grows unbounded
    // for as long as the death screen is up and any jellyfish stays alerted.
    if(player.dead) continue;

    let targetX=playerX, targetY=playerY, targetKind='player';
    let dist=Math.hypot(playerX-mob.x, playerY-mob.y);
    // mob.waveTarget is already maintained by the generic wander/chase loop
    // above (which jellyfish still passes through for movement) — just read
    // it here rather than re-deriving the player/NPC choice.
    if (isWaveMapMode() && _npcTarget && !_npcTarget.dead && mob.waveTarget!=='player') {
      targetX=_npcTarget.x; targetY=_npcTarget.y; targetKind='npc';
      dist=Math.hypot(_npcTarget.x-mob.x, _npcTarget.y-mob.y);
    }

    const zapRange = (mob.aggroRange||300) * JELLYFISH_ZAP_RANGE_FRAC;
    const chainRange = (mob.aggroRange||300) * JELLYFISH_CHAIN_RANGE_FRAC;

    if(mob.jellyfishZapTimer===undefined){
      mob.jellyfishZapTimer = JELLYFISH_ZAP_INTERVAL_MS;
    }
    // Only counts down while actually in range — same convention as
    // scorpion's fire timer, which only ticks in its 'hold' state. Without
    // this, a jellyfish walking toward its target could "bank" cooldown
    // progress while still out of range and fire almost immediately the
    // instant it arrives, rather than a clean 0.5s cadence from first contact.
    if(dist>zapRange) continue;
    mob.jellyfishZapTimer -= dt;
    if(mob.jellyfishZapTimer>0) continue;
    mob.jellyfishZapTimer = JELLYFISH_ZAP_INTERVAL_MS;

    // Chain target: nearest living friendly pet within chainRange of the
    // PRIMARY target (not the jellyfish, not the player specifically — it
    // bounces off whoever/whatever got hit first).
    let chainMobId=null, chainX=null, chainY=null, bestD=chainRange;
    for(const pet of mobs){
      if(pet.dead||!pet.isFriendlyPet) continue;
      const pd=Math.hypot(pet.x-targetX, pet.y-targetY);
      if(pd<bestD){ bestD=pd; chainMobId=pet.id; chainX=pet.x; chainY=pet.y; }
    }

    pendingJellyfishZaps.push({
      jellyfishId: mob.id,
      fromX: mob.x, fromY: mob.y,
      targetKind, targetX, targetY,
      targetPlayerId: targetKind === 'player' ? player.id : null,
      damage: mob.damage*0.8,
      chainMobId, chainX, chainY,
    });
  }

  // ── Missile updates (movement + lifetime, see missiles.js) ─────────────────
  updateMissiles(dt);

  // ── Mob-mob pushing ──────────────────────────────────────────────────────
  // Uniform grid sized from the LARGEST live collider each frame: CELL = 2×maxRadius,
  // so any overlapping pair (dist < ra+rb ≤ CELL) is always in the same or an
  // adjacent cell. (Was a fixed 6000 from an old size table — so big that the
  // "grid" held nearly every mob in one 3×3 block, i.e. an all-pairs O(n²) check
  // ×10 iterations per frame, which is what tanked FPS when lots of mobs spawned.)
  // Only the 4 "forward" neighbours are visited so each cross-cell pair is pushed
  // once per iteration, same as same-cell pairs. Grid is rebuilt each iteration so
  // mobs that crossed cell boundaries are found; iterations stop early once settled.
  //
  // Wall-pinning fix: when one mob is blocked by a wall it can't absorb its share
  // of the overlap, so the free mob now absorbs the FULL overlap instead of just
  // its proportional share. This makes crowds properly push things against walls
  // rather than phasing through them.
  const colliders=[];
  let maxColliderR=0;
  for(const mob of mobs){
    if(mob.dead) continue;
    if(NO_MOB_COLLISION_TYPES.has(mob.typeId)) continue;  // eggs never push or get pushed
    mob._isStructure=MOB_STRUCTURE_TYPES.has(mob.typeId);
    colliders.push(mob);
    if(mob.radius>maxColliderR) maxColliderR=mob.radius;
  }
  const CELL=Math.max(64, maxColliderR*2);
  const FORWARD_NEIGHBOURS=[[1,-1],[1,0],[1,1],[0,1]];
  for(let iter=0;iter<10;iter++){
    let anyPush=false;
    const grid=new Map();
    for(const mob of colliders){
      if(mob.dead) continue;
      const cx=Math.floor(mob.x/CELL), cy=Math.floor(mob.y/CELL), key=cx*100000+cy;
      let cell=grid.get(key);
      if(!cell){ cell=[]; grid.set(key,cell); }
      cell.push(mob);
    }
    for(const [key,cell] of grid){
      const cx=Math.floor(key/100000), cy=key%100000;
      const neighbours=[cell];
      for(const [ox,oy] of FORWARD_NEIGHBOURS){
        const n=grid.get((cx+ox)*100000+(cy+oy)); if(n) neighbours.push(n);
      }
      for(let ni=0;ni<neighbours.length;ni++){
        const other=neighbours[ni];
        for(let i=0;i<cell.length;i++){
          const a=cell[i];
          for(let j=(ni===0?i+1:0);j<other.length;j++){
            const b=other[j];
            if(a===b||a.dead||b.dead) continue;
            // Structures (ant_hole, beehive, pyramid, …) have no mob-mob collision — EXCEPT friendly pets do collide with them
            if((a._isStructure||b._isStructure)&&!(a.isFriendlyPet||b.isFriendlyPet)) continue;
            // Other friendly pets pass straight through friendly sandstorm pets (Stick's shield) —
            // hostile mobs still collide with them normally.
            const aIsFriendlySandstorm = a.isFriendlyPet && a.typeId==='sandstorm';
            const bIsFriendlySandstorm = b.isFriendlyPet && b.typeId==='sandstorm';
            if(aIsFriendlySandstorm && b.isFriendlyPet && b.typeId!=='sandstorm') continue;
            if(bIsFriendlySandstorm && a.isFriendlyPet && a.typeId!=='sandstorm') continue;
            const sameChain=a.chainId!=null&&a.chainId===b.chainId;
            const dx=b.x-a.x, dy=b.y-a.y, minD=a.radius+b.radius;
            if(dx>=minD||dx<=-minD||dy>=minD||dy<=-minD) continue;  // cheap reject before the sqrt
            const dist=Math.hypot(dx,dy);
            if(dist>=minD||dist<0.001) continue;
            anyPush=true;
            if(sameChain){
              const idxDiff=Math.abs((a.segIndex??0)-(b.segIndex??0));
              if(idxDiff<=1){
                // Adjacent segments — soft push at reduced strength to prevent clipping without fighting the follow logic
                const nx=dx/dist, ny=dy/dist, overlap=minD-dist, total=a.mass+b.mass;
                const strength=0.35; // gentler than full push
                const ax2=a.x-nx*overlap*(b.mass/total)*strength, ay2=a.y-ny*overlap*(b.mass/total)*strength;
                const bx2=b.x+nx*overlap*(a.mass/total)*strength, by2=b.y+ny*overlap*(a.mass/total)*strength;
                if(canMoveTo(ax2,ay2,a.radius)){a.x=ax2;a.y=ay2;}
                if(canMoveTo(bx2,by2,b.radius)){b.x=bx2;b.y=by2;}
                continue;
              }
              // Non-adjacent same-chain segments — full collision push (fall through)
            }
            const nx=dx/dist, ny=dy/dist, overlap=minD-dist, total=a.mass+b.mass;
            const ax=a.x-nx*overlap*(b.mass/total), ay=a.y-ny*overlap*(b.mass/total);
            const bx=b.x+nx*overlap*(a.mass/total), by=b.y+ny*overlap*(a.mass/total);
            const aCanMove=canMoveTo(ax,ay,a.radius);
            const bCanMove=canMoveTo(bx,by,b.radius);
            if(aCanMove&&bCanMove){
              a.x=ax;a.y=ay;b.x=bx;b.y=by;
            } else if(aCanMove&&!bCanMove){
              // b is wall-blocked — push a the full overlap so nothing is lost
              const ax2=a.x-nx*overlap, ay2=a.y-ny*overlap;
              if(canMoveTo(ax2,ay2,a.radius)){a.x=ax2;a.y=ay2;}
              else{a.x=ax;a.y=ay;} // wall on both sides, take a's share at minimum
            } else if(!aCanMove&&bCanMove){
              // a is wall-blocked — push b the full overlap so nothing is lost
              const bx2=b.x+nx*overlap, by2=b.y+ny*overlap;
              if(canMoveTo(bx2,by2,b.radius)){b.x=bx2;b.y=by2;}
              else{b.x=bx;b.y=by;} // wall on both sides, take b's share at minimum
            }
            // both wall-blocked: nothing to be done
          }
        }
      }
    }
    if(!anyPush) break;  // nothing overlapped this pass — further passes would be no-ops
  }

  // ── Facing & animation for regular mobs ───────────────────────────────────
  for(const mob of mobs){
    if(mob.dead||mob.isCentipede||mob.typeId==='hornet') continue;
    if(mob.typeId==='ant_hole'||mob.typeId==='ant_egg'||mob.typeId==='spider_egg'||mob.typeId==='beehive'||mob.typeId==='fire_ant_hole'||mob.typeId==='fire_ant_egg') continue;
    if(mob.typeId==='scorpion'||mob.typeId==='pyramid'||mob.typeId==='rock'||mob.typeId==='dandelion') continue;  // facing handled in their own AI loops
    if(mob.typeId==='crab') continue;  // facing/legPhase handled in its own AI loop, scorpion-style
    if(mob.typeId==='sponge'||mob.typeId==='sea_cave') continue;  // static ocean scenery
    if(mob.typeId==='shell') continue;  // facing handled in its own dedicated AI loop below
    if(mob.typeId==='debris') continue;  // facing (constant slow spin) handled in its own AI loop, no target-facing convergence
    if(mob.typeId==='bubble') continue;  // round with no directional art — no facing rotation needed at all
    let diff=mob.targetFacing-mob.facing;
    if(diff>Math.PI) diff-=Math.PI*2; if(diff<-Math.PI) diff+=Math.PI*2;
    if(mob.typeId==='spider'){
      mob.facing+=diff*0.08;
      const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
      if(spd>0.05) mob.legPhase+=0.07;
    } else if(mob.typeId==='bee'||mob.typeId==='queen_bee'){
      // Face targetFacing (set by AI) with smooth rotation.
      // Do NOT derive facing from (x - lastX) — collision pushes corrupt those deltas
      // and cause random rotation flips when touching other mobs.
      let diff2 = mob.targetFacing - mob.facing;
      if(diff2 > Math.PI) diff2 -= Math.PI*2; if(diff2 < -Math.PI) diff2 += Math.PI*2;
      mob.facing += diff2 * 0.08;
      // Wobble: a lazy sway while hovering that quickens as the bee speeds
      // up (drawBee turns this into the body's sway — see beeWobble there)
      const moved = Math.hypot(mob.x - (mob.lastX ?? mob.x), mob.y - (mob.lastY ?? mob.y));
      const pace = Math.min(1, moved / Math.max(0.01, mob.alertSpeed || mob.baseSpeed || 1));
      mob.wobblePhase = (mob.wobblePhase || 0) + 0.09 + 0.09 * pace;
      mob.lastX = mob.x; mob.lastY = mob.y;
      // hitbox follows the drawn sway (same curve as beeWobble in mobDrawing.js)
      const sway = Math.sin(mob.wobblePhase) * 0.2 + Math.sin(mob.wobblePhase * 0.5 + 0.7) * 0.06;
      mob.swayHitX = sway * (mob.drawRadius || mob.radius) * 0.55;
    } else if(mob.isAntMob){
      mob.facing+=diff*0.08;
      const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
      if(spd>0.05){
        // Scale animation speed with movement: faster movement = faster mandible chatter & wing flap
        const speedFactor=Math.min(4.0, spd/mob.baseSpeed * 2.5);
        mob.pincerPhase=(mob.pincerPhase||0)+0.18*speedFactor;
        mob.wingPhase  =(mob.wingPhase  ||0)+0.14*speedFactor;
      }
    } else if(mob.isFireAntMob){
      mob.facing+=diff*0.08;
      const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
      if(spd>0.05){
        const speedFactor=Math.min(4.0, spd/mob.baseSpeed * 2.5);
        mob.pincerPhase=(mob.pincerPhase||0)+0.18*speedFactor;
        mob.wingPhase  =(mob.wingPhase  ||0)+0.14*speedFactor;
      }
    } else if(mob.typeId==='beetle'||mob.typeId==='mummified_beetle'){
      mob.facing+=diff*0.08;
      const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
      if(spd>0.05){
        // Pincer animation: scale with speed so faster movement = faster clacking.
        // Shared with Mummified Beetle since it uses the identical draw code/animation.
        // Kept slow — mandibles open/close at a relaxed pace.
        const speedFactor=Math.min(4.0, spd/mob.baseSpeed * 2.5);
        mob.pincerPhase=(mob.pincerPhase||0)+0.10*speedFactor;
      }
    } else if(mob.typeId==='squid'){
      mob.facing+=diff*0.08;
      const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
      // Tentacles keep a slow idle sway even at rest, and speed up when jetting.
      const speedFactor=spd>0.05 ? Math.min(4.0, spd/mob.baseSpeed * 2.5) : 1;
      mob.tentaclePhase=(mob.tentaclePhase||0)+0.05*speedFactor;
    } else if(mob.typeId==='alligator'){
      mob.facing+=diff*0.08;
      const spd=Math.hypot(mob.x-(mob.lastX||mob.x),mob.y-(mob.lastY||mob.y));
      // Tail swing + foot shuffle keep a slow idle motion even at rest, same
      // as squid's tentacles, and speed up when lunging.
      const speedFactor=spd>0.05 ? Math.min(4.0, spd/mob.baseSpeed * 2.5) : 1;
      mob.tailPhase=(mob.tailPhase||0)+0.05*speedFactor;
    } else if(mob.typeId==='jellyfish'){
      // Rotates toward whatever it's chasing, same smoothing rate as every
      // other mob (squid/alligator/etc. above) — now that drawJellyfish
      // accepts a facing param, this is visible even though the tentacle
      // ring and dot marking don't individually have a "front" (see the
      // comment on drawJellyfish for why the combined shape still reads).
      mob.facing+=diff*0.08;
      // Tentacles always undulate, whether it's drifting or holding still.
      mob.tentaclePhase=(mob.tentaclePhase||0)+0.06;
    } else if(mob.typeId==='starfish'){
      // Barely moves and has no real "direction of travel", so instead of
      // chasing targetFacing, spin continuously in place.
      mob.facing=(mob.facing||0)+0.03;
    } else if(mob.typeId==='leech'){
      // Turns toward its target same as every other regular mob; the
      // fang-vibration jitter (leechAnimPhase) runs continuously and
      // independently of movement, same convention as tentaclePhase above —
      // pincers twitch at the head whether or not the body is currently moving.
      mob.facing+=diff*0.08;
      mob.leechAnimPhase=(mob.leechAnimPhase||0)+0.05;
    } else if(mob.typeId==='sandstorm'){
      // Sandstorm facing is already smoothed in its own AI loop; skip generic update
    } else if(mob.isDesertCentipede || mob.typeId==='cactus'){
      // Desert centipede facing handled in its own AI loop; cactus is static
    } else {
      mob.facing+=diff*0.07;
    }
    mob.lastX=mob.x; mob.lastY=mob.y;
  }

  // ── Spider egg hatching ────────────────────────────────────────────────────
  // After 4s, spider eggs despawn and spawn 3 spiders one tier below (min tier 0).
  for(const mob of mobs){
    if(mob.dead || mob.typeId !== 'spider_egg') continue;
    mob.spiderEggHatchTimer -= dt;
    if(mob.spiderEggHatchTimer <= 0){
      mob.dead = true;
      const spawnTier = Math.max(0, (mob.ownerTier ?? mob.tier ?? 0) - 1);
      for(let i = 0; i < 3; i++){
        const angle = (Math.PI * 2 / 3) * i;
        const ox = Math.cos(angle) * (mob.radius * 2);
        const oy = Math.sin(angle) * (mob.radius * 2);
        const baby = spawnMob('spider', mob.x + ox, mob.y + oy, mob.homeZoneId, spawnTier);
        if(baby) baby.alerted = true;
      }
    }
  }

  // ── Ant egg hatching ──────────────────────────────────────────────────────
  // After 3.5s, each egg dies and spawns a soldier ant of the same tier.
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='ant_egg') continue;
    // Apply outward launch drift from queen spin burst
    if(mob._launchVx || mob._launchVy){
      const lnx = mob.x + (mob._launchVx ?? 0), lny = mob.y + (mob._launchVy ?? 0);
      // ~25% chance to pass through walls (egg lands inside wall)
      if(canMoveTo(lnx, lny, mob.radius) || Math.random() < 0.25){
        mob.x = lnx; mob.y = lny;
      }
      // Decay velocity so egg settles (slower decay = travels farther)
      mob._launchVx = (mob._launchVx ?? 0) * 0.88;
      mob._launchVy = (mob._launchVy ?? 0) * 0.88;
      if(Math.hypot(mob._launchVx, mob._launchVy) < 0.1){ mob._launchVx = 0; mob._launchVy = 0; }
    }
    mob.eggHatchTimer=(mob.eggHatchTimer??3500)-dt;
    if(mob.eggHatchTimer<=0){
      // isHigherTierEgg flag: hatch soldier one tier higher (from queen boss spin burst)
      const hatchTier = mob.isHigherTierEgg ? Math.min(13, (mob.tier ?? 0) + 1) : (mob.tier ?? 0);
      const soldier=spawnAntMinion('soldier_ant',mob.x,mob.y,mob.homeX??mob.x,mob.homeY??mob.y,mob.homeZoneId,hatchTier);
      if(soldier && isWaveMapMode()) addTrackedMob(soldier.id);
      mob.dead=true;
    }
  }

  // ── Fire ant egg hatching ─────────────────────────────────────────────────
  for(const mob of mobs){
    if(mob.dead||mob.typeId!=='fire_ant_egg') continue;
    // Apply outward launch drift from fire queen spin burst (same as ant_egg)
    if(mob._launchVx || mob._launchVy){
      const lnx = mob.x + (mob._launchVx ?? 0), lny = mob.y + (mob._launchVy ?? 0);
      if(canMoveTo(lnx, lny, mob.radius) || Math.random() < 0.25){
        mob.x = lnx; mob.y = lny;
      }
      mob._launchVx = (mob._launchVx ?? 0) * 0.88;
      mob._launchVy = (mob._launchVy ?? 0) * 0.88;
      if(Math.hypot(mob._launchVx, mob._launchVy) < 0.1){ mob._launchVx = 0; mob._launchVy = 0; }
    }
    mob.eggHatchTimer=(mob.eggHatchTimer??3500)-dt;
    if(mob.eggHatchTimer<=0){
      // isHigherTierEgg flag: hatch soldier one tier higher (from fire queen boss spin burst)
      const hatchTier = mob.isHigherTierEgg ? Math.min(13, (mob.tier ?? 0) + 1) : (mob.tier ?? 0);
      const soldier=spawnFireAntMinion('fire_soldier_ant',mob.x,mob.y,mob.homeX??mob.x,mob.homeY??mob.y,mob.homeZoneId,hatchTier);
      if(soldier && isWaveMapMode()) addTrackedMob(soldier.id);
      mob.dead=true;
    }
  }

  // ── Bee boss — orbiting stinger ability ───────────────────────────────────
  const BEE_STINGER_COOLDOWN  = 15000; // ms between spawns
  const BEE_STINGER_COUNT     = 4;
  const BEE_STINGER_ORBIT_SPD = 0.0022; // radians per ms (~2 full rotations per 15s)

  for(const mob of mobs){
    if(mob.dead || mob.typeId !== 'bee' || !mob.isBoss) continue;

    // Init timer
    if(mob.beeStingerTimer === undefined) mob.beeStingerTimer = BEE_STINGER_COOLDOWN;
    mob.beeStingerTimer -= dt;

    // Advance orbit angle for any stingers already bound to this bee
    for(const s of bossStingers){
      if(s.dead || s.ownerId !== mob.id) continue;
      s.orbitAngle += BEE_STINGER_ORBIT_SPD * dt;
      const orbitR = (mob.drawRadius ?? mob.radius) * 2.2;
      s.x = mob.x + Math.cos(s.orbitAngle) * orbitR;
      s.y = mob.y + Math.sin(s.orbitAngle) * orbitR;
    }

    if(mob.beeStingerTimer <= 0){
      mob.beeStingerTimer = BEE_STINGER_COOLDOWN;

      // Collect surviving stingers from previous cycle
      const survivors = bossStingers.filter(s => !s.dead && s.ownerId === mob.id);
      const total = survivors.length + BEE_STINGER_COUNT;
      const orbitR = (mob.drawRadius ?? mob.radius) * 2.2;
      // Redistribute all (survivors + new) evenly around the orbit
      const allStingers = [...survivors];
      for(let i = 0; i < BEE_STINGER_COUNT; i++){
        const startAngle = (Math.PI * 2 / total) * (survivors.length + i);
        const stingerR = Math.max(5, Math.round((mob.drawRadius ?? mob.radius) * 0.35));
        const dmg = (mob.damage ?? 10) * 2; // high damage
        const hp  = 1; // single hit to destroy
        bossStingers.push({
          id: ++_bossStingerNextId,
          ownerId: mob.id,
          orbitAngle: startAngle,
          x: mob.x + Math.cos(startAngle) * orbitR,
          y: mob.y + Math.sin(startAngle) * orbitR,
          radius: stingerR,
          hp, maxHp: hp,
          damage: dmg,
          dead: false,
        });
        allStingers.push(bossStingers[bossStingers.length - 1]);
      }
      // Re-space all (survivors included) evenly
      for(let i = 0; i < allStingers.length; i++){
        allStingers[i].orbitAngle = (Math.PI * 2 / allStingers.length) * i;
      }
    }
  }

  // Clean up dead boss stingers
  for(let i = bossStingers.length - 1; i >= 0; i--){
    if(bossStingers[i].dead) bossStingers.splice(i, 1);
  }

  // ── Cactus boss — orbiting stingers (same as boss bee) + unlimited-range ram ──
  const CACTUS_STINGER_COOLDOWN  = 15000; // ms between spawns, same cadence as boss bee
  const CACTUS_STINGER_COUNT     = 4;
  const CACTUS_STINGER_ORBIT_SPD = 0.0022; // radians per ms, same as boss bee
  const CACTUS_RAM_COOLDOWN      = 10000; // ms between rams
  const CACTUS_RAM_SPEED         = 31.25; // px/frame — crosses the wave map diagonal (7500) in ~4s

  for(const mob of mobs){
    const player = targetPlayerFor(mob), playerX = player.x, playerY = player.y;
    if(mob.dead || mob.typeId !== 'cactus' || !mob.isBoss) continue;

    // Orbiting stingers — identical mechanic to boss bee, just owned by the cactus
    if(mob.cactusStingerTimer === undefined) mob.cactusStingerTimer = CACTUS_STINGER_COOLDOWN;
    mob.cactusStingerTimer -= dt;

    for(const s of bossStingers){
      if(s.dead || s.ownerId !== mob.id) continue;
      s.orbitAngle += CACTUS_STINGER_ORBIT_SPD * dt;
      const orbitR = (mob.drawRadius ?? mob.radius) * 2.2;
      s.x = mob.x + Math.cos(s.orbitAngle) * orbitR;
      s.y = mob.y + Math.sin(s.orbitAngle) * orbitR;
    }

    if(mob.cactusStingerTimer <= 0){
      mob.cactusStingerTimer = CACTUS_STINGER_COOLDOWN;
      const survivors = bossStingers.filter(s => !s.dead && s.ownerId === mob.id);
      const total = survivors.length + CACTUS_STINGER_COUNT;
      const orbitR = (mob.drawRadius ?? mob.radius) * 2.2;
      const allStingers = [...survivors];
      for(let i = 0; i < CACTUS_STINGER_COUNT; i++){
        const startAngle = (Math.PI * 2 / total) * (survivors.length + i);
        const stingerR = Math.max(5, Math.round((mob.drawRadius ?? mob.radius) * 0.35));
        const dmg = (mob.damage ?? 10) * 2;
        const hp  = 1;
        bossStingers.push({
          id: ++_bossStingerNextId,
          ownerId: mob.id,
          orbitAngle: startAngle,
          x: mob.x + Math.cos(startAngle) * orbitR,
          y: mob.y + Math.sin(startAngle) * orbitR,
          radius: stingerR,
          hp, maxHp: hp,
          damage: dmg,
          dead: false,
        });
        allStingers.push(bossStingers[bossStingers.length - 1]);
      }
      for(let i = 0; i < allStingers.length; i++){
        allStingers[i].orbitAngle = (Math.PI * 2 / allStingers.length) * i;
      }
    }

    // Unlimited-range ram — every 10s, zooms straight to whoever it's "aggroed"
    // to (player, or the nearer NPC in wave mode, same targeting every other
    // boss uses) from wherever it currently sits. Permanently relocates to
    // wherever the ram ends — it does not snap back afterward.
    if(mob.cactusRamTimer === undefined) mob.cactusRamTimer = CACTUS_RAM_COOLDOWN;

    if(mob.isRamming){
      const rdx = mob.cactusRamTargetX - mob.x, rdy = mob.cactusRamTargetY - mob.y;
      const rdist = Math.hypot(rdx, rdy);
      if(rdist <= CACTUS_RAM_SPEED || rdist < 1){
        mob.x = mob.cactusRamTargetX; mob.y = mob.cactusRamTargetY;
        mob.isRamming = false;
        mob.cactusRamTimer = CACTUS_RAM_COOLDOWN;
      } else {
        const rnx = rdx / rdist, rny = rdy / rdist;
        const nrx = mob.x + rnx * CACTUS_RAM_SPEED, nry = mob.y + rny * CACTUS_RAM_SPEED;
        mob.x = nrx; mob.y = nry; // structure — no canMoveTo wall-blocking check, matches its own static hitbox never needing one before
        mob.facing = Math.atan2(rny, rnx);
      }
    } else {
      mob.cactusRamTimer -= dt;
      if(mob.cactusRamTimer <= 0){
        let targetX = playerX, targetY = playerY;
        if(isWaveMapMode() && _npcTarget && !_npcTarget.dead){
          const dNpc = Math.hypot(_npcTarget.x - mob.x, _npcTarget.y - mob.y);
          const dPlayer = Math.hypot(playerX - mob.x, playerY - mob.y);
          if(dNpc < dPlayer){ targetX = _npcTarget.x; targetY = _npcTarget.y; }
        }
        mob.isRamming = true;
        mob.cactusRamTargetX = targetX;
        mob.cactusRamTargetY = targetY;
      }
    }
  }

  // ── Ladybug boss — rose minion ability ────────────────────────────────────
  const LADY_ROSE_COOLDOWN  = 15000; // ms between rose spawns
  const LADY_ROSE_PAUSE_DUR = 1000;  // ms freeze before spawning
  const LADY_ROSE_LIFETIME  = 20000; // ms before despawning and healing
  const LADY_ROSE_HEAL_PCT  = 0.10;  // heal per surviving rose (10% max HP)
  // Rose size matches the rose petal base radius (9) scaled the same way
  const LADY_ROSE_BASE_R    = 9;

  for(const mob of mobs){
    if(mob.dead || mob.typeId !== 'ladybug' || !mob.isBoss) continue;

    if(mob.ladyRoseCooldown === undefined) mob.ladyRoseCooldown = LADY_ROSE_COOLDOWN;
    mob.ladyRoseCooldown -= dt;

    // Advance stationary roses — just tick lifetime, no movement
    for(const r of bossRoses){
      if(r.dead || r.ownerId !== mob.id) continue;
      // Lifetime tick
      r.lifetime -= dt;
      if(r.lifetime <= 0){
        r.dead = true;
        // Heal the ladybug
        if(!mob.dead) mob.hp = Math.min(mob.maxHp, mob.hp + mob.maxHp * LADY_ROSE_HEAL_PCT);
      }
    }

    // Pause phase before spawn
    if(mob.ladyRosePausing){
      mob.ladyRosePauseTimer -= dt;
      if(mob.ladyRosePauseTimer <= 0){
        mob.ladyRosePausing = false;
        // Spawn 4-8 roses scattered around her — stationary, no orbit
        const count = 4 + Math.floor(Math.random() * 5);
        // Rose radius: same as rose petal base radius scaled by boss tier
        const t = mob.tier ?? 0;
        const roseR = Math.max(6, Math.round((mob.drawRadius ?? mob.radius) * 0.5));
        const roseHp = Math.round(mob.maxHp * 0.75);
        // Spread spawn positions around the ladybug at varying distances
        const spawnR = (mob.drawRadius ?? mob.radius) * 1.8;
        for(let i = 0; i < count; i++){
          const angle = (Math.PI * 2 / count) * i + Math.random() * 0.4;
          const dist2  = spawnR * (0.8 + Math.random() * 0.6);
          bossRoses.push({
            id: ++_bossStingerNextId,
            ownerId: mob.id,
            orbitAngle: angle, // keep for render reference, but not used for movement
            x: mob.x + Math.cos(angle) * dist2,
            y: mob.y + Math.sin(angle) * dist2,
            radius: roseR,
            hp: roseHp, maxHp: roseHp,
            damage: 0,
            lifetime: LADY_ROSE_LIFETIME,
            dead: false,
            spawnAngle: angle, // for renderer petal orientation
            hurtFlash: 0,
          });
        }
      }
      continue; // frozen while pausing
    }

    if(mob.ladyRoseCooldown <= 0){
      mob.ladyRoseCooldown = LADY_ROSE_COOLDOWN;
      mob.ladyRosePausing = true;
      mob.ladyRosePauseTimer = LADY_ROSE_PAUSE_DUR;
    }
  }

  // Clean up dead boss roses
  for(let i = bossRoses.length - 1; i >= 0; i--){
    if(bossRoses[i].dead) bossRoses.splice(i, 1);
  }

  // ── Queen Bee Egg hatching ────────────────────────────────────────────────
  for(const egg of queenBeeEggs){
    if(egg.dead) continue;
    egg.spawnTimer = Math.min(320, (egg.spawnTimer ?? 0) + dt); // pop-in anim
    egg.hatchTimer -= dt;
    if(egg.hatchTimer <= 0){
      egg.dead = true;
      // Spawn a bee or a stationary turret hornet
      if(egg.isHornetEgg){
        const h = spawnAntMinion('hornet', egg.x, egg.y, egg.x, egg.y, -1, egg.tier);
        if(h){
          h.isStationary = true;  // won't wander or approach — shoots in place
          h.alerted = true;
          h.shootState = 'aim';
          h.stingerProgress = 1;
          h.isZoneTracked = false;
          if(isWaveMapMode()) addTrackedMob(h.id);
        }
      } else {
        const b = spawnAntMinion('bee', egg.x, egg.y, egg.x, egg.y, -1, egg.tier);
        if(b){ b.alerted = true; b.isZoneTracked = false; if(isWaveMapMode()) addTrackedMob(b.id); }
      }
    }
  }
  for(let i = queenBeeEggs.length - 1; i >= 0; i--){
    if(queenBeeEggs[i].dead) queenBeeEggs.splice(i, 1);
  }

  // ── Queen Bee Pollen Orbit update ─────────────────────────────────────────
  const POLLEN_ORBIT_SPEED = 0.0035; // rad/ms
  const POLLEN_LAUNCH_SPEED = 8;
  for(const p of queenBeePollenOrbit){
    if(p.dead) continue;
    if(!p.launched){
      // Find owner queen
      const owner = mobs.find(m => m.id === p.ownerId && !m.dead);
      if(!owner){ p.dead = true; continue; }
      p.spinTimer -= dt;
      p.orbitAngle += POLLEN_ORBIT_SPEED * dt;
      p.x = owner.x + Math.cos(p.orbitAngle) * p.orbitR;
      p.y = owner.y + Math.sin(p.orbitAngle) * p.orbitR;
      if(p.spinTimer <= 0){
        // Launch outward from queen
        p.launched = true;
        const launchAngle = p.orbitAngle;
        p.vx = Math.cos(launchAngle) * POLLEN_LAUNCH_SPEED;
        p.vy = Math.sin(launchAngle) * POLLEN_LAUNCH_SPEED;
        p.settleTimer = 1500; // after 1.5s decay to rest
      }
    } else {
      // Fly outward then settle
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.92;
      p.vy *= 0.92;
      if(p.settleTimer !== undefined) p.settleTimer -= dt;
      if(p.settleTimer !== undefined && p.settleTimer <= 0 && Math.hypot(p.vx, p.vy) < 0.3){
        p.vx = 0; p.vy = 0; p.settled = true;
      }
      // Die after 6s settled or 8s total
      if(p.totalTimer === undefined) p.totalTimer = 8000;
      p.totalTimer -= dt;
      if(p.totalTimer <= 0) p.dead = true;
    }
  }
  for(let i = queenBeePollenOrbit.length - 1; i >= 0; i--){
    if(queenBeePollenOrbit[i].dead) queenBeePollenOrbit.splice(i, 1);
  }

  // ── Sea cave: spawn a crab + jellyfish (each with its own 12% bonus-mob
  // roll) every time it drops another 15% of its own max HP. Checked here,
  // once per frame against current HP, rather than at each of the many
  // individual damage-application sites in combat.js — a mob's HP can drop
  // from missiles, poison, contact damage, boss projectiles, etc., and
  // catching the threshold in one place after all of them have applied this
  // frame is far more robust than trying to hook every damage source
  // individually. seaCaveThresholdsSpawned counts how many 15% steps have
  // already triggered a wave; a single big hit that skips past more than one
  // threshold in one frame still spawns a wave for each step crossed, so a
  // one-shot kill from 100% to 0% doesn't get away with only firing once.
  for(const mob of mobs){
    if(mob.dead || mob.typeId!=='sea_cave' || mob.maxHp<=0) continue;
    const hpLostFrac = 1 - Math.max(0, mob.hp) / mob.maxHp;
    const thresholdsCrossed = Math.floor(hpLostFrac / 0.15);
    const alreadySpawned = mob.seaCaveThresholdsSpawned || 0;
    if(thresholdsCrossed > alreadySpawned){
      const tier = rarityTier(mob.rarity);
      for(let i=alreadySpawned; i<thresholdsCrossed; i++){
        spawnSeaCaveWave(mob.x, mob.y, mob.homeZoneId, tier);
      }
      mob.seaCaveThresholdsSpawned = thresholdsCrossed;
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for(let i=mobs.length-1;i>=0;i--){
    if(mobs[i].dead){ onMobDied(mobs[i]); mobs.splice(i,1); }
  }

  // ── Jellyfish lightning bolt visuals: fade out and expire ──────────────────
  // Runs unconditionally (like the mob cleanup above) so bolts still fade
  // out smoothly even the instant the player dies, rather than freezing.
  for(let i=jellyfishBolts.length-1;i>=0;i--){
    const b=jellyfishBolts[i];
    b.t+=dt;
    if(b.t>=b.lifetime) jellyfishBolts.splice(i,1);
  }

  // ── Explosion ring visuals (Ink Sack): fade out and expire, same pattern ───
  for(let i=explosionEffects.length-1;i>=0;i--){
    const e=explosionEffects[i];
    e.t+=dt;
    if(e.t>=e.lifetime) explosionEffects.splice(i,1);
  }

  // ── Small pop visuals (Bubble breaking, etc.): fade out and expire ─────────
  for(let i=popEffects.length-1;i>=0;i--){
    const p=popEffects[i];
    p.t+=dt;
    if(p.t>=p.lifetime) popEffects.splice(i,1);
  }

  // Rarity-zone mob population. Each biome's map carries a hand-painted per-tile
  // rarity grid; every zone is filled across its whole area when the biome is
  // entered, using that biome's own mob list, and mobs are streamed in/out around
  // the player so only nearby ones cost anything (see "Rarity-zone population").
  if (!isWaveMapMode()) updateZoneSpawning(dt);
}