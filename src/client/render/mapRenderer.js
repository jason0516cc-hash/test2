// mapRenderer.js — draws whichever biome the game world currently has active.
// Each biome's look (colours, decorative texture, drawMap) lives in
// client/render/biomes/; the map data itself is in shared/biomes/.
import { getActiveBiome } from '../../game/world.js';
import * as garden from './biomes/garden.js';
import * as desert from './biomes/desert.js';
import * as ocean  from './biomes/ocean.js';

const BIOME_RENDERERS = { garden, desert, ocean };

/** Each biome's floor colour + texture shape (see biomes/*.js FLOOR). */
export const BIOME_FLOORS = { garden: garden.FLOOR, desert: desert.FLOOR, ocean: ocean.FLOOR };

export function drawMap(ctx, cameraX, cameraY, canvasW, canvasH, zoomV = 1) {
  const renderer = BIOME_RENDERERS[getActiveBiome()] ?? garden;
  renderer.drawMap(ctx, cameraX, cameraY, canvasW, canvasH, zoomV);
}
