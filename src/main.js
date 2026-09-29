// main.js — boots the browser client and wires it to the game world.
//
// The game simulation (src/game/) advances in fixed ticks via advanceWorld();
// this file owns everything around it: the canvas, the frame loop, input,
// camera, the death overlay and the homescreen ↔ play transitions.
import { localPlayer as player } from './client/localPlayer.js';
import { writeLocalPlayerInput, clearHeldKeys } from './client/input.js';  // also registers all input listeners

import { addPlayer } from './game/player.js';
import { loadBiome, spawnPlayerInBiome, respawnAtCheckpoint, advanceWorld } from './game/game.js';
import { onGameEvent } from './game/events.js';
import { killPlayerSelf } from './game/combat.js';
import { clearInventory } from './game/inventory.js';
import { grantItem } from './game/commands.js';
import { initCamera, updateCamera, camera, zoomState, setZoom, getZoom, setMinZoom, DEFAULT_MIN_ZOOM, startCameraRush, isCameraRushing, updateCameraRush } from './client/camera.js';
import { rarityText } from './shared/rarities.js';
import { render, triggerPetalDeathPops, clearPetalDeathPops, setPlayerWasDead } from './client/render/renderer.js';
import { withInterpolatedPositions } from './client/render/interpolation.js';
import { levelHUD } from './client/ui/levelHud.js';
import { updateDamagePopups } from './client/render/damagePopups.js';
import { initUI, notifyInventoryChanged,
         updateHotbar, updateInventory,
         updateSettingsCog,
         showKillButton, hideKillButton, registerKillButtonHandler }             from './client/ui/uiManager.js';
import { setHomescreenMode, setHomescreenHotbarH,
         HS_SLOT_SIZE, HS_BENCH_SIZE, HS_BENCH_ROW_GAP } from './client/ui/hotbar.js';
import { showHomescreen, hideHomescreen, setPlayHandler } from './client/ui/homescreen.js';
import { irisTransition } from './client/ui/transition.js';
import { initTooltip }                   from './client/ui/mobTooltip.js';
import { drawPetalTooltip } from './client/ui/petalTooltip.js';
import { PETAL_TYPES } from './shared/petalTypes.js';
import { settings }                      from './client/settings.js';
import { linkSettings }                  from './client/inputState.js';
linkSettings(settings);

import { clearMobGallery } from './client/ui/mobGallery.js';

// ── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const ctx    = canvas.getContext('2d');

// Track CSS-pixel dimensions separately — render logic works in CSS pixels
let canvasW = window.innerWidth;
let canvasH = window.innerHeight;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvasW   = window.innerWidth;
  canvasH   = window.innerHeight;

  canvas.width        = Math.round(canvasW * dpr);
  canvas.height       = Math.round(canvasH * dpr);
  canvas.style.width  = canvasW + 'px';
  canvas.style.height = canvasH + 'px';

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resize();
window.addEventListener('resize', resize);

// ── Scroll wheel zoom ─────────────────────────────────────────────────────────
window.addEventListener('wheel', e => {
  // Don't hijack scroll events that originate inside a UI panel
  const UI_PANEL_IDS = ['inv-panel', 'crafting-panel', 'mobgal-panel', 'settings-panel', 'updatelog-panel'];
  if (UI_PANEL_IDS.some(id => document.getElementById(id)?.contains(e.target))) return;

  e.preventDefault();
  let factor;
  if (e.ctrlKey) {
    // Pinch-to-zoom on trackpad: deltaY is small, use proportionally
    factor = Math.pow(0.99, e.deltaY);
  } else if (e.deltaMode === 0) {
    // Mouse wheel: deltaMode 0 (pixels) with large deltaY — use fixed step
    factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  } else {
    // Trackpad two-finger scroll (line/page mode): scale gently
    factor = Math.pow(0.99, e.deltaY / 4);
  }
  setZoom(getZoom() * factor);
}, { passive: false });

// ── Early UI init — runs before play so panels exist on homescreen ────────────
initUI();
initTooltip(canvas);
registerKillButtonHandler(handleKillButtonClick);

// ── Death overlay ─────────────────────────────────────────────────────────────
let _deathOverlayVisible = false;

function showDeathOverlay() {
  if (_deathOverlayVisible) return;
  _deathOverlayVisible = true;

  // Populate "You were killed by: {rarity} {mob name}" — rarity name/color
  // pulled from death cause, snapshotted at the moment of death (see
  // setLastDeathCause / setLastDeathCauseSelf in player.js). No source
  // (poison tick, self-inflicted petal damage) falls back to a plain
  // "You died"; the X (kill) button's selfKill marker shows "Yourself"
  // in plain white, with no rarity color.
  const causeEl = document.getElementById('death-cause');
  if (causeEl) {
    if (player.deathCause?.selfKill) {
      causeEl.innerHTML =
        `You were killed by: <span class="death-cause-source">Yourself</span>`;
    } else if (player.deathCause) {
      const color = rarityText(player.deathCause.rarity);
      causeEl.innerHTML =
        `You were killed by: <span class="death-cause-source" style="color:${color}">` +
        `${player.deathCause.rarity} ${player.deathCause.name}</span>`;
    } else {
      causeEl.textContent = 'You died';
    }
  }

  const backdropEl = document.getElementById('death-backdrop');
  if (backdropEl) {
    backdropEl.style.display = 'block';
    backdropEl.getBoundingClientRect(); // force reflow before animating in
    backdropEl.style.opacity = '1';
  }

  const el = document.getElementById('death-overlay');
  if (!el) return;
  el.style.display = 'flex';
  // Force reflow then animate in
  el.getBoundingClientRect();
  el.style.transform = 'translateY(0)';
  el.style.opacity   = '1';
}

