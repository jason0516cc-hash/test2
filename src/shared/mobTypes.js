// mobTypes.js — what every mob IS: base definitions (size, speed, colours,
// XP, aggro), per-rarity stat tables, and size/mass scaling. Pure data +
// lookups, shared by the game simulation (game/mobs.js) and the client UI
// (mob gallery, tooltips). Mob behaviour/AI lives in game/mobs.js.
import { AGGRO_TIER_SCALE, MOB_SPEED_SCALE, PLAYER_SPEED } from './constants.js';

// ── Speeds tied to the player's base speed ─────────────────────────────────────
// Mob and player speeds go through the same 0.6 scale (MOB_SPEED_SCALE /
// PLAYER_SPEED_SCALE), so these are exact multiples of a player's base walk:
// ants (not baby ants) match it, bees are 35% faster, hornets 50% faster.
const BEE_SPEED    = PLAYER_SPEED * 1.35;
const HORNET_SPEED = PLAYER_SPEED * 1.5;

// ── Mob type base definitions ──────────────────────────────────────────────────
export const MOB_DEFS = {
  bee: {
    name:'Bee', description:'Eek! don\'t ram this guy!',
    radius:18, hitRadiusFactor:1.71, speed:BEE_SPEED, alertSpeed:BEE_SPEED, color:'#f5cf4b', border:'#ca9f25',
    xp:4, aggroRange:420, mass:80, dpsFactor:0.89,
  },
  ladybug: {
    name:'Ladybug', description:'Spots danger from surprisingly far away. Hits harder than it looks.',
    radius:18, hitRadiusFactor:1.123, speed:1.824, alertSpeed:3.2, color:'#e84040', border:'#991a1a',
    xp:3, aggroRange:260, mass:120, dpsFactor:0.86,
  },
  spider: {
    name:'Spider', description:'Yikes! Haci dolor! this little fella doesn\'t feel too good..',
    radius:18, hitRadiusFactor:1.06, speed:3.84, alertSpeed:3.84, color:'#5c3b1c', border:'#42280f',
    xp:5, aggroRange:320, mass:220, dpsFactor:1.00,
  },
  centipede_head: {
    name:'Centipede', description:'Sure is a an interesting specimen isn\'t it? It also kinda tickes with the touch..',
    radius:20, hitRadiusFactor:1.13, speed:2.1, alertSpeed:3.2, color:'#7ed62a', border:'#3a6b1a',
    xp:10, aggroRange:300, mass:180, dpsFactor:1.0,
  },
  centipede_body: {
    name:'Centipede', description:'',
    radius:20, hitRadiusFactor:1.13, speed:2.1, alertSpeed:3.2, color:'#7ed62a', border:'#3a6b1a',
    xp:4, aggroRange:0, mass:140, dpsFactor:1.0,
  },
  hornet: {
    name:'Hornet', description:'It shoots pokey things up the flowers stem..',
    radius:18, hitRadiusFactor:1.47, speed:HORNET_SPEED, alertSpeed:HORNET_SPEED, color:'#f5cf4b', border:'#ca9f25',
    xp:7, aggroRange:450, mass:70, dpsFactor:1.0,  // body damage enabled
  },
  soldier_ant: {
    name:'Soldier Ant', description:'Gah damn, this ants a visious little guy aint he?',
    radius:20, hitRadiusFactor:1.145, hitOffsetY:-5.5, speed:PLAYER_SPEED, alertSpeed:PLAYER_SPEED, color:'#3d3d3d', border:'#1a1a1a',
    xp:8, aggroRange:280, mass:100, dpsFactor:1.0,
  },
  worker_ant: {
    name:'Worker Ant', description:'seems like this guys just hanging around, peaceful untill hit..',
    radius:18, hitRadiusFactor:1.125, hitOffsetY:-8.5, speed:PLAYER_SPEED, alertSpeed:PLAYER_SPEED, color:'#3d3d3d', border:'#1a1a1a',
    xp:5, aggroRange:0, mass:90, dpsFactor:1.0,
  },
  baby_ant: {
    name:'Baby Ant', description:'Aww, what a cute baby! Gooh gooh gah gah..',
    radius:13, hitRadiusFactor:0.82, hitOffsetY:0, speed:1.5, alertSpeed:1.5, color:'#3d3d3d', border:'#1a1a1a',
    xp:2, aggroRange:0, mass:50, dpsFactor:0.0,
  },
  queen_ant: {
    name:'Queen Ant', description:'Such royalty that she can make slav- i mean soldiers at her own will..',
    radius:42, hitRadiusFactor:1.058, hitOffsetX:0, hitOffsetY:-8.5, speed:PLAYER_SPEED, alertSpeed:PLAYER_SPEED, color:'#3d3d3d', border:'#1a1a1a',
    xp:20, aggroRange:300, mass:220, dpsFactor:1.0,
  },
  digger: {
    name:'Digger', description:'Youch! Spikey! But he does make a good comrade..',
    radius:25, hitRadiusFactor:1.535, speed:3.2, alertSpeed:5, color:'#8c8c8c', border:'#1a1a1a',
    xp:12, aggroRange:350, mass:160, dpsFactor:1.0,
  },
  beekeeper: {
    name:'Beekeeper', description:'Spikey.. also a good comrade as well! but has stick honey lingering on it that spills off as honey tiles..',
    radius:25, hitRadiusFactor:1.188, speed:3.5, alertSpeed:5.5, color:'#F0A830', border:'#A86820',
    xp:12, aggroRange:350, mass:280, dpsFactor:1.0,
  },
  ant_hole: {
    name:'Ant Hole', description:'The beating heart of the colony. Spawns defenders when damaged. Erupts violently when destroyed.',
    radius:38, hitRadiusFactor:1.0, speed:0, alertSpeed:0, color:'#b8750a', border:'#7a4d08',
    xp:50, aggroRange:0, mass:6000, dpsFactor:1.0,
  },
  ant_egg: {
    name:'Ant Egg', description:'Turns into a slav- i mean Soldier ant',
    radius:14, hitRadiusFactor:1.04, speed:0, alertSpeed:0, color:'#e8e8e8', border:'#1a1a1a',
    xp:4, aggroRange:0, mass:180, dpsFactor:0.0,
  },
  beehive: {
    name:'Beehive', description:'Eww.. Why is it so oohy goohy icky and sticky?',
    radius:28, hitRadiusFactor:1.57, hitOffsetX:0.0, hitOffsetY:0.0, speed:0, alertSpeed:0, color:'#e8a820', border:'#a06010',
    xp:60, aggroRange:0, mass:4500, dpsFactor:1.0,
  },
  rock: {
    name:'Rock', description:'Just an ordinary garden rock. Not going anywhere.',
    radius:20, hitRadiusFactor:1.075, hitOffsetX:0.0, hitOffsetY:0.2, speed:0, alertSpeed:0, color:'#8a8580', border:'#5c5852',
    xp:10, aggroRange:0, mass:5000, dpsFactor:1.0,
  },
  dandelion: {
    name:'Dandelion', description:'A dandelion, seeds and all. Fragile-looking, but it holds its ground.',
    radius:24, hitRadiusFactor:1.0, hitOffsetX:0.0, hitOffsetY:0.0, speed:0, alertSpeed:0, color:'#ffffff', border:'#8a8a8a',
    xp:14, aggroRange:0, mass:800, dpsFactor:1.0,
  },
  queen_bee: {
    name:'Queen Bee', description:'Same as queen ant.. Can also poo out slav- i mean gaurdians with her own free willl.. Don\'t forget, she also hurts!',
    radius:27, hitRadiusFactor:1.71, hitOffsetX:0.0, hitOffsetY:0.0, speed:BEE_SPEED, alertSpeed:BEE_SPEED, color:'#f5cf4b', border:'#ca9f25',
    xp:20, aggroRange:380, mass:120, dpsFactor:1.0,
  },
  beetle: {
    name:'Beetle', description:'Those mandibles look sharp.. maybe don\'t get too close.',
    radius:20, hitRadiusFactor:1.277, hitOffsetX:0.0, hitOffsetY:0.0, speed:2.6, alertSpeed:4.7, color:'#8E44AD', border:'#7D3C98',
    xp:5, aggroRange:280, mass:140, dpsFactor:1.0,
  },
  sandstorm: {
    name:'Sandstorm', description:'A swirling vortex of hexagonal sand shards. It drifts lazily... until it spots you.',
    radius:23, hitRadiusFactor:0.82, hitOffsetX:0.0, hitOffsetY:0.0, speed:1.8, alertSpeed:3.2, color:'#c8a84b', border:'#8a6820',
    xp:8, aggroRange:320, mass:160, dpsFactor:1.0,
  },
  desert_centipede_head: {
    name:'Desert Centipede', description:'A pale desert centipede that wanders the sands. It may not come straight for you, but it knows you\'re there.',
    radius:20, hitRadiusFactor:1.13, speed:5.2, alertSpeed:5.2, color:'#C5B357', border:'#8a7a30',
    xp:10, aggroRange:300, mass:180, dpsFactor:1.0,
  },
  desert_centipede_body: {
    name:'Desert Centipede', description:'',
    radius:20, hitRadiusFactor:1.13, speed:5.2, alertSpeed:5.2, color:'#C5B357', border:'#8a7a30',
    xp:4, aggroRange:0, mass:140, dpsFactor:1.0,
  },
  cactus: {
    name:'Cactus', description:'A prickly desert cactus. Don\'t get too close.',
    radius:32, hitRadiusFactor:1.0, hitOffsetX:0.0, hitOffsetY:0.0, speed:0, alertSpeed:0, color:'#689a10', border:'#3a5c0a',
    xp:12, aggroRange:0, mass:3000, dpsFactor:1.0,
  },

  // ── Desert / Egypt tier — NEW, all fields locked ────────────────────────────
  scorpion: {
    name:'Scorpion', description:'Its tail never stops twitching — it can smell you from here.',
    radius:22, hitRadiusFactor:0.80, hitOffsetX:-0.5, hitOffsetY:0.0,
    speed:1.56, alertSpeed:2.82, color:'#9a7412', border:'#6e5308',
    xp:6, aggroRange:350, mass:100, dpsFactor:1.0,
  },
  pyramid: {
    name:'Pyramid', description:'Ancient stone, still guarded. Something inside keeps sending more.',
    radius:24, hitRadiusFactor:1.20, hitOffsetX:0.0, hitOffsetY:0.0,
    speed:0, alertSpeed:0, color:'#d4a24a', border:'#8a651f',   // static structure
    xp:65, aggroRange:0, mass:6500, dpsFactor:1.0,
  },
  mummified_beetle: {
    name:'Mummified Beetle', description:'Wrapped tight and still walking. Whatever put it here didn\'t finish the job.',
    radius:20, hitRadiusFactor:1.25, hitOffsetX:0.0, hitOffsetY:0.0,
    speed:2.6, alertSpeed:4.7, color:'#e8dcc0', border:'#9e8b5e',
    xp:8, aggroRange:280, mass:165, dpsFactor:1.0,
  },

  // ── Fire Ants (desert) ────────────────────────────────────────────────────
  fire_soldier_ant: {
    name:'Fire Soldier Ant', description:'A vicious desert warrior — its bite burns like an ember.',
    radius:20, hitRadiusFactor:1.145, hitOffsetY:-5.5, speed:PLAYER_SPEED, alertSpeed:PLAYER_SPEED, color:'#8b1a00', border:'#5a0d00',
    xp:14, aggroRange:280, mass:100, dpsFactor:1.0,
  },
  fire_worker_ant: {
    name:'Fire Worker Ant', description:'Industrious and aggressive — don\'t let the name fool you.',
    radius:18, hitRadiusFactor:1.125, hitOffsetY:-8.5, speed:PLAYER_SPEED, alertSpeed:PLAYER_SPEED, color:'#8b1a00', border:'#5a0d00',
    xp:9, aggroRange:0, mass:90, dpsFactor:1.0,
  },
  fire_baby_ant: {
    name:'Fire Baby Ant', description:'Small, warm to the touch, and utterly harmless.',
    radius:13, hitRadiusFactor:0.82, hitOffsetY:0, speed:1.5, alertSpeed:1.5, color:'#8b1a00', border:'#5a0d00',
    xp:3, aggroRange:0, mass:50, dpsFactor:0.0,
  },
  fire_queen_ant: {
    name:'Fire Queen Ant', description:'Rules with fire. Lays eggs that hatch into burning soldiers.',
    radius:42, hitRadiusFactor:1.058, hitOffsetX:0, hitOffsetY:-8.5, speed:PLAYER_SPEED, alertSpeed:PLAYER_SPEED, color:'#8b1a00', border:'#5a0d00',
    xp:35, aggroRange:300, mass:220, dpsFactor:1.0,
  },
  fire_ant_egg: {
    name:'Fire Ant Egg', description:'Pulsing with heat — soon it will hatch.',
    radius:14, hitRadiusFactor:1.04, speed:0, alertSpeed:0, color:'#c0392b', border:'#5a0d00',
    xp:7, aggroRange:0, mass:180, dpsFactor:0.0,
  },
  fire_ant_hole: {
    name:'Fire Ant Hole', description:'A smoldering crater in the desert sand. The colony within does not welcome visitors.',
    radius:38, hitRadiusFactor:1.0, speed:0, alertSpeed:0, color:'#7a1f00', border:'#3d0d00',
    xp:88, aggroRange:0, mass:6000, dpsFactor:1.0,
  },

  // ── Ocean tier — NEW, all fields DRAFT (hitboxes measured against real sprites,
  //    everything else — speed/aggro/xp/mass/stats — is a first pass for polish later) ──
  jellyfish: {
    name:'Jellyfish', description:'Drifts along on its own. Brushing its tendrils stings more than you\'d expect.',
    radius:22, hitRadiusFactor:1.000, hitOffsetX:0.0, hitOffsetY:0.0, speed:1.4, alertSpeed:2.0, color:'#d68ce8', border:'#8c4aa0',
    xp:6, aggroRange:300, mass:60, dpsFactor:0.9,
  },
  squid: {
    name:'Squid', description:'Jets backward in short bursts, trailing ink when it gets spooked.',
    radius:24, hitRadiusFactor:0.640, hitOffsetX:0.0, hitOffsetY:-1.8, speed:3.96, alertSpeed:5.04, color:'#7a4fc9', border:'#4a2d80',
    xp:9, aggroRange:340, mass:110, dpsFactor:1.0,
  },
  alligator: {
    name:'Alligator', description:'Low, patient, and a lot faster than it looks once it commits to a lunge.',
    radius:33, hitRadiusFactor:1.538, hitOffsetX:0.0, hitOffsetY:0.0, speed:3.0, alertSpeed:6.2, color:'#4a7a3a', border:'#274018',
    xp:16, aggroRange:360, mass:260, dpsFactor:1.0,
  },
  crab: {
    name:'Crab', description:'Skitters sideways and snaps with a pincer that\'s stronger than its size suggests.',
    radius:20, hitRadiusFactor:1.022, hitOffsetX:0.0, hitOffsetY:0.0, speed:2.6, alertSpeed:4.4, color:'#e0693c', border:'#973f1e',
    xp:9, aggroRange:260, mass:140, dpsFactor:1.0,
  },
  starfish: {
    name:'Starfish', description:'Barely moves, barely fights back — mostly just sits there and takes it.',
    // hitRadiusFactor is set to the sprite's shortest-arm silhouette (all 5
    // arms fully retracted via the low-HP shrink in mobDrawing.js), not the
    // full-health outline — measured directly from STARFISH_OUTLINE at max
    // shrink (0.6067x the full-health radius), and kept fixed at that size
    // regardless of the starfish's current HP/shrink state.
    radius:20, hitRadiusFactor:0.607, hitOffsetX:0.0, hitOffsetY:0.0, speed:0.4, alertSpeed:0.6, color:'#e8934b', border:'#a3601f',
    xp:4, aggroRange:0, mass:90, dpsFactor:0.5,
  },
  shell: {
    name:'Shell', description:'Sits on the sea floor. Whatever used to live in it is long gone.',
    // Sits completely motionless until hit (aggroRange:0, same "passive until
    // touched" pattern as bee/starfish/leech), then every 0.7s gets pushed
    // toward its target in a real walked burst (not a teleport) — see the
    // dedicated Shell AI block in updateMobs. speed/alertSpeed here are the
    // walk speed used DURING that push; it is otherwise fully stationary.
    radius:18, hitRadiusFactor:1.000, hitOffsetX:0.0, hitOffsetY:0.0, speed:0, alertSpeed:6, color:'#f0dcc0', border:'#a88860',
    xp:3, aggroRange:0, mass:70, dpsFactor:1.0,
  },
  sponge: {
    name:'Sponge', description:'A soft, porous lump that doesn\'t react to much of anything.',
    radius:22, hitRadiusFactor:1.000, hitOffsetX:0.0, hitOffsetY:0.0, speed:0, alertSpeed:0, color:'#e8a848', border:'#a06e1e',
    xp:4, aggroRange:0, mass:80, dpsFactor:0.0,
  },
  bubble: {
    name:'Bubble', description:'Pops the instant anything touches it. Doesn\'t put up a fight.',
    radius:16, hitRadiusFactor:1.000, hitOffsetX:0.0, hitOffsetY:0.0, speed:0.6, alertSpeed:0.6, color:'#bfe8f2', border:'#8fd6e8',
    xp:1, aggroRange:0, mass:5, dpsFactor:0.0,
  },
  sea_cave: {
    name:'Sea Cave', description:'A dark opening in the reef. Best not to find out what\'s inside the hard way.',
    radius:38, hitRadiusFactor:1.0, hitOffsetX:0.0, hitOffsetY:0.0, speed:0, alertSpeed:0, color:'#3d7ea6', border:'#0a1f33',
    xp:40, aggroRange:0, mass:5500, dpsFactor:1.0,
  },
  debris: {
    name:'Debris', description:'Waterlogged junk that drifts slowly with the current, tumbling as it goes. Harmless, never aggressive.',
    radius:20, hitRadiusFactor:1.000, hitOffsetX:0.0, hitOffsetY:0.0, speed:0.5, alertSpeed:0.5, color:'#7a6a52', border:'#4a3e2c',
    xp:2, aggroRange:0, mass:60, dpsFactor:0.0,
  },
  leech: {
    name:'Leech', description:'Latches on fast. The gallery pose is fixed for now — no live movement animation yet.',
    // radius halved (20 -> 10) per a "make it a lot smaller" request — this
    // does NOT shrink the body's overall length, since body length is driven
    // purely by TRAIL_MAX_POINTS * speed (see mobs.js), completely
    // independent of radius. Only the body's thickness/width and the
    // head/fang size scale down with this, which is exactly the intended
    // "smaller and longer-looking" snake proportions.
    radius:10, hitRadiusFactor:1.000, hitOffsetX:0.0, hitOffsetY:0.0, speed:2.2, alertSpeed:3.6, color:'#3d3d3d', border:'#1a1a1a',
    xp:7, aggroRange:220, mass:100, dpsFactor:0.8,
  },
};

