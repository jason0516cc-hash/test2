/**
 * homescreen.js
 *
 * Background: homeBackground.js — the selected biome's map floor with that
 * biome's mobs spiralling in; the Garden / Desert / Ocean buttons switch it
 * (the new biome opens out from the button).
 *
 * UI: title, name + Play row, flower face preview with stats. The hotbar
 * and every panel are the normal in-game ones (drawn by main.js's homescreen
 * loop at the same size and place as in game).
 *
 * main.js drives it with showHomescreen() / hideHomescreen() — the background
 * and flower animations only run while it's visible — and setPlayHandler()
 * to learn which biome to start when Play is pressed. Play goes through the
 * iris transition (transition.js); the game starts while the screen is black.
 */

import { localPlayer as player } from '../localPlayer.js';
import { drawFlowerFaceParams, circle } from '../render/renderer.js';
import { PLAYER_COLOR, PLAYER_BORDER, PLAYER_MAX_HP, PLAYER_BASE_BODY_DAMAGE } from '../../shared/constants.js';
import { levelFromXp, xpForLevel, totalXpForLevel } from '../../shared/leveling.js';
import { createHomeBackground } from './homeBackground.js';
import { irisTransition } from './transition.js';

// Filled in by runHomescreen() — the loops/listeners that only run while visible
let _startLoops   = () => {};
let _stopLoops    = () => {};
let _refreshStats = () => {};
let _onPlay       = () => {};

/** main.js registers the function that actually starts a game in `biome`. */
export function setPlayHandler(fn) { _onPlay = fn; }

let _homescreenVisible = false;

export function showHomescreen() {
  const homeEl = document.getElementById('home-screen');
  if (homeEl) homeEl.style.display = 'flex';
  showBiomeBar();
  _refreshStats();
  if (!_homescreenVisible) { _homescreenVisible = true; _startLoops(); }
}

export function hideHomescreen() {
  const homeEl = document.getElementById('home-screen');
  if (homeEl) homeEl.style.display = 'none';
  hideBiomeBar();
  if (_homescreenVisible) { _homescreenVisible = false; _stopLoops(); }
}

