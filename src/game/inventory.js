// inventory.js — a player's stored petals, stacked by typeId (player.inventory
// is { typeId → count }). Every function takes the player that owns the items.

export function addToInventory(player, typeId, count = 1) {
  player.inventory[typeId] = (player.inventory[typeId] || 0) + count;
}

/** Removes one of `typeId`. Returns false if the player had none. */
export function removeFromInventory(player, typeId) {
  const items = player.inventory;
  if (!items[typeId]) return false;
  items[typeId]--;
  if (items[typeId] <= 0) delete items[typeId];
  return true;
}

export function clearInventory(player) {
  for (const key of Object.keys(player.inventory)) delete player.inventory[key];
}
