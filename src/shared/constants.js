// ── World ────────────────────────────────────────────────────────────────────
export const WORLD_W = 21000;
export const WORLD_H = 35000;

// ── Simulation rate ──────────────────────────────────────────────────────────
// The game world advances in fixed ticks (see game/game.js). Every per-tick
// number in the game — movement speeds, orbit rotation, per-hit petal damage —
// is tuned against this rate, so changing it changes how fast everything
// plays. 60 keeps controls responsive and collisions precise; a future server
// can keep simulating at 60 and send network updates less often (20–30/s).
export const TICKS_PER_SECOND = 60;

// ── Speed tuning ─────────────────────────────────────────────────────────────
// One knob per group, multiplied on top of the base numbers (PLAYER_SPEED,
// every mob's speed/alertSpeed in mobTypes.js, ORBIT_SPEED + Faster's spin
// bonus). The base numbers were raised while the game ran at a laggy frame
// rate; these bring them back to the intended feel at a steady 60 ticks/s.
// Distance per second = speed × scale × TICKS_PER_SECOND.
export const PLAYER_SPEED_SCALE = 0.6;
export const MOB_SPEED_SCALE    = 0.6;
export const ORBIT_SPEED_SCALE  = 0.6;

// ── Player ───────────────────────────────────────────────────────────────────
export const PLAYER_RADIUS  = 22;
export const PLAYER_SPEED   = 6;
export const PLAYER_COLOR   = '#ffe840';
export const PLAYER_BORDER  = '#f0c800';
export const PLAYER_MAX_HP  = 100;
export const PLAYER_BASE_BODY_DAMAGE = 25;  // DPS dealt to mobs touching the player

// ── Camera ───────────────────────────────────────────────────────────────────
export const CAMERA_LAG        = 0.08;
export const PETAL_ORIGIN_LAG  = 0.18;

// ── Petals / Orbit ────────────────────────────────────────────────────────────
export const ORBIT_RADIUS_NORMAL   = 55;
export const ORBIT_RADIUS_EXPANDED = 110;
export const ORBIT_RADIUS_RETRACT  = 20;
export const ORBIT_EXPAND_SPEED    = 0.14;
export const ORBIT_SPEED           = 0.080;
export const PETAL_RADIUS          = 10;
export const PETAL_COLOR           = '#ffffff';
export const PETAL_BORDER          = '#cccccc';

// ── Hotbar ────────────────────────────────────────────────────────────────────
export const MAX_HOTBAR_SLOTS = 5;
export const HOTBAR_SLOT_SIZE = 56;
export const HOTBAR_GAP       = 8;

// ── Inventory panel ───────────────────────────────────────────────────────────
export const INV_PANEL_W   = 370;
export const INV_COLS      = 5;
export const INV_SLOT_SIZE = 58;
export const INV_SLOT_GAP  = 6;
export const INV_PADDING   = 12;
export const INV_HEADER_H  = 44;

// ── Rarities ─────────────────────────────────────────────────────────────────
// Rarity names, tiers and colours all live in shared/rarities.js.

// ── Mobs ──────────────────────────────────────────────────────────────────────
export const MOB_SPAWN_TOTAL  = 50;
export const MOB_SAFE_RADIUS  = 350;
export const HORNET_PREFERRED_DIST_BASE = 250;
// Aggro range scaling per tier: higher = mobs notice targets from farther away
export const AGGRO_TIER_SCALE = 0.65;

// ── Physics ───────────────────────────────────────────────────────────────────
export const PLAYER_MASS     = 150;
