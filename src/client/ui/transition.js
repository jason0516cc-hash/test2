// ── Iris transition (the black circle) ───────────────────────────────────────
// One transition for every screen change (Play, Menu after death): a circle
// of the current scene shrinks to black, the scene is swapped while the
// screen is fully black, then the new scene opens back out from the centre.
//
//   irisTransition({ onMidpoint, onDone })
//
// Only one runs at a time (a second call while one is running is ignored, so
// double-clicking Play can't start two games). While it runs it swallows
// clicks, it's drawn at device resolution (crisp edge) and follows resizes.

const CLOSE_MS = 480;
const HOLD_MS  = 90;     // fully black — lets the new scene draw its first frame
const OPEN_MS  = 620;

const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic   = t => 1 - Math.pow(1 - t, 3);

let running = false;

export function isTransitioning() { return running; }

export function irisTransition({ onMidpoint = null, onDone = null } = {}) {
  if (running) return false;
  const tc = document.getElementById('transition-canvas');
  if (!tc) { onMidpoint?.(); onDone?.(); return true; }
  running = true;
  const ctx = tc.getContext('2d');
  tc.style.display = 'block';
  tc.style.pointerEvents = 'auto';

  let t0 = null, midDone = false;

  function frame(now) {
    if (t0 === null) t0 = now;
    const el = now - t0;

    // Size to the window every frame (handles resizes mid-transition)
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    if (tc.width !== Math.round(W * dpr) || tc.height !== Math.round(H * dpr)) {
      tc.width = Math.round(W * dpr); tc.height = Math.round(H * dpr);
      tc.style.width = W + 'px'; tc.style.height = H + 'px';
    }
    const maxR = Math.hypot(W, H) / 2 + 4;

    let open;   // 1 = circle covers the whole screen, 0 = fully black
    if (el < CLOSE_MS) {
      open = 1 - easeInOutCubic(el / CLOSE_MS);
    } else if (el < CLOSE_MS + HOLD_MS) {
      open = 0;
      if (!midDone) { midDone = true; onMidpoint?.(); }
    } else {
      if (!midDone) { midDone = true; onMidpoint?.(); }
      open = easeOutCubic(Math.min(1, (el - CLOSE_MS - HOLD_MS) / OPEN_MS));
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    if (open > 0) ctx.arc(W / 2, H / 2, open * maxR, 0, Math.PI * 2, true);   // hole (even-odd via reverse winding)
    ctx.fill();

    if (el < CLOSE_MS + HOLD_MS + OPEN_MS) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, W, H);
      tc.style.display = 'none';
      tc.style.pointerEvents = 'none';
      running = false;
      onDone?.();
    }
  }
  requestAnimationFrame(frame);
  return true;
}
