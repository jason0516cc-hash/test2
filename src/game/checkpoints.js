/**
 * checkpoints.js
 *
 * Per-biome checkpoint progress and the death-penalty state machine.
 *
 * Design notes (see chat history for the full spec discussion):
 *  - Checkpoints are strictly ordered by real tunnel-distance from spawn
 *    (game/world.js's getCheckpoints() / getDistanceFromSpawn(), which forward to
 *    the active biome's own CHECKPOINTS array — only Garden has one so far).
 *  - "Reached" a checkpoint = the player's own distance-from-spawn has ever
 *    met or exceeded that checkpoint's distFromSpawn AND the player has
 *    physically come within CHECKPOINT_PROXIMITY_TILES of its actual
 *    location at least once (distance alone isn't enough on a map with
 *    loops/spirals — see the proximity constant below). Reaching one is
 *    permanent for the run — it does not un-reach on retreating. Every
 *    reached checkpoint is recorded individually, in the order reached
 *    (see `reachedIndices` below) — a player can jump straight from
 *    checkpoint 3 to checkpoint 14 without ever touching 4-13, and those
 *    in-between ones simply never enter the list.
 *  - Normal death: respawn at the LAST entry in reachedIndices (the most
 *    recently/furthest reached checkpoint), or map spawn if the list is
 *    empty.
 *  - Penalty: 3 deaths within 90 seconds of each other steps the effective
 *    respawn point back ONE ENTRY in reachedIndices — i.e. the previous
 *    checkpoint the player actually reached, NOT simply "index minus 1" in
 *    the full checkpoint list. E.g. reached only #3 then #14 (skipping
 *    4-13 entirely) — the penalty sends the player to #3, not #13, because
 *    #13 was never actually reached. Escalates: another 3-in-90s streak
 *    steps back one more ENTRY in the list. Surviving 90s with no death
 *    resets the death counter to 0.
 *  - Progress persists across trips to the homescreen (the person can sit at
 *    the homescreen and come back), but is tied to whichever biome was last
 *    *entered* — entering a DIFFERENT biome than the one currently holding
 *    progress resets that old biome's progress to 0 first. This state is
 *    designed to be easy to move server-side later for multiplayer: it's a
 *    plain per-biome data object with explicit read/write functions, nothing
 *    tucked into closures tied to the game loop.
 */

import { getActiveBiome, getCheckpoints, getDistanceFromSpawn, getSpawnChamberCenter, findSafeSpawnNear, getTileSize } from './world.js';

const DEATH_LIMIT       = 3;      // deaths...
const DEATH_WINDOW_MS   = 90000;  // ...within this many ms triggers the penalty

// A checkpoint only counts as "reached" once the player is BOTH past its
// distance threshold AND has come within this many world units of its
// actual location at least once. Distance-alone is not enough on a map with
// loops/spirals: two physically-close tunnel strands can have very
// different tunnel-distances (a player deep in one strand can numerically
// "pass" a checkpoint's distance value while being nowhere near it, on a
// totally different loop of the path) — see chat history for the concrete
// example that surfaced this. 10 tiles, per spec.
const CHECKPOINT_PROXIMITY_TILES = 10;
let _checkpointProximityWorldUnits = null; // lazily resolved (needs TILE_SIZE from game/world.js)
function _proximityWorldUnits() {
  if (_checkpointProximityWorldUnits === null) {
    // TILE_SIZE is 300 for every biome so far (see each *Map.js's own
    // const) — read it once via getTileSize() rather than hardcoding 300
    // here so this stays correct if a future biome ever differs.
    _checkpointProximityWorldUnits = CHECKPOINT_PROXIMITY_TILES * (getTileSize() || 300);
  }
  return _checkpointProximityWorldUnits;
}

