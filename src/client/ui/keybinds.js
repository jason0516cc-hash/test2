/**
 * client/ui/keybinds.js — what every one-shot shortcut does.
 *
 * Which KEY triggers each action lives in client/keymap.js (rebindable in
 * Settings → Keybinds); this file maps action ids to what they do. One window
 * keydown listener. Shortcuts never fire while the player is typing (name
 * box, inventory search, chat…), while chat is open, or while the Keybinds
 * tab is waiting for a key, and holding a key down doesn't re-trigger toggles.
 *
 * Movement / attack / defend are NOT here — those are held-key state read by
 * client/inputState.js every frame.
 */
import { settings } from '../settings.js';
import { actionFor, eventCode } from '../keymap.js';
import { togglePanel, closeAllPanels, anyPanelOpen } from './panels.js';
import { onEnterKey, isChatOpen } from './chat.js';
import { onSwapKey, onSwapAll } from './hotbar.js';
import { refreshSettingsPanel, isCapturingKey } from './settingsPanel.js';
import { toggleMinimapZoom, toggleHitboxes } from '../render/renderer.js';

/** True when keyboard input is going into a text field rather than the game. */
export function isTypingTarget(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(type);
  }
  return false;
}

function toggleSetting(key) {
  settings[key] = !settings[key];
  refreshSettingsPanel();
}

// action id (keymap.js) → handler
const HANDLERS = {
  chat:       () => onEnterKey(),
  closeMenus: () => { if (anyPanelOpen()) closeAllPanels(); },

  inventory:  () => togglePanel('inventory'),
  crafting:   () => togglePanel('crafting'),
  mobGallery: () => togglePanel('mobGallery'),
  settings:   () => togglePanel('settings'),

  swapAll:    () => onSwapAll(),
  minimap:    () => toggleMinimapZoom(),
  hitboxes:   () => toggleHitboxes(),

  mouseMovement: () => toggleSetting('mouseMovement'),
  invertAttack:  () => toggleSetting('invertAttack'),
  invertDefend:  () => toggleSetting('invertDefend'),
};
// Swap Slot 1–10 swap hotbar slots 0–9 with the bench
for (let i = 1; i <= 10; i++) HANDLERS[`swap${i}`] = () => onSwapKey(i - 1);

window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isCapturingKey() || isChatOpen() || isTypingTarget(e.target)) return;
  const fn = HANDLERS[actionFor(eventCode(e))];
  if (!fn) return;
  if (e.repeat) return;
  fn();
});