function runHomescreen() {
  const homeEl     = document.getElementById('home-screen');
  const bgCanvas   = document.getElementById('bg-canvas');
  const nameInput  = document.getElementById('player-name-input');
  const playBtn    = document.getElementById('play-btn');

  if (!homeEl || !bgCanvas || !nameInput || !playBtn) return;

  // ── Wire homescreen mouse events into hotbar system ─────────────────────
  // The window-level listeners in input.js already forward mouse events
  // to onHotbarMouseDown/Move/Up, so the hotbar works on the homescreen
  // without any extra wiring needed here.

  // (The homescreen hotbar animation itself is started by main.js once it has
  // finished loading — see the end of main.js.)

  // ── Home-screen level pill ────────────────────────────────────────────────
  const homePillEl = document.getElementById('home-level-pill-text');
  function updateHomePill() {
    if (!homePillEl) return;
    const xp      = player.xp ?? 0;
    const contLvl = levelFromXp(xp);
    const intLvl  = Math.floor(contLvl);
    const xpStart = totalXpForLevel(intLvl);
    const xpNext  = xpStart + xpForLevel(intLvl + 1);
    const f = n => Math.floor(n).toLocaleString('en-US');
    homePillEl.textContent = `${intLvl + 1} (${f(xp - xpStart)} / ${f(xpNext - xpStart)})`;
  }
  updateHomePill();
  _refreshStats = updateHomePill;

  // ── Background (biome floor + mobs) ────────────────────────────────────
  const background = createHomeBackground(bgCanvas);

  // ── Flower face preview canvas ─────────────────────────────────────────────
  let startFlower = () => {};
  let stopFlower  = () => {};

  const flowerCanvas = document.getElementById('flower-canvas');
  if (flowerCanvas) {
    const fctx = flowerCanvas.getContext('2d');
    const FW = 90, FH = 90;
    flowerCanvas.width  = FW * (window.devicePixelRatio || 1);
    flowerCanvas.height = FH * (window.devicePixelRatio || 1);
    flowerCanvas.style.width  = FW + 'px';
    flowerCanvas.style.height = FH + 'px';
    fctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

    const faceState = { attackT: 0, defendT: 0, eyeAngle: 0 };
    let mouseAngle = 0;
    let isAttacking = false;
    const FACE_SPEED = 0.012;
    const cx = FW / 2, cy = FH / 2;
    const flowerR = FW * 0.34;
    let lastFaceTime = performance.now();

    // Mouse tracking — angle from flower center to cursor
    function onMouseMove(e) {
      const rect = flowerCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - cx;
      const my = e.clientY - rect.top  - cy;
      // Only update if mouse is reasonably close (within 600px)
      const dist = Math.hypot(mx, my);
      if (dist < 600) mouseAngle = Math.atan2(my, mx);
    }
    function onMouseDown() { isAttacking = true; }
    function onMouseUp()   { isAttacking = false; }

    function animateFlower(now) {
      const dt = Math.min(now - lastFaceTime, 100);
      lastFaceTime = now;
      const k = 1 - Math.pow(1 - FACE_SPEED, dt);

      // Lerp eye toward mouse angle (shortest path)
      let da = mouseAngle - faceState.eyeAngle;
      while (da >  Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      faceState.eyeAngle += da * k * 2; // slightly snappier than in-game

      faceState.attackT += ((isAttacking ? 1 : 0) - faceState.attackT) * k;
      faceState.defendT  = 0;

      fctx.clearRect(0, 0, FW, FH);

      // Draw flower body
      circle(fctx, cx, cy, flowerR, PLAYER_COLOR, PLAYER_BORDER, 3, 1);

      // Draw face using the exact in-game function
      drawFlowerFaceParams(fctx, cx, cy, flowerR,
        faceState.attackT, faceState.defendT, faceState.eyeAngle, 1, PLAYER_COLOR);

      _flowerRaf = requestAnimationFrame(animateFlower);
    }

    let _flowerRaf = null;

    // Runs (animation + mouse listeners) only while the homescreen is visible
    startFlower = () => {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup',   onMouseUp);
      isAttacking = false;
      lastFaceTime = performance.now();
      if (!_flowerRaf) _flowerRaf = requestAnimationFrame(animateFlower);
    };
    stopFlower = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup',   onMouseUp);
      if (_flowerRaf) { cancelAnimationFrame(_flowerRaf); _flowerRaf = null; }
    };
  }

  _startLoops = () => { background.start(); startFlower(); };
  _stopLoops  = () => { background.stop();  stopFlower(); };

  // ── Stat preview ───────────────────────────────────────────────────────────
  const hpEl  = document.getElementById('stat-hp');
  const dmgEl = document.getElementById('stat-dmg');
  if (hpEl)  hpEl.textContent  = PLAYER_MAX_HP;
  if (dmgEl) dmgEl.textContent = PLAYER_BASE_BODY_DAMAGE;
  nameInput.addEventListener('input', () => {
    const v = nameInput.value.trim();
    player.name = v.length > 0 ? v : 'Unnamed';
  });
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') playBtn.click();
  });

  // ── Biome select bar — always visible, toggle group (Garden/Desert/Ocean) ──
  // Replaces the old Play → mode bar → Waves → biome bar flow entirely: one
  // of the three is always the active selection (default Garden), Play just
  // starts the game in whichever is currently selected.
  if (!document.getElementById('_biomeBarStyle')) {
    const bs = document.createElement('style');
    bs.id = '_biomeBarStyle';
    bs.textContent = `
      #biome-select-bar {
        position: fixed;
        left: 50%;
        top: 18px;
        transform: translateX(-50%);
        display: flex;
        gap: 10px;
        padding: 10px 16px;
        z-index: 9999;
      }
      .biome-btn {
        padding: 9px 26px;
        border-radius: 8px;
        border: 2px solid rgba(255,255,255,0.10);
        font-family: 'UbuntuCustom','Ubuntu',Arial,sans-serif;
        font-size: 15px;
        font-weight: 800;
        cursor: pointer;
        letter-spacing: 0.4px;
        transition: filter 0.15s, transform 0.1s, border-color 0.15s, box-shadow 0.15s;
        white-space: nowrap;
      }
      .biome-btn:hover  { filter: brightness(1.18); transform: scale(1.05); }
      .biome-btn:active { transform: scale(0.96); }
      .biome-btn.selected {
        border-color: rgba(255,255,255,0.85);
        box-shadow: 0 0 0 2px rgba(255,255,255,0.25);
      }
      #biome-btn-garden {
        background: #1ea761;
        color: #fff;
      }
      #biome-btn-desert {
        background: #d4a843;
        color: #fff;
      }
      #biome-btn-ocean {
        background: #2b8fc4;
        color: #fff;
      }
    `;
    document.head.appendChild(bs);
  }

  const biomeBar = document.createElement('div');
  biomeBar.id = 'biome-select-bar';

  const gardenBtn = document.createElement('button');
  gardenBtn.id = 'biome-btn-garden';
  gardenBtn.className = 'biome-btn';
  gardenBtn.textContent = 'Garden';

  const desertBtn = document.createElement('button');
  desertBtn.id = 'biome-btn-desert';
  desertBtn.className = 'biome-btn';
  desertBtn.textContent = 'Desert';

  const oceanBtn = document.createElement('button');
  oceanBtn.id = 'biome-btn-ocean';
  oceanBtn.className = 'biome-btn';
  oceanBtn.textContent = 'Ocean';

  biomeBar.appendChild(gardenBtn);
  biomeBar.appendChild(desertBtn);
  biomeBar.appendChild(oceanBtn);
  document.body.appendChild(biomeBar);

  const biomeButtons = { garden: gardenBtn, desert: desertBtn, ocean: oceanBtn };
  let selectedBiome = 'garden'; // default selection on load

  function _selectBiome(biome) {
    selectedBiome = biome;
    for (const [id, btn] of Object.entries(biomeButtons)) {
      btn.classList.toggle('selected', id === biome);
    }
    // The new biome's background opens out from the button that was clicked
    const r = biomeButtons[biome].getBoundingClientRect();
    background.setBiome(biome, r.left + r.width / 2, r.top + r.height / 2);
  }
  for (const [id, btn] of Object.entries(biomeButtons)) btn.addEventListener('click', () => _selectBiome(id));
  _selectBiome('garden'); // apply default highlight on load

  // ── Play button — start the currently-selected biome directly ─────────────
  playBtn.addEventListener('click', () => {
    const v = nameInput.value.trim();
    player.name = v.length > 0 ? v : 'Unnamed';
    nameInput.blur();
    // Iris closes over the homescreen; the game starts while it's black
    irisTransition({ onMidpoint: () => _onPlay(selectedBiome) });
  });
}

// Biome bar visibility — shown only on the homescreen. Called from main.js's
// startGame() / returnToHomescreen() at the same two transition points as
// the kill button's showKillButton()/hideKillButton().
export function showBiomeBar() {
  const el = document.getElementById('biome-select-bar');
  if (el) el.style.display = 'flex';
}

export function hideBiomeBar() {
  const el = document.getElementById('biome-select-bar');
  if (el) el.style.display = 'none';
}

// Guard: this module must only initialize once. If it's ever evaluated twice
// (e.g. loaded under two different URLs like homescreen.js and
// homescreen.js?v=2, which ES modules treat as separate modules), a second
// run would stack a duplicate biome bar and a second Play handler — and
// one Play click would start the game twice.
if (!window.__homescreenInitialized) {
  window.__homescreenInitialized = true;
  runHomescreen();
}