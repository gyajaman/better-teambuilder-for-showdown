/**
 * Unit tests for the pure, DOM/Showdown-independent helper functions in src/content.js.
 *
 * content.js is a plain content script (no bundler, no ES module syntax) that runs its whole
 * feature set inside one big IIFE. It exposes these specific functions to Node via a test-only
 * `module.exports` guard near the top of that IIFE (see the comment there) — everything else in
 * the file (DOM patching, event wiring, Showdown-global monkey-patches) only makes sense on a
 * live Showdown page and isn't exercised here.
 */
const {
	escapeHTML, toIDSafe, curSetHasMove, curSetMovesFull, baseSpeciesID,
	curTeamHasSpecies, curTeamFull, parseEVs, natureModifierHTML, speedNatureIndicator,
	formatSpeedEvText, speedStageMultiplier, applySpeedModifiers, speedCmpTooltipWidthClass,
	normalizeMoveRowId, cycleSpeedOp, speedFilterActive, passesSpeedFilter,
} = require('../src/content.js');

describe('escapeHTML', () => {
	it('escapes the five HTML-significant characters', () => {
		expect(escapeHTML('<b>"Fake Out" & Friends</b>'))
			.toBe('&lt;b&gt;&quot;Fake Out&quot; &amp; Friends&lt;/b&gt;');
	});

	it('returns an empty string for null/undefined rather than the literal word', () => {
		expect(escapeHTML(null)).toBe('');
		expect(escapeHTML(undefined)).toBe('');
	});

	it('stringifies non-string input', () => {
		expect(escapeHTML(42)).toBe('42');
	});
});

describe('toIDSafe', () => {
	it('lowercases and strips non-alphanumeric characters, matching Showdown\'s own toID', () => {
		expect(toIDSafe('Choice Scarf')).toBe('choicescarf');
		expect(toIDSafe('Flutter Mane')).toBe('fluttermane');
		expect(toIDSafe("King's Rock")).toBe('kingsrock');
	});
});

describe('curSetHasMove', () => {
	it('finds a move by name regardless of case/spacing', () => {
		const set = { moves: ['Fake Out', 'Ice Shard', '', undefined] };
		expect(curSetHasMove(set, 'fakeout')).toBe(true);
		expect(curSetHasMove(set, 'Ice Shard')).toBe(true);
	});

	it('returns false when the move is absent, or the set/moves array is missing', () => {
		expect(curSetHasMove({ moves: ['Fake Out'] }, 'Tackle')).toBe(false);
		expect(curSetHasMove({}, 'Tackle')).toBe(false);
		expect(curSetHasMove(null, 'Tackle')).toBe(false);
	});
});

describe('curSetMovesFull', () => {
	it('is true only when all 4 move slots (0-3) are filled', () => {
		expect(curSetMovesFull({ moves: ['A', 'B', 'C', 'D'] })).toBe(true);
	});

	it('is false when a slot is empty, missing, or undefined — checked by index, not length', () => {
		expect(curSetMovesFull({ moves: ['A', 'B', 'C', ''] })).toBe(false);
		expect(curSetMovesFull({ moves: ['A', 'B'] })).toBe(false);
		expect(curSetMovesFull({ moves: ['A', 'B', 'C', undefined] })).toBe(false);
	});

	it('is false when there is no set or no moves array', () => {
		expect(curSetMovesFull(null)).toBe(false);
		expect(curSetMovesFull({})).toBe(false);
	});
});

describe('baseSpeciesID', () => {
	afterEach(() => {
		delete window.CF_Pikalytics;
	});

	it('falls back to plain toIDSafe when CF_Pikalytics is unavailable', () => {
		expect(baseSpeciesID('Ninetales-Alola')).toBe('ninetalesalola');
	});

	it('delegates to CF_Pikalytics.resolveQuerySpecies when present (Mega/Primal collapsing)', () => {
		window.CF_Pikalytics = { resolveQuerySpecies: () => 'Blastoise' };
		expect(baseSpeciesID('Blastoise-Mega')).toBe('blastoise');
	});
});

