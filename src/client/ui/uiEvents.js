/**
 * uiEvents.js — UI mouse handling
 * Routes mouse events to the hotbar. (Keyboard shortcuts: keybinds.js.)
 */
import { onHotbarMouseDown, onHotbarMouseMove, onHotbarMouseUp, hotbarCanvasH } from './hotbar.js';
import { isPointOnMinimap, setMinimapHovering } from '../render/renderer.js';

// ── Mouse tracking ────────────────────────────────────────────────────────────
export const mousePos = { x: 0, y: 0 };
export let uiConsumedLastMouseDown = false;

// The hotbar is laid out against a different H on the homescreen (see hotbar.js).
const _hotbarH = hotbarCanvasH;

export function handleMouseMove(x, y) {
  mousePos.x = x;
  mousePos.y = y;
  onHotbarMouseMove(x, y, window.innerWidth, _hotbarH());
  setMinimapHovering(isPointOnMinimap(x, y, window.innerWidth, window.innerHeight));
}

export function handleMouseDown(x, y, canvasW, canvasH, button, shiftKey = false) {
  uiConsumedLastMouseDown = false;
  if (button === 0) {
    const consumed = onHotbarMouseDown(x, y, canvasW, _hotbarH(), shiftKey);
    if (consumed) {
      uiConsumedLastMouseDown = true;
      return true;
    }
  }
  return false;
}

export function handleMouseUp(x, y, canvasW, canvasH) {
  onHotbarMouseUp(x, y, canvasW, _hotbarH());
}
