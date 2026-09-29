/**
 * client/ui/panels.js — one place that knows which side panel is open.
 *
 * Every panel (inventory, crafting, mob gallery, settings, update log)
 * registers itself here with its own open/close functions and the DOM ids
 * that belong to it (the panel and its toolbar button). The registry then
 * enforces the shared rules so no panel has to know about the others:
 *
 *   - only one panel is open at a time (opening one closes the rest)
 *   - a mousedown outside every open panel/button closes them all
 *   - Escape closes them all (bound in keybinds.js)
 *
 * No imports — panels import this, never the other way round.
 */

const panels = new Map();   // id → { open, close, isOpen, rootIds }
const clickOutsideIgnores = [];

/**
 * @param {string} id
 * @param {{ open: Function, close: Function, isOpen: () => boolean, rootIds?: string[] }} def
 *   open/close do the panel's own show/hide work; the registry decides WHEN.
 */
export function registerPanel(id, def) {
  panels.set(id, { rootIds: [], ...def });
}

export function isPanelOpen(id) {
  return !!panels.get(id)?.isOpen();
}

export function anyPanelOpen() {
  for (const p of panels.values()) if (p.isOpen()) return true;
  return false;
}

export function openPanel(id) {
  const p = panels.get(id);
  if (!p || p.isOpen()) return;
  for (const [otherId, other] of panels) {
    if (otherId !== id && other.isOpen()) other.close();
  }
  p.open();
}

export function closePanel(id) {
  const p = panels.get(id);
  if (p?.isOpen()) p.close();
}

export function togglePanel(id) {
  if (isPanelOpen(id)) closePanel(id);
  else openPanel(id);
}

export function closeAllPanels() {
  for (const p of panels.values()) if (p.isOpen()) p.close();
}

/** Registers a predicate `(event) => boolean`; when it returns true, that
 *  mousedown doesn't count as "outside" (e.g. grabbing a hotbar slot). */
export function ignoreClickOutside(fn) {
  clickOutsideIgnores.push(fn);
}

document.addEventListener('mousedown', e => {
  if (!anyPanelOpen()) return;
  if (clickOutsideIgnores.some(fn => fn(e))) return;
  for (const p of panels.values()) {
    if (!p.isOpen()) continue;
    for (const rid of p.rootIds) {
      if (document.getElementById(rid)?.contains(e.target)) return;
    }
  }
  closeAllPanels();
});