// Per-biome progress, kept per player (player.checkpoints). `reachedIndices` is every checkpoint index the player
// has ever actually reached, ascending and deduplicated (NOT necessarily
// consecutive — jumping from checkpoint 3 straight to 14 leaves 4-13 out of
// this list entirely, since they were never reached). `setbackSteps` is how
// many entries back FROM THE END of that list the death-penalty has knocked
// the effective respawn point (0 = no penalty active, respawn at the last/
// furthest entry). See recordCheckpointProgress() for how reaching a
// checkpoint again can clear an active setback.
function _freshBiomeState() {
  return {
    reachedIndices: [],
    setbackSteps: 0,
    deathTimestamps: [], // ms timestamps (performance.now()), oldest first
  };
}

/** This player's checkpoint record, created on first use. */
function progressOf(player) {
  if (!player.checkpoints) {
    player.checkpoints = {
      lastEnteredBiome: null,
      biomes: { garden: _freshBiomeState(), desert: _freshBiomeState(), ocean: _freshBiomeState() },
    };
  }
  return player.checkpoints;
}

/**
 * Call once, at the start of entering a biome (see startGame() in main.js),
 * BEFORE respawnPlayer() / getRespawnPosition() are used for this session.
 * If this is a different biome than the one last entered, the old biome's
 * progress resets to 0 first (per spec — only one biome's progress is ever
 * "live" at a time).
 */
export function onBiomeEntered(player, biomeId) {
  const progress = progressOf(player);
  if (progress.lastEnteredBiome !== null && progress.lastEnteredBiome !== biomeId) {
    progress.biomes[progress.lastEnteredBiome] = _freshBiomeState();
  }
  progress.lastEnteredBiome = biomeId;
}

/** The checkpoint index the player would currently respawn at, or -1 if
 *  none reached yet (or the setback has been pushed back past the start of
 *  reachedIndices — respawn falls back to map spawn in that case). */
function _effectiveReachedIndex(state) {
  const pos = state.reachedIndices.length - 1 - state.setbackSteps;
  if (pos < 0 || pos >= state.reachedIndices.length) return -1;
  return state.reachedIndices[pos];
}

/**
 * Call every tick (or at least on player movement) while the player is
 * alive. Cheap: getDistanceFromSpawn is
 * one downsampled-grid lookup, and this only does real work when the
 * player's distance has actually grown past their current furthest.
 */
export function recordCheckpointProgress(player, biomeId) {
  const playerX = player.x, playerY = player.y;
  if (biomeId !== getActiveBiome()) {
    console.warn(`checkpoints.js: recordCheckpointProgress called for "${biomeId}" but active biome is "${getActiveBiome()}" — ignoring.`);
    return;
  }
  const checkpoints = getCheckpoints(); // always the currently-active biome (game/world.js router)
  if (!checkpoints || checkpoints.length === 0) return;

  const state = progressOf(player).biomes[biomeId];
  if (!state) return;

  const playerDist = getDistanceFromSpawn(playerX, playerY);
  if (playerDist < 0) return; // position not resolvable (shouldn't happen in practice)

  const proximity = _proximityWorldUnits();
  const currentFurthest = state.reachedIndices.length > 0
    ? state.reachedIndices[state.reachedIndices.length - 1]
    : -1;

  // Find every checkpoint the player both (a) has a high enough
  // distance-from-spawn for, AND (b) has physically come within
  // CHECKPOINT_PROXIMITY_TILES of right now. Distance is checked over ALL
  // checkpoints (not just ones past the current furthest) so that walking
  // back up to/past an already-reached checkpoint can still clear an active
  // penalty even though it isn't new overall progress.
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    if (playerDist < cp.distFromSpawn) break; // ordered — nothing later qualifies either
    const physDist = Math.hypot(playerX - cp.x, playerY - cp.y);
    if (physDist > proximity) continue; // distance qualifies but player isn't actually near it

    if (i > currentFurthest) {
      // Genuine new progress — a checkpoint never reached before. Recorded
      // individually — this does NOT fill in any skipped checkpoints
      // between the old furthest and this one, per spec (jumping from 3 to
      // 14 never adds 4-13 to the list).
      state.reachedIndices.push(i);
      state.setbackSteps = 0;
    } else if (state.reachedIndices.includes(i) && state.setbackSteps > 0) {
      // Not new progress, but the player has walked back to ANY checkpoint
      // they'd already reached before, while a death penalty had the
      // effective anchor set further back — reaching it again for real
      // clears the penalty and re-anchors at the true furthest-reached
      // checkpoint again (not necessarily this specific one). This also
      // correctly handles the case where setbackSteps had pushed the
      // effective anchor past the start of reachedIndices entirely (map
      // spawn) — touching ANY previously-reached checkpoint still clears it.
      state.setbackSteps = 0;
    }
  }
}

