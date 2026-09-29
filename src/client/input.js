/**
 * input.js — browser input for the local player.
 *
 * Listens to keyboard/mouse events (writing raw state into inputState.js and
 * routing clicks to the UI), and once per frame turns that raw state into the
 * player's `input` object — the only thing the game simulation reads.
 */
import { keys, mouse, inputState } from './inputState.js';
import { eventCode } from './keymap.js';
import {
  handleMouseDown,
  handleMouseUp,
  handleMouseMove,
  mousePos,
} from './ui/uiEvents.js';
import { isChatOpen } from './ui/chat.js';
import { isTypingTarget } from './ui/keybinds.js';
import { anyPanelOpen } from './ui/panels.js';
import { setMinimapHovering } from './render/renderer.js';
import { settings } from './settings.js';
import { camera, zoomState } from './camera.js';

// ── Per-frame player input ───────────────────────────────────────────────────
/**
 * Writes this frame's controls into `player.input` (see makeNeutralInput in
 * game/player.js): walk direction from WASD — or toward the mouse when mouse
 * movement is on and no panel is open — plus attack/defend and view range.
 */
export function writeLocalPlayerInput(player) {
  let dx = 0, dy = 0;
  if (inputState.up)    dy -= 1;
  if (inputState.down)  dy += 1;
  if (inputState.left)  dx -= 1;
  if (inputState.right) dx += 1;
  // Normalize diagonal WASD movement
  if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

  // Mouse movement: walk toward the cursor when enabled and no WASD held.
  // Blocked while any side panel is open.
  const guiOpen = anyPanelOpen();
  if (settings.mouseMovement && !guiOpen && dx === 0 && dy === 0) {
    const worldMX = (mousePos.x - window.innerWidth  / 2) / zoomState.v + camera.x;
    const worldMY = (mousePos.y - window.innerHeight / 2) / zoomState.v + camera.y;
    const distX = worldMX - player.x;
    const distY = worldMY - player.y;
    const dist  = Math.hypot(distX, distY);
    // Only move if the mouse is far enough away (dead zone = 10 world units)
    if (dist > 10) { dx = distX / dist; dy = distY / dist; }
  }

  const input = player.input;
  input.moveX     = dx;
  input.moveY     = dy;
  input.attack    = inputState.expand;
  input.defend    = inputState.retract;
  input.viewRange = 600 / Math.max(0.1, zoomState.v);
  // Half-size of the visible screen in world units — what the player can
  // actually see. Pets and pop cards only react to mobs inside this box.
  input.viewHalfW = (window.innerWidth  / 2) / Math.max(0.1, zoomState.v);
  input.viewHalfH = (window.innerHeight / 2) / Math.max(0.1, zoomState.v);
}

/** Releases every held key — used on respawn so movement doesn't carry over. */
export function clearHeldKeys() {
  for (const k in keys) delete keys[k];
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
// Held-key state only (by physical key code, see keymap.js) — shortcuts are
// in ui/keybinds.js. Keys typed into a text field (name box, search, chat)
// never count as held.
// Keys that make the browser scroll whatever is focused/under the cursor —
// the game uses them, so no panel, list or the page itself ever scrolls or
// shifts from them (text boxes still get them, for the caret).
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
                             'PageUp', 'PageDown', 'Home', 'End']);
window.addEventListener('keydown', e => {
  const typing = isChatOpen() || isTypingTarget(e.target);
  if (!typing) {
    keys[eventCode(e)] = true;
    // (Enter/Space would also "click" whichever button was clicked last)
    if (SCROLL_KEYS.has(e.code) || e.key === 'Tab' || e.key === 'Enter') e.preventDefault();
  }
});
window.addEventListener('keyup', e => { keys[eventCode(e)] = false; });
// Alt-tabbing away with a key down never sends its keyup
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ── Mouse ─────────────────────────────────────────────────────────────────────
window.addEventListener('mousemove', e => {
  handleMouseMove(e.clientX, e.clientY);
});

// If the mouse leaves the browser window entirely, no further mousemove
// fires — without this the minimap could get stuck showing its hover state
// forever. Mirrors the same safeguard mobTooltip.js already uses.
window.addEventListener('mouseleave', () => {
  setMinimapHovering(false);
});

window.addEventListener('mousedown', e => {
  const consumed = handleMouseDown(
    e.clientX, e.clientY,
    window.innerWidth, window.innerHeight,
    e.button, e.shiftKey,
  );
  if (e.button === 0) {
    mouse.left     = true;
    // Only allow left-click expand if the UI didn't consume the event
    mouse.expandOk = !consumed;
  }
  if (e.button === 2) mouse.right = true;
});

window.addEventListener('mouseup', e => {
  if (e.button === 0) {
    handleMouseUp(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
    mouse.left     = false;
    mouse.expandOk = false;
  }
  if (e.button === 2) mouse.right = false;
});

window.addEventListener('contextmenu', e => e.preventDefault());

// ── Scroll (callback-based) ───────────────────────────────────────────────────
const scrollHandlers = [];
export function onScroll(fn) { scrollHandlers.push(fn); }
window.addEventListener('wheel', e => {
  scrollHandlers.forEach(fn => fn(e.deltaY));
});
