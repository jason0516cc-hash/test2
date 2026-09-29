/**
 * client/ui/homeBackground.js — the homescreen's animated background.
 *
 *   - Floor: the selected biome's own map floor (colour + texture shapes,
 *     from client/render/biomes/*.js FLOOR), drifting slowly.
 *   - Mobs: that biome's mobs (no eggs) spiral in from the edges and shrink
 *     into the centre, drawn with the in-game mob drawer and every idle
 *     animation running at in-game speed (legs, wings, pincers, wobble,
 *     tentacles, tails, spinning hexes and cutters). Diggers and beekeepers show up in every biome (and
 *     keep going when the biome changes); leeches never appear.
 *   - Switching biome: the new floor opens out in a circle from the clicked
 *     button, and every mob pops into one of the new biome's mobs as the
 *     edge passes it.
 */
import { BIOME_FLOORS } from '../render/mapRenderer.js';
import { drawMob as drawWorldMob } from '../render/mobDrawing.js';
import { MOB_DEFS } from '../../shared/mobTypes.js';

// ── Which mobs appear where (relative weights) ──────────────────────────────
// 'centipede' / 'desert_centipede' are whole chains (head + body segments).
const BIOME_MOBS = {
  garden: {
    bee: 4, ladybug: 3, spider: 3, hornet: 3, soldier_ant: 2, worker_ant: 2, baby_ant: 2,
    queen_ant: 1, queen_bee: 1, ant_hole: 1, beehive: 1, rock: 1.5, dandelion: 1.5, centipede: 0.6,
  },
  desert: {
    beetle: 4, scorpion: 3, sandstorm: 3, cactus: 2, fire_soldier_ant: 2, fire_worker_ant: 2,
    fire_baby_ant: 2, fire_queen_ant: 1, fire_ant_hole: 1, pyramid: 1, mummified_beetle: 1.5,
    desert_centipede: 0.6,
  },
  ocean: {
    jellyfish: 4, squid: 3, crab: 3, starfish: 2.5, alligator: 1.5, shell: 2, sponge: 1.5,
    bubble: 2.5, sea_cave: 1, debris: 1.5,
  },
};
const NEUTRAL = { digger: 0.02, beekeeper: 0.03 };   // chance per spawn, any biome
const CHAINS  = new Set(['centipede', 'desert_centipede']);
// Nests, plants and scenery turn slowly instead of facing where they go
const STATIC  = new Set(['ant_hole', 'beehive', 'rock', 'dandelion', 'cactus', 'fire_ant_hole', 'pyramid',
                         'shell', 'sponge', 'bubble', 'sea_cave', 'debris', 'starfish']);

const TOTAL_MOBS   = 60;
const SPAWN_EVERY  = 160;    // ms between spawns while filling up
const REVEAL_MS    = 750;
const CELL         = 210;    // floor texture spacing (px)

function pickWeighted(table) {
  let sum = 0;
  for (const k in table) sum += table[k];
  let r = Math.random() * sum;
  for (const k in table) { r -= table[k]; if (r <= 0) return k; }
  return Object.keys(table)[0];
}
const rand = (a, b) => a + Math.random() * (b - a);
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function backOut(t) { const c = 1.7; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }

/** Visual size factor from the mob's real radius (bee = 1). */
function sizeOf(type) {
  const id = type === 'centipede' ? 'centipede_head' : type === 'desert_centipede' ? 'desert_centipede_head' : type;
  const r = MOB_DEFS[id]?.radius ?? 18;
  return Math.max(0.8, Math.min(1.8, Math.pow(r / 18, 0.7)));
}

