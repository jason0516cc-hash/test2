/**
 * client/ui/killButton.js
 *
 * X (kill) button — sits to the right of the discord button (top-left area).
 * Only visible while actually playing (hidden on the homescreen) — see
 * showKillButton()/hideKillButton(), called from main.js at the same two
 * transition points as setHomescreenMode(false)/(true).
 *
 * Click while alive  → instantly kills the player ("You were killed by:
 *                       Yourself" on the death overlay).
 * Click while dead   → returns to the homescreen (same as the death
 *                       overlay's Menu button).
 *
 * The actual click behavior lives in main.js (it needs player/death-overlay
 * state) and is registered here via registerKillButtonHandler() to avoid a
 * circular import between this module and main.js.
 */

let _onKillButtonClick = () => {};
export function registerKillButtonHandler(fn) { _onKillButtonClick = fn; }

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────
(function injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
    #kill-btn {
      /* smaller than the 44px buttons, centred on the same row */
      position: fixed; top: 22px; left: 184px;
      width: 32px; height: 32px; border-radius: 7px;
      background: #e8524a; border: 3px solid #7a1414;
      cursor: pointer; z-index: 101;
      display: none; align-items: center; justify-content: center;
      padding: 5px; box-sizing: border-box;
      transition: background 0.12s; user-select: none;
    }
    #kill-btn.visible { display: flex; }
    #kill-btn:hover  { background: #f0716a; }
    #kill-btn:active { transform: scale(0.95); }
    #kill-btn img    { width: 100%; height: 100%; object-fit: contain; display: block; }
  `;
  document.head.appendChild(s);
})();

// ─────────────────────────────────────────────────────────────────────────────
// DOM setup
// ─────────────────────────────────────────────────────────────────────────────
export function ensureKillButtonDOM() {
  if (document.getElementById('kill-btn')) return;

  const btn = document.createElement('div');
  btn.id = 'kill-btn';

  const img = document.createElement('img');
  img.src = './public/icons/close.png';
  img.draggable = false;
  btn.appendChild(img);

  document.body.appendChild(btn);

  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('click', () => _onKillButtonClick());
}

// Hidden by default (see #kill-btn's display:none above) — shown only while
// actually playing. Called from startGame() / returnToHomescreen() in main.js.
export function showKillButton() {
  document.getElementById('kill-btn')?.classList.add('visible');
}

export function hideKillButton() {
  document.getElementById('kill-btn')?.classList.remove('visible');
}