function hideDeathOverlay(onDone) {
  if (!_deathOverlayVisible) { if (onDone) onDone(); return; }
  _deathOverlayVisible = false;

  const backdropEl = document.getElementById('death-backdrop');
  if (backdropEl) backdropEl.style.opacity = '0';

  const el = document.getElementById('death-overlay');
  if (!el) { if (onDone) onDone(); return; }
  el.style.transform = 'translateY(-110%)';
  el.style.opacity   = '0';
  setTimeout(() => {
    el.style.display = 'none';
    if (backdropEl) backdropEl.style.display = 'none';
    if (onDone) onDone();
  }, 420);
}

// Shared homescreen-return flow — used by the death overlay's Menu button and
// by the X (kill) button when clicked while already dead. Callers are
// responsible for closing/hiding whatever overlay is currently up first.
function returnToHomescreen() {
  // Iris closes → swap to the homescreen while black → iris opens
  irisTransition({
    onMidpoint: () => {
      respawnAtCheckpoint(player);
      clearHeldKeys();
      clearPetalDeathPops();
      setPlayerWasDead(false);
      _playerWasDeadLocal = false;
      stopGameLoop();
      hideKillButton();
      showHomescreen();
      startHomescreenHotbar();
    },
  });
}

// Wire death overlay buttons directly (modules execute after DOM parse)
{
  const respawnBtn = document.getElementById('death-respawn');
  const menuBtn     = document.getElementById('death-menu');
  const closeBtn    = document.getElementById('death-close');

  // Respawn — stays in the map. Respawns the player immediately on click
  // (camera rush starts right away too); the overlay fades out concurrently
  // rather than gating the respawn behind its ~420ms fade animation. The game
  // already recorded the death itself; respawnAtCheckpoint places the player
  // at their current checkpoint (or the map spawn).
  if (respawnBtn) {
    respawnBtn.addEventListener('click', () => {
      hideDeathOverlay(null);
      respawnAtCheckpoint(player);
      clearHeldKeys();
      clearPetalDeathPops();
      setPlayerWasDead(false);
      _playerWasDeadLocal = false;
      startCameraRush();
    });
  }

  // Menu — same behavior "Continue" used to have: return to the homescreen.
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      hideDeathOverlay(returnToHomescreen);
    });
  }

  // Close — just dismisses the overlay; player stays dead.
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      hideDeathOverlay(null);
    });
  }
}

// ── X (kill) button — see client/ui/killButton.js for the button's own DOM/styling ──
// While alive: instantly kills the player (bypassing shield/invincibility),
// death cause shows "Yourself" — the game reports the death on its next tick
// (the 'playerDied' event) and the normal death overlay sequence runs.
// While already dead: same as the death overlay's Menu button — return to
// the homescreen. (The death overlay may or may not be open in this case;
// either way we hide it before transitioning, which is a harmless no-op if
// it wasn't showing.)
export function handleKillButtonClick() {
  if (player.dead) {
    hideDeathOverlay(returnToHomescreen);
  } else {
    killPlayerSelf(player);
  }
}

// ── Homescreen hotbar canvas loop ─────────────────────────────────────────────
// Draws the hotbar (the bigger homescreen layout, just under the name box),
// tooltips and panels while the homescreen is up. The hotbar's contents are
// the player's real hotbar, so it's the same one you play with; the game
// loop takes over on Play.
let _homebar_raf = null;

function startHomescreenHotbar() {
  stopHomescreenHotbar();
  setHomescreenMode(true);

  // Seed inventory at homescreen so player can set up hotbar before choosing a mode
  clearInventory(player);
  clearMobGallery();
  grantItem(player, 'magnet_voidbound');
  grantItem(player, 'ant_egg_imperial');
  grantItem(player, 'cutter_imperial');
  grantItem(player, 'stinger_super');
  notifyInventoryChanged();

  let lastFrameTime = performance.now();
  function frame(now) {
    const dt = Math.min(now - lastFrameTime, 100);
    lastFrameTime = now;
    canvasW = window.innerWidth;
    canvasH = window.innerHeight;
    ctx.clearRect(0, 0, canvasW, canvasH);
    const homeContent = document.querySelector('.home-content');
    const rect = homeContent ? homeContent.getBoundingClientRect() : null;
    const hotbarGap = 28;
    const hotbarOffset = 18 + HS_SLOT_SIZE + HS_BENCH_ROW_GAP + HS_BENCH_SIZE;
    const desiredTop = rect ? rect.bottom + hotbarGap : canvasH * 0.65;
    const virtualH = desiredTop + hotbarOffset;
    setHomescreenHotbarH(virtualH);   // hotbar.js lays out + hit-tests against this
    updateHotbar(ctx, canvasW, virtualH);
    drawPetalTooltip(ctx, canvasW, canvasH, dt);
    updateInventory();
    updateSettingsCog(now);
    _homebar_raf = requestAnimationFrame(frame);
  }
  _homebar_raf = requestAnimationFrame(frame);
}