export function createHomeBackground(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  let biome = 'garden';
  let reveal = null;          // { from, to, t0, ox, oy, maxR }
  const fields = {};          // biome → floor shapes for the current size
  const mobs = [];
  const puffs = [];
  let raf = null, last = 0, spawnClock = 0;
  let offX = 0, offY = 0, velX = 0.24, velY = 0.15, tvX = 0.24, tvY = 0.15, dirClock = 0;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    for (const k in fields) delete fields[k];
    for (const m of mobs) retarget(m);
  }

  // ── Floor ──────────────────────────────────────────────────────────────────
  function field(b) {
    if (fields[b]) return fields[b];
    const F = BIOME_FLOORS[b];
    const cols = Math.ceil((W + CELL * 2) / CELL), rows = Math.ceil((H + CELL * 2) / CELL);
    const shapes = [];
    for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
      shapes.push({
        bx: (gx + 0.2 + Math.random() * 0.6) * CELL, by: (gy + 0.2 + Math.random() * 0.6) * CELL,
        r: F.radius * rand(F.sizeMin, F.sizeMax), rot: Math.random() * Math.PI * 2,
        k1: Math.random(), k2: Math.random(), x: 0, y: 0,
      });
    }
    return (fields[b] = { F, shapes, spanX: cols * CELL, spanY: rows * CELL });
  }

  function drawFloor(b) {
    const { F, shapes, spanX, spanY } = field(b);
    ctx.fillStyle = F.color;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = F.shapeColor;
    for (const s of shapes) {
      s.x = ((s.bx + offX) % spanX + spanX) % spanX - CELL;
      s.y = ((s.by + offY) % spanY + spanY) % spanY - CELL;
      if (s.x < -s.r * 2 || s.x > W + s.r * 2 || s.y < -s.r * 2 || s.y > H + s.r * 2) continue;
      F.path(ctx, s);
      ctx.fill();
    }
  }

  // ── Mobs (spiral from an edge into the centre, shrinking) ─────────────────
  function pickType() {
    for (const [t, p] of Object.entries(NEUTRAL)) if (Math.random() < p) return t;
    return pickWeighted(BIOME_MOBS[biome]);
  }

  function retarget(m) {
    m.mx = W / 2; m.my = H / 2;
    m.dist = Math.max(60, Math.hypot(m.mx - m.cx, m.my - m.cy));
  }

  function makeMob() {
    const edge = Math.floor(Math.random() * 4), off = 50;
    const cx = edge === 0 ? Math.random() * W : edge === 1 ? W + off : edge === 2 ? Math.random() * W : -off;
    const cy = edge === 0 ? -off : edge === 1 ? Math.random() * H : edge === 2 ? H + off : Math.random() * H;
    const type = pickType();
    const m = {
      type, cx, cy, t: 0,
      turns: rand(0.7, 1.3), spin: Math.random() < 0.5 ? 1 : -1,
      startR: rand(16, 28) * sizeOf(type),
      speed: rand(0.00004, 0.00014),       // path fraction per ms
      rot: Math.random() * Math.PI * 2, rotSpeed: rand(-0.0006, 0.0006),
      phase: Math.random() * 10000, popAt: -1e9, kills: 0,
      anim: newAnim(),
    };
    retarget(m);
    m.baseAngle = Math.atan2(m.my - cy, m.mx - cx);
    if (CHAINS.has(type)) {
      m.speed *= 3;
      m.segments = [];
      const n = 7 + Math.floor(Math.random() * 9);
      const spacing = (1.9 * m.startR) / m.dist;
      for (let i = 0; i < n; i++) m.segments.push({ t: -(i + 1) * spacing, idx: i + 1 });
    }
    return m;
  }

  // ── In-game animation state ────────────────────────────────────────────────
  // The same fields game/mobs.js advances each tick, advanced here at the
  // same per-tick rates (a tick = 1/60 s) so every mob moves like in game.
  function newAnim() {
    const r = () => Math.random() * Math.PI * 2;
    return {
      typeId: '', id: Math.floor(Math.random() * 1e6) + 1, facing: 0, speed: 1, state: 'neutral',
      wobblePhase: r(), legPhase: r(), pincerPhase: r(), wingPhase: r(), tentaclePhase: r(), tailPhase: r(),
      hexRotations: [r(), r(), r()], cutterRot: r(), eyeAngle: 0, stingerProgress: 1,
      hp: 1, maxHp: 1, isFriendlyPet: false, spots: null, spongeDots: null,
    };
  }
  const HEX_SPEEDS = [-0.00225, -0.006, 0.00525];   // per ms, as in game/mobs.js
  function stepAnim(a, dt) {
    const k = dt / 16.67;   // game ticks this frame
    a.wobblePhase   += 0.12 * k;
    a.legPhase      += 0.2 * k;
    a.pincerPhase   += 0.18 * k;
    a.wingPhase     += 0.14 * k;
    a.tentaclePhase += 0.06 * k;
    a.tailPhase     += 0.05 * k;
    a.cutterRot     += 0.03 * k;
    for (let i = 0; i < 3; i++) a.hexRotations[i] += HEX_SPEEDS[i] * dt;
  }

  function pos(m, t = m.t) {
    const a = m.baseAngle + m.spin * m.turns * Math.PI * 2 * t;
    const rad = m.dist * (1 - t);
    return { x: m.mx + Math.cos(a) * rad, y: m.my + Math.sin(a) * rad, r: m.startR * (1 - t) };
  }

  function heading(m, t = m.t) {
    const a = pos(m, t), b = pos(m, t + 0.002);
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  function popScale(m, now) {
    const p = (now - m.popAt) / 380;
    return p >= 1 ? 1 : Math.max(0, backOut(Math.max(0, p)));
  }

  function drawMob(m, now) {
    const p = pos(m);
    if (p.r < 1) return;
    const s = popScale(m, now);
    if (s <= 0.01) return;
    const a = m.anim;

    if (m.segments) {
      const desert = m.type === 'desert_centipede';
      a.typeId = desert ? 'desert_centipede_body' : 'centipede_body';
      let prev = p;
      for (const seg of m.segments) {
        if (seg.t <= 0) break;
        const sp = pos(m, seg.t);
        if (sp.r < 1) { prev = sp; continue; }
        a.facing = Math.atan2(prev.y - sp.y, prev.x - sp.x);
        a.segIndex = seg.idx;
        drawWorldMob(ctx, a, sp.x, sp.y, sp.r * s);
        prev = sp;
      }
      a.typeId = desert ? 'desert_centipede_head' : 'centipede_head';
      a.facing = heading(m);
      drawWorldMob(ctx, a, p.x, p.y, p.r * s);
      return;
    }

    a.typeId = m.type;
    a.eyeAngle = a.facing = STATIC.has(m.type) ? m.rot : heading(m);
    if (STATIC.has(m.type)) {
      // Scenery without a facing of its own still turns slowly
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(m.rot);
      drawWorldMob(ctx, a, 0, 0, p.r * s);
      ctx.restore();
    } else {
      drawWorldMob(ctx, a, p.x, p.y, p.r * s);
    }
  }

  function puff(x, y, r, color = '#ffffff') { if (r > 0.5) puffs.push({ x, y, r, age: 0, color }); }

  /** Turns a mob into one of the current biome's mobs, with a pop. */
  function swapMob(m, now) {
    const p = pos(m);
    if (m.segments) for (const seg of m.segments) {
      if (seg.t > 0) { const sp = pos(m, seg.t); puff(sp.x, sp.y, sp.r * 1.4); }
    }
    let type = pickWeighted(BIOME_MOBS[biome]);
    for (let i = 0; i < 6 && CHAINS.has(type); i++) type = pickWeighted(BIOME_MOBS[biome]);
    if (CHAINS.has(type)) type = Object.keys(BIOME_MOBS[biome])[0];
    m.startR = m.startR / sizeOf(m.type) * sizeOf(type);
    m.type = type;
    m.anim.spots = null; m.anim.spongeDots = null;
    m.segments = null;
    m.speed = Math.min(m.speed, 0.00014);
    m.popAt = now;
    m.swap = false;
    puff(p.x, p.y, p.r * 1.6);
  }

  // ── Frame ──────────────────────────────────────────────────────────────────
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, Math.max(0, now - last));
    last = now;

    // Drift direction wanders every few seconds
    dirClock -= dt;
    if (dirClock <= 0) {
      const a = Math.random() * Math.PI * 2, sp = rand(0.18, 0.34);
      tvX = Math.cos(a) * sp; tvY = Math.sin(a) * sp;
      dirClock = rand(3000, 5000);
    }
    const kv = 1 - Math.pow(0.98, dt / 16.67);
    velX += (tvX - velX) * kv; velY += (tvY - velY) * kv;
    offX += velX * dt; offY += velY * dt;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Floor — and the new biome opening out over it while switching
    let revealR = -1;
    if (reveal) {
      // (rAF's timestamp can be a touch earlier than the click's performance.now())
      const p = Math.max(0, Math.min(1, (now - reveal.t0) / REVEAL_MS));
      revealR = easeInOut(p) * reveal.maxR;
      drawFloor(reveal.from);
      ctx.save();
      ctx.beginPath(); ctx.arc(reveal.ox, reveal.oy, revealR, 0, Math.PI * 2); ctx.clip();
      drawFloor(reveal.to);
      ctx.restore();
      // soft bright edge on the growing circle
      ctx.save();
      ctx.globalAlpha = 0.35 * (1 - p);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.arc(reveal.ox, reveal.oy, revealR, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      if (p >= 1) { reveal = null; revealR = Infinity; }
    } else {
      drawFloor(biome);
    }

    // Spawn up to the target count, a few at a time
    spawnClock -= dt;
    if (mobs.length < TOTAL_MOBS && spawnClock <= 0) { mobs.push(makeMob()); spawnClock = SPAWN_EVERY; }

    for (let i = mobs.length - 1; i >= 0; i--) {
      const m = mobs[i];
      m.t += m.speed * dt;
      m.rot += m.rotSpeed * dt;
      stepAnim(m.anim, dt);
      if (m.segments) for (const seg of m.segments) seg.t += m.speed * dt;

      // The switch reaches this mob → it becomes a new-biome mob
      if (m.swap && revealR >= 0) {
        const p = pos(m);
        if (Math.hypot(p.x - reveal?.ox, p.y - reveal?.oy) <= revealR || revealR === Infinity) swapMob(m, now);
      }

      // Diggers pop whatever they bump into (and pop themselves after 4)
      if (m.type === 'digger') {
        const dp = pos(m);
        for (const o of mobs) {
          if (o === m || o.type === 'digger' || o.dead) continue;
          const op = pos(o);
          if (Math.hypot(op.x - dp.x, op.y - dp.y) < dp.r + op.r) {
            o.dead = true; puff(op.x, op.y, op.r * 2.2);
            if (++m.kills >= 4) { m.dead = true; puff(dp.x, dp.y, dp.r * 2.6); break; }
          }
        }
      }

      const lastT = m.segments?.length ? m.segments[m.segments.length - 1].t : m.t;
      if (m.dead || lastT >= 1) { mobs[i] = makeMob(); continue; }
      drawMob(m, now);
    }

    // Pop puffs
    for (let i = puffs.length - 1; i >= 0; i--) {
      const f = puffs[i];
      f.age += dt / 420;
      if (f.age >= 1) { puffs.splice(i, 1); continue; }
      const a = 1 - f.age, rr = f.r * (1 + f.age * 1.3);
      ctx.save();
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = f.color; ctx.lineWidth = Math.max(1.5, rr * 0.16);
      ctx.beginPath(); ctx.arc(f.x, f.y, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = a * 0.3;
      ctx.fillStyle = f.color;
      ctx.beginPath(); ctx.arc(f.x, f.y, rr * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    start() { if (raf == null) { last = performance.now(); raf = requestAnimationFrame(frame); } },
    stop()  { if (raf != null) { cancelAnimationFrame(raf); raf = null; } },
    get biome() { return biome; },
    /** Switch biome, opening the new floor out from (ox, oy). */
    setBiome(next, ox = W / 2, oy = H / 2) {
      if (!BIOME_FLOORS[next] || (next === biome && !reveal)) return;
      const from = reveal ? reveal.to : biome;
      biome = next;
      if (raf == null) { reveal = null; for (const m of mobs) if (!NEUTRAL[m.type]) swapMob(m, -1e9); return; }
      const maxR = Math.max(Math.hypot(ox, oy), Math.hypot(W - ox, oy), Math.hypot(ox, H - oy), Math.hypot(W - ox, H - oy));
      reveal = { from, to: next, t0: performance.now(), ox, oy, maxR };
      for (const m of mobs) m.swap = !NEUTRAL[m.type];
    },
  };
}
