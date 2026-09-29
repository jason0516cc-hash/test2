// ── Click-and-drag panning for scroll areas without scrollbars ───────────────
// Used by the crafting grid and the mob gallery. A press that moves more than
// a few pixels becomes a pan (and the click that follows it is swallowed, so
// dragging never adds a petal by accident); a press that stays put is a click.

const THRESHOLD = 5;

/**
 * @param {HTMLElement} el
 * @param {object} o
 * @param {() => void} o.start           called when a pan begins
 * @param {(dx:number, dy:number) => void} o.move   total movement since the press
 */
export function enableDragPan(el, o) {
  let press = null, panning = false, swallowClick = false;

  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.shiftKey) return;
    press = { x: e.clientX, y: e.clientY, id: e.pointerId };
    panning = false;
  });
  window.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!panning && Math.hypot(dx, dy) > THRESHOLD) {
      panning = true;
      o.start();
      el.style.cursor = 'grabbing';
    }
    if (panning) o.move(dx, dy);
  });
  const end = () => {
    if (panning) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); }
    press = null; panning = false;
    el.style.cursor = '';
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  el.addEventListener('click', e => {
    if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
  }, true);
}
