// ── Mob icons (gallery tiles, pop cards) ─────────────────────────────────────
// One shared renderer for every static mob thumbnail. Replaces the two
// hand-copied switch statements that used to live in renderer.js (pop cards)
// and client/ui/mobGallery.js (gallery tiles), each with its own per-mob size fudges
// and pixel-scan centering hacks.
//
// How it works: every mob is drawn at a reference radius facing north-east.
// Its real on-screen bounds (all pixels, including legs, tails, wings and
// animation extremes) are measured ONCE per type on an offscreen canvas, then
// each draw scales and centres that box into whatever area the caller gives —
// so no mob pokes out of its card or sits off-centre, and adding a new mob is
// just one case in drawMobArt.
import {
  drawSpider, drawBee, drawQueenBee, drawLadybug, drawCentipedeHead, drawCentipedeBody, drawHornet,
  drawSoldierAnt, drawWorkerAnt, drawBabyAnt, drawQueenAnt, drawAntEgg, drawAntHole, drawDigger, drawBeekeeper, drawHive,
  drawDesertCentipedeHead, drawDesertCentipedeBody, drawBeetle, drawSandstorm, drawCactus, drawRock, drawDandelion,
  drawFireSoldierAnt, drawFireWorkerAnt, drawFireBabyAnt, drawFireQueenAnt, drawFireAntEgg, drawFireAntHole,
  drawScorpion, drawPyramid, drawMummifiedBeetle,
  drawJellyfish, drawSquid, drawAlligator, drawCrab, drawStarfish, drawShell, drawSponge,
  drawBubble, drawSeaCave, drawDebris, drawLeechPose,
  SHELL_FACING_CORRECTION, SPONGE_ICON_DOTS,
} from './mobDrawing.js';

/** Every directional mob faces this way in icons (facing 0 = east, so −45° = north-east). */
export const NE_FACING = -Math.PI / 4;

const REF_R = 40;   // reference radius the bounds are measured at

/**
 * Draws a mob's icon art centred near (0,0) at radius r, facing north-east.
 * `t` is a timestamp in ms driving idle animations (tentacles, spinning
 * cutters, sandstorm hexes); pass a fixed value for a frozen pose.
 * `live` adds the extra idle motion the gallery uses (wobbling bees, walking
 * spider legs, clicking mandibles) that the pop cards leave still.
 */
