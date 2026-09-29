// player.js — players in the world: what a player IS (createPlayer) and how
// one moves, levels up, dies and respawns.
//
// Every piece of per-player state lives on the player object itself —
// position and HP, but also its hotbar/bench, orbiting petals, inventory,
// poison, checkpoint progress and input — so the world can hold any number
// of players. Game functions always take the player they act on.
import {
  PLAYER_RADIUS, PLAYER_SPEED,
  PLAYER_COLOR, PLAYER_BORDER,
  PLAYER_MAX_HP,
  PLAYER_MASS,
  PETAL_ORIGIN_LAG,
  MAX_HOTBAR_SLOTS,
  ORBIT_RADIUS_NORMAL,
  PLAYER_SPEED_SCALE,
} from '../shared/constants.js';
import { canMoveTo, findSafeSpawnPosition } from './world.js';
import { PETAL_TYPES } from '../shared/petalTypes.js';
import { hpAtLevel, levelFromXp, petalSlotsForLevel } from '../shared/leveling.js';
import { emitGameEvent } from './events.js';
import { setHotbarSlots, rebuildPetals } from './petals.js';

// ── Player registry ──────────────────────────────────────────────────────────
/** Every player currently in the world. */
export const players = [];

export function addPlayer(player) {
  if (!players.includes(player)) players.push(player);
  return player;
}

export function removePlayer(player) {
  const i = players.indexOf(player);
  if (i !== -1) players.splice(i, 1);
}

export function getPlayerById(id) {
  return players.find(p => p.id === id) ?? null;
}

