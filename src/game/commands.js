// commands.js — every change a player can ASK the game to make to their own
// things: equipping and rearranging petals, and crafting.
//
// The client UI calls these instead of editing hotbar/inventory arrays itself.
// Each command checks the request is legal (the player really owns the petal,
// the slot exists, there are enough petals to craft…) and returns false/null
// when it isn't, so the same functions can later sit behind a server that
// receives them over the network.
import { PETAL_TYPES } from '../shared/petalTypes.js';
import { addToInventory, removeFromInventory } from './inventory.js';
import { rebuildPetals } from './petals.js';
import { canCraft, getNextTypeId, performCraftSingle } from './crafting.js';
import { emitGameEvent } from './events.js';

// ── Helpers ──────────────────────────────────────────────────────────────────
function rowArray(player, row) {
  if (row === 'hotbar') return player.hotbar;
  if (row === 'bench')  return player.bench;
  return null;
}

function isValidSlot(player, row, slot) {
  const arr = rowArray(player, row);
  return !!arr && Number.isInteger(slot) && slot >= 0 && slot < arr.length;
}

function inventoryChanged(player) {
  emitGameEvent('inventoryChanged', { playerId: player.id });
}

// ── Loadout (hotbar + bench) ─────────────────────────────────────────────────
/**
 * Moves one `typeId` from the inventory into a hotbar/bench slot. Whatever was
 * in that slot goes back to the inventory. Returns false if the player doesn't
 * have the petal or the slot doesn't exist.
 */
export function equipFromInventory(player, typeId, row, slot) {
  if (!PETAL_TYPES[typeId] || !isValidSlot(player, row, slot)) return false;
  if (!removeFromInventory(player, typeId)) return false;
  const arr = rowArray(player, row);
  const displaced = arr[slot];
  arr[slot] = typeId;
  if (displaced) addToInventory(player, displaced);
  if (row === 'hotbar') rebuildPetals(player);
  inventoryChanged(player);
  return true;
}

/** Swaps the contents of two slots (either row, either may be empty). */
export function moveSlot(player, fromRow, fromSlot, toRow, toSlot) {
  if (!isValidSlot(player, fromRow, fromSlot) || !isValidSlot(player, toRow, toSlot)) return false;
  if (fromRow === toRow && fromSlot === toSlot) return false;
  const from = rowArray(player, fromRow), to = rowArray(player, toRow);
  const tmp = to[toSlot];
  to[toSlot] = from[fromSlot];
  from[fromSlot] = tmp;
  if (fromRow === 'hotbar' || toRow === 'hotbar') rebuildPetals(player);
  return true;
}

/** Moves a slot's petal back to the inventory. Returns its typeId, or null if the slot was empty. */
export function unequipToInventory(player, row, slot) {
  if (!isValidSlot(player, row, slot)) return null;
  const arr = rowArray(player, row);
  const typeId = arr[slot];
  if (!typeId) return null;
  arr[slot] = null;
  addToInventory(player, typeId);
  if (row === 'hotbar') rebuildPetals(player);
  inventoryChanged(player);
  return typeId;
}

/** Swaps hotbar[slot] with bench[slot] (the swap key). */
export function swapWithBench(player, slot) {
  return moveSlot(player, 'hotbar', slot, 'bench', slot);
}

// ── Crafting ─────────────────────────────────────────────────────────────────
// The crafting table holds one petal type at a time (player.craftHold) as a
// single pool of any size. Petals placed on it leave the inventory. Crafting
// runs attempts of 5 while at least 5 are left (see game/crafting.js); what
// remains afterwards (0-4) stays on the table until collected.
function craftHoldOf(player) {
  if (!player.craftHold) player.craftHold = { typeId: null, count: 0 };
  return player.craftHold;
}

/** Current crafting-table contents: { typeId, count }. */
export function getCraftHold(player) {
  return { ...craftHoldOf(player) };
}

/**
 * Moves up to `count` of `typeId` from the inventory onto the crafting table.
 * A different type already on the table is returned to the inventory first.
 * Returns how many were actually moved.
 */
export function addToCraftHold(player, typeId, count = 1) {
  if (!canCraft(typeId)) return 0;
  const hold = craftHoldOf(player);
  if (hold.typeId !== typeId && hold.count > 0) returnCraftHold(player);
  hold.typeId = typeId;
  let moved = 0;
  while (moved < count && removeFromInventory(player, typeId)) moved++;
  hold.count += moved;
  if (hold.count === 0) hold.typeId = null;
  if (moved) inventoryChanged(player);
  return moved;
}

/** Moves `count` petals (default: all) from the crafting table back to the inventory. */
export function returnCraftHold(player, count = Infinity) {
  const hold = craftHoldOf(player);
  const n = Math.min(hold.count, count);
  if (n > 0 && hold.typeId) {
    addToInventory(player, hold.typeId, n);
    hold.count -= n;
    inventoryChanged(player);
  }
  if (hold.count === 0) hold.typeId = null;
  return n;
}

/**
 * Crafts everything on the table: attempts of 5 while at least 5 are left.
 * Successes go straight to the inventory; the leftover (0-4) stays on the
 * table. Returns every attempt in order so the client can animate them, or
 * null if the request is invalid (nothing craftable, or fewer than 5).
 *
 * @returns {{ typeId, nextTypeId, startCount, left, successCount, lostTotal,
 *             rounds: { success: boolean, lost: number, poolAfter: number }[] } | null}
 */
export function craftFromHold(player) {
  const hold = craftHoldOf(player);
  const typeId = hold.typeId;
  if (!typeId || !canCraft(typeId) || hold.count < 5) return null;

  const startCount = hold.count;
  const rounds = [];
  let nextTypeId = getNextTypeId(typeId);
  let successCount = 0;
  while (hold.count >= 5) {
    const res = performCraftSingle(player, typeId);
    if (!res) break;
    nextTypeId = res.nextTypeId;
    const lost = res.success ? 5 : 5 - res.returned;   // a failure loses 1-4
    hold.count -= lost;
    if (res.success) { successCount++; addToInventory(player, nextTypeId); }
    rounds.push({ success: res.success, lost, poolAfter: hold.count });
  }
  if (hold.count === 0) hold.typeId = null;
  inventoryChanged(player);
  return {
    typeId, nextTypeId, startCount, rounds, successCount,
    lostTotal: rounds.reduce((n, r) => n + (r.success ? 0 : r.lost), 0),   // lost to failures
    left: hold.count,
  };
}

// ── Admin / debug ────────────────────────────────────────────────────────────
/** Gives a player petals outright (chat /give, /petals, starting kit). */
export function grantItem(player, typeId, count = 1) {
  if (!PETAL_TYPES[typeId] || count < 1) return false;
  addToInventory(player, typeId, count);
  inventoryChanged(player);
  return true;
}
