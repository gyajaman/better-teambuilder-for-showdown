# Better Teambuilder for Showdown!

A Chrome/Firefox extension that adds custom search filters, a Speed stat comparator, a live [Pikalytics](https://pikalytics.com) usage-stats sidebar, a Speed Tiers panel with a head-to-head Speed comparison popup, and — on a blank "Add Pokémon" slot — a usage-ranked Popular column plus a Similar Teams panel of real matching tournament rosters, to the [Pokémon Showdown](https://play.pokemonshowdown.com) teambuilder. Filters are computed from a species' full movepool or ability access, not just a single static field like Showdown's built-in filters.

If this is useful to you, consider [supporting it on Patreon](https://www.patreon.com/cw/yajaman).

## Filters

### Pokémon & Move search

Priority, Redirection, Spread, Wind, Sound, Never Miss, Speed Control, Pivoting, Hazard, Hazard Removal

### Move search only

Ability-synergy filters, useful once a specific Pokémon/ability is locked in:

- **Sharpness** — slicing moves (Sharpness-boosted)
- **Recoil** — moves that damage the user on hit
- **Sheer Force** — damaging moves with a secondary effect
- **Contact** — moves that make contact
- **Punching** — punching moves (Iron Fist-boosted)
- **Biting** — biting moves (Strong Jaw-boosted)
- **Pulse** — pulse moves (Mega Launcher-boosted)
- **Ball/Bomb** — a negative (exclusion) filter that hides ballistic moves, for building around Bulletproof. Renders as a red chip to mark it as an exclusion.

### Pokémon search only

Ability-based filters, matched against a species' declarable abilities rather than its movepool:

- **Negates Intimidate** — abilities that block, reverse, or come out ahead of Intimidate's Attack drop
- **Weather Setter** — abilities that set weather (Drought, Drizzle, Sand Stream, etc.)
- **Terrain Setter** — abilities that set terrain (Electric Surge, Grassy Surge, etc.)

### Speed stat filter

A widget below the native "Sort: …" row in Pokémon search:

- An **operator toggle** cycling through `>`, `<`, and off
- An **`=` toggle** (combinable: `>` + `=` → `>=`, `<` + `=` → `<=`, `=` alone → exactly equal)
- A **number input** for the base Speed threshold

Leave the number blank to keep the filter inactive.

## Pikalytics sidebar

When the window is wide enough, no side room is docked, and a Pokémon is being edited, the teambuilder splits in half and a panel appears alongside it with live Pikalytics usage stats for that Pokémon in the team's current format: Common Moves, Abilities, Items, Natures, Spreads, and Teammates. Data always matches the species and format currently being edited, and shows "No data" rather than stale results when nothing is available. Mega/Primal Pokémon are looked up under their base species, matching how Pikalytics tracks Mega usage.

Format coverage is a deliberate, narrow allowlist — Pokemon Champions VGC 2026 Regulations A and B only:

| Format | Data source |
|---|---|
| Reg A (Bo1) | Ranked ladder |
| Reg A (Bo3) | Tournament |
| Reg B (Bo1) | Ranked ladder |
| Reg B (Bo3) | Tournament |

Any other format shows "No data" rather than guessing at a slug mapping. Results are cached locally for up to 24 hours and refresh automatically when Pikalytics rolls over to a new month.

## Speed Tiers panel

A narrow column docked to the left of the Pikalytics sidebar, listing the top 20 Pokémon by usage in the current format — sprite only, ranked top to bottom, with gold/silver/bronze badges for the top 3.

The teambuilder room itself is capped to a fixed max width regardless of monitor size, so on a wide window the sidebar absorbs whatever room the editor doesn't need instead of staying locked to a 50/50 split.

### Speed comparison popup

Hovering a Pokémon in the Speed Tiers column opens a popup comparing its expected Speed against whichever Pokémon you're currently editing:

- **Ally** column — your real EVs, nature, and currently-held item.
- **Foe** column — the hovered species' base Speed stat plus its single most common EV spread and nature. Never includes an item, since Pikalytics' "most common item" is a population statistic, not a fact about a specific build.
- Nine scenario rows: a baseline, then Tailwind, paralysis, and a −1/−2 stage drop, each applied to one side at a time.
- Conditional columns, shown only when relevant: one **Mega** column per Mega Stone that crosses its usage threshold (a species can have more than one viable Mega Stone), and a **Scarf** column for the same idea with Choice Scarf. Each is badged with the real item icon and its actual usage percentage.

## Add Pokémon screen

The same column and sidebar repurpose themselves when the slot currently open for editing is blank (a fresh "Add Pokémon" click) rather than an existing team member — no recommendations or synthesized advice, just real usage data laid out for you to act on.

### Popular column

The Speed Tiers column relabels itself **Popular** and becomes clickable: click any row to fill the blank slot with that species outright (`TeambuilderRoom.prototype.setPokemon`), the same as picking it from Showdown's own species search.

- Each row's border is colored by how hard your team's existing damaging move types already hit that species — solid green (4×), light green (2×), untinted (neutral or nothing to compare against yet), light red (resisted), dark red (immune) — so a glance down the column shows which popular Pokémon your team already threatens and which it doesn't, without reading any numbers.
- A species commonly built with a Speed-relevant item gets a small corner badge — Choice Scarf, or its most popular Mega Stone — whichever one actually clears its own usage threshold *and* has the higher real usage percent (not "Scarf always wins"); a Mega row also swaps its displayed Speed to the Mega forme's own base stat.
- Hovering a row (without clicking) shows a preview tooltip: base stats, top moves, ability, item, nature, and spread, each with real usage percentages — the same shape of data as the six-section per-species sidebar, just for a Pokémon you haven't added yet.

### Similar Teams panel

Alongside the Popular column, the main sidebar fills with **Similar Teams**: real tournament rosters — sourced from Pikalytics' own bulk Top Teams data, not a synthetic sample — that share at least one species with your current roster, ranked by how many species they share (ties broken by real recorded wins). Each row shows the team's sprites (aligned under the matching Pokémon in your own roster's column order), the author, tournament and placement, and win-loss record.

Hovering a row shows each of that team's Pokémon — sprite, item badge, ability, and top moves — in the same column layout as the row itself. More teams load automatically as you scroll to the bottom.

Shows "No Pokémon on your team yet" until at least one real slot has a species in it, and "No similar teams found yet" if nothing in the format's team pool shares any species with your roster.

## Settings

Click the extension's icon in the toolbar to open its popup, which holds:

- **Auto-close side rooms on load** — closes any chat/side rooms Showdown restores from your last session as soon as the page loads. On by default.
- **Scarf/Mega thresholds** — the minimum Pikalytics usage percent before the Speed comparison popup's conditional Scarf/Mega columns show at all. 5%/15% by default, and adjustable since these are starting guesses rather than researched numbers.

Changes take effect the next time you reload the Showdown tab.

## Usage

### Typed filters

Type a filter's name into the Pokémon or Move search box, the same way you'd type a move/type/ability. A suggestion appears under a **"Custom Filters"** header — click it (or press Enter) to add it as a removable chip in the site's own `Filters: …` row, combinable with native filters. Remove it by clicking the `×` on the chip, or pressing Backspace when the search box is empty.

### Hover tooltip

In Pokémon search, hover a result to see which specific moves or abilities matched each active custom filter. Moves marked **conditional** (e.g. Fake Out) display a yellow `conditional` tag with the condition in a title tooltip.

### Dark mode

All custom UI adapts to Showdown's dark mode automatically.

## Install

1. Clone or download this repo.
2. **Chrome:** Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
   **Firefox:** Go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `manifest.json` in this folder.
3. Open https://play.pokemonshowdown.com and navigate to the teambuilder.

## How it works

A MAIN-world content script patches `DexSearch.prototype` (the teambuilder's search engine) so it recognizes custom filter categories alongside the native ones, reusing the site's own legality checks (`canLearn()`) rather than reimplementing search logic.

- **Movepool filters** walk each category's move list through `canLearn(speciesId, moveId)`.
- **Ability filters** check `species.abilities` membership directly.
- **Speed filter** post-filters `engine.results` against the widget's operator/value state.
- **Filter chips** are folded into the site's own "Filters: …" row by wrapping `BattleSearch.prototype.getFilterText`/`removeFilter`.
- **Tooltips** — both the custom-filter match tooltip and the Speed comparison popup — share a single floating overlay, positioned via `getBoundingClientRect`.

The teambuilder sidebar and Pikalytics data follow the same "patch, don't replace" approach:

- **Sidebar layout** caps `#room-teambuilder` to a fixed max width via CSS and docks a real DOM sibling alongside it, never a fake Showdown `Room`.
- **Split state** is re-evaluated on window resize and on the Showdown methods that can change which Pokémon is being edited.
- **Pikalytics data** is fetched client-side (`src/pikalytics.js`) against a small, explicit format→slug allowlist rather than guessing at unverified slugs. The Similar Teams panel draws on a separate part of that same client — Pikalytics' `/api/topteams/` endpoints, a bulk list of real featured tournament teams plus a per-team detail lookup — entirely distinct from the per-species `/api/p/`/`/api/l/`/`/ai/pokedex/` endpoints the rest of the sidebar uses; see the "Top Teams" section of `pikalytics.js`'s own module comment for the full endpoint shapes and their quirks.
- **Speed math** (`src/content.js`) always goes through `TeambuilderRoom.prototype.getStat`, the same method Showdown's own Stats/EV panel uses, rather than a reimplemented stat formula. Tailwind, paralysis, stat stages, Choice Scarf, and Iron Ball are applied afterward as plain multipliers.
- **Settings**: `src/content.js` runs in the page's MAIN world, which has no access to `chrome.storage`. A separate isolated-world script, `src/settings-bridge.js`, reads settings and hands them to `content.js` via a DOM attribute on `<html>`, since the two worlds don't share a `window`.

See `src/move-data.js` for the filter definitions, `src/pikalytics.js` for the Pikalytics client/cache, and `src/content.js` for the patching logic.

## Development

`npm install` sets up ESLint and [Vitest](https://vitest.dev) (dev-only — nothing here ships to the extension itself) and points git at the versioned `.githooks/` directory so the checks below run locally as well as in CI.

- `npm run lint` — ESLint over `src/`.
- `npm test` — the unit test suite (`test/*.test.js`), covering the pure logic in `content.js`/`pikalytics.js` and `move-data.js`'s data shape. DOM patching and Showdown-global wiring aren't unit-tested, since they only mean anything on a live Showdown page.
- A `pre-push` git hook runs the test suite before every push and blocks it on a failure (skip deliberately with `git push --no-verify`); CI runs lint and tests on every push/PR as a backstop.

## License

MIT
