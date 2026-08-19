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
	normalizeMoveRowId, cycleSpeedOp, speedFilterActive, passesSpeedFilter, rawPrefixLengthForIdLength,
	pikaSectionHTML, pikaRowAttrs, pikaRowDivHTML, iconOrSpacer,
	buildMovesSection, buildAbilitiesSection, buildNaturesSection, buildItemsSection,
	buildSpreadsSection, buildTeammatesSection,
} = require('../src/content.js');

/** Minimal window.Dex stand-in for the icon-rendering branches in the Pikalytics sidebar
 *  section builders below — real Dex.getTypeIcon/getItemIcon/getPokemonIcon all return some
 *  non-empty HTML string, so a fixed non-empty stand-in is enough to exercise the "there is an
 *  icon" branch without pulling in the real Dex implementation. */
function mockDex() {
	window.Dex = {
		getTypeIcon: (type) => `<img class="type-icon" alt="${type}">`,
		getItemIcon: (item) => `background:url(${item})`,
		getPokemonIcon: (species) => `background:url(${species})`,
	};
}

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

describe('rawPrefixLengthForIdLength', () => {
	it('returns the same length for a single-word label with no stripped characters', () => {
		expect(rawPrefixLengthForIdLength('Priority', 'priorit'.length)).toBe('priorit'.length);
	});

	it('skips a space when mapping a toID-character count back onto the raw label', () => {
		// toID('Hazard Removal') === 'hazardremoval'; typing 'hazardr' (7 id-chars) should
		// bold "Hazard R" (8 raw chars — the space between the words doesn't count).
		expect(rawPrefixLengthForIdLength('Hazard Removal', 7)).toBe(8);
	});

	it('skips punctuation the same way', () => {
		// toID('Ball/Bomb') === 'ballbomb'; typing 'ballb' (5 id-chars) should bold "Ball/B"
		// (6 raw chars — the slash doesn't count).
		expect(rawPrefixLengthForIdLength('Ball/Bomb', 5)).toBe(6);
	});

	it('returns 0 for a zero-length match', () => {
		expect(rawPrefixLengthForIdLength('Hazard Removal', 0)).toBe(0);
	});

	it('returns the full label length when idLength reaches every id-character in it', () => {
		expect(rawPrefixLengthForIdLength('Hazard Removal', 'hazardremoval'.length)).toBe('Hazard Removal'.length);
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

describe('pikaSectionHTML', () => {
	it('wraps escaped title and pre-built row markup in the section shell', () => {
		expect(pikaSectionHTML('A & B', '<div>rows</div>')).toBe(
			'<div class="cf-pika-section"><h3 class="cf-pika-header">A &amp; B</h3>' +
			'<div class="cf-pika-rows"><div>rows</div></div></div>'
		);
	});
});

describe('pikaRowAttrs', () => {
	it('is clickable with a data-cf-pika-action/value pair when not disabled', () => {
		const { cls, attrs } = pikaRowAttrs('move', 'Fake Out', false, false);
		expect(cls).toBe('cf-pika-row cf-pika-row-clickable');
		expect(attrs).toBe(' data-cf-pika-action="move" data-cf-pika-value="Fake Out"');
	});

	it('adds the equipped class on top of clickable, without dropping it', () => {
		const { cls } = pikaRowAttrs('move', 'Fake Out', true, false);
		expect(cls).toBe('cf-pika-row cf-pika-row-clickable cf-pika-row-equipped');
	});

	it('is disabled with no data attributes at all when disabled', () => {
		const { cls, attrs } = pikaRowAttrs('move', 'Fake Out', false, true);
		expect(cls).toBe('cf-pika-row cf-pika-row-disabled');
		expect(attrs).toBe('');
	});

	it('escapes the value written into the data attribute', () => {
		const { attrs } = pikaRowAttrs('move', 'Fake Out & Friends', false, false);
		expect(attrs).toBe(' data-cf-pika-action="move" data-cf-pika-value="Fake Out &amp; Friends"');
	});
});

describe('pikaRowDivHTML', () => {
	it('assembles the icon/name/pct cells inside the given class/attrs wrapper', () => {
		expect(pikaRowDivHTML(
			'cf-pika-row cf-pika-row-clickable',
			' data-cf-pika-action="move" data-cf-pika-value="Fake Out"',
			'<i>icon</i>', 'Fake Out', '80%'
		)).toBe(
			'<div class="cf-pika-row cf-pika-row-clickable" data-cf-pika-action="move" data-cf-pika-value="Fake Out">' +
			'<i>icon</i><span class="cf-pika-name">Fake Out</span><span class="cf-pika-pct">80%</span></div>'
		);
	});

	it('renders cleanly with empty icon/attrs strings (the no-icon sections)', () => {
		expect(pikaRowDivHTML('cf-pika-row', '', '', 'Intimidate', '100%')).toBe(
			'<div class="cf-pika-row"><span class="cf-pika-name">Intimidate</span><span class="cf-pika-pct">100%</span></div>'
		);
	});
});

describe('iconOrSpacer', () => {
	it('passes real icon HTML through unchanged', () => {
		expect(iconOrSpacer('<img src="x.png">')).toBe('<img src="x.png">');
	});

	it('falls back to the spacer placeholder for empty/falsy input', () => {
		expect(iconOrSpacer('')).toBe('<span class="cf-pika-icon-spacer"></span>');
	});
});

describe('buildMovesSection', () => {
	afterEach(() => { delete window.Dex; });

	it('shows the empty-state message when mon has no moves', () => {
		expect(buildMovesSection({}, { curSet: {} })).toContain('No move data.');
	});

	it('renders a clickable row with a type icon and usage percent', () => {
		mockDex();
		const mon = { moves: [{ move: 'Fake Out', type: 'Normal', percent: '80.0' }] };
		const html = buildMovesSection(mon, { curSet: { moves: [] } });
		expect(html).toContain('cf-pika-row-clickable');
		expect(html).toContain('data-cf-pika-action="move" data-cf-pika-value="Fake Out"');
		expect(html).toContain('<img class="type-icon" alt="Normal">');
		expect(html).toContain('Fake Out');
		expect(html).toContain('80.0%');
	});

	it('falls back to the spacer icon when a move has no type', () => {
		const mon = { moves: [{ move: 'Struggle', percent: '1.0' }] };
		const html = buildMovesSection(mon, { curSet: { moves: [] } });
		expect(html).toContain('cf-pika-icon-spacer');
	});

	it('highlights a move already on the set as equipped and keeps it clickable even when the set is full', () => {
		const mon = { moves: [{ move: 'Fake Out', percent: '80.0' }] };
		const set = { moves: ['Fake Out', 'Ice Shard', 'Aqua Jet', 'Tackle'] };
		const html = buildMovesSection(mon, { curSet: set });
		expect(html).toContain('cf-pika-row-equipped');
		expect(html).toContain('cf-pika-row-clickable');
		expect(html).not.toContain('cf-pika-row-disabled');
	});

	it('disables a move NOT on the set once all 4 slots are filled with other moves', () => {
		const mon = { moves: [{ move: 'Ice Shard', percent: '30.0' }] };
		const set = { moves: ['Fake Out', 'Aqua Jet', 'Tackle', 'Toxic'] };
		const html = buildMovesSection(mon, { curSet: set });
		expect(html).toContain('cf-pika-row-disabled');
		expect(html).not.toContain('data-cf-pika-action');
	});
});

describe('buildAbilitiesSection', () => {
	it('shows the empty-state message when there is no ability data', () => {
		expect(buildAbilitiesSection({}, { curSet: {} })).toContain('No ability data.');
	});

	it('filters out zero-percent abilities, falling back to the empty state if none remain', () => {
		const mon = { abilities: [{ ability: 'Rare Ability', percent: '0.0' }] };
		expect(buildAbilitiesSection(mon, { curSet: {} })).toContain('No ability data.');
	});

	it('highlights the ability matching the set\'s current ability, and is always clickable', () => {
		const mon = { abilities: [{ ability: 'Intimidate', percent: '100.0' }] };
		const html = buildAbilitiesSection(mon, { curSet: { ability: 'intimidate' } });
		expect(html).toContain('cf-pika-row-equipped');
		expect(html).toContain('data-cf-pika-action="ability" data-cf-pika-value="Intimidate"');
	});
});

describe('buildNaturesSection', () => {
	it('shows the empty-state message when there is no nature or spread data', () => {
		expect(buildNaturesSection({}, { curSet: {} })).toContain('No nature data.');
	});

	it('uses the natures array directly when present', () => {
		const mon = { natures: [{ nature: 'Jolly', percent: 60 }] };
		const html = buildNaturesSection(mon, { curSet: {} });
		expect(html).toContain('Jolly');
		expect(html).toContain('60.0%');
	});

	it('derives natures from spreads by summing percentages when natures is missing, sorted descending', () => {
		const mon = {
			spreads: [
				{ nature: 'Jolly', percent: '15.0' },
				{ nature: 'Jolly', percent: '10.0' },
				{ nature: 'Adamant', percent: '5.0' },
			],
		};
		const html = buildNaturesSection(mon, { curSet: {} });
		expect(html).toContain('25.0%'); // 15.0 + 10.0
		expect(html.indexOf('Jolly')).toBeLessThan(html.indexOf('Adamant'));
	});

	it('highlights the nature matching the set\'s current nature as equipped', () => {
		const mon = { natures: [{ nature: 'Jolly', percent: 60 }] };
		const html = buildNaturesSection(mon, { curSet: { nature: 'jolly' } });
		expect(html).toContain('cf-pika-row-equipped');
	});
});

describe('buildItemsSection', () => {
	afterEach(() => { delete window.Dex; });

	it('shows the empty-state message when there is no item data', () => {
		expect(buildItemsSection({}, { curSet: {} })).toContain('No item data.');
	});

	it('renders an item icon when window.Dex is available', () => {
		mockDex();
		const mon = { items: [{ item: 'Choice Scarf', percent: '20.0' }] };
		const html = buildItemsSection(mon, { curSet: {} });
		expect(html).toContain('class="itemicon"');
		expect(html).toContain('Choice Scarf');
	});

	it('falls back to the spacer icon when window.Dex is unavailable', () => {
		const mon = { items: [{ item: 'Choice Scarf', percent: '20.0' }] };
		const html = buildItemsSection(mon, { curSet: {} });
		expect(html).toContain('cf-pika-icon-spacer');
	});

	it('highlights the item matching the set\'s current item as equipped', () => {
		const mon = { items: [{ item: 'Choice Scarf', percent: '20.0' }] };
		const html = buildItemsSection(mon, { curSet: { item: 'choicescarf' } });
		expect(html).toContain('cf-pika-row-equipped');
	});
});

describe('buildSpreadsSection', () => {
	it('shows the empty-state message when there is no spread data', () => {
		expect(buildSpreadsSection({})).toContain('No spread data.');
	});

	it('omits the Nature column entirely when no spread carries one', () => {
		const mon = { spreads: [{ ev: '4/236/0/0/76/188', percent: '15.0' }] };
		expect(buildSpreadsSection(mon)).not.toContain('cf-spread-nature');
	});

	it('includes a Nature column when at least one spread has one', () => {
		const mon = { spreads: [{ nature: 'Jolly', ev: '4/236/0/0/76/188', percent: '15.0' }] };
		const html = buildSpreadsSection(mon);
		expect(html).toContain('cf-spread-nature');
		expect(html).toContain('Jolly');
	});

	it('splits the EV string into one cell per stat', () => {
		const mon = { spreads: [{ ev: '4/236/0/0/76/188', percent: '15.0' }] };
		const html = buildSpreadsSection(mon);
		expect((html.match(/<td>/g) || []).length).toBe(6);
	});
});

describe('buildTeammatesSection', () => {
	afterEach(() => { delete window.Dex; delete window.CF_Pikalytics; });

	it('shows the empty-state message when there is no teammate data', () => {
		expect(buildTeammatesSection({}, { curSetList: [] })).toContain('No teammate data.');
	});

	it('prefers percent, then rank, then 1-based list position for the displayed usage figure', () => {
		const mon = {
			team: [
				{ pokemon: 'Rillaboom', percent: '25.0' },
				{ pokemon: 'Landorus-Therian', rank: 5 },
				{ pokemon: 'Flutter Mane' }, // neither -> falls back to its position, #3
			],
		};
		const html = buildTeammatesSection(mon, { curSetList: [] });
		expect(html).toContain('25.0%');
		expect(html).toContain('#5');
		expect(html).toContain('#3');
	});

	it('highlights and disables a teammate already on the team, even with room to spare', () => {
		const mon = { team: [{ pokemon: 'Rillaboom', percent: '25.0' }] };
		const tbRoom = { curSetList: [{ species: 'Rillaboom' }], curTeam: { capacity: 6 } };
		const html = buildTeammatesSection(mon, tbRoom);
		expect(html).toContain('cf-pika-row-equipped');
		expect(html).toContain('cf-pika-row-disabled');
		expect(html).not.toContain('data-cf-pika-action');
	});

	it('disables (without the equipped look) a teammate suggestion once the team is full', () => {
		const mon = { team: [{ pokemon: 'Rillaboom', percent: '25.0' }] };
		const tbRoom = { curSetList: [0, 1, 2, 3, 4, 5].map((i) => ({ species: 'Mon' + i })), curTeam: { capacity: 6 } };
		const html = buildTeammatesSection(mon, tbRoom);
		expect(html).toContain('cf-pika-row-disabled');
		expect(html).not.toContain('cf-pika-row-equipped');
	});

	it('leaves a teammate suggestion clickable when the team has room and lacks it', () => {
		const mon = { team: [{ pokemon: 'Rillaboom', percent: '25.0' }] };
		const tbRoom = { curSetList: [{ species: 'Landorus-Therian' }], curTeam: { capacity: 6 } };
		const html = buildTeammatesSection(mon, tbRoom);
		expect(html).toContain('cf-pika-row-clickable');
		expect(html).toContain('data-cf-pika-action="teammate" data-cf-pika-value="Rillaboom"');
	});
});
