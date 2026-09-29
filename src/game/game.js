// game.js — runs the world. This is the one place that advances the
// simulation: a fixed-rate tick (TICKS_PER_SECOND, see shared/constants.js) that updates every player,
// their petals, mobs, combat and drops, in that order.
//
// The client never steps systems itself — it hands this module the real time
// that passed each frame (advanceWorld) and draws the result. Because the tick
// rate is fixed, the game plays identically on a 60Hz and a 144Hz screen, and a
// server could run exactly the same loop.
import { players, updatePlayer, respawnPlayer, placePlayer } from './player.js';
import { updatePetals, rebuildPetals } from './petals.js';
import { mobs, missiles, bossStingers, bossPeas, bossRoses, initMobs, updateMobs } from './mobs.js';
import { updateCombat } from './combat.js';
import { updateDrops, checkPickups, missileEntities, pollenEntities, honeycombEntities } from './drops.js';
import { addToInventory } from './inventory.js';
import { setActiveBiome, getActiveBiome } from './world.js';
import { onBiomeEntered, recordCheckpointProgress, recordDeath, getRespawnPosition } from './checkpoints.js';
import { PETAL_TYPES } from '../shared/petalTypes.js';
import { emitGameEvent } from './events.js';
import { TICKS_PER_SECOND } from '../shared/constants.js';

/** Length of one simulation tick in ms. */
export const TICK_MS = 1000 / TICKS_PER_SECOND;
/** After a long stall (background tab), drop the backlog instead of fast-forwarding. */
const MAX_TICKS_PER_FRAME = 6;

let _accumulator = 0;

// ── Entering the world ───────────────────────────────────────────────────────
/** Makes `biomeId` the active map and clears out the previous run's mobs. */
export function loadBiome(biomeId) {
  setActiveBiome(biomeId);
  initMobs();
  _accumulator = 0;
}

/**
 * Puts a player into the active biome: resets progress if they came from a
 * different biome, then spawns them at their furthest checkpoint (or the map
 * spawn). Call after loadBiome.
 */
export function spawnPlayerInBiome(player, biomeId) {
  onBiomeEntered(player, biomeId);
  respawnAtCheckpoint(player);
}

/** Respawns a dead (or living) player at their current checkpoint. */
export function respawnAtCheckpoint(player) {
  respawnPlayer(player);
  player.deathRecorded = false;
  const cp = getRespawnPosition(player, getActiveBiome());
  if (cp) placePlayer(player, cp.x, cp.y);
}

// ── Running ──────────────────────────────────────────────────────────────────
/**
 * Advances the world by `frameMs` of real time, running as many fixed ticks as
 * fit. Returns how far (0..1) real time is into the next tick, so the renderer
 * can draw moving things between their last two positions.
 */
export function advanceWorld(frameMs) {
  _accumulator += frameMs;
  let ticks = 0;
  while (_accumulator >= TICK_MS && ticks < MAX_TICKS_PER_FRAME) {
    stepWorld(TICK_MS);
    _accumulator -= TICK_MS;
    ticks++;
  }
  if (ticks === MAX_TICKS_PER_FRAME) _accumulator = 0;
  return _accumulator / TICK_MS;
}

/** One simulation tick. */
export function stepWorld(dt) {
  rememberPositions();
  const biome = getActiveBiome();

  for (const player of players) {
    if (player.dead) continue;
    updatePlayer(player, dt);
    recordCheckpointProgress(player, biome);
    updatePetals(player, dt);
  }
  updateMobs(dt);
  updateCombat(dt);
  updateDrops(dt);

  for (const player of players) {
    if (!player.dead) collectPickups(player);
    // A player who died this tick: record it once (checkpoint death penalty)
    // and tell the client.
    if (player.dead && !player.deathRecorded) {
      player.deathRecorded = true;
      recordDeath(player, biome);
      emitGameEvent('playerDied', { playerId: player.id, cause: player.deathCause });
    }
  }
}

// ── Pickups ──────────────────────────────────────────────────────────────────
function collectPickups(player) {
  let pickupMult = 1, flatPickupBonus = 0;
  for (const typeId of player.hotbar) {
    if (!typeId) continue;
    const pt = PETAL_TYPES[typeId];
    if (pt?.pickupBonus)     pickupMult      += pt.pickupBonus;
    if (pt?.flatPickupBonus) flatPickupBonus += pt.flatPickupBonus;
  }
  checkPickups(player.x, player.y, (typeId, drop) => {
    // Lets the client fly the drop into the player (spin + shrink)
    emitGameEvent('dropPickedUp', {
      playerId: player.id, typeId,
      x: drop.x + drop.ox, y: drop.y + drop.oy, rotation: drop.rotation, size: drop.size,
      baseRadius: drop.pickupRadius,
    });
    if (typeId === 'rose') {
      player.hp = Math.min(player.maxHp, player.hp + 22);
      return;
    }
    if (player.options.autoEquipDrops) {
      const emptyTop = player.hotbar.indexOf(null);
      if (emptyTop !== -1) {
        player.hotbar[emptyTop] = typeId;
        rebuildPetals(player);
        return;
      }
      const emptyBench = player.bench.indexOf(null);
      if (emptyBench !== -1) {
        player.bench[emptyBench] = typeId;
        return;
      }
    }
    addToInventory(player, typeId);
    emitGameEvent('inventoryChanged', { playerId: player.id });
  }, pickupMult, flatPickupBonus);
}

// ── Smooth rendering support ─────────────────────────────────────────────────
// Every moving thing remembers where it was at the start of the tick
// (prevX/prevY; petals: prevWorldX/prevWorldY) so the renderer can draw it
// part-way between ticks — see client/render/interpolation.js.
const MOVING_ARRAYS = [mobs, missiles, bossStingers, bossPeas, bossRoses, missileEntities, pollenEntities, honeycombEntities];

function rememberPositions() {
  for (const player of players) {
    player.prevX = player.x; player.prevY = player.y;
    player.petalOrigin.prevX = player.petalOrigin.x; player.petalOrigin.prevY = player.petalOrigin.y;
    for (const p of player.petals) { p.prevWorldX = p.worldX; p.prevWorldY = p.worldY; }
  }
  for (const arr of MOVING_ARRAYS) {
    for (const e of arr) { e.prevX = e.x; e.prevY = e.y; }
  }
}

/** Moving things, for the renderer's interpolation. */
export function getMovingEntityArrays() { return MOVING_ARRAYS; }