// ── Mob stat scaling ─────────────────────────────────────────────────────────
// Every mob's stats are (its Common base) × (a shared per-rarity multiplier).
// The multiplier is built from STEP tables: each entry is how much a stat grows
// going FROM the previous rarity INTO that one, so the curve is shaped by
// editing a single step instead of retyping 14 numbers for 40+ mobs.
//
// Balance reference — player petals scale DMG ×3 / HP ×3.75 per rarity, and
// the player's defensive petals (Soil max HP, Bone armor, heals) ×3. So a ×3
// step means "same fight as last rarity with same-rarity gear"; anything above
// ×3 is a difficulty wall, anything below eases the player in.
//
//   Common → Mythic : below ×3 — gentle on-ramp (HP matches the old curve)
//   Mythic → Ultra  : BIG wall — HP ×250 (Ultras sit in the millions), DMG ×10
//   Ultra  → Unique : HP ×3, DMG ×2.5
//   Unique → Runic  : second wall — HP ×5, DMG ×4
//   Runic  → Impr.  : HP ×3, DMG ×2.5
//
// HP is meant to tower over damage: from Ultra up HP grows faster than DMG, so
// the HP:DMG ratio widens every rarity (spider ~10:1 at Mythic, ~260:1 at
// Ultra, ~1000:1 at Voidbound). Armor and missile HP follow the DMG curve
// (armor is subtracted per frame from pet damage — HP-sized armor would make
// pets useless, and missiles should stay breakable in a hit or two).
//                          Com  Unu  Rar  Epi  Leg  Myt  Ult  Sup  Rad  Mys  Run  Ser  Umb  Imp
const MOB_HP_STEPS     = [  1, 2.2, 2.3, 2.3, 2.6, 2.7, 250,   3,   3,   3,   5,   3,   3,   3];
const MOB_DMG_STEPS    = [  1, 1.5, 1.7, 1.9, 2.1, 2.3,  10, 2.5, 2.5, 2.5,   4, 2.5, 2.5, 2.5];