function stopHomescreenHotbar() {
  if (_homebar_raf) { cancelAnimationFrame(_homebar_raf); _homebar_raf = null; }
}

// ── Game loop ─────────────────────────────────────────────────────────────────
let lastTime = performance.now();
let _lastMinZoom = DEFAULT_MIN_ZOOM;
let _loopRaf = null;
let _loopToken = 0; // bumped on every start/stop — any loop holding an old token exits
let _playerWasDeadLocal = false;

// Only ONE frame loop may ever run — a second one would render twice per frame
// and, before the fixed tick, used to double player speed. stopGameLoop()
// invalidates any loop still holding an old token.
function stopGameLoop() {
  _loopToken++;
  if (_loopRaf) { cancelAnimationFrame(_loopRaf); _loopRaf = null; }
}

function startGameLoop() {
  stopGameLoop();
  const token = _loopToken;
  const tick = (now) => {
    if (token !== _loopToken) return; // superseded by a newer start/stop
    loop(now);
    if (token === _loopToken) _loopRaf = requestAnimationFrame(tick);
  };
  _loopRaf = requestAnimationFrame(tick);
}

// The game tells us when the local player dies (it has already recorded the
// death for the checkpoint penalty) — play the death visuals and overlay.
onGameEvent('playerDied', e => {
  if (e.playerId !== player.id || _playerWasDeadLocal) return;
  _playerWasDeadLocal = true;
  setPlayerWasDead(true);
  player.deathRotation = (Math.random() * 2 - 1) * (15 * Math.PI / 180);
  triggerPetalDeathPops(canvasW, canvasH);
  setTimeout(showDeathOverlay, 350);
});

// Items the local player picked up / crafted / was given → refresh the inventory UI.
onGameEvent('inventoryChanged', e => {
  if (e.playerId === player.id) notifyInventoryChanged();
});

function loop(now) {
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;

  // Hand this frame's controls to the game, then let it catch up to real time.
  writeLocalPlayerInput(player);
  player.options.autoEquipDrops = settings.equipDrops;
  const alpha = advanceWorld(dt);

  // Everything below draws the world between its last two ticks (see interpolation.js).
  withInterpolatedPositions(alpha, () => {
    if (isCameraRushing()) {
      updateCameraRush(player.x, player.y, dt);
    } else {
      updateCamera(player.x, player.y);
    }
    updateDamagePopups(dt);

    // ── Antennae vision bonus ──────────────────────────────────────────────
    let totalVisionBonus = 0;
    for (const typeId of player.hotbar) {
      if (!typeId) continue;
      const pt = PETAL_TYPES[typeId];
      if (pt?.visionBonus) totalVisionBonus += pt.visionBonus;
    }
    const newMinZoom = DEFAULT_MIN_ZOOM / (1 + totalVisionBonus);
    if (Math.abs(newMinZoom - _lastMinZoom) > 0.0001) {
      const wasAtMin = Math.abs(zoomState.v - _lastMinZoom) < 0.01;
      setMinZoom(newMinZoom);
      if (wasAtMin) setZoom(newMinZoom);
      _lastMinZoom = newMinZoom;
    }

    render(ctx, canvasW, canvasH, camera.x, camera.y, dt);
  });
}

// ── startGame — enter play from the homescreen ────────────────────────────────
// `biome` picks which map (shared/biomes/) becomes active. loadBiome() swaps
// the map and clears the previous run's mobs; spawnPlayerInBiome() then places
// the player at this biome's furthest-reached checkpoint (or its spawn point),
// resetting progress first if they last played a different biome — this is
// what makes progress "carry over" across a trip to the homescreen and back
// into the SAME biome.
async function startGame(biome = 'garden') {
  stopHomescreenHotbar();
  setHomescreenMode(false);
  showKillButton();
  hideHomescreen();
  _playerWasDeadLocal = false;
  setPlayerWasDead(false);

  loadBiome(biome);
  addPlayer(player);
  spawnPlayerInBiome(player, biome);
  clearHeldKeys();

  initCamera(player.x, player.y);

  // Inventory was seeded at homescreen — player configured hotbar before entering
  clearMobGallery();

  lastTime = performance.now();
  levelHUD.init(player.xp);
  startGameLoop();
}

// Boot straight into the homescreen with its hotbar running. (Started here,
// not from homescreen.js — importing main.js from there loaded a second copy
// of this whole module, with its own game loop.)
setPlayHandler(startGame);
showHomescreen();
startHomescreenHotbar();