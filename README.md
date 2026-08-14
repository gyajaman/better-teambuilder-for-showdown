# Better Teambuilder for Showdown!

A Chrome/Firefox extension that adds custom search filters and a Speed stat comparator to the [Pokémon Showdown](https://play.pokemonshowdown.com) teambuilder — filters computed from a species' full movepool or ability access, not just a single static field like the site's built-in type/move/ability filters.

## Filters

### Pokémon & Move search

Priority, Redirection, Spread, Wind, Sound, Never Miss, Speed Control, Pivoting, Hazard, Hazard Removal

### Move search only

Ability-synergy filters — only useful once a specific Pokémon/ability is locked in:

- **Sharpness** — slicing moves (Sharpness-boosted)
- **Recoil** — moves that damage the user on hit
- **Sheer Force** — damaging moves with a secondary effect
- **Contact** — moves that make contact
- **Punching** — punching moves (Iron Fist-boosted)
- **Biting** — biting moves (Strong Jaw-boosted)
- **Pulse** — pulse moves (Mega Launcher-boosted)
- **Ball/Bomb** — a *negative* (exclusion) filter that *hides* ballistic moves, for building around Bulletproof. The chip renders in red to indicate it's an exclusion.

### Pokémon search only

Ability-based filters — matched against a species' declarable abilities rather than its movepool:

- **Negates Intimidate** — abilities that block, reverse, or come out ahead of Intimidate's Attack drop
- **Weather Setter** — abilities that set weather (Drought, Drizzle, Sand Stream, etc.)
- **Terrain Setter** — abilities that set terrain (Electric Surge, Grassy Surge, etc.)

### Speed stat filter

A persistent widget that appears below the native "Sort: …" row in Pokémon search. It provides:

- An **operator toggle** cycling through `>`, `<`, and `−` (off)
- An **`=` toggle** (combinable: `>` + `=` → `>=`, `<` + `=` → `<=`, just `=` alone → exactly equal)
- A **number input** for the base Speed threshold

The filter narrows results to species whose base Speed satisfies the comparison. No value typed = filter inactive, so toggling buttons before entering a number never hides everything.

## Usage

### Typed filters

Type a filter's name into the Pokémon or Move search box, the same way you'd type a move/type/ability. A suggestion appears under a **"Custom Filters"** header — click it (or press Enter) and it becomes a removable chip in the site's own `Filters: …` row, combinable with native filters. Remove it by clicking the `×` on the chip, or by pressing Backspace when the search box is empty.

### Hover tooltip

In Pokémon search, hover a result to see which specific moves or abilities matched each active custom filter. Moves marked **conditional** (e.g. Fake Out — "only usable the turn the user switches in") display a yellow `conditional` tag with the condition in a title tooltip.

### Dark mode

All custom UI — tooltips, the Speed filter pill, negative-filter chip colors — adapts to Showdown's dark mode automatically.

## Install

1. Clone or download this repo.
2. **Chrome:** Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
   **Firefox:** Go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `manifest.json` in this folder.
3. Open https://play.pokemonshowdown.com and navigate to the teambuilder.

## How it works

A MAIN-world content script patches `DexSearch.prototype` (the teambuilder's search engine) so it recognizes custom filter categories alongside the native ones — reusing the site's own legality checks (`canLearn()`) and rendering rather than reimplementing search logic.

- **Movepool filters** walk each category's move list through `canLearn(speciesId, moveId)` — the same prevo/battle-only/gen-appropriate learnset walk the native moves tab uses.
- **Ability filters** (`negatesintimidate`, `weathersetter`, `terrainsetter`) check `species.abilities` membership instead — no `canLearn()` involved.
- **Speed filter** post-filters `engine.results` by comparing each species' `baseStats.spe` against the widget's operator/value state.
- **Typed suggestions** are injected as synthetic `['customfilter', catId]` rows that the site's own click → `addFilter` chain handles natively.
- **Filter chips** are folded into the site's own "Filters: …" row by wrapping `BattleSearch.prototype.getFilterText` / `removeFilter`.
- **Tooltip** is a standalone floating overlay (`#cf-tooltipwrapper`), never inserted into the results DOM, positioned via `getBoundingClientRect`.

See `src/move-data.js` for the filter definitions and `src/content.js` for the patching logic; both are commented throughout.

## License

MIT
