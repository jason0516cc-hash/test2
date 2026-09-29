// interpolation.js — draws moving things between simulation ticks.
//
// The game advances in fixed 60-per-second ticks (game/game.js), but the screen
// may refresh faster or at uneven intervals. Drawing raw tick positions would
// stutter, so for the duration of one render we move every entity to where it
// "is" part-way between its previous and current tick position, then put the
// real positions back so the simulation never sees the blended values.
import { players } from '../../game/player.js';
import { getMovingEntityArrays } from '../../game/game.js';

const saved = [];   // [entity, keyX, keyY, realX, realY] ...

function blend(entity, keyX, keyY, prevX, prevY, alpha) {
  if (prevX === undefined || prevY === undefined) return;
  const x = entity[keyX], y = entity[keyY];
  if (typeof x !== 'number' || typeof y !== 'number') return;
  saved.push(entity, keyX, keyY, x, y);
  entity[keyX] = prevX + (x - prevX) * alpha;
  entity[keyY] = prevY + (y - prevY) * alpha;
}

/** Runs `draw` with every moving entity blended `alpha` (0..1) of the way into the current tick. */
export function withInterpolatedPositions(alpha, draw) {
  for (const player of players) {
    blend(player, 'x', 'y', player.prevX, player.prevY, alpha);
    blend(player.petalOrigin, 'x', 'y', player.petalOrigin.prevX, player.petalOrigin.prevY, alpha);
    for (const p of player.petals) blend(p, 'worldX', 'worldY', p.prevWorldX, p.prevWorldY, alpha);
  }
  for (const arr of getMovingEntityArrays()) {
    for (const e of arr) blend(e, 'x', 'y', e.prevX, e.prevY, alpha);
  }
  try {
    draw();
  } finally {
    for (let i = saved.length - 5; i >= 0; i -= 5) {
      const entity = saved[i];
      entity[saved[i + 1]] = saved[i + 3];
      entity[saved[i + 2]] = saved[i + 4];
    }
    saved.length = 0;
  }
}
