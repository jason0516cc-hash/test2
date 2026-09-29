/**
 * uiManager.js — thin coordinator
 *
 * Responsibilities:
 *  1. Create every UI module's DOM in the right order (initUI).
 *  2. Own the window resize listener that keeps panels/buttons positioned.
 *  3. Re-export the public surface the rest of the client imports.
 *
 * Which panel is open (and closing the others / click-outside / Escape) is
 * handled by panels.js; every keyboard shortcut lives in keybinds.js.
 */

export {
  updateHotbar,
  onHotbarMouseMove,
  onHotbarMouseDown,
  onHotbarMouseUp,
  slotAtPoint,
  benchSlotAtPoint,
  onSwapKey,
  onSwapAll,
  drag,
  invSlotCSS,
} from './hotbar.js';

export {
  updateInventory,
  notifyInventoryChanged,
  ensureInvDOM,
  equipFromInventory,
  isInventoryOpen,
} from './inventoryPanel.js';

export { toggleCraftingPanel, renderCraftingPanel } from './craftingPanel.js';
export { ensureSettingsBtn, updateSettingsCog } from './settingsPanel.js';
export { toggleMobGal } from './mobGallery.js';
export { ensureChatDOM, positionChat, isChatOpen, onEnterKey } from './chat.js';
export { ensureKillButtonDOM, showKillButton, hideKillButton, registerKillButtonHandler } from './killButton.js';
export { openPanel, closePanel, togglePanel, closeAllPanels, isPanelOpen, anyPanelOpen } from './panels.js';

import './keybinds.js';   // registers the global shortcut listener
import { ignoreClickOutside } from './panels.js';
import { ensureOverlay, isPointOnHotbar } from './hotbar.js';
import { ensureInvDOM, positionInvButton, positionInvPanel, isInventoryOpen } from './inventoryPanel.js';
import { ensureCraftingDOM, positionCraftingButton, positionCraftingPanel, isCraftingOpen } from './craftingPanel.js';
import { ensureSettingsBtn } from './settingsPanel.js';
import { ensureMobGalDOM, positionMobGalButton, positionMobGalPanel, isMobGalOpen } from './mobGallery.js';
import { ensureUpdateLogDOM } from './updateLog.js';
import { ensureDiscordDOM } from './discordButton.js';
import { ensureKillButtonDOM } from './killButton.js';
import { ensureChatDOM, positionChat } from './chat.js';

export function initUI() {
  // Hotbar overlay first (inventory draws its fly animation on it), then the
  // inventory (the crafting panel registers with it).
  ensureOverlay();
  ensureInvDOM();
  ensureCraftingDOM();
  ensureSettingsBtn();
  ensureMobGalDOM();
  ensureUpdateLogDOM();
  ensureDiscordDOM();
  ensureKillButtonDOM();
  ensureChatDOM();

  // Grabbing a hotbar/bench slot (e.g. to drag it into the inventory) isn't
  // a click "outside" the open panel.
  ignoreClickOutside(e => isPointOnHotbar(e.clientX, e.clientY));
}

window.addEventListener('resize', () => {
  positionInvButton();
  if (isInventoryOpen()) positionInvPanel();
  positionCraftingButton();
  if (isCraftingOpen()) positionCraftingPanel();
  positionMobGalButton();
  if (isMobGalOpen()) positionMobGalPanel();
  positionChat();
});
