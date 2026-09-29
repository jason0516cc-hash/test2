/**
 * inputState.js — Raw input state. Imports only keymap.js (which imports
 * nothing), so petals.js and input.js can safely import from here without
 * creating circular dependencies.
 *
 * `keys` holds physical key codes (see keymap.js eventCode) → held.
 */
import { isHeld } from './keymap.js';

export const keys  = {};
export const mouse = { left: false, right: false };

// Settings reference (set lazily to avoid circular imports)
let _settings = null;
export function linkSettings(s) { _settings = s; }

export const inputState = {
  get up()      { return !_settings?.mouseMovement && isHeld('moveUp', keys);    },
  get down()    { return !_settings?.mouseMovement && isHeld('moveDown', keys);  },
  get left()    { return !_settings?.mouseMovement && isHeld('moveLeft', keys);  },
  get right()   { return !_settings?.mouseMovement && isHeld('moveRight', keys); },
  get _rawExpand()  { return isHeld('attack', keys) || !!mouse.expandOk; },
  get _rawRetract() { return isHeld('defend', keys) || !!mouse.right; },
  get expand() {
    const invAtk = _settings && _settings.invertAttack;
    const invDef = _settings && _settings.invertDefend;
    // Invert Attack: default is expanded; pressing attack key returns to normal (cancel expand)
    // Invert Defend: pressing attack while invert defend is on returns to normal orbit
    if (invAtk) return !this._rawExpand && !this._rawRetract; // always expanded unless key pressed
    if (invDef) return false; // invert defend: suppress expand, player is stuck defending unless they press attack to go normal
    return this._rawExpand;
  },
  get retract() {
    const invAtk = _settings && _settings.invertAttack;
    const invDef = _settings && _settings.invertDefend;
    // Invert Defend: default is retracted; pressing attack key brings to normal
    if (invDef) return !this._rawExpand && !this._rawRetract; // always retracted unless attack pressed
    if (invAtk) return false; // invert attack: suppress retract
    return this._rawRetract;
  },
};