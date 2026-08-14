# Better Teambuilder for Showdown!

A Chrome extension that adds custom search filters to the [Pokémon Showdown](https://play.pokemonshowdown.com) teambuilder — filters computed from a species' full movepool or ability access, not just a single static field like the site's built-in type/move/ability filters.

## Filters

- **Pokémon & Move search:** Priority, Redirection, Spread, Wind, Sound, Speed Control, Pivoting, Hazard
- **Move search only** (ability-synergy — only useful once a specific ability is locked in): Sharpness, Recoil, Sheer Force, Contact, Punching, Biting, Pulse, Ball/Bomb (a negative filter — hides ballistic moves, for building around Bulletproof)
- **Pokémon search only** (ability-based): Negates Intimidate, Weather Setter, Terrain Setter

## Usage

Type a filter's name into the Pokémon or Move search box, same as you'd type a move/type/ability. A suggestion appears under "Custom Filters" — click it (or press Enter) and it becomes a removable chip in the site's own `Filters: ...` row, combinable with native filters. Hover a result to see which specific move or ability matched.

## Install

1. Clone or download this repo.
2. Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
3. Open https://play.pokemonshowdown.com/teambuilder.

## How it works

A MAIN-world content script patches `DexSearch.prototype` (the teambuilder's search engine) so it recognizes custom filter categories alongside the native ones — reusing the site's own legality checks (`canLearn()`) and rendering rather than reimplementing search logic. See `src/move-data.js` for the filter definitions and `src/content.js` for the patching logic; both are commented throughout.

## License

MIT
