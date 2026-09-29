// camera.js — where the local player's view is centred and how zoomed in it is.
// Purely a client concern: the game simulation never reads the camera.
import { CAMERA_LAG, PLAYER_RADIUS } from '../shared/constants.js';

export const camera = { x: 0, y: 0 };

// Default zoom limits
export const DEFAULT_MIN_ZOOM = 0.56;  // most zoomed out (default)
export const MAX_ZOOM_IN      = 1.61;  // most zoomed in

// The current minimum zoom (may be lowered by antennae vision bonus)
export let minZoom = DEFAULT_MIN_ZOOM;

// Zoom stored as an object so all importers always read the live value.
// Use `zoom.v` to read the current zoom level everywhere.
export const zoomState = { v: 1 };

// Convenience getter used by main.js wheel handler
export function getZoom() { return zoomState.v; }

export function setMinZoom(z) {
  minZoom = z;
  zoomState.v = Math.max(minZoom, Math.min(MAX_ZOOM_IN, zoomState.v));
}

export function setZoom(z) {
  zoomState.v = Math.max(minZoom, Math.min(MAX_ZOOM_IN, z));
}

export function initCamera(playerX, playerY) {
  camera.x = playerX;
  camera.y = playerY;
}

// Instantly snap the camera to a position (no lag, e.g. on teleport)
export function snapCamera(playerX, playerY) {
  camera.x = playerX;
  camera.y = playerY;
}

// ── Respawn camera rush ───────────────────────────────────────────────────────
// A fast, eased (not instant) catch-up used right after an in-place respawn,
// where the player can reappear far from the death spot — an instant snapCamera
// would look like nothing happened, so this animates the camera closing the
// gap quickly instead of at the normal per-frame CAMERA_LAG rate.
let _rushActive   = false;
let _rushElapsed  = 0;
const RUSH_DURATION_MS = 260;

/** Call once, right after respawnPlayer() repositions the player, to start the rush. */
export function startCameraRush() {
  _rushActive  = true;
  _rushElapsed = 0;
}

/** Returns true while a rush is in progress — updateCamera uses this to
 *  temporarily override its normal lag behavior. */
export function isCameraRushing() {
  return _rushActive;
}

// Eases the camera toward (playerX, playerY) over RUSH_DURATION_MS, then hands
// control back to the normal lagged updateCamera. Call this instead of
// updateCamera on frames where isCameraRushing() is true.
export function updateCameraRush(playerX, playerY, dt) {
  _rushElapsed += dt;
  const t = Math.min(1, _rushElapsed / RUSH_DURATION_MS);
  // Ease-out cubic — fast start, gentle settle, matches the "rushes quickly" feel.
  const eased = 1 - Math.pow(1 - t, 3);

  camera.x += (playerX - camera.x) * eased;
  camera.y += (playerY - camera.y) * eased;

  if (t >= 1) {
    _rushActive = false;
    camera.x = playerX; camera.y = playerY;
  }
}

// Maximum distance the camera may lag behind the player —
// one flower body size. Without this, a large sudden speed spike (e.g. a
// high-tier Centipede Legs bonus) can make the lag grow far beyond what the
// fixed lerp factor can catch up with in a frame; since mouse-movement mode
// computes the world position under the cursor relative to camera.x/y, an
// unbounded lag there made that math drift and feel "buggy" at high speed.
const MAX_CAMERA_LAG_DIST = PLAYER_RADIUS;

export function updateCamera(playerX, playerY) {
  camera.x += (playerX - camera.x) * CAMERA_LAG;
  camera.y += (playerY - camera.y) * CAMERA_LAG;

  // Clamp the lag to at most one flower body size, measured as a true 2D
  // distance (not per-axis), so a fast diagonal dash can't stretch the gap
  // out along one axis while looking fine on the other.
  const camDx = playerX - camera.x, camDy = playerY - camera.y;
  const camDist = Math.hypot(camDx, camDy);
  if (camDist > MAX_CAMERA_LAG_DIST) {
    const pull = (camDist - MAX_CAMERA_LAG_DIST) / camDist;
    camera.x += camDx * pull;
    camera.y += camDy * pull;
  }
}

// Convert a world position to screen-space given canvas dimensions.
export function toScreen(wx, wy, canvasW, canvasH) {
  return {
    sx: (wx - camera.x) * zoomState.v + canvasW  / 2,
    sy: (wy - camera.y) * zoomState.v + canvasH / 2,
  };
}
