// world.js — the active biome's map, as the game simulation sees it.
//
// The real per-biome maps (tile collision mask, rarity spawn zones,
// checkpoints, spawn chamber) live in shared/biomes/. This module is the
// single point the simulation imports from, so no caller needs to know which
// biome is active — canMoveTo/findSafeSpawnPosition/getZoneTierAt/etc. always
// forward to whichever biome setActiveBiome() last selected. Drawing the map is
// the client's job (client/render/mapRenderer.js).

import * as garden from '../shared/biomes/garden.js';
import * as desert from '../shared/biomes/desert.js';
import * as ocean  from '../shared/biomes/ocean.js';

const BIOMES = { garden, desert, ocean };

let _active = garden; // sensible default before main.js explicitly sets one

/** Called by main.js when the player picks a biome from the homescreen. */
export function setActiveBiome(biomeId) {
  const mod = BIOMES[biomeId];
  if (!mod) {
    console.warn(`world.js: unknown biome "${biomeId}", keeping current biome active.`);
    return;
  }
  _active = mod;
}

export function getActiveBiome() {
  for (const [id, mod] of Object.entries(BIOMES)) {
    if (mod === _active) return id;
  }
  return null;
}

// ── Live-forwarding exports ───────────────────────────────────────────────────
// Functions forward with a small wrapper (cheap — one extra call frame) so
// they always dispatch to whichever biome is active *at call time*, not at
// import time. MAP_W/MAP_H can't be safely re-exported as plain consts (an ES
// module const binding snapshots the value that was live when first read by
// some engines' bundling, and definitely reads stale after a biome switch
// mid-session) so they're exposed as getter functions instead — mobs.js is
// the only consumer and already only reads them inside function bodies.

export function canMoveTo(x, y, radius = 22) {
  return _active.canMoveTo(x, y, radius);
}

export function findSafeSpawnPosition(radius = 22, playerX, playerY, safeRadius = 350) {
  return _active.findSafeSpawnPosition(radius, playerX, playerY, safeRadius);
}

// Finds a randomized, wall-clear spot near an arbitrary world position (used
// to respawn at a checkpoint, similar to findSafeSpawnPosition but for a
// point anywhere on the map, not just the map's own spawn chamber).
export function findSafeSpawnNear(nearX, nearY, radius = 22, clearanceTiles = 3) {
  if (typeof _active.findSafeSpawnNear !== 'function') return { x: nearX, y: nearY };
  return _active.findSafeSpawnNear(nearX, nearY, radius, clearanceTiles);
}

export function findOpenSpawnPosition(radius, existingMobs, tries = 60) {
  return _active.findOpenSpawnPosition(radius, existingMobs, tries);
}

// Rarity tier (0 = Common ... 13 = Voidbound) of the spawn zone covering
// a world position in the active biome, or -1 if the position is in a wall or
// off the map. Zones are painted per-tile in each biome's own module (see
// "Rarity spawn zones" in the shared/biomes/ files) and layered
// on top of the wall mask — they never affect collision.
export function getZoneTierAt(x, y) {
  return _active.getZoneTierAt(x, y);
}

export function getMapW() { return _active.MAP_W; }
export function getMapH() { return _active.MAP_H; }
export function getGridW() { return _active.GRID_W; }
export function getGridH() { return _active.GRID_H; }
export function getTileSize() { return _active.TILE_SIZE; }
export function isOpenTile(gx, gy) { return _active.isOpenTile(gx, gy); }
export function worldToTile(x, y) {
  const t = _active.TILE_SIZE;
  return { gx: Math.floor(x / t), gy: Math.floor(y / t) };
}

// Returns { x, y } for the active biome's spawn-chamber center, or null if
// that biome hasn't defined one yet (only Garden has one so far — Desert
// and Ocean can get the same treatment later).
export function getSpawnChamberCenter() {
  return _active.SPAWN_CHAMBER_CENTER ?? null;
}

// Checkpoints — only Garden has these so far (see shared/biomes/garden.js's own header
// comment on CHECKPOINTS for the data shape); Desert and Ocean return an
// empty array until they get the same treatment, so callers (checkpoints.js)
// never need to know which biomes have checkpoints defined yet.
export function getCheckpoints() {
  return _active.CHECKPOINTS ?? [];
}

// Real (downsampled) tunnel-distance-from-spawn at a world position, or -1
// if that biome hasn't defined a distance grid yet (see shared/biomes/garden.js's
// getDistanceFromSpawn for the accuracy/size tradeoff notes).
export function getDistanceFromSpawn(x, y) {
  if (typeof _active.getDistanceFromSpawn !== 'function') return -1;
  return _active.getDistanceFromSpawn(x, y);
}