function drawMobArt(ctx, typeId, r, t, live = false) {
  const legPhase     = (t * 0.006)  % (Math.PI * 2);
  const pincerPhase  = (t * 0.004)  % (Math.PI * 2);
  const slowPhase    = (t * 0.0015) % (Math.PI * 2);
  const cutterRot    = (t * 0.0012) % (Math.PI * 2);
  const wobble       = live ? (t * 0.004) % (Math.PI * 2) : 0;
  const livePhase    = live ? slowPhase : 0;
  const wingPhase    = live ? (t * 0.012) % (Math.PI * 2) : 0;
  switch (typeId) {
    case 'bee':        drawBee(ctx, 0, 0, r, NE_FACING, wobble); break;
    case 'queen_bee':  drawQueenBee(ctx, 0, 0, r, NE_FACING, wobble); break;
    case 'beehive':    drawHive(ctx, 0, 0, r); break;
    case 'hornet':     drawHornet(ctx, 0, 0, r, NE_FACING, 0, 1); break;   // full stinger, no wobble
    case 'ladybug':    drawLadybug(ctx, 0, 0, r, NE_FACING, []); break;
    case 'spider':     drawSpider(ctx, 0, 0, r, NE_FACING, legPhase, live ? 1 : 0); break;
    case 'centipede_head':
    case 'centipede_body': {
      // Head plus one trailing body segment so it reads as a centipede.
      const back = NE_FACING + Math.PI;
      drawCentipedeBody(ctx, Math.cos(back) * r * 1.55, Math.sin(back) * r * 1.55, r * 0.9, NE_FACING, 0, 1);
      drawCentipedeHead(ctx, 0, 0, r, NE_FACING);
      break;
    }
    case 'desert_centipede_head':
    case 'desert_centipede_body': {
      const back = NE_FACING + Math.PI;
      drawDesertCentipedeBody(ctx, Math.cos(back) * r * 1.55, Math.sin(back) * r * 1.55, r * 0.9, NE_FACING, (t * 0.0018) % (Math.PI * 2), 1);
      drawDesertCentipedeHead(ctx, 0, 0, r, NE_FACING);
      break;
    }
    case 'soldier_ant':      drawSoldierAnt(ctx, 0, 0, r, NE_FACING, slowPhase, slowPhase); break;
    case 'worker_ant':       drawWorkerAnt(ctx, 0, 0, r, NE_FACING, slowPhase); break;
    case 'baby_ant':         drawBabyAnt(ctx, 0, 0, r, NE_FACING, slowPhase); break;
    case 'queen_ant':        drawQueenAnt(ctx, 0, 0, r, NE_FACING, livePhase, wingPhase); break;
    case 'ant_egg':          drawAntEgg(ctx, 0, 0, r); break;
    case 'ant_hole':         drawAntHole(ctx, 0, 0, r); break;
    case 'fire_soldier_ant': drawFireSoldierAnt(ctx, 0, 0, r, NE_FACING, slowPhase, slowPhase); break;
    case 'fire_worker_ant':  drawFireWorkerAnt(ctx, 0, 0, r, NE_FACING, slowPhase); break;
    case 'fire_baby_ant':    drawFireBabyAnt(ctx, 0, 0, r, NE_FACING, slowPhase); break;
    case 'fire_queen_ant':   drawFireQueenAnt(ctx, 0, 0, r, NE_FACING, livePhase, wingPhase); break;
    case 'fire_ant_egg':     drawFireAntEgg(ctx, 0, 0, r); break;
    case 'fire_ant_hole':    drawFireAntHole(ctx, 0, 0, r); break;
    case 'beetle':           drawBeetle(ctx, 0, 0, r, NE_FACING, live ? pincerPhase : 0); break;
    case 'digger':           drawDigger(ctx, 0, 0, r, 'neutral', cutterRot, 0, null); break;
    case 'beekeeper':        drawBeekeeper(ctx, 0, 0, r, 'neutral', cutterRot, 0, null); break;
    case 'sandstorm':
      drawSandstorm(ctx, 0, 0, r, [(t * -0.001) % (Math.PI * 2), (t * -0.0008) % (Math.PI * 2), (t * 0.0012) % (Math.PI * 2)], false, false);
      break;
    case 'cactus':           drawCactus(ctx, 0, 0, r); break;
    case 'rock':             drawRock(ctx, 0, 0, r); break;
    case 'dandelion':        drawDandelion(ctx, 0, 0, r); break;
    case 'scorpion':         drawScorpion(ctx, 0, 0, r, NE_FACING, legPhase, pincerPhase); break;
    case 'pyramid':          drawPyramid(ctx, 0, 0, r); break;
    case 'mummified_beetle': drawMummifiedBeetle(ctx, 0, 0, r, NE_FACING, pincerPhase); break;
    case 'squid':            drawSquid(ctx, 0, 0, r, NE_FACING, slowPhase); break;
    case 'alligator':        drawAlligator(ctx, 0, 0, r, NE_FACING, slowPhase); break;
    case 'jellyfish':        drawJellyfish(ctx, 0, 0, r, slowPhase, NE_FACING); break;
    // Crab and shell sprites are authored facing a different way — apply the
    // same corrections drawMob uses in-world so they still face north-east.
    case 'crab':             drawCrab(ctx, 0, 0, r, NE_FACING + Math.PI, (t * 0.002) % (Math.PI * 2)); break;
    case 'shell':            drawShell(ctx, 0, 0, r, NE_FACING + SHELL_FACING_CORRECTION); break;
    case 'starfish':
      // Radially symmetric — rotated like the live mob (rotate(facing)).
      ctx.save(); ctx.rotate(NE_FACING); drawStarfish(ctx, 0, 0, r, 0, 0); ctx.restore();
      break;
    case 'sponge':           drawSponge(ctx, 0, 0, r, SPONGE_ICON_DOTS); break;
    case 'bubble':           drawBubble(ctx, 0, 0, r); break;
    case 'sea_cave':         drawSeaCave(ctx, 0, 0, r); break;
    case 'debris':           drawDebris(ctx, 0, 0, r); break;
    case 'leech':
      // Fixed 380-unit icon pose authored head-top-left (north-west); mirrored
      // so the head points north-east like every other mob.
      ctx.save();
      ctx.scale(-r / 150, r / 150);
      ctx.translate(-150, -150);
      drawLeechPose(ctx, 0, 0);
      ctx.restore();
      break;
    // ── Summons that aren't regular mob types (pop cards only) ──────────────
    case 'spider_egg':
      // Same silky sac as the in-world spider egg (drawMob's spider_egg case)
      ctx.beginPath(); ctx.arc(0, 0, r * 1.12, 0, Math.PI * 2);
      ctx.fillStyle = '#2a1a0a'; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#e8dfc8'; ctx.fill();
      break;
    case 'queen_bee_egg':
    case 'queen_hornet_egg': {
      // Same oval as the queen bee eggs drawn in renderer.js; hornet eggs get the dark X
      const bw = r * 0.14;
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.66 + bw, r + bw, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#ca9f25'; ctx.fill();
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.66, r, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#f5cf4b'; ctx.fill();
      if (typeId === 'queen_hornet_egg') {
        const xs = r * 0.22;
        ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = r * 0.13; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-xs, -xs); ctx.lineTo(xs, xs); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(xs, -xs); ctx.lineTo(-xs, xs); ctx.stroke();
      }
      break;
    }
    case 'ladybug_rose':
      // Boss ladybug's rose minion — same pink disc as in-world
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#f0287a'; ctx.fill();
      ctx.strokeStyle = '#a0005a'; ctx.lineWidth = r * 0.18; ctx.stroke();
      break;
    default:
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#aaaaaa'; ctx.strokeStyle = '#555555'; ctx.lineWidth = r * 0.12;
      ctx.fill(); ctx.stroke();
  }
}