/**
 * Call exactly once per death (not every frame), BEFORE computing the
 * respawn position for this death. Records the death timestamp, prunes
 * anything outside the rolling 90s window, and applies the step-back
 * penalty if this death is the 3rd within that window. Escalates
 * automatically — setbackSteps keeps incrementing on each new qualifying
 * streak, and getRespawnPosition() clamps it so it never goes below map
 * spawn (a setback past the start of reachedIndices = no checkpoint at all).
 */
export function recordDeath(player, biomeId) {
  const state = progressOf(player).biomes[biomeId];
  if (!state) return;

  const now = performance.now();
  state.deathTimestamps.push(now);
  // Prune deaths outside the window — this is also what implements "if
  // alive for 90s the counter resets": once enough time has passed with no
  // new death, old timestamps age out and the array naturally shrinks below
  // the trigger count again.
  state.deathTimestamps = state.deathTimestamps.filter(t => now - t <= DEATH_WINDOW_MS);

  if (state.deathTimestamps.length >= DEATH_LIMIT) {
    state.setbackSteps += 1;
    // This streak has been "spent" on the penalty — clear it so the next
    // death starts counting a fresh streak rather than re-triggering every
    // death from here on.
    state.deathTimestamps = [];
  }
}

/**
 * Returns { x, y } to respawn the player at, for the given biome, honoring
 * reachedIndices/setbackSteps. Falls back to the biome's map spawn chamber
 * center if no checkpoint has been reached yet, or if the setback has been
 * pushed back past the start of reachedIndices. The actual position is a
 * randomized, wall-clear spot near the checkpoint (findSafeSpawnNear), not
 * the checkpoint's exact coordinate — same "safe respawn" behavior as the
 * map's own spawn chamber, just centered on the checkpoint instead.
 */
export function getRespawnPosition(player, biomeId) {
  if (biomeId !== getActiveBiome()) {
    console.warn(`checkpoints.js: getRespawnPosition called for "${biomeId}" but active biome is "${getActiveBiome()}" — using active biome's checkpoints anyway.`);
  }
  const state = progressOf(player).biomes[biomeId];
  const checkpoints = getCheckpoints(); // always the currently-active biome (game/world.js router)

  const effectiveIndex = state ? _effectiveReachedIndex(state) : -1;

  if (state && checkpoints.length > 0 && effectiveIndex >= 0) {
    const cp = checkpoints[effectiveIndex];
    return findSafeSpawnNear(cp.x, cp.y);
  }

  // No checkpoint reached (or stepped back past the start of the list) — map spawn.
  const center = getSpawnChamberCenter();
  return center ? { x: center.x, y: center.y } : null;
}

/** For debug/HUD use — not required by the core loop. */
export function getProgress(player, biomeId) {
  const state = progressOf(player).biomes[biomeId];
  if (!state) return null;
  return {
    reachedIndices: [...state.reachedIndices],
    effectiveIndex: _effectiveReachedIndex(state),
    setbackSteps: state.setbackSteps,
    recentDeathCount: state.deathTimestamps.length,
  };
}

