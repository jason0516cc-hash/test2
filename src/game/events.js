// events.js — one-way messages from the game simulation to whoever presents it.
//
// The simulation never touches the screen, DOM or UI directly. When something
// happens that a player should see or hear (a damage number, a kill for the mob
// gallery, XP gained, a boss announcement), it emits an event here and moves
// on. Today the client subscribes in-process; with a server, the server would
// forward the same events over the network instead.
//
// Event types and their payloads:
//   'damage'            { x, y, amount, color, radius, target }  floating damage number
//   'mobKilled'         { typeId, tier }                         mob gallery kill count
//   'xpGained'          { playerId, amount }                     level bar
//   'bossAnnouncement'  { label, color, spawned }                boss banner
//   'mobDied'           { mob }                                  death pop + dots (the removed mob object)
//   'petalBroken'       { typeId, x, y, radius, isPiece, pieceAngle }  petal break pop
//   'dropPickedUp'      { playerId, typeId, x, y, rotation, size, baseRadius }  drop flies to player

const listeners = new Map();   // type -> Set<fn>

/** Subscribe to an event type. Returns an unsubscribe function. */
export function onGameEvent(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

/** Emit an event to every subscriber of its type. */
export function emitGameEvent(type, data) {
  const set = listeners.get(type);
  if (!set) return;
  for (const fn of set) fn(data);
}

/** Shorthand for the most common event — a floating damage number over `target`. */
export function emitDamage(x, y, amount, color = '#ff4444', radius = 0, target = null) {
  emitGameEvent('damage', { x, y, amount, color, radius, target });
}