describe('curTeamHasSpecies', () => {
	afterEach(() => {
		delete window.CF_Pikalytics;
	});

	it('matches an existing teammate by base species id', () => {
		const tbRoom = { curSetList: [{ species: 'Landorus-Therian' }, { species: 'Rillaboom' }] };
		expect(curTeamHasSpecies(tbRoom, 'Rillaboom')).toBe(true);
		expect(curTeamHasSpecies(tbRoom, 'Urshifu')).toBe(false);
	});

	it('collapses Mega formes so a team with the base species greys out the Mega suggestion', () => {
		window.CF_Pikalytics = { resolveQuerySpecies: (n) => n.replace('-Mega', '') };
		const tbRoom = { curSetList: [{ species: 'Blastoise' }] };
		expect(curTeamHasSpecies(tbRoom, 'Blastoise-Mega')).toBe(true);
	});

	it('treats a missing curSetList as an empty team', () => {
		expect(curTeamHasSpecies({}, 'Rillaboom')).toBe(false);
	});
});

describe('curTeamFull', () => {
	it('is full once curSetList reaches the team\'s capacity', () => {
		const tbRoom = { curSetList: new Array(6).fill({}), curTeam: { capacity: 6 } };
		expect(curTeamFull(tbRoom)).toBe(true);
	});

	it('defaults capacity to 6 when curTeam/capacity is missing', () => {
		expect(curTeamFull({ curSetList: new Array(6).fill({}) })).toBe(true);
		expect(curTeamFull({ curSetList: new Array(5).fill({}) })).toBe(false);
	});

	it('is false for an empty/missing team', () => {
		expect(curTeamFull({})).toBe(false);
	});
});

describe('parseEVs', () => {
	it('parses a slash-separated HP/Atk/Def/SpA/SpD/Spe string in order', () => {
		expect(parseEVs('4/0/0/28/0/0')).toEqual({ hp: 4, atk: 0, def: 0, spa: 28, spd: 0, spe: 0 });
	});

	it('clamps every value to the Champions VGC 0-32 EV range', () => {
		expect(parseEVs('300/-5/32/0/0/0')).toEqual({ hp: 32, atk: 0, def: 32, spa: 0, spd: 0, spe: 0 });
	});

	it('treats a missing/non-numeric slot as 0 rather than throwing', () => {
		expect(parseEVs('4///28//')).toEqual({ hp: 4, atk: 0, def: 0, spa: 28, spd: 0, spe: 0 });
		expect(parseEVs('')).toEqual({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 });
	});
});

describe('natureModifierHTML', () => {
	afterEach(() => {
		delete window.BattleNatures;
	});

	it('renders the (+Stat/-Stat) annotation for a boosting nature', () => {
		window.BattleNatures = { Timid: { plus: 'spe', minus: 'atk' } };
		expect(natureModifierHTML('Timid')).toBe(' <span class="cf-pika-nature-mod">(+Spe/-Atk)</span>');
	});

	it('renders nothing for a neutral nature (no plus/minus)', () => {
		window.BattleNatures = { Hardy: {} };
		expect(natureModifierHTML('Hardy')).toBe('');
	});

	it('degrades to no annotation when BattleNatures is unavailable', () => {
		expect(natureModifierHTML('Timid')).toBe('');
	});
});

describe('speedNatureIndicator', () => {
	afterEach(() => {
		delete window.BattleNatures;
	});

	it('returns + for a Speed-boosting nature, − for a Speed-lowering one, empty otherwise', () => {
		window.BattleNatures = {
			Timid: { plus: 'spe', minus: 'atk' },
			Brave: { plus: 'atk', minus: 'spe' },
			Hardy: {},
		};
		expect(speedNatureIndicator('Timid')).toBe('+');
		expect(speedNatureIndicator('Brave')).toBe('−');
		expect(speedNatureIndicator('Hardy')).toBe('');
	});

	it('returns empty when BattleNatures or the named nature is unavailable', () => {
		expect(speedNatureIndicator('Timid')).toBe('');
	});
});

