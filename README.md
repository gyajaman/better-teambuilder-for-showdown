# Better Teambuilder for Showdown!

A Chrome/Firefox extension that adds custom search filters, a Speed stat comparator, and a live [Pikalytics](https://pikalytics.com) usage-stats sidebar to the [Pokémon Showdown](https://play.pokemonshowdown.com) teambuilder — filters computed from a species' full movepool or ability access, not just a single static field like the site's built-in type/move/ability filters.

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

## Pikalytics sidebar

When the browser window is wide enough, no side room (chat, etc.) is docked, and a specific Pokémon is being edited, the teambuilder splits in half: the room itself shrinks to 50% width and a new panel appears alongside it showing live [Pikalytics](https://pikalytics.com) usage stats for that exact Pokémon in the team's current format:

- **Common Moves** — with the same type icons Showdown uses natively
- **Common Abilities**
- **Common Items**
- **Common Natures**
- **Common Spreads**
- **Common Teammates** — with the same Pokémon sprites the species search uses

Data always matches the currently-edited species and format — switching Pokémon or formats refreshes the panel, and it clearly says "No data" rather than showing stale or wrong information when nothing is available. Mega/Primal Pokémon are looked up under their base species (e.g. "Blastoise-Mega" queries as "Blastoise"), matching how Pikalytics itself tracks Mega usage.

**Format coverage is a deliberate, narrow allowlist** — Pokemon Champions VGC 2026 Regulations A and B only, not every format Pikalytics tracks:

| Format | Data source |
|---|---|
| Reg A (Bo1) | Ranked ladder battle data |
| Reg A (Bo3) | Tournament data |
| Reg B (Bo1) | Ranked ladder battle data |
| Reg B (Bo3) | Tournament data |

Bo1 uses the official matchmaking ladder (the larger, more representative sample); Bo3 is tournament-only, so it's mapped to Pikalytics' tournament-aggregate data instead. Any other format shows "No data" — no guessing at an unverified slug mapping. Data is cached locally (`localStorage`) for up to 24 hours and automatically invalidated the moment Pikalytics rolls over to a new month's data, so you never have to manually clear anything.

## Options

An extension options page (right-click the extension icon → **Options**, or `chrome://extensions` → **Details** → **Extension options**) lets you toggle:

- **Auto-close side rooms on load** — closes any chat/side rooms Showdown restores from your last session as soon as the page loads, so the layout starts clean. On by default.

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

The teambuilder sidebar and Pikalytics data follow the same "patch, don't replace" philosophy:

- **Sidebar layout** works by shrinking `#room-teambuilder` itself to 50% width (a CSS `!important` override, since Showdown's own layout engine keeps re-setting a non-important inline width) and docking a genuine DOM sibling — never a fake Showdown `Room`/tab — in the freed half.
- **Split state** is re-evaluated on window resize and by wrapping four Showdown methods (`app.updateLayout`, `TeambuilderRoom.prototype.update`/`updateSetTop`/`updatePokemonSprite`) that each catch a different way the edited Pokémon can change without the others firing.
- **Pikalytics data** is fetched client-side (`src/pikalytics.js`) via the same `/api/p/{month}/{slug}-{cutoff}/{species}` endpoint pikalytics.com's own per-Pokémon pages use, against a small, explicit format→slug allowlist (see the Pikalytics sidebar section above) rather than guessing at every format Pikalytics happens to have a similarly-named slug for.
- **Options/settings**: `src/content.js` runs in the page's MAIN world (needed to see Showdown's own globals) and has no access to `chrome.storage`. A separate isolated-world script, `src/settings-bridge.js`, reads the setting and hands it to `content.js` via a DOM attribute on `<html>` — the one thing both JS realms share.

See `src/move-data.js` for the filter definitions, `src/pikalytics.js` for the Pikalytics client/cache, and `src/content.js` for the patching logic; all are commented throughout.

## License

MIT
