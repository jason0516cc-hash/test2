/**
 * client/ui/levelHud.js — top-left in-game status HUD
 *
 * Layout:
 *
 *   [● flower ●]  [██████████░░░  HP  ]
 *   [_________][████░░░  Lvl N  ]        ← connector pill bridges flower→lvl, no gap
 */

import { localPlayer as player } from '../localPlayer.js';
import { drawFlowerFaceParams, circle, cutterRot } from '../render/renderer.js';
import { drawPetalShape, drawThirdEyeAccessory } from '../render/petalDrawing.js';
import { mousePos }                      from './uiEvents.js';
import { inputState }                    from '../inputState.js';


import { onGameEvent }                     from '../../game/events.js';
import {
  levelFromXp,
  xpForLevel,
  totalXpForLevel,
} from '../../shared/leveling.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function fmt(n) {
  n = Math.max(0, Math.floor(n));
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layout constants
// ─────────────────────────────────────────────────────────────────────────────
// Cog: top 16 + height 54 + border 3 = 73px bottom. We sit 17px below that.

const PAD_X    = 12;         // HUD left edge
const PAD_Y    = 92;         // HUD top edge (layout space, before scaling)

// The whole HUD is drawn at HUD_SCALE, scaled around the flower's top-left
// corner, which lands at (PAD_X, HUD_TOP) on screen — just under the
// top-left buttons (which end at y = 60).
const HUD_SCALE = 0.85;
const HUD_TOP   = 72;

const FLOWER_R = 28;         // flower body radius
const GAP      = 8;          // gap between flower right edge and pill left edge

// HP pill
const HP_W     = 150;
const HP_H     = 24;
// Shield overlay — thin bar hugging the bottom edge of the HP pill, only
// drawn when the player actually has any shield capacity.
// Shield overlay — white layer painted on top of the HP fill
const SHIELD_FILL = 'rgba(255, 255, 255, 0.55)';
// LVL pill — narrower, centered under HP pill
const LVL_W    = 116;
const LVL_H    = 18;
const PILL_GAP = 0;          // no gap — strokes kiss, zero overlap

// Derived positions
const PILL_X    = PAD_X + FLOWER_R * 2 + GAP;     // left edge of both pills

// HP bar Y first — flower center is derived from it so eyes line up
const HP_Y      = PAD_Y + FLOWER_R;               // top of HP pill
// Flower center = HP bar vertical center  →  eyes level with HP bar
const FLOWER_CX = PAD_X + FLOWER_R;
const FLOWER_CY = HP_Y + HP_H / 2;                // eyes level with HP center

// LVL bar: directly below HP, no gap, centered horizontally under it
const LVL_Y     = HP_Y + HP_H + PILL_GAP;
const LVL_X     = PILL_X + (HP_W - LVL_W) / 2;

// Connector: same row as HP pill, extends from under the flower all the way to
// beyond the HP pill right edge. Taller than HP pill (overhangs top and bottom)
// so it reads as a visible backing plate. HP pill stroke renders on top.
const CONN_EXTRA_H   = 6;                          // extra height above+below HP pill
const CONN_OVERSHOOT = 4;                           // px past HP pill right edge stroke
const CONN_X  = FLOWER_CX;                         // left end hidden under flower
const CONN_W  = PILL_X - CONN_X + HP_W + CONN_OVERSHOOT; // full HP width + just past stroke
const CONN_Y  = HP_Y - CONN_EXTRA_H / 2;          // taller: hangs above HP pill
const CONN_H  = HP_H + CONN_EXTRA_H;              // taller: hangs below HP pill

// Scale anchor (flower top-left in layout space)
const ANCHOR_X = PAD_X;
const ANCHOR_Y = FLOWER_CY - FLOWER_R;

// Colours
const HP_BG    = '#2a2a2a';
const HP_FILL  = '#75dd34';
const LVL_BG   = '#2a2a2a';
const LVL_FILL = '#e2eb67';

// ─────────────────────────────────────────────────────────────────────────────
// LevelHUD class
// ─────────────────────────────────────────────────────────────────────────────