describe('formatSpeedEvText', () => {
	it('shows just the EV count when there is no nature indicator', () => {
		expect(formatSpeedEvText(32, '')).toBe('32 EV');
	});

	it('appends the indicator after a slash when present', () => {
		expect(formatSpeedEvText(32, '+')).toBe('32 EV / +');
		expect(formatSpeedEvText(0, '−')).toBe('0 EV / −');
	});
});

describe('speedStageMultiplier', () => {
	it('is 1 for stage 0 (or falsy)', () => {
		expect(speedStageMultiplier(0)).toBe(1);
	});

	it('matches the standard Pokémon stage-multiplier table for negative stages', () => {
		expect(speedStageMultiplier(-1)).toBeCloseTo(2 / 3);
		expect(speedStageMultiplier(-2)).toBe(0.5);
	});

	it('matches the standard table for positive stages too', () => {
		expect(speedStageMultiplier(1)).toBe(1.5);
		expect(speedStageMultiplier(2)).toBe(2);
	});
});

describe('applySpeedModifiers', () => {
	it('returns the base stat unmodified with no item/status/stage/Tailwind', () => {
		expect(applySpeedModifiers(100, null, {})).toBe(100);
	});

	it('applies Choice Scarf\'s 1.5x multiplier', () => {
		expect(applySpeedModifiers(100, 'Choice Scarf', {})).toBe(150);
	});

	it('applies Iron Ball\'s 0.5x multiplier', () => {
		expect(applySpeedModifiers(100, 'Iron Ball', {})).toBe(50);
	});

	it('halves for paralysis and doubles for Tailwind', () => {
		expect(applySpeedModifiers(100, null, { paralyzed: true })).toBe(50);
		expect(applySpeedModifiers(100, null, { tailwind: true })).toBe(200);
	});

	it('applies a negative stage via speedStageMultiplier', () => {
		expect(applySpeedModifiers(100, null, { stage: -1 })).toBe(66); // floor(100 * 2/3)
	});

	it('floors the stage step separately, before combining and flooring the other modifiers — matching the real sim', () => {
		// Real order (see the function's own doc comment, sourced from Showdown's sim/pokemon.ts
		// and sim/battle.ts): stage first, floored on its own — floor(100 * 2/3) = 66 — THEN
		// item/status/field multiply together and floor once more — floor(66 * 1.5) = 99.
		// A single combined floor at the end (the old, wrong behavior) would instead give
		// floor(100 * 1.5 * 2/3) = 100 — off by one from the real engine.
		expect(applySpeedModifiers(100, 'Choice Scarf', { stage: -1 })).toBe(99);
	});

	it('stacks every non-stage modifier into one combined multiplier, floored together', () => {
		// floor(100 * 2/3) = 66 (stage), then floor(66 * 1.5 * 0.5 * 2) = floor(66 * 1.5) = 99.
		expect(applySpeedModifiers(100, 'Choice Scarf', { paralyzed: true, tailwind: true, stage: -1 })).toBe(99);
	});

	it('ignores an item with no known Speed effect', () => {
		expect(applySpeedModifiers(100, 'Leftovers', {})).toBe(100);
	});
});