/** The living player closest to (x, y), or null if nobody is alive. */
export function nearestLivingPlayer(x, y) {
  let best = null, bestD = Infinity;
  for (const p of players) {
    if (p.dead) continue;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// ── Creating a player ────────────────────────────────────────────────────────
/** Input with nothing pressed. moveX/moveY is the desired walk direction
 *  (length ≤ 1); attack/defend are the expand/retract states after the
 *  player's invert settings; viewRange is how far (world units) they can see,
 *  used to limit auto-targeting abilities to on-screen mobs; viewHalfW/viewHalfH
 *  are the half-size of their visible screen in world units (pets only aggro
 *  to mobs inside that box). */
export function makeNeutralInput() {
  return { moveX: 0, moveY: 0, attack: false, defend: false, viewRange: 600, viewHalfW: 800, viewHalfH: 450 };
}

export function createPlayer({ id, name = 'Unnamed' }) {
  const spawn = findSafeSpawnPosition(PLAYER_RADIUS);
  const player = {
    id,
    name,
    x:         spawn.x,
    y:         spawn.y,
    radius:    PLAYER_RADIUS,
    speed:     PLAYER_SPEED * PLAYER_SPEED_SCALE,
    color:     PLAYER_COLOR,
    border:    PLAYER_BORDER,
    hp:        PLAYER_MAX_HP,
    maxHp:     PLAYER_MAX_HP,
    armor:     0,     // recomputed each tick from active petals (Bone, Scales, …)
    shield:    0,     // absorbs damage before HP — recomputed each tick from equipped petals (Carapace, Shell)
    maxShield: 0,     // recomputed each tick — sum of equipped shieldAmount petals (Shell)
    spongePool: 0,          // Sponge — deferred damage waiting to drain out over spongeTimeRemaining
    spongeTimeRemaining: 0, // ms left in the current spread window; resets to the full duration whenever new damage merges in
    poison:    { dps: 0, timer: 0 },   // poison currently ticking on this player
    dead:      false,
    deathCause: null, // { name, rarity } | { selfKill: true } | null — see setDeathCause
    mass:      PLAYER_MASS,
    vx:        0,
    vy:        0,
    isMoving:  false,
    moveAngle: 0,   // last walk direction in radians — used for eye tracking
    smoothRotation: 0,   // smoothed rotation for centipede legs
    legPhase:  0,   // animation phase for centipede legs accessory
    _soilHpBonus: 0,  // cached sum of maxHpBonus from equipped soil petals
    deathRotation: 0, // random tilt applied on death
    invincibleTimer: 0, // ms remaining of spawn invincibility (5s on spawn/respawn)
    hurtFlash: 0,       // ms remaining of red damage flash

    // ── Leveling ──────────────────────────────────────────────────────────────
    xp:    0,    // total accumulated XP
    level: 0,    // integer level, always === Math.floor(levelFromXp(xp))

    // ── Petals ────────────────────────────────────────────────────────────────
    // hotbar: equipped petal typeIds (null = empty slot); starts with 5 basics.
    // bench:  the second row — owned but not orbiting.
    // petals: live petal instances built from the hotbar (see rebuildPetals).
    hotbar: Array.from({ length: MAX_HOTBAR_SLOTS }, (_, i) => (i < 5 ? 'basic' : null)),
    bench:  Array.from({ length: MAX_HOTBAR_SLOTS }, () => null),
    petals: [],
    // radius: ring for petals that expand; innerRadius: ring for petals that don't (eggs, roses…)
    orbit:  { angle: 0, radius: ORBIT_RADIUS_NORMAL, targetRadius: ORBIT_RADIUS_NORMAL,
              innerRadius: ORBIT_RADIUS_NORMAL, innerTargetRadius: ORBIT_RADIUS_NORMAL },
    wing:   { attackT: 0, pulseT: 0 },   // Wing petal attack animation (also moves its hitbox)
    petalOrigin: { x: spawn.x, y: spawn.y }, // petals orbit this point, which lags behind the player

    // ── Inventory & crafting ──────────────────────────────────────────────────
    inventory: {},       // typeId → count
    craftAttempts: {},   // typeId → failed attempts so far (crafting pity)
    craftHold: { typeId: null, count: 0 },  // petals sitting on the crafting table (see commands.js)

    // ── Options chosen by the player that change game rules for them ─────────
    options: { autoEquipDrops: false },   // picked-up petals go straight into empty slots

    deathRecorded: false, // set once the game has processed this death (see game.js)

    // ── Checkpoints ───────────────────────────────────────────────────────────
    checkpoints: null,   // per-biome progress, created by checkpoints.js on first use

    // ── Chat command overrides (cheats/debug) ────────────────────────────────
    godmode:      false, // /godmode — player takes no damage
    _hpBonus:     0,     // /set hp {num} — flat bonus added on top of leveled maxHp (stacks with soil petals)
    _dmgBonus:    0,     // /set dmg {num} — flat bonus added on top of body damage
    _speedMult:   1,     // /speed {num} — multiplier applied to total speed (base + petal bonuses)

    // ── Input — written by whoever controls this player (the local client today,
    // a network connection later); the simulation only ever reads it. ──────────
    input: makeNeutralInput(),
  };
  rebuildPetals(player);
  return player;
}

// ── Leveling ─────────────────────────────────────────────────────────────────
/** Award XP to a player (call this when a mob they're credited with dies). */
export function addXp(player, amount) {
  player.xp   += amount;
  player.level = Math.floor(levelFromXp(player.xp));

  // Level-up: grant any newly unlocked petal slots
  setHotbarSlots(player, petalSlotsForLevel(player.level));

  // Level-up: raise maxHp and give back the difference as a heal bonus
  const newMax = hpAtLevel(player.level) + player._soilHpBonus;
  if (newMax > player.maxHp) {
    player.hp  = Math.min(player.hp + (newMax - player.maxHp), newMax);
  }
  player.maxHp = newMax;

  emitGameEvent('xpGained', { playerId: player.id, amount });
}

// ── Death cause tracking ──────────────────────────────────────────────────────
// Snapshotted at the moment player.dead becomes true (see applyDamageToPlayer
// in combat.js) so the death overlay can show "You were killed by: {rarity}
// {mob name}" even after the killer mob itself has been cleaned up/despawned.
// null means no attacker (e.g. poison tick, self-inflicted petal damage) —
// the overlay falls back to a generic message in that case. The special value
// { selfKill: true } means the player used the X (kill) button — the overlay
// shows "You were killed by: Yourself" with no rarity color.
export function setDeathCause(player, source) {
  player.deathCause = source ? { name: source.name, rarity: source.rarity } : null;
}

export function setDeathCauseSelf(player) {
  player.deathCause = { selfKill: true };
}

// ── Respawn ──────────────────────────────────────────────────────────────────
/** Reset a player for respawn — keeps name & petals, restores hp and position. XP is never lost. */
export function respawnPlayer(player) {
  const spawn = findSafeSpawnPosition(PLAYER_RADIUS);
  placePlayer(player, spawn.x, spawn.y);
  player.hp   = player.maxHp;
  player.dead = false;
  player.vx   = 0;
  player.vy   = 0;
  player.deathRotation = 0;
  // Drop any held input so movement doesn't carry over from death
  player.input = makeNeutralInput();
  // Grant 5 seconds of spawn invincibility
  player.invincibleTimer = 5000;
  player.hurtFlash       = 0;
}

/** Teleport a player (and their petal orbit centre) to a position. */
export function placePlayer(player, x, y) {
  player.x = x;
  player.y = y;
  player.petalOrigin.x = x;
  player.petalOrigin.y = y;
}

// ── Per-tick update ──────────────────────────────────────────────────────────
// Maximum distance the petal orbit centre may lag behind the player — one
// flower body size, so a sudden speed spike can't stretch the ring away.
const MAX_PETAL_ORIGIN_LAG = PLAYER_RADIUS;

export function updatePlayer(player, dt = 16) {
  // ── Accessory bonuses from hotbar ────────────────────────────────────────
  let speedBonus = 0;
  let soilBonus  = 0;
  let sizeBonus  = 0; // Air — fraction added to player radius, stacks additively across copies
  for (const typeId of player.hotbar) {
    if (!typeId) continue;
    const pt = PETAL_TYPES[typeId];
    if (pt?.walkSpeedBonus) speedBonus += pt.walkSpeedBonus;
    if (pt?.maxHpBonus)     soilBonus  += pt.maxHpBonus;
    if (pt?.sizeBonus)      sizeBonus  += pt.sizeBonus;
  }
  player.speed  = (PLAYER_SPEED + speedBonus) * PLAYER_SPEED_SCALE * (player._speedMult || 1);
  player.radius = PLAYER_RADIUS * (1 + sizeBonus);

  // ── Max HP: level-scaled base + soil petal bonus + /set hp bonus ──────────
  const leveledMaxHp = hpAtLevel(player.level) + soilBonus + (player._hpBonus || 0);
  if (soilBonus !== player._soilHpBonus || leveledMaxHp !== player.maxHp) {
    const wasFull = player.hp >= player.maxHp;
    player._soilHpBonus = soilBonus;
    player.maxHp        = leveledMaxHp;
    // If the player was topped off (or this is a /set hp bump), keep them topped off
    // instead of clamping down when maxHp only grew.
    player.hp = wasFull ? player.maxHp : Math.min(player.hp, player.maxHp);
  }

  const dx = player.input.moveX, dy = player.input.moveY;

  // Update eye direction whenever the player is walking
  player.isMoving = dx !== 0 || dy !== 0;
  if (player.isMoving) {
    player.moveAngle = Math.atan2(dy, dx);
  }

  // Decay knockback velocity (friction)
  player.vx *= 0.78;
  player.vy *= 0.78;

  // Tick down spawn invincibility
  if (player.invincibleTimer > 0) player.invincibleTimer = Math.max(0, player.invincibleTimer - dt);

  const newX = player.x + dx * player.speed + player.vx;
  const newY = player.y + dy * player.speed + player.vy;

  if (canMoveTo(newX, newY, player.radius)) {
    player.x = newX;
    player.y = newY;
    // Animate centipede legs only when actually moving
    if (player.isMoving) {
      player.legPhase += 0.14;
    }
  } else {
    player.vx = 0;
    player.vy = 0;
  }

  // ── Petal orbit centre trails the player ─────────────────────────────────
  const o = player.petalOrigin;
  o.x += (player.x - o.x) * PETAL_ORIGIN_LAG;
  o.y += (player.y - o.y) * PETAL_ORIGIN_LAG;
  const lagX = player.x - o.x, lagY = player.y - o.y;
  const lag  = Math.hypot(lagX, lagY);
  if (lag > MAX_PETAL_ORIGIN_LAG) {
    const pull = (lag - MAX_PETAL_ORIGIN_LAG) / lag;
    o.x += lagX * pull;
    o.y += lagY * pull;
  }
}