function cumulativeSteps(steps) {
  const out = [];
  for (let t = 0; t < steps.length; t++) out.push(t === 0 ? 1 : out[t - 1] * steps[t]);
  return out;
}
export const MOB_HP_MULT  = cumulativeSteps(MOB_HP_STEPS);
export const MOB_DMG_MULT = cumulativeSteps(MOB_DMG_STEPS);

/** Scales a Common base value across all 14 rarities. Non-zero bases never round below 1. */
function scaleByTier(base, mult) {
  return mult.map(m => base === 0 ? 0 : Math.max(1, Math.round(base * m)));
}

// Spider poison total damage per tier (total over 3s) — follows the damage curve.
export const SPIDER_POISON_TOTAL = scaleByTier(10, MOB_DMG_MULT);

// Common-rarity base stats. hp uses MOB_HP_MULT; dmg/armor/missileHp/missileDmg use MOB_DMG_MULT.
const MOB_BASE_STATS = {
  spider:                { hp:90, dmg:30, armor:1 },
  bee:                   { hp:65, dmg:31, armor:0 },  // bee dmg buffed 10%
  ladybug:               { hp:110, dmg:28, armor:1 },  // ladybug dmg lowered to not exceed bee
  centipede_head:        { hp:125, dmg:28, armor:1 },
  hornet:                { hp:75, dmg:40, armor:1, missileHp:40, missileDmg:20 },
  soldier_ant:           { hp:145, dmg:35, armor:2 },
  worker_ant:            { hp:85, dmg:28, armor:1 },
  baby_ant:              { hp:22, dmg:8, armor:0 },
  fire_baby_ant:         { hp:22, dmg:14, armor:0 },  // baby_ant dmg 8 × 1.75 = 14
  queen_ant:             { hp:275, dmg:45, armor:2 },
  ant_hole:              { hp:750, dmg:20, armor:5 },
  ant_egg:               { hp:145, dmg:10, armor:0 },

  // ── Fire Ant stats — same HP/armor as normal ants, damage ×1.75 ──────────────
  fire_soldier_ant:      { hp:145, dmg:61, armor:2 },  // soldier_ant dmg 35 × 1.75 = ~61
  fire_worker_ant:       { hp:85, dmg:49, armor:1 },  // worker_ant dmg 28 × 1.75 = ~49
  fire_queen_ant:        { hp:275, dmg:79, armor:2 },  // queen_ant dmg 45 × 1.75 = ~79
  fire_ant_egg:          { hp:145, dmg:0, armor:0 },  // eggs deal no damage
  fire_ant_hole:         { hp:750, dmg:35, armor:5 },  // ant_hole dmg 20 × 1.75 = 35
  digger:                { hp:370, dmg:55, armor:1 },
  beekeeper:             { hp:330, dmg:60, armor:1 },
  beehive:               { hp:520, dmg:30, armor:5 },
  rock:                  { hp:179, dmg:62, armor:5/3 },  // placeholder — scaled down from Cactus by xp ratio 10/12; not yet balanced
  dandelion:             { hp:150, dmg:88, armor:0.7 },  // placeholder — fragile: low HP/armor, scaled from Cactus by xp ratio 14/12 then reduced; not yet balanced
  queen_bee:             { hp:330, dmg:55, armor:0 },
  beetle:                { hp:130, dmg:30, armor:1 },  // buffed above most garden roamers (was 45, an outlier ~half every peer's HP)
  sandstorm:             { hp:438, dmg:50, armor:1 },
  desert_centipede_head: { hp:215, dmg:75, armor:2 },
  cactus:                { hp:215, dmg:75, armor:2 },

  // ── Desert / Egypt tier — NEW mobs ────────────────────────────────────────
  // dmg buffed to sit alongside Beetle/Hornet (was 22, lowest of any garden roamer).
  // missileHp gives the stinger projectile real durability (was hardcoded to 1, destroyed
  // by a single petal touch — a likely cause of shots appearing to never fire, since
  // Scorpion holds much closer to the player than Hornet does).
  scorpion:              { hp:110, dmg:29, armor:1, missileHp:40 },  // HP ~15% under Beetle (was 38 — far weaker than intended)
  pyramid:               { hp:915, dmg:24, armor:5 },  // HP/DMG +22% vs Ant Hole; armor matches Ant Hole
  mummified_beetle:     { hp:195, dmg:35, armor:1 },  // HP +50% vs Beetle's new 130, DMG +15% vs Beetle's 30; armor matches Beetle

  // ── Ocean tier — NEW mobs, DRAFT stats (weight-classed against Garden/Desert peers) ──
  jellyfish:             { hp:70, dmg:30, armor:0 },  // ~bee weight class
  squid:                 { hp:110, dmg:42, armor:1 },  // ~hornet weight class
  alligator:             { hp:280, dmg:55, armor:3 },  // ~digger/beekeeper weight class, heaviest roamer
  crab:                  { hp:150, dmg:34, armor:2 },  // ~soldier_ant weight class
  starfish:              { hp:55, dmg:16, armor:1 },  // weakest roamer — low threat, barely moves
  shell:                 { hp:60, dmg:30, armor:1 },  // static, no bite — dpsFactor 0 like ant_egg
  sponge:                { hp:90, dmg:0, armor:0 },  // static
  bubble:                { hp:1, dmg:0, armor:0 },  // pops instantly — one petal touch kills it at any tier
  sea_cave:              { hp:700, dmg:0, armor:4 },  // static structure, ~ant_hole weight but no minions defined yet
  debris:                { hp:40, dmg:0, armor:0 },  // static clutter
  leech:                 { hp:80, dmg:26, armor:0 },  // draft only — drawLeechPose has no live-animation params yet, see mobDrawing.js
};