describe('speedCmpTooltipWidthClass', () => {
	// Regression test: this was a real bug. array[0] is '' (the "no extra columns" case), and
	// '' is falsy — an earlier `array[extraCols] || fallback` implementation wrongly replaced
	// that correct empty-string case with the widest tier, so every tooltip with zero
	// conditional columns (most of them) rendered stretched to the widest CSS class with
	// nothing on the right side to fill it.
	it('returns no extra class for zero conditional columns, not the widest tier', () => {
		expect(speedCmpTooltipWidthClass(0)).toBe('');
	});

	it('returns the wide/widest/widest2 tiers for 1/2/3 conditional columns', () => {
		expect(speedCmpTooltipWidthClass(1)).toBe(' cf-speedcmp-tooltip-wide');
		expect(speedCmpTooltipWidthClass(2)).toBe(' cf-speedcmp-tooltip-widest');
		expect(speedCmpTooltipWidthClass(3)).toBe(' cf-speedcmp-tooltip-widest2');
	});

	it('clamps to the widest tier rather than returning undefined for an out-of-range count', () => {
		expect(speedCmpTooltipWidthClass(4)).toBe(' cf-speedcmp-tooltip-widest2');
	});
});

describe('normalizeMoveRowId', () => {
	it('passes a plain move id through unchanged', () => {
		expect(normalizeMoveRowId('fakeout')).toBe('fakeout');
	});

	it('strips the _SLOT_ prefix used for a set\'s currently-filled move slot', () => {
		expect(normalizeMoveRowId('_move_fakeout')).toBe('fakeout');
	});

	it('returns empty string for a malformed prefixed id', () => {
		expect(normalizeMoveRowId('_move_')).toBe('');
	});
});

describe('cycleSpeedOp', () => {
	it('cycles > -> < -> off (null) -> > ...', () => {
		expect(cycleSpeedOp('>')).toBe('<');
		expect(cycleSpeedOp('<')).toBe(null);
		expect(cycleSpeedOp(null)).toBe('>');
	});
});

describe('speedFilterActive', () => {
	it('is false with no value typed, regardless of op/eq', () => {
		expect(speedFilterActive({ op: '>', orEqual: true, value: null })).toBe(false);
		expect(speedFilterActive({ op: null, orEqual: false, value: undefined })).toBe(false);
		expect(speedFilterActive({ op: null, orEqual: false, value: NaN })).toBe(false);
	});

	it('is true once a value is set and either an operator or "=" is engaged', () => {
		expect(speedFilterActive({ op: '>', orEqual: false, value: 100 })).toBe(true);
		expect(speedFilterActive({ op: null, orEqual: true, value: 100 })).toBe(true);
	});

	it('is false for a bare value with no operator and no "=" toggle', () => {
		expect(speedFilterActive({ op: null, orEqual: false, value: 100 })).toBe(false);
	});
});

describe('passesSpeedFilter', () => {
	it('passes everything when the row has no base Speed to compare (e.g. a move row)', () => {
		expect(passesSpeedFilter({ op: '>', orEqual: false, value: 100 }, null)).toBe(true);
		expect(passesSpeedFilter({ op: '>', orEqual: false, value: 100 }, undefined)).toBe(true);
	});

	it('treats op=null as exact equality ("=" alone)', () => {
		const sf = { op: null, orEqual: true, value: 100 };
		expect(passesSpeedFilter(sf, 100)).toBe(true);
		expect(passesSpeedFilter(sf, 99)).toBe(false);
	});

	it('handles > and >= via orEqual', () => {
		expect(passesSpeedFilter({ op: '>', orEqual: false, value: 100 }, 100)).toBe(false);
		expect(passesSpeedFilter({ op: '>', orEqual: false, value: 100 }, 101)).toBe(true);
		expect(passesSpeedFilter({ op: '>', orEqual: true, value: 100 }, 100)).toBe(true);
	});

	it('handles < and <= via orEqual', () => {
		expect(passesSpeedFilter({ op: '<', orEqual: false, value: 100 }, 100)).toBe(false);
		expect(passesSpeedFilter({ op: '<', orEqual: false, value: 100 }, 99)).toBe(true);
		expect(passesSpeedFilter({ op: '<', orEqual: true, value: 100 }, 100)).toBe(true);
	});
});
