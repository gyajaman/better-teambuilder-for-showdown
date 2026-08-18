# Better Teambuilder for Showdown!

A Chrome/Firefox extension that adds custom search filters, a Speed stat comparator, a live [Pikalytics](https://pikalytics.com) usage-stats sidebar, and a Speed Tiers panel with a head-to-head Speed comparison popup to the [Pokémon Showdown](https://play.pokemonshowdown.com) teambuilder. Filters are computed from a species' full movepool or ability access, not just a single static field like Showdown's built-in filters.

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
- **Pikalytics data** is fetched client-side (`src/pikalytics.js`) against a small, explicit format→slug allowlist rather than guessing at unverified slugs.
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