export const MOB_STATS = {};
for (const [id, b] of Object.entries(MOB_BASE_STATS)) {
  const s = {
    hp:    scaleByTier(b.hp,    MOB_HP_MULT),
    dmg:   scaleByTier(b.dmg,   MOB_DMG_MULT),
    armor: scaleByTier(b.armor, MOB_DMG_MULT),
  };
  if (b.missileHp  != null) s.missileHp  = scaleByTier(b.missileHp,  MOB_DMG_MULT);
  if (b.missileDmg != null) s.missileDmg = scaleByTier(b.missileDmg, MOB_DMG_MULT);
  MOB_STATS[id] = s;
}
MOB_STATS.centipede_body = MOB_STATS.centipede_head;
MOB_STATS.desert_centipede_body = MOB_STATS.desert_centipede_head;

// Tiers 0–9 (Common→Unique): hand-tuned curve. Unique (17.0) is the anchor;
// every rarity above it is ×1.10 the previous one (Runic 18.7 … Voidbound ~24.9).
// Mass still scales on its own curve (see MASS_SCALE).
const MYSTIC_TIER = 9, POST_MYSTIC_SIZE_STEP = 1.10;
export const RADIUS_SCALE = [1.2, 1.0, 1.2, 1.83, 3.0, 5.96, 7.75, 10.1, 13.1, 17.0];
for (let t = MYSTIC_TIER + 1; t <= 13; t++) RADIUS_SCALE.push(Math.round(RADIUS_SCALE[t - 1] * POST_MYSTIC_SIZE_STEP * 100) / 100);
// Mass scale per tier — derived from the intended growth examples.
// Tiers 0–8 match the provided series exactly; tiers 9–13 continue at ×2.25 per tier.
export const MASS_SCALE = [1, 1.3222, 1.7556, 2.5556, 4.4, 10.2333, 49.0, 100.0, 225.0, 506.25, 1139.06, 2562.89, 5766.5, 12974.6];


export function getMobStats(typeId, tier) {
  const lookupId = (typeId === 'centipede_body' ? 'centipede_head' : typeId === 'desert_centipede_body' ? 'desert_centipede_head' : typeId);
  const d = MOB_DEFS[lookupId];
  const s = MOB_STATS[lookupId];
  if (!d) return null;
  const t = Math.max(0,Math.min(13,tier));
  const aggroRange = d.aggroRange>0 ? Math.round(d.aggroRange * (1 + t * AGGRO_TIER_SCALE)) : 0;
  const out = {
    name:d.name, description:d.description||'',
    hp:s?s.hp[t]:50, damage:s?s.dmg[t]:10, armor:s?s.armor[t]:0,
    speed:d.speed*MOB_SPEED_SCALE, alertSpeed:(d.alertSpeed||d.speed)*MOB_SPEED_SCALE,  // same at every rarity
    mass:Math.round(d.mass*(MASS_SCALE[t]??1)), aggroRange,
  };
  // Spider poison info (total over 3s and per-second)
  if (lookupId === 'spider'){
    const total = SPIDER_POISON_TOTAL[t] ?? 0;
    out.poisonTotal = total;
    out.poisonDps = Math.round(total / 3);
  }
  return out;
}
