// localPlayer.js — the player this browser controls.
//
// Created once and kept for the whole session (it survives trips to the
// homescreen, so XP, petals and checkpoint progress carry over). main.js adds
// it to the game world when a run starts; the UI and renderer read it to show
// "your" hotbar, inventory, HP and so on.
import { createPlayer } from '../game/player.js';

export const localPlayer = createPlayer({ id: 'local', name: 'Unnamed' });