// ── Bounds measurement ───────────────────────────────────────────────────────
const _boundsCache = new Map();   // typeId -> { cx, cy, w, h } in REF_R units
const SAMPLE_TIMES = [0, 700, 1400, 2100, 2800];  // union of a few animation frames

function measureMobBounds(typeId) {
  const cached = _boundsCache.get(typeId);
  if (cached) return cached;
  const SIZE = REF_R * 12, mid = SIZE / 2;   // ±6 radii of room
  const cv = document.createElement('canvas');
  cv.width = SIZE; cv.height = SIZE;
  const c = cv.getContext('2d', { willReadFrequently: true });
  let minX = SIZE, minY = SIZE, maxX = -1, maxY = -1;
  for (const t of SAMPLE_TIMES) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, SIZE, SIZE);
    c.translate(mid, mid);
    drawMobArt(c, typeId, REF_R, t);
    const data = c.getImageData(0, 0, SIZE, SIZE).data;
    for (let y = 0; y < SIZE; y++) {
      const row = y * SIZE * 4;
      for (let x = 0; x < SIZE; x++) {
        if (data[row + x * 4 + 3] > 8) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
  }
  const b = maxX < 0
    ? { cx: 0, cy: 0, w: REF_R * 2, h: REF_R * 2 }
    : { cx: (minX + maxX + 1) / 2 - mid, cy: (minY + maxY + 1) / 2 - mid, w: maxX - minX + 1, h: maxY - minY + 1 };
  _boundsCache.set(typeId, b);
  return b;
}

/**
 * Draws `typeId`'s icon fitted inside the box (x, y, w, h): uniformly scaled
 * so its measured bounds just fit, and centred. `time` drives idle animation
 * (defaults to now); `live` turns on the gallery's extra idle motion.
 */
export function drawMobIconInBox(ctx, typeId, x, y, w, h, time = Date.now(), live = false) {
  if (!(w > 0 && h > 0)) return;   // cards pop in from 0px — nothing visible yet
  const b = measureMobBounds(typeId);
  const k = Math.min(w / b.w, h / b.h);
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(k, k);
  ctx.translate(-b.cx, -b.cy);
  drawMobArt(ctx, typeId, REF_R, time, live);
  ctx.restore();
}
