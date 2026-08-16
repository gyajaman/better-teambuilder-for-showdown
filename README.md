# Better Teambuilder for Showdown!

A Chrome/Firefox extension that adds custom search filters, a Speed stat comparator, a live [Pikalytics](https://pikalytics.com) usage-stats sidebar, and a Speed Tiers panel with a real head-to-head Speed comparison popup to the [Pokémon Showdown](https://play.pokemonshowdown.com) teambuilder — filters computed from a species' full movepool or ability access, not just a single static field like the site's built-in type/move/ability filters.

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

## Speed Tiers panel

A narrow scrolling column docked to the left of the Pikalytics sidebar, alongside it whenever the split is active. It lists the top 20 Pokémon by usage in the current format, sprite only, top to bottom in rank order — ranks 1–3 get a gold/silver/bronze badge in the corner, every other rank gets a plain one.

The teambuilder room itself is capped to a fixed max width regardless of monitor size, so on a wide window the sidebar absorbs whatever room the (now-capped) editor doesn't need instead of the two staying locked to a 50/50 split forever.

### Speed comparison popup

Hovering a Pokémon in the Speed Tiers column opens a popup comparing its expected Speed against whichever Pokémon you're currently editing:

- **Ally** column — your real EVs, nature, and currently-held item, read straight from the set editor.
- **Foe** column — the hovered species' base Speed stat plus its single most common EV spread and nature, from Pikalytics. Deliberately never includes an item: Pikalytics' "most common item" is a population statistic about the whole spread's usage, not a known fact about a specific build, so it's never guessed into this baseline — item hypotheticals live exclusively in the two conditional columns below.
- Both columns go through `TeambuilderRoom.prototype.getStat`, the exact method Showdown's own Stats/EV panel uses to compute the number it displays — not a hand-rolled formula. (Pokemon Champions turned out to use a different stat formula than mainline games — `floor((base + EV + 20) × nature)`, EVs running 0–32, no level or IVs involved at all — reusing the real method sidesteps needing to have gotten that right by hand.)
- Nine scenario rows: a baseline, then Tailwind / paralysis / a −1 stage / a −2 stage, each applied to one side at a time (never combined).
- Two further columns, shown only when relevant and never replacing the base Foe column (a Pokémon holding a Mega Stone can't also be holding Choice Scarf, so the base column's own identity never changes): **Mega** — shown when a Mega Stone's usage crosses a threshold, using the Mega forme's own real sprite and base stat (from Showdown's Dex, since Pikalytics tracks Mega usage under the base species — see the Pikalytics sidebar section above) — and **Scarf**, the same idea for Choice Scarf. Both are badged with the real item icon plus their actual usage percentage in a small pixel font, so a borderline case is always visible to judge for yourself rather than hidden behind a threshold you can't see.

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
- **Tooltip** is a standalone floating overlay (`#cf-tooltipwrapper`), never inserted into the results DOM, positioned via `getBoundingClientRect` — shared, not duplicated, between the custom-filter match tooltip and the Speed comparison popup below, since both are just pre-built HTML strings handed to the same show/position/hide logic.

The teambuilder sidebar and Pikalytics data follow the same "patch, don't replace" philosophy:

- **Sidebar layout** works by capping `#room-teambuilder` itself to a fixed max width (plain CSS `max-width`, which clamps the final rendered box regardless of which declaration actually won the `width` property — no `!important` fight needed for that part) and docking a genuine DOM sibling — never a fake Showdown `Room`/tab — in the freed space. In split mode the sidebar's own `left` is `min(50%, <the same max-width>)`, so it always starts exactly where the room's real right edge lands, absorbing everything the capped room doesn't need on a wide monitor instead of a flat, wasteful 50/50 split.
- **Split state** is re-evaluated on window resize and by wrapping four Showdown methods (`app.updateLayout`, `TeambuilderRoom.prototype.update`/`updateSetTop`/`updatePokemonSprite`) that each catch a different way the edited Pokémon can change without the others firing.
- **Pikalytics data** is fetched client-side (`src/pikalytics.js`) via the same `/api/p/{month}/{slug}-{cutoff}/{species}` endpoint pikalytics.com's own per-Pokémon pages use, against a small, explicit format→slug allowlist (see the Pikalytics sidebar section above) rather than guessing at every format Pikalytics happens to have a similarly-named slug for.
- **Top-20 usage list** (`src/pikalytics.js`'s `getTopUsageList`) comes from Pikalytics' bulk `/api/l/{month}/{slug}-{cutoff}` endpoint purely for its rank-ordered name list — confirmed live that every entry past #1 is otherwise missing its own move/item/spread data — then each of the top 20 names is looked up through the same cached per-species path `getSpeciesData` already uses, so it costs no new request shape, just more of the existing one.
- **Speed math** (`src/content.js`) always goes through `TeambuilderRoom.prototype.getStat`, never a reimplemented formula — for the currently-edited Pokémon directly, and for a hovered Pikalytics entry via a synthetic `{species, evs, nature, ivs, level}` object built from its most-common spread. Tailwind/paralysis/stat-stage/Choice Scarf/Iron Ball are applied afterward as plain multipliers.
- **Options/settings**: `src/content.js` runs in the page's MAIN world (needed to see Showdown's own globals) and has no access to `chrome.storage`. A separate isolated-world script, `src/settings-bridge.js`, reads the setting and hands it to `content.js` via a DOM attribute on `<html>` — the one thing both JS realms share.

See `src/move-data.js` for the filter definitions, `src/pikalytics.js` for the Pikalytics client/cache, and `src/content.js` for the patching logic; all are commented throughout.

## License

MIT
