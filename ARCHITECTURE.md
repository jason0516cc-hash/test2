# How the game is organised

The code is split so the game simulation can later run on a server while the
browser only draws and sends input. Today everything still runs in one browser
tab, but the boundaries are already in place.

```
src/
  main.js        Boots the browser client: canvas, frame loop, death overlay,
                 homescreen ↔ play transitions. Wires client and game together.

  shared/        Pure data and rules. No DOM, no game state. Safe for a server.
    constants.js     player/orbit/world constants
    rarities.js      THE rarity module: names, tier order, fill/border/text
                     colours and the shared box painter — every GUI, tooltip,
                     drop and label takes its rarity colours from here
    leveling.js      XP curve, HP per level, petal slots per level
    petalTypes.js    every petal and its per-rarity stats
    mobTypes.js      every mob: base stats, per-rarity stat curves, size/mass scaling
    biomes/          garden / desert / ocean map data: walls, spawn zones,
                     checkpoints, collision queries

  game/          The simulation. Never touches the screen, DOM or UI.
    game.js          runs the world: loadBiome, spawnPlayerInBiome, advanceWorld
                     (fixed 60 ticks/second)
    player.js        createPlayer, the `players` list, movement, XP, respawn
    petals.js        a player's petals: building them from the hotbar, orbiting, eggs/pets
    mobs.js          mob AI, spawning, zone streaming
    missiles.js      hornet/scorpion missiles: fire, move, HP/damage/mass, team-based collision
    combat.js        all damage: per-player pass + world pass (poison, pets…)
    drops.js         world drops, webs, pollen/missile/honeycomb entities
    inventory.js     add/remove petals in a player's inventory
    crafting.js      crafting chances and pity rules
    checkpoints.js   per-player checkpoint progress and death penalty
    world.js         the active biome (canMoveTo, zones, spawn points…)
    commands.js      everything a player can ASK to change (equip, move, craft…)
    events.js        messages from the game to the client
    bosses.js        dormant boss-spawning code (not wired in)

  client/        The browser side: drawing, UI, input.
    localPlayer.js   the player this browser controls
    input.js         keyboard/mouse → player.input each frame
    keymap.js        which key does what: rebindable actions, saved per
                     player (Settings → Keybinds)
    camera.js        view position and zoom
    settings.js      client preferences
    render/          renderer, mob/petal drawing, map drawing (biomes/),
                     damage popups, interpolation between ticks
      mobIcons.js      mob art fitted into a box (facing north-east)
      renderer.js      the world draw; drops look like hotbar tiles (drawn once
                       per petal, then only scaled) and fly into the player
                       when collected ('dropPickedUp' event)
      deathFx.js       mobs and petals swell + fade when they die/break, mobs
                       burst into dots of their rarity colour
      mobTile.js       THE mob tile (box + art + name + count) — pop icons,
                       mob gallery and any future mob tile use drawMobTile()
    ui/              hotbar, inventory, crafting, mob gallery, chat, settings,
                     homescreen, tooltips, level bar…
      panels.js        which side panel is open: one at a time, click-outside
                       and Escape close them. Panels register themselves here.
      keybinds.js      what each keyboard shortcut does (ignored while
                       typing in a text box or chat)
      mobGallery.js    mob gallery panel: per-mob rows of live tiles, search,
                       tooltips, kill records
      mobSearch.js     the gallery's search (names, drops, rarities, biomes,
                       found/missing, -exclude, "a, b") —
                       pure logic, no DOM
      dragPan.js       click-and-drag scrolling for the scrollbar-less grids
      homescreen.js    title / name / Play / biome buttons, flower preview
      homeBackground.js  homescreen background: the chosen biome's floor and
                       mobs; switching biome opens the new one out from the
                       button
      transition.js    the black-circle (iris) transition between screens

tools/mapDebug.js    archived wall-tagging tool (not loaded by the game)
public/icons, public/fonts
```

## The rules that keep it server-ready

1. **`game/` and `shared/` never import from `client/`.** If game code needs
   the player to see something (damage number, kill, XP, death), it emits an
   event through `game/events.js`, and client code subscribes with `onGameEvent`.

2. **All per-player state lives on the player object** (`player.hotbar`,
   `player.bench`, `player.petals`, `player.inventory`, `player.orbit`,
   `player.craftHold`, `player.checkpoints`…). Game functions take the player
   they act on: `updatePetals(player, dt)`, `addXp(player, amount)`. There is
   no single global player in `game/`.

3. **The game reads input, it never reads the keyboard.** The client writes
   `player.input` (`moveX`, `moveY`, `attack`, `defend`, `viewRange`) each frame
   in `client/input.js`. A server would fill the same object from network messages.

4. **The UI asks, the game decides.** UI code never edits the hotbar or
   inventory arrays itself. It calls `game/commands.js` (`equipFromInventory`,
   `moveSlot`, `unequipToInventory`, `swapWithBench`, `addToCraftHold`,
   `returnCraftHold`, `craftFromHold`, `grantItem`), which checks the request
   is legal and returns false/null if not. Reading state for display
   (`player.inventory`, `player.hotbar`) is fine.

5. **Time moves in fixed ticks.** `advanceWorld(frameMs)` in `game/game.js`
   runs 60 ticks per second no matter the monitor's refresh rate. Rendering
   blends positions between the last two ticks (`client/render/interpolation.js`).

## Adding things

- **New mob:** stats in `shared/mobTypes.js`, behaviour in `game/mobs.js`,
  drawing in `client/render/mobDrawing.js` + one case in `client/render/mobIcons.js`.
- **New petal:** stats in `shared/petalTypes.js`, behaviour in `game/petals.js`
  or `game/combat.js`, drawing in `client/render/petalDrawing.js`.
- **New player action** (e.g. a new crafting mode, trading): add a function to
  `game/commands.js` that validates and applies it, then call it from the UI.
- **Something the player should see happen:** emit an event in `game/events.js`
  (document it in the list at the top) and subscribe in the client.