class LevelHUD {
  constructor() {
    this.xp         = 0;
    this.level      = 0;
    this._renderXp  = 0;
    this._renderHp  = 0;
    this._initAnim  = 0;

    // Face state — mirrors renderer's face object exactly
    this._attackT     = 0;
    this._defendT     = 0;
    this._hudEyeAngle = 0;

    this._ready = false;

    // Level-up confetti (HUD layout space) and the level it last celebrated
    this._confetti   = [];
    this._partyLevel = 0;
  }

  init(xp = 0) {
    this.xp        = xp;
    this.level     = Math.floor(levelFromXp(xp));
    this._renderXp = xp;
    this._ready    = true;
    this._initAnim = 0;
    this._confetti   = [];
    this._partyLevel = Math.floor(levelFromXp(xp));
  }

  addXp(amount) {
    this.xp    = Math.max(0, this.xp + amount);
    this.level = Math.floor(levelFromXp(this.xp));
  }

  // ── Main draw ──────────────────────────────────────────────────────────────
  draw(ctx, W, H, dt, playerHp, maxHp) {
    if (!this._ready) return;

    // Slide-in from the left on init/respawn
    this._initAnim = lerp(this._initAnim, 1, 0.055);
    const slideX   = (1 - this._initAnim) * -220;

    ctx.save();
    ctx.translate(slideX + ANCHOR_X, HUD_TOP);
    ctx.scale(HUD_SCALE, HUD_SCALE);
    ctx.translate(-ANCHOR_X, -ANCHOR_Y);
    // Mouse in layout space, for the hover labels
    const hudMx = ANCHOR_X + (mousePos.x - slideX - ANCHOR_X) / HUD_SCALE;
    const hudMy = ANCHOR_Y + (mousePos.y - HUD_TOP) / HUD_SCALE;

    // Smooth interpolation
    const spd      = Math.min(1, 0.07 * (dt / 16));
    this._renderXp = lerp(this._renderXp, this.xp,   spd);
    this._renderHp = lerp(this._renderHp, playerHp,  spd * 1.4);

    // ── Face expression + eye-direction state ────────────────────────────────
    const FACE_SPD = 0.012;
    const fk = 1 - Math.pow(1 - FACE_SPD, dt);

    this._attackT += ((inputState.expand  ? 1 : 0) - this._attackT) * fk;
    this._defendT += ((inputState.retract && !inputState.expand ? 1 : 0) - this._defendT) * fk;

    if (player.isMoving) {
      let da = player.moveAngle - this._hudEyeAngle;
      while (da >  Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      this._hudEyeAngle += da * fk;
    }

    // ── Connector pill (drawn first so flower renders on top) ───────────────
    this._drawConnector(ctx);

    // ── Flower ──────────────────────────────────────────────────────────────
    this._drawFlower(ctx);

    // ── HP pill ─────────────────────────────────────────────────────────────
    const hpPct   = Math.max(0, Math.min(1, this._renderHp / maxHp));
    const hoverHp = this._isOver(hudMx, hudMy, PILL_X, HP_Y, HP_W, HP_H);
    const hasShield = player.maxShield > 0;
    // "X + X" (current HP + current shield) when a shield source is
    // equipped, or just "X" (current HP) when there's none — per
    // instruction. No maxHP/labels shown in this format.
    const hpLabel = hasShield
      ? `${fmt(hoverHp ? playerHp : this._renderHp)} + ${fmt(player.shield)}`
      : `${fmt(hoverHp ? playerHp : this._renderHp)}`;
    // Shield overlay — clear layer painted on top of the HP fill, covering the
    // same fraction of the bar as shield/maxShield, with the label drawn over
    // it. Only shown once the player has any shield capacity.
    const shieldPct = hasShield ? Math.max(0, Math.min(1, player.shield / player.maxShield)) : 0;
    this._drawPill(ctx, PILL_X, HP_Y, HP_W, HP_H, hpPct, HP_FILL, HP_BG, hpLabel, 13, 'rgba(0,0,0,0.90)', shieldPct);

    // ── Level / XP pill ─────────────────────────────────────────────────────
    const contLvl  = levelFromXp(this._renderXp);
    const intLvl   = Math.floor(contLvl);
    const xpFrac   = contLvl % 1;
    const xpStart  = totalXpForLevel(intLvl);
    const xpEnd    = xpStart + xpForLevel(intLvl + 1);
    const hoverLvl = this._isOver(hudMx, hudMy, LVL_X, LVL_Y, LVL_W, LVL_H);
    const lvlLabel = hoverLvl
      ? `${fmt(this.xp)} / ${fmt(xpEnd)} XP`
      : `Lvl ${intLvl + 1}`;
    this._drawPill(ctx, LVL_X, LVL_Y, LVL_W, LVL_H, xpFrac, LVL_FILL, LVL_BG, lvlLabel, 11, 'rgba(0,0,0,0.90)');

    // The bar just filled up → confetti bursts out of its very end
    if (intLvl > this._partyLevel) {
      this._partyLevel = intLvl;
      this._burstConfetti(LVL_X + LVL_W - LVL_H * 0.4, LVL_Y + LVL_H / 2);
    }
    this._drawConfetti(ctx, dt);

    ctx.restore();
  }

  // ── Level-up confetti ───────────────────────────────────────────────────────
  _burstConfetti(x, y) {
    const COLORS = ['#e2eb67', '#75dd34', '#ff6b6b', '#4dabf7', '#f783ac', '#ffd43b', '#ffffff'];
    for (let i = 0; i < 26; i++) {
      // Mostly up and out to the right, some falling back over the bar
      const a = -Math.PI / 2 + (Math.random() - 0.3) * 2.2;
      const sp = 0.09 + Math.random() * 0.16;
      this._confetti.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        w: 3 + Math.random() * 2.5, h: 5 + Math.random() * 3,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.02,
        age: 0, life: 750 + Math.random() * 450,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
      });
    }
  }

  _drawConfetti(ctx, dt) {
    const drag = Math.pow(0.985, dt / 16.67);
    for (let i = this._confetti.length - 1; i >= 0; i--) {
      const c = this._confetti[i];
      c.age += dt;
      if (c.age >= c.life) { this._confetti.splice(i, 1); continue; }
      c.vy += 0.00045 * dt;                 // gravity
      c.vx *= drag; c.vy *= drag;
      c.x += c.vx * dt; c.y += c.vy * dt;
      c.rot += c.vr * dt;
      const t = c.age / c.life;
      ctx.save();
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      // flutter: the piece flips as it tumbles
      ctx.scale(1, Math.cos(c.age * 0.012 + c.rot));
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
      ctx.restore();
    }
  }

  // ── Flower draw ─────────────────────────────────────────────────────────────
  _drawFlower(ctx) {
    const cx = FLOWER_CX, cy = FLOWER_CY, r = FLOWER_R;

    // ── Centipede legs — drawn under body ──────────────────────────────────
    if (player.hotbar.some(id => id?.startsWith('centipede_legs'))) {
      ctx._legPhase    = player.legPhase;
      ctx._legRotation = player.smoothRotation;
      ctx._isIcon      = false;
      drawPetalShape(ctx, 'centipede_legs', cx, cy, r);
      ctx._legPhase = 0; ctx._legRotation = 0;
    }

    // ── Body — disc makes stroke black ─────────────────────────────────────
    const borderColor = player.hotbar.some(id => id?.startsWith('disc')) ? '#000000' : player.border;
    circle(ctx, cx, cy, r, player.color, borderColor, 3, 1);

    // ── Cutter — animated saw ring ─────────────────────────────────────────
    if (player.hotbar.some(id => id?.startsWith('cutter'))) {
      ctx._cutterRot = cutterRot;
      drawPetalShape(ctx, 'cutter', cx, cy, r * 1.14);
      ctx._cutterRot = 0;
    }

    // ── Face ───────────────────────────────────────────────────────────────
    drawFlowerFaceParams(ctx, cx, cy, r,
      this._attackT, this._defendT, this._hudEyeAngle, 1, player.color);

    // ── Third eye — on forehead (drawn after face) ─────────────────────────
    if (player.hotbar.some(id => id?.startsWith('third_eye'))) {
      drawThirdEyeAccessory(ctx, cx, cy, r);
    }

    // ── Antennae ───────────────────────────────────────────────────────────
    if (player.hotbar.some(id => id && (id === 'antennae' || id.startsWith('antennae_')))) {
      drawPetalShape(ctx, 'antennae', cx, cy, r);
    }
  }

  // ── Connector pill draw ─────────────────────────────────────────────────────
  // Fills the gap between the flower and the HP pill using HP_BG color.
  // Left end starts at FLOWER_CX and is hidden under the flower body.
  // Right end butts flush against the HP pill left edge.
  _drawConnector(ctx) {
    const r = CONN_H / 2;
    ctx.save();
    ctx.fillStyle = HP_BG;
    ctx.beginPath();
    ctx.roundRect(CONN_X, CONN_Y, CONN_W, CONN_H, r);
    ctx.fill();
    ctx.restore();
  }

  // ── Pill draw ───────────────────────────────────────────────────────────────
  _drawPill(ctx, x, y, w, h, fraction, fillColor, bgColor, label, fontSize, strokeColor = 'rgba(255,255,255,0.10)', shieldPct = 0) {
    const r  = h / 2;
    const pd = 3;
    const iw = w - pd * 2;
    const ih = h - pd * 2;
    const ir = ih / 2;

    ctx.save();

    // Background pill
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();

    // Subtle inner border ring
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.stroke();

    // Fill bar — clipped to inner pill shape
    if (fraction > 0.001) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x + pd, y + pd, iw, ih, ir);
      ctx.clip();
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(x + pd, y + pd, Math.max(ir * 2, fraction * iw), ih, ir);
      ctx.fill();
      ctx.restore();
    }

    // Shield overlay sits over the fill but under the label, so the text
    // always stays readable on top of it
    if (shieldPct > 0.001) this._drawShieldOverlay(ctx, x, y, w, h, shieldPct);

    // Label
    ctx.font         = `900 ${fontSize}px "UbuntuCustom","Ubuntu",Arial,sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const lx = x + w / 2, ly = y + h / 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.80)';
    ctx.lineWidth   = 2.5;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillText(label, lx, ly);

    ctx.restore();
  }

  // ── Shield overlay — a clear/translucent gray layer painted directly on
  // top of the green HP fill (not a separate strip), covering the same
  // ── Shield overlay — white layer painted directly on top of the HP fill,
  // covering the same proportion of the bar as shield/maxShield. Reads as
  // "a white coating over your health" rather than a second resource track
  // — shield sits in front of HP in the damage order, so it visually sits
  // in front here too. Clips against the SAME inner rounded-rect the HP
  // fill itself clips against (x+pd, y+pd, iw, ih, ir) — not the pill's
  // outer shape — so its edges round off exactly like the HP bar's do.
  // `pct` is shield/maxShield, drawn left-to-right from the same origin the
  // HP fill uses so the two overlap rather than sitting side by side.
  _drawShieldOverlay(ctx, x, y, w, h, pct) {
    if (pct <= 0.001) return;
    const pd = 3;
    const iw = w - pd * 2;
    const ih = h - pd * 2;
    const ir = ih / 2;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x + pd, y + pd, iw, ih, ir);
    ctx.clip();
    ctx.fillStyle = SHIELD_FILL;
    ctx.beginPath();
    ctx.roundRect(x + pd, y + pd, Math.max(ir * 2, pct * iw), ih, ir);
    ctx.fill();
    ctx.restore();
  }


  _isOver(mx, my, rx, ry, rw, rh) {
    return mx >= rx && mx <= rx + rw && my >= ry && my <= ry + rh;
  }
}

export const levelHUD = new LevelHUD();

// XP is awarded by the game simulation (game/player.js addXp).
onGameEvent('xpGained', e => levelHUD.addXp(e.amount));
