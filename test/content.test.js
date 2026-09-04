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
	curTeamHasSpecies, curTeamFull, isBlankSlot, isTeamOverview, parseEVs, natureModifierHTML, speedNatureIndicator,
	formatSpeedEvText, speedStageMultiplier, applySpeedModifiers, speedCmpTooltipWidthClass,
	normalizeMoveRowId, cycleSpeedOp, speedFilterActive, passesSpeedFilter, rawPrefixLengthForIdLength,
	teamDamagingMoveTypes, typeEffectivenessMultiplier, bestTeamCoverageMultiplier, coverageTierClass,
	topSpeedItemBadge, aggregateTopTeams, curRosterSpeciesOrder, alignSimilarTeamPokemon, ordinalLabel,
	pikaSectionHTML, pikaRowAttrs, pikaRowDivHTML, iconOrSpacer,
	buildMovesSection, buildAbilitiesSection, buildNaturesSection, buildItemsSection,
	buildSpreadsSection, buildTeammatesSection,
	computeSpeedSpectrumEntries, computeSpeedSpectrumDomain, resolveSpeedSpectrumSpecies,
	assignSpeedSpectrumLanes, buildSpeedSpectrumHTML,
	ALL_TYPES, DEFENSIVE_ABILITY_IMMUNITIES, applyDefensiveAbility, resolveMemberAbility,
	computeTeamDefensiveProfile, defensiveTierClass, defensiveCellText, buildTeamDefensiveProfileHTML,
	buildMemberThreatRows, isDamagingMove, movePower, effectiveMoveType, stabAdjustedPower, computeThreatMoveReasons, computeThreatSpeedReason,
	threatHasMoveOfCategory,
	computeThreatReasons,
	computeThreatOffense, computeMemberDefense,
	buildTeamThreatCounterHTML, buildTeamThreatMemberRowHTML, buildTeamThreatsSectionHTML,
	buildTeamThreatReasonCellHTML, buildTeamThreatTooltipHTML,
	buildSimilarTeamRowHTML, buildSimilarTeamsSectionHTML, buildSimilarTeamTooltipHTML,
	buildSpeciesPreviewTooltipHTML, patchDexSearch,
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

/** Minimal window.Dex.moves/types/items stand-in for teamDamagingMoveTypes/
 *  typeEffectivenessMultiplier/topSpeedItemBadge below — a tiny hand-picked slice of the real
 *  move/type/item tables (not the full Dex) is enough to exercise the multiplier math and
 *  badge selection without pulling in the real data files. */
function mockBattleDex() {
	const moves = {
		flareblitz: { exists: true, type: 'Fire', category: 'Physical' },
		fakeout: { exists: true, type: 'Normal', category: 'Physical' },
		partingshot: { exists: true, type: 'Dark', category: 'Status' },
		earthquake: { exists: true, type: 'Ground', category: 'Physical' },
	};
	const types = {
		water: { exists: true, damageTaken: { Electric: 1, Fire: 2, Water: 2, Ground: 0 } },
		fire: { exists: true, damageTaken: { Water: 1, Fire: 2, Ground: 1 } },
		flying: { exists: true, damageTaken: { Ground: 3, Electric: 1 } },
	};
	const items = {
		'choice scarf': { exists: true, name: 'Choice Scarf' },
		'blastoisinite': { exists: true, name: 'Blastoisinite', megaStone: { Blastoise: 'Blastoise-Mega' } },
	};
	const species = {
		'blastoise-mega': {
			exists: true, name: 'Blastoise-Mega', battleOnly: true, baseSpecies: 'Blastoise',
			baseStats: { hp: 79, atk: 103, def: 120, spa: 135, spd: 115, spe: 78 },
		},
	};
	window.Dex = {
		getPokemonIcon: (species) => `background:url(${species})`,
		getItemIcon: (item) => `background:url(${item})`,
		moves: { get: (name) => moves[toIDSafe(name)] || { exists: false } },
		types: { get: (name) => types[String(name).toLowerCase()] || { exists: false } },
		items: { get: (name) => items[String(name).toLowerCase()] || { exists: false } },
		species: { get: (name) => species[String(name).toLowerCase()] || { exists: false } },
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

	it('returns the wide/widest/widest2/widest3 tiers for 1/2/3/4 conditional columns', () => {
		expect(speedCmpTooltipWidthClass(1)).toBe(' cf-speedcmp-tooltip-wide');
		expect(speedCmpTooltipWidthClass(2)).toBe(' cf-speedcmp-tooltip-widest');
		expect(speedCmpTooltipWidthClass(3)).toBe(' cf-speedcmp-tooltip-widest2');
		expect(speedCmpTooltipWidthClass(4)).toBe(' cf-speedcmp-tooltip-widest3');
	});

	it('clamps to the widest tier rather than returning undefined for an out-of-range count', () => {
		expect(speedCmpTooltipWidthClass(5)).toBe(' cf-speedcmp-tooltip-widest3');
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

describe('patchDexSearch — DexSearch.prototype.find idempotency', () => {
	beforeEach(() => {
		window.toID = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
		window.CF_MOVE_CATEGORIES = {};
		// Defined fresh per test (not hoisted to describe scope) so each test's
		// patchDexSearch() call wraps a pristine, unpatched prototype — patchDexSearch
		// wraps whatever DexSearch.prototype.find already is, so reusing one class
		// across tests would compound a fresh wrapper on top of the previous test's.
		//
		// Minimal stand-in for the real DexSearch: reproduces just the one contract
		// this regression test cares about — the real find() (battle-dex-search.ts)
		// short-circuits to `return false` without touching `this.results` when the
		// query hasn't changed and results are already populated. `this.results`
		// starts as a single native ['sortpokemon'] row, the same row
		// applyCustomFilters docks a ['cf-speedrow'] after.
		window.DexSearch = class FakeDexSearch {
			constructor() {
				this.query = '';
				this.results = null;
				this.typedSearch = { searchType: 'pokemon' };
				this.__cfFilters = [];
			}
			find(query) {
				const q = window.toID(query);
				if (this.query === q && this.results) return false;
				this.query = q;
				this.results = [['sortpokemon']];
				return true;
			}
		};
		patchDexSearch();
	});

	afterEach(() => {
		delete window.toID;
		delete window.CF_MOVE_CATEGORIES;
		delete window.DexSearch;
	});

	it('injects exactly one cf-speedrow after a real (query-changing) find', () => {
		const engine = new window.DexSearch();
		engine.find('pikachu');
		const speedRows = engine.results.filter((row) => row[0] === 'cf-speedrow');
		expect(speedRows.length).toBe(1);
	});

	it('does not duplicate the injected cf-speedrow when find() is called again with the same query', () => {
		const engine = new window.DexSearch();
		engine.find('pikachu');
		engine.find('pikachu'); // same query — the real DexSearch.find no-ops on this call
		const speedRows = engine.results.filter((row) => row[0] === 'cf-speedrow');
		expect(speedRows.length).toBe(1); // was 2 before the `if (changed)` guard
	});

	it('still re-processes results when the query genuinely changes', () => {
		const engine = new window.DexSearch();
		engine.find('pikachu');
		engine.find('raichu');
		const speedRows = engine.results.filter((row) => row[0] === 'cf-speedrow');
		expect(speedRows.length).toBe(1);
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

describe('computeSpeedSpectrumEntries', () => {
	it('skips slots with no species (blank slots, the extra empty slot Showdown appends)', () => {
		const tbRoom = {
			curSetList: [{ species: 'Incineroar', name: '' }, { species: '' }, null],
			getStat: () => 100,
		};
		const entries = computeSpeedSpectrumEntries(tbRoom);
		expect(entries).toHaveLength(1);
		expect(entries[0].species).toBe('Incineroar');
	});

	it('falls back to species for the display name when there is no nickname', () => {
		const tbRoom = { curSetList: [{ species: 'Incineroar', name: '' }], getStat: () => 100 };
		expect(computeSpeedSpectrumEntries(tbRoom)[0].name).toBe('Incineroar');
	});

	it('prefers a real nickname when the set has one', () => {
		const tbRoom = { curSetList: [{ species: 'Incineroar', name: 'Big Cat' }], getStat: () => 100 };
		expect(computeSpeedSpectrumEntries(tbRoom)[0].name).toBe('Big Cat');
	});

	it('reads the real Speed stat via tbRoom.getStat, the same method every other Speed number in this file uses', () => {
		const set = { species: 'Ninjask' };
		const getStat = vi.fn((stat, s) => (stat === 'spe' && s === set ? 188 : 0));
		const tbRoom = { curSetList: [set], getStat };
		expect(computeSpeedSpectrumEntries(tbRoom)[0].speed).toBe(188);
		expect(getStat).toHaveBeenCalledWith('spe', set);
	});

	it('resolves a Mega-Stone holder to the Mega forme for species/name/speed alike', () => {
		mockBattleDex();
		const set = { species: 'Blastoise', item: 'Blastoisinite', name: '' };
		const getStat = vi.fn((stat, s) => (s.species === 'Blastoise-Mega' ? 78 : -1));
		const tbRoom = { curSetList: [set], getStat };
		expect(computeSpeedSpectrumEntries(tbRoom)).toEqual([{ species: 'Blastoise-Mega', name: 'Blastoise-Mega', speed: 78, hasScarf: false, hasIronBall: false }]);
		delete window.Dex;
	});

	it('applies a real held Choice Scarf to the plotted speed — this is what makes the dot actually move when one is equipped', () => {
		const set = { species: 'Incineroar', item: 'Choice Scarf' };
		const tbRoom = { curSetList: [set], getStat: () => 100 };
		const entry = computeSpeedSpectrumEntries(tbRoom)[0];
		expect(entry.speed).toBe(150); // floor(100 * 1.5)
		expect(entry.hasScarf).toBe(true);
	});

	it('applies a real held Iron Ball to the plotted speed too, via the same modifier path', () => {
		const set = { species: 'Incineroar', item: 'Iron Ball' };
		const tbRoom = { curSetList: [set], getStat: () => 100 };
		const entry = computeSpeedSpectrumEntries(tbRoom)[0];
		expect(entry.speed).toBe(50); // floor(100 * 0.5)
		expect(entry.hasScarf).toBe(false);
	});

	it('leaves speed unmodified and hasScarf false with no held item', () => {
		const set = { species: 'Incineroar' };
		const tbRoom = { curSetList: [set], getStat: () => 100 };
		const entry = computeSpeedSpectrumEntries(tbRoom)[0];
		expect(entry.speed).toBe(100);
		expect(entry.hasScarf).toBe(false);
	});
});

describe('resolveSpeedSpectrumSpecies', () => {
	afterEach(() => { delete window.Dex; });

	it('leaves a plain set alone with no matching item', () => {
		expect(resolveSpeedSpectrumSpecies({ species: 'Incineroar', item: 'Leftovers' })).toEqual({ species: 'Incineroar', isMega: false });
		expect(resolveSpeedSpectrumSpecies({ species: 'Incineroar' })).toEqual({ species: 'Incineroar', isMega: false });
	});

	it('resolves to the Mega forme when the held item is a matching Mega Stone', () => {
		mockBattleDex();
		expect(resolveSpeedSpectrumSpecies({ species: 'Blastoise', item: 'Blastoisinite' })).toEqual({ species: 'Blastoise-Mega', isMega: true });
	});

	it('still reports isMega when species is already the Mega forme itself (megaStone is keyed by the base species, but battleOnly catches it)', () => {
		mockBattleDex();
		expect(resolveSpeedSpectrumSpecies({ species: 'Blastoise-Mega', item: 'Blastoisinite' })).toEqual({ species: 'Blastoise-Mega', isMega: true });
	});

	it('reports isMega for a Mega picked directly from species search, with no Mega Stone item at all', () => {
		mockBattleDex();
		expect(resolveSpeedSpectrumSpecies({ species: 'Blastoise-Mega' })).toEqual({ species: 'Blastoise-Mega', isMega: true });
	});
});

describe('assignSpeedSpectrumLanes', () => {
	const posOf = (speed) => speed; // identity — lets test positions double as plain percentages

	it('keeps widely separated entries in the same lane (no collision to avoid)', () => {
		const entries = [{ species: 'Torkoal', speed: 10 }, { species: 'Ninjask', speed: 90 }];
		const lanes = assignSpeedSpectrumLanes(entries, posOf).map((e) => e.lane);
		expect(lanes).toEqual([0, 0]);
	});

	it('opens a second lane only for entries too close to the first lane\'s last placement', () => {
		const entries = [{ species: 'A', speed: 100 }, { species: 'B', speed: 101 }];
		const lanes = assignSpeedSpectrumLanes(entries, posOf).map((e) => e.lane);
		expect(lanes).toEqual([0, 1]);
	});

	it('reuses lane 0 once it clears the gap again, rather than always advancing to a new lane', () => {
		// B is too close to A (lane 1), C is far from both A and B — first-fit should slot it
		// back into lane 0 instead of opening an unnecessary third lane.
		const entries = [{ species: 'A', speed: 100 }, { species: 'B', speed: 101 }, { species: 'C', speed: 130 }];
		const lanes = assignSpeedSpectrumLanes(entries, posOf).map((e) => e.lane);
		expect(lanes).toEqual([0, 1, 0]);
	});

	it('opens as many lanes as a tight cluster genuinely needs, not a fixed cap', () => {
		const entries = [100, 101, 102, 103, 104].map((speed, i) => ({ species: 'M' + i, speed }));
		const lanes = assignSpeedSpectrumLanes(entries, posOf).map((e) => e.lane);
		expect(new Set(lanes).size).toBeGreaterThan(2); // would be capped at 2 under the old row toggle
	});

	it('does not mutate the input array', () => {
		const entries = [{ species: 'Torkoal', speed: 10 }];
		assignSpeedSpectrumLanes(entries, posOf);
		expect(entries[0]).not.toHaveProperty('lane');
	});
});

describe('computeSpeedSpectrumDomain', () => {
	// Real base Speeds for the four hardcoded reference species (content.js's own
	// SPEED_SPECTRUM_FASTEST_NON_MEGA/etc, researched by hand — see that const's own comment):
	// Dragapult 142, Alakazam-Mega 150, Torkoal 20, Sableye-Mega 20.
	function fakeGetStat(stat, set, ev, natureMult) {
		const base = { Dragapult: 142, 'Alakazam-Mega': 150, Torkoal: 20, 'Sableye-Mega': 20 }[set.species];
		if (base === undefined) throw new Error('unexpected reference species: ' + set.species);
		return natureMult === 0.9 || natureMult === 1.1 ? base : -1; // sanity: always called with a real override
	}

	it('takes the format-wide fastest non-Mega, Scarfed, as the ceiling — beats the fastest Mega', () => {
		// Scarfed Dragapult: floor(142 * 1.5) = 213, vs. Alakazam-Mega's plain 150.
		const domain = computeSpeedSpectrumDomain({ getStat: fakeGetStat });
		expect(domain.max).toBe(213);
		expect(domain).toMatchObject({ maxSpecies: 'Dragapult', maxIsMega: false });
	});

	it('takes the format-wide slowest non-Mega, Iron-Balled, as the floor — beats the slowest Mega', () => {
		// Iron-Balled Torkoal: floor(20 * 0.5) = 10, vs. Sableye-Mega's plain 20.
		const domain = computeSpeedSpectrumDomain({ getStat: fakeGetStat });
		expect(domain.min).toBe(10);
		expect(domain).toMatchObject({ minSpecies: 'Torkoal', minIsMega: false });
	});

	it('never applies Scarf/Iron Ball to a Mega candidate', () => {
		const getStat = vi.fn(fakeGetStat);
		computeSpeedSpectrumDomain({ getStat });
		// Both Mega calls resolve to a bare 150/20 with no further modification — confirmed by
		// the ceiling/floor assertions above already reflecting the un-multiplied Mega values
		// whenever they win; this just confirms getStat itself was actually asked for them.
		expect(getStat).toHaveBeenCalledWith('spe', { species: 'Alakazam-Mega', level: 50 }, 32, 1.1);
		expect(getStat).toHaveBeenCalledWith('spe', { species: 'Sableye-Mega', level: 50 }, 0, 0.9);
	});

	it('picks whichever candidate (Mega or Scarf/Iron-Balled non-Mega) is actually more extreme, not always one or the other', () => {
		// Flip the usual outcome: make the Mega candidates the more extreme ones this time.
		const getStat = (stat, set) => ({ Dragapult: 100, 'Alakazam-Mega': 500, Torkoal: 100, 'Sableye-Mega': 1 }[set.species]);
		const domain = computeSpeedSpectrumDomain({ getStat });
		expect(domain).toMatchObject({ maxSpecies: 'Alakazam-Mega', maxIsMega: true });
		expect(domain).toMatchObject({ minSpecies: 'Sableye-Mega', minIsMega: true });
	});
});

describe('buildSpeedSpectrumHTML', () => {
	beforeEach(() => mockDex());
	afterEach(() => { delete window.Dex; });

	// Realistic default: neither bound comes from a Mega winner, so both would normally show
	// their own item badge (Iron Ball/Scarf) — tests that care specifically about *entry-level*
	// badges override minIsMega/maxIsMega to true to isolate them from the bound's own badges.
	function fakeDomain(min, max, overrides) {
		return Object.assign({ min, minSpecies: 'Torkoal', minIsMega: false, max, maxSpecies: 'Ninjask', maxIsMega: false }, overrides);
	}

	it('shows the empty-state message with no roster at all', () => {
		expect(buildSpeedSpectrumHTML([], null)).toContain('No Pokémon on your team yet.');
	});

	it('positions an entry along the given domain, not a padded range derived from itself', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: 'Incineroar', speed: 100 }], fakeDomain(50, 150));
		expect(html).toContain('left:50.0%');
		expect(html).toContain('>50<');
		expect(html).toContain('>150<');
	});

	it('never lets the low bound render as negative even if the domain somehow is', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Torkoal', name: 'Torkoal', speed: 10 }], fakeDomain(-5, 40));
		expect(html).toContain('>0<');
	});

	it('stacks a lone team Pokémon in the single lane closest to the track (top:0)', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: 'Incineroar', speed: 100 }], fakeDomain(50, 150));
		expect(html).toContain('top:0px');
	});

	it('shows the real species/nickname and exact Speed number in the hover title', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: 'Big Cat', speed: 87 }], fakeDomain(50, 150));
		expect(html).toContain('title="Big Cat: 87 Speed"');
	});

	it('escapes a nickname used in the hover title', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: '<script>', speed: 87 }], fakeDomain(50, 150));
		expect(html).not.toContain('title="<script>: 87 Speed"');
		expect(html).toContain('&lt;script&gt;');
	});

	it('opens a second lane (top:46px) for a Pokémon too close in Speed to overlap otherwise', () => {
		const html = buildSpeedSpectrumHTML([
			{ species: 'A', name: 'A', speed: 100 },
			{ species: 'B', name: 'B', speed: 101 },
		], fakeDomain(50, 150));
		expect(html).toContain('top:0px');
		expect(html).toContain('top:46px');
	});

	it('shows the Choice Scarf/Iron Ball badge on an entry that has one, and never on one that does not', () => {
		// Both bounds forced Mega here specifically to isolate entry-level badges from the
		// bound's own — see the dedicated bound-badge tests below for those.
		const html = buildSpeedSpectrumHTML([
			{ species: 'Incineroar', name: 'Incineroar', speed: 150, hasScarf: true, hasIronBall: false },
			{ species: 'Ninjask', name: 'Ninjask', speed: 90, hasScarf: false, hasIronBall: true },
			{ species: 'Torkoal', name: 'Torkoal', speed: 60, hasScarf: false, hasIronBall: false },
		], fakeDomain(50, 200, { minIsMega: true, maxIsMega: true }));
		expect((html.match(/cf-speedcmp-item-badge/g) || [])).toHaveLength(2);
	});

	it('clamps a real entry outside the given domain to the nearest edge instead of rendering off it', () => {
		// e.g. a real Iron Ball holder can fall below the plain 0-EV/negative-nature floor.
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: 'Incineroar', speed: 20 }], fakeDomain(50, 150));
		expect(html).toContain('left:0.0%');
		expect(html).not.toContain('left:-');
	});

	it('positions threshold markers at the track\'s own left:0%/100%, a small fixed gap below it', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: 'Incineroar', speed: 100 }], fakeDomain(50, 150));
		const trackTop = Number(html.match(/cf-speedspectrum-track" style="top:(\d+)px"/)[1]);
		const thresholds = [...html.matchAll(/cf-speedspectrum-threshold" style="left:(\d+)%;top:(\d+)px/g)];
		expect(thresholds).toHaveLength(2);
		const lefts = thresholds.map((m) => Number(m[1])).sort((a, b) => a - b);
		expect(lefts).toEqual([0, 100]);
		// Both sit at the same small, fixed gap below the track — not far away at the bottom of
		// a much taller diagram, and not vertically centered on the track's own line either.
		thresholds.forEach((m) => expect(Number(m[2]) - trackTop).toBe(8));
	});

	it('shares the exact same coordinate space as the roster icons — a real entry at the domain edge lines up with the threshold marker', () => {
		// speed:150 sits exactly at the domain max, so it should land at left:100.0%, the same
		// horizontal position speedSpectrumThresholdHTML uses for the ceiling marker itself.
		const html = buildSpeedSpectrumHTML([{ species: 'Dragapult', name: 'Dragapult', speed: 150 }], fakeDomain(50, 150));
		expect(html).toContain('cf-speedspectrum-icon" style="left:100.0%');
		expect(html).toContain('cf-speedspectrum-threshold" style="left:100%');
	});

	it('shows a sprite of the winning species at each threshold marker', () => {
		const html = buildSpeedSpectrumHTML(
			[{ species: 'Incineroar', name: 'Incineroar', speed: 100 }],
			fakeDomain(50, 150, { minSpecies: 'Torkoal', maxSpecies: 'Ninjask' })
		);
		expect(html).toContain('cf-speedspectrum-threshold');
		expect(html).toContain('background:url(Torkoal)');
		expect(html).toContain('background:url(Ninjask)');
	});

	it('badges a non-Mega bound winner with Iron Ball on the floor and Choice Scarf on the ceiling', () => {
		const html = buildSpeedSpectrumHTML(
			[{ species: 'Incineroar', name: 'Incineroar', speed: 100 }],
			fakeDomain(50, 150, { minIsMega: false, maxIsMega: false })
		);
		expect((html.match(/cf-speedcmp-item-badge/g) || [])).toHaveLength(2);
	});

	it('never badges a Mega bound winner — holding the Mega Stone is already implicit', () => {
		const html = buildSpeedSpectrumHTML(
			[{ species: 'Incineroar', name: 'Incineroar', speed: 100 }],
			fakeDomain(50, 150, { minIsMega: true, maxIsMega: true })
		);
		expect(html).not.toContain('cf-speedcmp-item-badge');
	});

	it('never renders a legend, a tick, or a popular/team distinction — just the roster', () => {
		const html = buildSpeedSpectrumHTML([{ species: 'Incineroar', name: 'Incineroar', speed: 100 }], fakeDomain(50, 150));
		expect(html).not.toContain('legend');
		expect(html).not.toContain('cf-speedspectrum-tick');
		expect(html).not.toContain('cf-speedspectrum-icon-team');
		expect(html).not.toContain('cf-speedspectrum-icon-popular');
	});
});

/** Minimal window.Dex for computeTeamDefensiveProfile/buildTeamDefensiveProfileHTML tests — a
 *  hand-picked slice giving each of two species exactly one real weakness/resistance, everything
 *  else left to typeEffectivenessMultiplier's own neutral default, the same "small, internally
 *  consistent, not the real type chart" approach mockThreatsDex takes. */
function mockDefMatrixDex() {
	const types = {
		water: { exists: true, damageTaken: { Electric: 1 } }, // weak to Electric (2x)
		grass: { exists: true, damageTaken: { Fire: 1, Water: 2 } }, // weak to Fire (2x), resists Water (.5x)
	};
	const species = {
		blastoise: { exists: true, types: ['Water'] },
		sceptile: { exists: true, types: ['Grass'] },
	};
	window.Dex = {
		getPokemonIcon: (s) => `background:url(${s})`,
		getTypeIcon: (t) => `<img alt="${t}">`,
		types: { get: (name) => types[String(name).toLowerCase()] || { exists: false } },
		species: { get: (name) => species[String(name).toLowerCase()] || { exists: false } },
	};
}

describe('ALL_TYPES', () => {
	it('lists all 18 real types, each exactly once', () => {
		expect(ALL_TYPES).toHaveLength(18);
		expect(new Set(ALL_TYPES).size).toBe(18);
	});
});

describe('DEFENSIVE_ABILITY_IMMUNITIES', () => {
	it('lists exactly the 11 real flat-type-immunity abilities (verified against pokemon-showdown\'s own data/abilities.ts)', () => {
		expect(DEFENSIVE_ABILITY_IMMUNITIES).toEqual({
			waterabsorb: 'Water', dryskin: 'Water', stormdrain: 'Water',
			voltabsorb: 'Electric', lightningrod: 'Electric', motordrive: 'Electric',
			flashfire: 'Fire', wellbakedbody: 'Fire',
			sapsipper: 'Grass',
			levitate: 'Ground', eartheater: 'Ground',
		});
	});
});

describe('applyDefensiveAbility', () => {
	it('zeroes out the one type each real immunity ability blocks', () => {
		expect(applyDefensiveAbility(1, 'Water', 'Water Absorb')).toBe(0);
		expect(applyDefensiveAbility(2, 'Water', 'Dry Skin')).toBe(0);
		expect(applyDefensiveAbility(1, 'Water', 'Storm Drain')).toBe(0);
		expect(applyDefensiveAbility(1, 'Electric', 'Volt Absorb')).toBe(0);
		expect(applyDefensiveAbility(1, 'Electric', 'Lightning Rod')).toBe(0);
		expect(applyDefensiveAbility(1, 'Electric', 'Motor Drive')).toBe(0);
		expect(applyDefensiveAbility(2, 'Fire', 'Flash Fire')).toBe(0);
		expect(applyDefensiveAbility(1, 'Fire', 'Well-Baked Body')).toBe(0);
		expect(applyDefensiveAbility(1, 'Grass', 'Sap Sipper')).toBe(0);
		expect(applyDefensiveAbility(1, 'Ground', 'Levitate')).toBe(0);
		expect(applyDefensiveAbility(1, 'Ground', 'Earth Eater')).toBe(0);
	});

	it('leaves every other type unaffected by a real immunity ability', () => {
		expect(applyDefensiveAbility(2, 'Grass', 'Water Absorb')).toBe(2); // Water Absorb doesn't touch Grass
		expect(applyDefensiveAbility(0.5, 'Ground', 'Flash Fire')).toBe(0.5); // Flash Fire only blocks Fire
	});

	it('passes the raw multiplier through unchanged with no ability or an unrelated one', () => {
		expect(applyDefensiveAbility(2, 'Water', '')).toBe(2);
		expect(applyDefensiveAbility(2, 'Water', 'Intimidate')).toBe(2);
		expect(applyDefensiveAbility(2, 'Grass', 'Thick Fat')).toBe(2); // Thick Fat doesn't touch Grass
	});

	it('applies Wonder Guard\'s own rule instead — everything below super effective becomes 0', () => {
		expect(applyDefensiveAbility(1, 'Normal', 'Wonder Guard')).toBe(0); // neutral -> blocked
		expect(applyDefensiveAbility(0.5, 'Fire', 'Wonder Guard')).toBe(0); // resisted -> blocked
		expect(applyDefensiveAbility(0, 'Ground', 'Wonder Guard')).toBe(0); // already immune -> still 0
		expect(applyDefensiveAbility(2, 'Ice', 'Wonder Guard')).toBe(2); // super effective -> passes through real
		expect(applyDefensiveAbility(4, 'Rock', 'Wonder Guard')).toBe(4); // quad -> passes through real
	});

	it('stacks a real fractional weakness modifier on top of the raw multiplier, not replacing it', () => {
		expect(applyDefensiveAbility(1, 'Fire', 'Dry Skin')).toBe(1.25); // neutral by typing, extra-weak via ability
		expect(applyDefensiveAbility(2, 'Fire', 'Dry Skin')).toBe(2.5); // already weak by typing, stacks further
		expect(applyDefensiveAbility(1, 'Fire', 'Fluffy')).toBe(2);
		expect(applyDefensiveAbility(2, 'Fire', 'Fluffy')).toBe(4); // real case: a Fire-weak Fluffy holder takes quad
	});

	it('a Dry Skin holder is immune to Water AND extra-weak to Fire at once — two different real effects, not a contradiction', () => {
		expect(applyDefensiveAbility(1, 'Water', 'Dry Skin')).toBe(0);
		expect(applyDefensiveAbility(1, 'Fire', 'Dry Skin')).toBe(1.25);
	});

	it('stacks a real fractional resistance modifier the same way', () => {
		expect(applyDefensiveAbility(1, 'Fire', 'Thick Fat')).toBe(0.5);
		expect(applyDefensiveAbility(1, 'Ice', 'Thick Fat')).toBe(0.5);
		expect(applyDefensiveAbility(1, 'Fire', 'Heatproof')).toBe(0.5);
		expect(applyDefensiveAbility(1, 'Fire', 'Water Bubble')).toBe(0.5);
		expect(applyDefensiveAbility(2, 'Water', 'Water Bubble')).toBe(2); // Water Bubble doesn't touch Water defensively
		expect(applyDefensiveAbility(1, 'Ghost', 'Purifying Salt')).toBe(0.5);
	});

	it('blunts an already-super-effective hit by a flat 0.75x, but leaves a neutral or resisted hit untouched', () => {
		expect(applyDefensiveAbility(2, 'Ice', 'Solid Rock')).toBe(1.5);
		expect(applyDefensiveAbility(4, 'Ice', 'Filter')).toBe(3);
		expect(applyDefensiveAbility(2, 'Ice', 'Prism Armor')).toBe(1.5);
		expect(applyDefensiveAbility(1, 'Ice', 'Solid Rock')).toBe(1); // neutral -> untouched
		expect(applyDefensiveAbility(0.5, 'Ice', 'Solid Rock')).toBe(0.5); // resisted -> untouched
	});
});

describe('computeTeamDefensiveProfile', () => {
	afterEach(() => { delete window.Dex; });

	it('returns empty members/rows for an empty roster', () => {
		expect(computeTeamDefensiveProfile({ curSetList: [] })).toEqual({ members: [], rows: [] });
	});

	it('skips blank slots, lists every real type in ALL_TYPES order, colors the ones that deviate from neutral', () => {
		mockDefMatrixDex();
		const tbRoom = {
			curTeam: { capacity: 2 },
			curSetList: [{ species: 'Blastoise', name: '' }, { species: '' }, { species: 'Sceptile', name: '' }],
		};
		const profile = computeTeamDefensiveProfile(tbRoom);
		expect(profile.members).toEqual([
			{ species: 'Blastoise', name: 'Blastoise', canToggle: false, displayAsMega: false, empty: false },
			{ species: 'Sceptile', name: 'Sceptile', canToggle: false, displayAsMega: false, empty: false },
		]);
		expect(profile.rows.map((r) => r.type)).toEqual(ALL_TYPES); // every real type, ALL_TYPES order, not alphabetical
		expect(profile.rows.find((r) => r.type === 'Fire').multipliers).toEqual([1, 2]); // neutral vs Blastoise, weak vs Sceptile
		expect(profile.rows.find((r) => r.type === 'Water').multipliers).toEqual([1, 0.5]); // neutral vs Blastoise, resisted vs Sceptile
		expect(profile.rows.find((r) => r.type === 'Electric').multipliers).toEqual([2, 1]); // weak vs Blastoise, neutral vs Sceptile
	});

	it('still includes a type row even when every member is exactly neutral to it', () => {
		mockDefMatrixDex();
		const profile = computeTeamDefensiveProfile({ curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise', name: '' }] });
		// Nothing in the fixture touches Normal — genuinely neutral, but still a real row.
		expect(profile.rows.find((r) => r.type === 'Normal').multipliers).toEqual([1]);
	});

	it('resolves a Mega-Stone holder to the Mega forme before looking up its defensive types, defaulting to displaying as Mega', () => {
		mockBattleDex();
		const tbRoom = { curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise', item: 'Blastoisinite', name: '' }] };
		expect(computeTeamDefensiveProfile(tbRoom).members).toEqual([
			{ species: 'Blastoise-Mega', name: 'Blastoise-Mega', canToggle: true, displayAsMega: true, empty: false },
		]);
	});

	it('also allows toggling a Mega picked directly from species search, with no separate Mega Stone item', () => {
		mockBattleDex();
		const tbRoom = { curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise-Mega', name: '' }] };
		expect(computeTeamDefensiveProfile(tbRoom).members).toEqual([
			{ species: 'Blastoise-Mega', name: 'Blastoise-Mega', canToggle: true, displayAsMega: true, empty: false },
		]);
	});

	it('actually swaps to the real base forme (via Dex baseSpecies, not the raw set data) when toggling a directly-picked Mega', () => {
		mockBattleDex();
		// set.species is already 'Blastoise-Mega' here — there's no separate base-species field
		// anywhere on this set the way there is for a base-species-plus-item build, so the base
		// name has to come from window.Dex's own baseSpecies, not sets[i].species (which would
		// just be 'Blastoise-Mega' again, silently toggling to the exact same sprite).
		const tbRoom = { curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise-Mega', name: '' }] };
		expect(computeTeamDefensiveProfile(tbRoom, new Set([0])).members).toEqual([
			{ species: 'Blastoise', name: 'Blastoise', canToggle: true, displayAsMega: false, empty: false },
		]);
	});

	it('shows the real base forme instead when that slot\'s index is in baseFormeSlots', () => {
		mockBattleDex();
		const tbRoom = { curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise', item: 'Blastoisinite', ability: 'Torrent', name: '' }] };
		const profile = computeTeamDefensiveProfile(tbRoom, new Set([0]));
		expect(profile.members).toEqual([
			{ species: 'Blastoise', name: 'Blastoise', canToggle: true, displayAsMega: false, empty: false },
		]);
	});

	it('ignores a baseFormeSlots index that isn\'t actually Mega-capable — a harmless no-op', () => {
		mockDefMatrixDex();
		const tbRoom = { curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise', name: '' }] };
		const profile = computeTeamDefensiveProfile(tbRoom, new Set([0]));
		expect(profile.members).toEqual([
			{ species: 'Blastoise', name: 'Blastoise', canToggle: false, displayAsMega: false, empty: false },
		]);
	});

	it('folds a real held ability\'s immunity into the multiplier — Water Absorb blocks Water outright', () => {
		mockDefMatrixDex();
		const tbRoom = {
			curTeam: { capacity: 2 },
			curSetList: [{ species: 'Blastoise', name: '', ability: 'Water Absorb' }, { species: 'Sceptile', name: '' }],
		};
		const profile = computeTeamDefensiveProfile(tbRoom);
		// Water: Blastoise would normally be neutral (1x), but Water Absorb makes it 0 — still a
		// real row (Sceptile's own .5x keeps it non-neutral), just with the ability's own 0 for
		// the Blastoise column instead of typing alone.
		expect(profile.rows.find((r) => r.type === 'Water').multipliers).toEqual([0, 0.5]);
	});

	it('uses a real Mega Evolution\'s own fixed ability, not the base set\'s chosen one', () => {
		window.Dex = {
			items: { get: (name) => (String(name).toLowerCase() === 'blastoisinite' ? { exists: true, megaStone: { Blastoise: 'Blastoise-Mega' } } : { exists: false }) },
			types: { get: () => ({ exists: false }) }, // irrelevant to this test — isolates the ability override from real type-chart math
			species: { get: (name) => (name === 'Blastoise-Mega' ? { exists: true, types: ['Water'], abilities: { 0: 'Water Absorb' } } : { exists: false }) },
		};
		const tbRoom = { curTeam: { capacity: 1 }, curSetList: [{ species: 'Blastoise', item: 'Blastoisinite', ability: 'Torrent', name: '' }] };
		const profile = computeTeamDefensiveProfile(tbRoom);
		// Torrent (the base set's own chosen ability, ignored here) does nothing to Water; Water
		// Absorb (the Mega's own real, fixed ability) is what actually applies. If the base
		// ability had been used instead this row wouldn't exist at all — nothing in this test's
		// bare-neutral type mock produces a non-1x result on its own.
		expect(profile.rows.find((r) => r.type === 'Water').multipliers).toEqual([0]);
	});

	it('reserves all 6 (or the real team capacity) columns once a real roster exists, padding unfilled slots with empty placeholders', () => {
		mockDefMatrixDex();
		const tbRoom = { curSetList: [{ species: 'Blastoise', name: '' }] }; // no curTeam.capacity given -> falls back to 6, same as curTeamFull
		const profile = computeTeamDefensiveProfile(tbRoom);
		expect(profile.members).toHaveLength(6);
		expect(profile.members[0]).toEqual({ species: 'Blastoise', name: 'Blastoise', canToggle: false, displayAsMega: false, empty: false });
		for (let i = 1; i < 6; i++) {
			expect(profile.members[i]).toEqual({ species: null, name: '', canToggle: false, displayAsMega: false, empty: true });
		}
		// Every row still lines up 1-to-1 with the 6 columns — real Blastoise data first, then
		// null ("nothing to compute," not "computed and neutral") for every still-open slot.
		expect(profile.rows.find((r) => r.type === 'Fire').multipliers).toEqual([1, null, null, null, null, null]);
	});

	it('respects a real, non-default team capacity when reserving columns', () => {
		mockDefMatrixDex();
		const tbRoom = { curTeam: { capacity: 3 }, curSetList: [{ species: 'Blastoise', name: '' }] };
		expect(computeTeamDefensiveProfile(tbRoom).members).toHaveLength(3);
	});
});

describe('resolveMemberAbility', () => {
	afterEach(() => { delete window.Dex; });

	it('returns the set\'s own chosen ability unchanged for a non-Mega member', () => {
		expect(resolveMemberAbility({ ability: 'Torrent' }, 'Blastoise', false)).toBe('Torrent');
	});

	it('overrides with the Mega forme\'s own real fixed ability when isMega is true', () => {
		window.Dex = { species: { get: (name) => (name === 'Blastoise-Mega' ? { exists: true, abilities: { 0: 'Mega Launcher' } } : { exists: false }) } };
		expect(resolveMemberAbility({ ability: 'Torrent' }, 'Blastoise-Mega', true)).toBe('Mega Launcher');
	});

	it('falls back to the set\'s own ability if the Mega species entry has no abilities data', () => {
		window.Dex = { species: { get: () => ({ exists: false }) } };
		expect(resolveMemberAbility({ ability: 'Torrent' }, 'Blastoise-Mega', true)).toBe('Torrent');
	});

	it('falls back to the set\'s own ability without window.Dex at all', () => {
		expect(resolveMemberAbility({ ability: 'Torrent' }, 'Blastoise-Mega', true)).toBe('Torrent');
	});
});

describe('defensiveTierClass', () => {
	it('maps all six discrete type-chart products to their own tier', () => {
		expect(defensiveTierClass(4)).toBe('cf-defmatrix-quadweak');
		expect(defensiveTierClass(2)).toBe('cf-defmatrix-weak');
		expect(defensiveTierClass(1)).toBe('');
		expect(defensiveTierClass(0.5)).toBe('cf-defmatrix-resist');
		expect(defensiveTierClass(0.25)).toBe('cf-defmatrix-quadresist');
		expect(defensiveTierClass(0)).toBe('cf-defmatrix-immune');
	});

	it('distinguishes a real double-resist (.25x, still hittable) from true immunity (0x)', () => {
		expect(defensiveTierClass(0.25)).not.toBe(defensiveTierClass(0));
	});

	it('renders a still-open slot (null) as a plain uncolored cell, not immune', () => {
		// A bare comparison would coerce null to 0 and wrongly fall through to the immune tier —
		// the real bug this guards against (a still-empty slot reading as "immune to everything").
		expect(defensiveTierClass(null)).toBe('');
		expect(defensiveTierClass(undefined)).toBe('');
		expect(defensiveTierClass(null)).not.toBe(defensiveTierClass(0));
	});

	it('gives a real ability-driven multiplier strictly between the clean tiers its own lighter mild tier, not the neutral cell or the full tier', () => {
		// Dry Skin's real Fire weakness on an otherwise-neutral typing: 1 * 1.25 = 1.25.
		expect(defensiveTierClass(1.25)).toBe('cf-defmatrix-mildweak');
		expect(defensiveTierClass(1.25)).not.toBe(defensiveTierClass(1));
		expect(defensiveTierClass(1.25)).not.toBe(defensiveTierClass(2));
		// Solid Rock blunting an already-4x weakness: 4 * 0.75 = 3 — still >= 2, so it stays in
		// the ordinary "weak" tier rather than getting its own mild variant; a 3x hit is still a
		// real, meaningfully super-effective-strength weakness, just short of the full quad tier.
		expect(defensiveTierClass(3)).toBe('cf-defmatrix-weak');
		// Purifying Salt on an otherwise-weak (2x) Ghost matchup: 2 * 0.5 = 1 — lands back on the
		// clean neutral tier, not a mild one, since 1 is one of the six real discrete products.
		expect(defensiveTierClass(1)).toBe('');
		// A real value strictly between 0.5 and 1 — e.g. Solid Rock's own 0.75x reducer applied
		// hypothetically below its real >=2x gate — reads as a mild resist, not the full 0.5 tier.
		expect(defensiveTierClass(0.75)).toBe('cf-defmatrix-mildresist');
		expect(defensiveTierClass(0.75)).not.toBe(defensiveTierClass(0.5));
	});
});

describe('defensiveCellText', () => {
	it('writes 0/¼×/½× for the three sub-1 multipliers, and a plain ×-suffixed number otherwise', () => {
		expect(defensiveCellText(0)).toBe('0');
		expect(defensiveCellText(0.25)).toBe('¼×');
		expect(defensiveCellText(0.5)).toBe('½×');
		expect(defensiveCellText(1)).toBe('1×');
		expect(defensiveCellText(2)).toBe('2×');
		expect(defensiveCellText(4)).toBe('4×');
	});

	it('writes nothing for a still-open slot (null)', () => {
		expect(defensiveCellText(null)).toBe('');
		expect(defensiveCellText(undefined)).toBe('');
	});
});

describe('buildTeamDefensiveProfileHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('shows the empty-state message with no roster at all', () => {
		expect(buildTeamDefensiveProfileHTML({ members: [], rows: [] })).toContain('No Pokémon on your team yet.');
	});

	it('renders one header cell per member and one row per type, with a colored/labeled non-neutral cell', () => {
		mockDefMatrixDex();
		const profile = {
			members: [{ species: 'Blastoise', name: 'Blastoise' }, { species: 'Sceptile', name: 'Sceptile' }],
			rows: [{ type: 'Fire', multipliers: [1, 2] }],
		};
		const html = buildTeamDefensiveProfileHTML(profile);
		expect(html).toContain('background:url(Blastoise)');
		expect(html).toContain('background:url(Sceptile)');
		expect(html).toContain('<img alt="Fire">');
		expect(html).toContain('cf-defmatrix-weak');
		expect(html).toContain('2×');
	});

	it('renders a neutral (1x) cell blank, with no tier class', () => {
		mockDefMatrixDex();
		const profile = { members: [{ species: 'Blastoise', name: 'Blastoise' }], rows: [{ type: 'Fire', multipliers: [1] }] };
		const html = buildTeamDefensiveProfileHTML(profile);
		expect(html).toMatch(/<td class="cf-defmatrix-cell"><\/td>/);
	});

	it('renders a still-open slot with the shared empty-slot placeholder, no toggle affordance, and a blank cell', () => {
		mockDefMatrixDex();
		const profile = {
			members: [
				{ species: 'Blastoise', name: 'Blastoise', canToggle: false, displayAsMega: false, empty: false },
				{ species: null, name: '', canToggle: false, displayAsMega: false, empty: true },
			],
			rows: [{ type: 'Fire', multipliers: [1, null] }],
		};
		const html = buildTeamDefensiveProfileHTML(profile);
		expect(html).toContain('cf-similarteam-empty-slot'); // same placeholder Similar Teams already uses
		expect(html).not.toContain('cf-defmatrix-member-toggleable');
		expect(html).not.toContain('data-cf-defmatrix-member-idx="1"'); // no toggle handling for an empty slot
		expect(html).toMatch(/<td class="cf-defmatrix-cell"><\/td>/); // the null-multiplier cell renders blank, not "immune"
	});

	it('marks a Mega-capable member with a persistent corner badge, not a title tooltip', () => {
		mockDefMatrixDex();
		const profile = {
			members: [
				{ species: 'Blastoise-Mega', name: 'Blastoise-Mega', canToggle: true, displayAsMega: true },
				{ species: 'Sceptile', name: 'Sceptile', canToggle: false, displayAsMega: false },
			],
			rows: [{ type: 'Fire', multipliers: [1, 2] }],
		};
		const html = buildTeamDefensiveProfileHTML(profile);
		expect(html).toContain('cf-defmatrix-toggle-badge');
		expect(html).not.toContain('title="');
		expect((html.match(/cf-defmatrix-toggle-badge/g) || []).length).toBe(1); // only the toggleable member gets one
	});
});

describe('isBlankSlot', () => {
	it('is true for a real, currently-open slot with no species/name yet', () => {
		expect(isBlankSlot({ curSet: { species: '', name: '' } })).toBe(true);
	});

	it('is false once a species (or nickname) is set', () => {
		expect(isBlankSlot({ curSet: { species: 'Incineroar', name: '' } })).toBe(false);
		expect(isBlankSlot({ curSet: { species: '', name: 'Big Cat' } })).toBe(false);
	});

	it('is false with no curSet at all (the team-overview screen)', () => {
		expect(isBlankSlot({ curSet: null })).toBe(false);
		expect(isBlankSlot({})).toBe(false);
	});
});

describe('isTeamOverview', () => {
	it('is true once a team is open with no slot being edited', () => {
		expect(isTeamOverview({ curTeam: { name: 'Untitled 1', format: 'gen9' }, curSet: null })).toBe(true);
	});

	it('is false on the outer "all your teams" list screen, even though curSet is null there too', () => {
		expect(isTeamOverview({ curTeam: null, curSet: null })).toBe(false);
		expect(isTeamOverview({ curSet: null })).toBe(false);
	});

	it('is false once a slot is being edited, blank or filled', () => {
		expect(isTeamOverview({ curTeam: { name: 'Untitled 1' }, curSet: { species: '', name: '' } })).toBe(false);
		expect(isTeamOverview({ curTeam: { name: 'Untitled 1' }, curSet: { species: 'Incineroar' } })).toBe(false);
	});

	it('is false with no tbRoom at all', () => {
		expect(isTeamOverview(null)).toBe(false);
		expect(isTeamOverview({})).toBe(false);
	});
});

describe('teamDamagingMoveTypes', () => {
	afterEach(() => { delete window.Dex; });

	it('collects only damaging moves\' types, skipping Status moves and blank/missing sets', () => {
		mockBattleDex();
		const tbRoom = {
			curSetList: [
				{ species: 'Incineroar', moves: ['Flare Blitz', 'Fake Out', 'Parting Shot', ''] },
				{ species: '', moves: ['Earthquake'] }, // blank slot itself: no species -> ignored
				{ species: 'Garchomp', moves: ['Earthquake'] },
			],
		};
		expect(teamDamagingMoveTypes(tbRoom)).toEqual(['Fire', 'Normal', 'Ground']);
	});

	it('returns an empty list without window.Dex', () => {
		expect(teamDamagingMoveTypes({ curSetList: [{ species: 'Incineroar', moves: ['Flare Blitz'] }] })).toEqual([]);
	});
});

describe('typeEffectivenessMultiplier', () => {
	afterEach(() => { delete window.Dex; });

	it('multiplies per-type factors across a dual-type defender', () => {
		mockBattleDex();
		// Water/Flying-ish stand-in: Electric is 2x vs Water and (via the mock) 1x vs Flying -> 2x overall.
		expect(typeEffectivenessMultiplier('Electric', ['water'])).toBe(2);
		expect(typeEffectivenessMultiplier('Fire', ['water'])).toBe(0.5);
		expect(typeEffectivenessMultiplier('Ground', ['flying'])).toBe(0); // immune
	});

	it('is case-insensitive on the attacking type (damageTaken keys are capitalized)', () => {
		mockBattleDex();
		expect(typeEffectivenessMultiplier('electric', ['water'])).toBe(2);
	});

	it('defaults to neutral (1) without window.Dex or a real defender type', () => {
		expect(typeEffectivenessMultiplier('Electric', ['water'])).toBe(1);
	});
});

describe('bestTeamCoverageMultiplier', () => {
	afterEach(() => { delete window.Dex; });

	it('returns the best (highest) multiplier across every move type, not an average', () => {
		mockBattleDex();
		// Fire (0.5x vs water) and a hypothetical Electric (2x vs water) -> best is 2.
		expect(bestTeamCoverageMultiplier(['Fire', 'Electric'], ['water'])).toBe(2);
	});

	it('returns null (not 0, not "neutral") with no moves or no defender types to compute from', () => {
		expect(bestTeamCoverageMultiplier([], ['water'])).toBe(null);
		expect(bestTeamCoverageMultiplier(['Fire'], [])).toBe(null);
	});
});

describe('coverageTierClass', () => {
	it('maps the discrete type-chart products to the six documented tiers', () => {
		expect(coverageTierClass(4)).toBe('cf-coverage-quad');
		expect(coverageTierClass(2)).toBe('cf-coverage-super');
		expect(coverageTierClass(1)).toBe('');
		expect(coverageTierClass(0.5)).toBe('cf-coverage-resist');
		expect(coverageTierClass(0.25)).toBe('cf-coverage-quadresist');
		expect(coverageTierClass(0)).toBe('cf-coverage-immune');
	});

	it('distinguishes a real double-resist (.25x, still hittable) from true immunity (0x)', () => {
		expect(coverageTierClass(0.25)).not.toBe(coverageTierClass(0));
	});

	it('is also the neutral (no) class for "nothing to compute" (null)', () => {
		expect(coverageTierClass(null)).toBe('');
	});
});

describe('topSpeedItemBadge', () => {
	afterEach(() => { delete window.Dex; });

	it('flags a Choice Scarf past the usage threshold', () => {
		mockBattleDex();
		const mon = { items: [{ item: 'Choice Scarf', percent: '44.7' }] };
		expect(topSpeedItemBadge(mon, 'Basculegion')).toEqual({ item: 'Choice Scarf', isMega: false });
	});

	it('flags a Mega Stone past its own usage threshold, with its forme name', () => {
		mockBattleDex();
		const mon = { items: [{ item: 'Blastoisinite', percent: '20.0' }] };
		expect(topSpeedItemBadge(mon, 'Blastoise')).toEqual({ item: 'Blastoisinite', isMega: true, formeName: 'Blastoise-Mega' });
	});

	it('returns null below either threshold, or with no relevant item at all', () => {
		mockBattleDex();
		expect(topSpeedItemBadge({ items: [{ item: 'Choice Scarf', percent: '1.0' }] }, 'Basculegion')).toBe(null);
		expect(topSpeedItemBadge({ items: [{ item: 'Leftovers', percent: '80.0' }] }, 'Incineroar')).toBe(null);
		expect(topSpeedItemBadge(null, 'Incineroar')).toBe(null);
	});

	it('picks whichever of Scarf/Mega Stone is actually more popular, not Scarf unconditionally', () => {
		mockBattleDex();
		// Mega Stone (20%) is more popular here than Scarf (18%) -> Mega should win.
		const megaWins = { items: [{ item: 'Choice Scarf', percent: '18.0' }, { item: 'Blastoisinite', percent: '20.0' }] };
		expect(topSpeedItemBadge(megaWins, 'Blastoise').isMega).toBe(true);
		// Scarf (44.7%) is more popular here than the Mega Stone (20%) -> Scarf should win.
		const scarfWins = { items: [{ item: 'Choice Scarf', percent: '44.7' }, { item: 'Blastoisinite', percent: '20.0' }] };
		expect(topSpeedItemBadge(scarfWins, 'Blastoise').isMega).toBe(false);
	});

	it('breaks an exact tie in Scarf\'s favor', () => {
		mockBattleDex();
		const tied = { items: [{ item: 'Choice Scarf', percent: '20.0' }, { item: 'Blastoisinite', percent: '20.0' }] };
		expect(topSpeedItemBadge(tied, 'Blastoise')).toEqual({ item: 'Choice Scarf', isMega: false });
	});
});

describe('aggregateTopTeams', () => {
	const teamA = { author: 'Ash', record: '13-2', pokemon: [{ name: 'Incineroar' }, { name: 'Garchomp' }] };
	const teamB = { author: 'Misty', record: '9-3', pokemon: [{ name: 'Incineroar' }] };
	const teamC = { author: 'Brock', record: '5-3', recordData: { wins: 5, losses: 3, ties: 0 }, pokemon: [{ name: 'Incineroar' }, { name: 'Garchomp' }, { name: 'Rillaboom' }] };
	const teamD = { author: 'Nobody', record: '1-0', pokemon: [{ name: 'Rillaboom' }] }; // no overlap with the roster at all

	it('counts a direct intersection between the team\'s own Pokémon and the roster', () => {
		const matches = aggregateTopTeams([teamC], ['incineroar', 'garchomp', 'rillaboom']);
		expect(matches).toHaveLength(1);
		expect(matches[0].shared).toBe(3);
	});

	it('accepts any real overlap (shared >= 1), regardless of roster size', () => {
		// Deliberately not scaled up to "requires 2 once the roster has 2+ species" — unlike the
		// old per-species design this replaced, this list isn't pre-filtered to contain any
		// roster species at all, so shared >= 1 is already a meaningful filter; requiring 2 hid
		// every genuinely popular single-species match (confirmed live: Swampert).
		const matches = aggregateTopTeams([teamA, teamB], ['incineroar', 'garchomp']);
		expect(matches.map((m) => m.author).sort()).toEqual(['Ash', 'Misty']); // Misty's team only shares Incineroar (1), still included
	});

	it('still ranks a team sharing more of the roster above one sharing less, via the sort — not by dropping it', () => {
		const matches = aggregateTopTeams([teamB, teamA], ['incineroar', 'garchomp']);
		expect(matches.map((m) => m.author)).toEqual(['Ash', 'Misty']); // Ash shares 2, Misty shares 1 — both present, Ash first
	});

	it('drops teams with zero overlap with the roster entirely', () => {
		const matches = aggregateTopTeams([teamD], ['incineroar', 'garchomp']);
		expect(matches).toEqual([]);
	});

	it('sorts by share count first, then by wins (recordData.wins, falling back to parsing `record`)', () => {
		const matches = aggregateTopTeams([teamA, teamC], ['incineroar', 'garchomp', 'rillaboom']);
		expect(matches.map((m) => m.author)).toEqual(['Brock', 'Ash']); // Brock shares 3, Ash shares 2
	});

	it('breaks a share-count tie by wins, preferring recordData.wins over a parsed record', () => {
		const higherRecordDataWins = Object.assign({}, teamA, { author: 'Gary', record: '1-0', recordData: { wins: 99, losses: 0, ties: 0 } });
		const matches = aggregateTopTeams([teamA, higherRecordDataWins], ['incineroar', 'garchomp']);
		expect(matches.map((m) => m.author)).toEqual(['Gary', 'Ash']); // both share 2; Gary's recordData.wins (99) beats Ash's parsed 13
	});

	it('returns nothing when the roster has no real species yet', () => {
		expect(aggregateTopTeams([teamA], [])).toEqual([]);
		expect(aggregateTopTeams([teamA], undefined)).toEqual([]);
	});

	it('ignores malformed entries without a pokemon array', () => {
		expect(aggregateTopTeams([{ author: 'Ash' }], ['incineroar'])).toEqual([]);
	});
});

describe('buildMemberThreatRows', () => {
	it('keeps one row per member, sorted into each member\'s own real rank order', () => {
		const rows = buildMemberThreatRows([
			{ member: 'Incineroar', counters: [{ pokemon: 'Sylveon', rank: 3 }, { pokemon: 'Staraptor', rank: 1 }] },
			{ member: 'Garchomp', counters: [{ pokemon: 'Zapdos', rank: 2 }] },
		]);
		expect(rows).toEqual([
			{ member: 'Incineroar', counters: [{ pokemon: 'Staraptor', rank: 1 }, { pokemon: 'Sylveon', rank: 3 }] },
			{ member: 'Garchomp', counters: [{ pokemon: 'Zapdos', rank: 2 }] },
		]);
	});

	it('does not blend or dedupe the same counter across different members\' rows', () => {
		// Unlike the older aggregated design, each member keeps its own independent list — a
		// counter shared by two members shows up on both of their rows, not merged into one.
		const rows = buildMemberThreatRows([
			{ member: 'Incineroar', counters: [{ pokemon: 'Zapdos', rank: 1 }] },
			{ member: 'Garchomp', counters: [{ pokemon: 'Zapdos', rank: 4 }] },
		]);
		expect(rows).toEqual([
			{ member: 'Incineroar', counters: [{ pokemon: 'Zapdos', rank: 1 }] },
			{ member: 'Garchomp', counters: [{ pokemon: 'Zapdos', rank: 4 }] },
		]);
	});

	it('keeps a member\'s own row even with no counters data at all, as an empty list', () => {
		const rows = buildMemberThreatRows([{ member: 'Incineroar', counters: null }]);
		expect(rows).toEqual([{ member: 'Incineroar', counters: [] }]);
	});

	it('drops malformed counter entries (missing pokemon/rank) without dropping the row', () => {
		const rows = buildMemberThreatRows([
			{ member: 'Garchomp', counters: [null, {}, { pokemon: 'Staraptor' }, { pokemon: 'Sylveon', rank: 1 }] },
		]);
		expect(rows).toEqual([{ member: 'Garchomp', counters: [{ pokemon: 'Sylveon', rank: 1 }] }]);
	});

	it('returns nothing for an empty roster', () => {
		expect(buildMemberThreatRows([])).toEqual([]);
		expect(buildMemberThreatRows(undefined)).toEqual([]);
	});
});

/** Minimal window.Dex for the threat-reasons tests below — deliberately its own small fixture
 *  rather than reusing the file's shared mockBattleDex() (defined near the top), since these
 *  tests need a Special move and specific type matchups mockBattleDex doesn't define, and
 *  extending a fixture 30+ other tests share is worth avoiding when a local one is this cheap. */
function mockThreatsDex() {
	const moves = {
		'water spout': { exists: true, type: 'Water', category: 'Special', basePower: 150 },
		'brave bird': { exists: true, type: 'Flying', category: 'Physical', basePower: 120 },
		'protect': { exists: true, type: 'Normal', category: 'Status', basePower: 0 },
		// Fictional type assignment (real Detect is Fighting-type) — deliberately given the
		// same type as Water Spout above so a test can prove a Status move is excluded on its
		// own real category, not incidentally excluded for lacking a qualifying type. Mirrors
		// the real bug this guards against: Detect showing as a reason to fear a Water-weak
		// defender purely because Pikalytics' own move data tags every move with a type,
		// Status moves included, with nothing marking "but this one deals zero damage."
		'detect': { exists: true, type: 'Water', category: 'Status', basePower: 0 },
		// Real base powers, real shape — the actual reported case computeThreatMoveReasons'
		// own doc comment names: Basculegion commonly runs both, Aqua Jet's real usage can
		// outrank Wave Crash's, but Wave Crash (120 base power, recoil) is obviously the more
		// threatening of the two next to Aqua Jet's mere 40.
		'aqua jet': { exists: true, type: 'Water', category: 'Physical', basePower: 40 },
		'wave crash': { exists: true, type: 'Water', category: 'Physical', basePower: 120 },
		// Real moves, real shape (type/category/flags) — for effectiveMoveType's own ability/
		// weather tests below.
		'hyper voice': { exists: true, type: 'Normal', category: 'Special', flags: { sound: 1 }, basePower: 90 },
		'weather ball': { exists: true, type: 'Normal', category: 'Special', basePower: 50 },
		// Real base powers, real shape — for stabAdjustedPower's own tests: the actual reported
		// case, a non-STAB Solar Beam (120, Grass — not one of Charizard's own Fire/Flying types)
		// outranking a real STAB Flamethrower (90, Fire) on raw power alone, despite Flamethrower
		// hitting harder in practice (90 * 1.5 STAB = 135 > Solar Beam's un-boosted 120).
		'solar beam': { exists: true, type: 'Grass', category: 'Special', basePower: 120 },
		'flamethrower': { exists: true, type: 'Fire', category: 'Special', basePower: 90 },
	};
	// Fictional defender types, not the real type chart — 'weak' takes super-effective (2x)
	// damage from both Water and Flying (damageTaken code 1, per typeEffectivenessMultiplier's
	// own DAMAGE_TAKEN_MULTIPLIERS), 'neutral' takes exactly 1x from everything (an unlisted
	// attacking type defaults to code 0 -> neutral, same as a real Dex.types entry), 'resists'
	// takes resisted (0.5x, code 2) damage from Water specifically. 'fairyweak'/'fireweak' are
	// super-effective against Fairy/Fire specifically (and nothing else, Normal included) — for
	// proving an ability/weather type conversion is what actually made a move qualify, not the
	// move's own original type.
	const types = {
		weak: { exists: true, damageTaken: { Water: 1, Flying: 1 } },
		neutral: { exists: true, damageTaken: {} },
		resists: { exists: true, damageTaken: { Water: 2 } },
		fairyweak: { exists: true, damageTaken: { Fairy: 1 } },
		fireweak: { exists: true, damageTaken: { Fire: 1 } },
		// Super effective against both Grass and Fire — for proving STAB (not just raw power)
		// decides the ranking between two moves that both already qualify.
		stabtest: { exists: true, damageTaken: { Grass: 1, Fire: 1 } },
	};
	window.Dex = {
		getPokemonIcon: (species) => `background:url(${species})`,
		getTypeIcon: (type) => `<img alt="${type}">`,
		moves: { get: (name) => moves[String(name).toLowerCase()] || { exists: false } },
		types: { get: (name) => types[String(name).toLowerCase()] || { exists: false } },
		// No species known by default (individual tests override window.Dex.species directly
		// when they actually need one, e.g. for a Mega-Stone/STAB scenario) — just present so
		// code that unconditionally calls window.Dex.species.get(...) doesn't throw for tests
		// that don't care about species data at all.
		species: { get: () => ({ exists: false }) },
	};
}

describe('effectiveMoveType', () => {
	afterEach(() => { delete window.Dex; });

	it('leaves a move\'s type unchanged with no ability, an unrelated one, or no window.Dex', () => {
		expect(effectiveMoveType('Hyper Voice', 'Normal', '')).toBe('Normal');
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Intimidate')).toBe('Normal');
		mockThreatsDex();
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Intimidate')).toBe('Normal');
	});

	it('turns a Normal move into the ability\'s own type — Pixilate: Fairy (Sylveon\'s real case)', () => {
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Pixilate')).toBe('Fairy');
	});

	it('normalizes a lowercase moveType before comparing — real Pikalytics move data sends "normal", not "Normal" (the actual live Sylveon-vs-Tyranitar bug)', () => {
		expect(effectiveMoveType('Hyper Voice', 'normal', 'Pixilate')).toBe('Fairy');
	});

	it('returns a Titlecase type even when nothing converts it, regardless of the input\'s own case', () => {
		expect(effectiveMoveType('Water Spout', 'water', '')).toBe('Water');
	});

	it('does the same for Aerilate/Galvanize/Refrigerate', () => {
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Aerilate')).toBe('Flying');
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Galvanize')).toBe('Electric');
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Refrigerate')).toBe('Ice');
	});

	it('never converts a move that isn\'t actually Normal-type, even with a converting ability', () => {
		expect(effectiveMoveType('Water Spout', 'Water', 'Pixilate')).toBe('Water');
	});

	it('Normalize converts any move to Normal, not just Normal ones', () => {
		expect(effectiveMoveType('Water Spout', 'Water', 'Normalize')).toBe('Normal');
	});

	it('Liquid Voice converts a sound-flagged move to Water, real move flags checked via window.Dex', () => {
		mockThreatsDex();
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Liquid Voice')).toBe('Water');
		expect(effectiveMoveType('Water Spout', 'Water', 'Liquid Voice')).toBe('Water'); // already Water, no-op either way
	});

	it('Liquid Voice leaves a non-sound move alone', () => {
		mockThreatsDex();
		expect(effectiveMoveType('Brave Bird', 'Flying', 'Liquid Voice')).toBe('Flying');
	});

	it('leaves Liquid Voice\'s own sound check unresolved (no conversion) without window.Dex to check flags against', () => {
		expect(effectiveMoveType('Hyper Voice', 'Normal', 'Liquid Voice')).toBe('Normal');
	});

	it('excludes Weather Ball from every type-converting ability — it resolves its own type below instead', () => {
		expect(effectiveMoveType('Weather Ball', 'Normal', 'Pixilate')).toBe('Normal'); // no weather-setter, no conversion either way
	});

	it('sets Weather Ball\'s real type from the weather its own ability sets — Drought: Fire (Charizard\'s real case)', () => {
		expect(effectiveMoveType('Weather Ball', 'Normal', 'Drought')).toBe('Fire');
	});

	it('does the same for the other three weather-setters', () => {
		expect(effectiveMoveType('Weather Ball', 'Normal', 'Drizzle')).toBe('Water');
		expect(effectiveMoveType('Weather Ball', 'Normal', 'Sand Stream')).toBe('Rock');
		expect(effectiveMoveType('Weather Ball', 'Normal', 'Snow Warning')).toBe('Ice');
	});

	it('leaves Weather Ball at its own listed type with no weather-setting ability', () => {
		expect(effectiveMoveType('Weather Ball', 'Normal', 'Blaze')).toBe('Normal');
		expect(effectiveMoveType('Weather Ball', 'Normal', '')).toBe('Normal');
	});
});

describe('isDamagingMove', () => {
	afterEach(() => { delete window.Dex; });

	it('is true for a real Physical/Special move', () => {
		mockThreatsDex();
		expect(isDamagingMove('Water Spout')).toBe(true);
		expect(isDamagingMove('Brave Bird')).toBe(true);
	});

	it('is false for a real Status move, regardless of its own flavor type', () => {
		mockThreatsDex();
		expect(isDamagingMove('Protect')).toBe(false);
		expect(isDamagingMove('Detect')).toBe(false);
	});

	it('is false without window.Dex — an unverifiable claim is worse than a skipped one', () => {
		expect(isDamagingMove('Water Spout')).toBe(false);
	});

	it('is false for a move Dex doesn\'t recognize', () => {
		mockThreatsDex();
		expect(isDamagingMove('Not A Real Move')).toBe(false);
	});
});

describe('movePower', () => {
	afterEach(() => { delete window.Dex; });

	it('reads a move\'s own real base power', () => {
		mockThreatsDex();
		expect(movePower('Wave Crash')).toBe(120);
		expect(movePower('Aqua Jet')).toBe(40);
	});

	it('is 0 for a move Dex can\'t confirm a real base power for, or without window.Dex at all', () => {
		mockThreatsDex();
		expect(movePower('Not A Real Move')).toBe(0);
		delete window.Dex;
		expect(movePower('Wave Crash')).toBe(0);
	});

	it('doubles Weather Ball\'s real 50 power to 100 under a real weather-setting ability', () => {
		mockThreatsDex();
		expect(movePower('Weather Ball', 'Drought')).toBe(100);
		expect(movePower('Weather Ball', 'Drizzle')).toBe(100);
	});

	it('leaves Weather Ball at its bare 50 power with no weather-setting ability, and leaves every other move alone regardless of ability', () => {
		mockThreatsDex();
		expect(movePower('Weather Ball')).toBe(50);
		expect(movePower('Weather Ball', 'Torrent')).toBe(50); // a real ability, just not a weather-setter
		expect(movePower('Wave Crash', 'Drought')).toBe(120); // unrelated move, unaffected
	});
});

describe('stabAdjustedPower', () => {
	it('multiplies by 1.5 when the type is one of the attacker\'s own real types', () => {
		expect(stabAdjustedPower(90, 'Fire', ['Fire', 'Flying'])).toBe(135);
	});

	it('leaves power unchanged when the type isn\'t one of the attacker\'s own types', () => {
		expect(stabAdjustedPower(120, 'Grass', ['Fire', 'Flying'])).toBe(120);
	});

	it('leaves power unchanged with no/empty attackerTypes', () => {
		expect(stabAdjustedPower(90, 'Fire', [])).toBe(90);
		expect(stabAdjustedPower(90, 'Fire', undefined)).toBe(90);
	});
});

describe('computeThreatMoveReasons', () => {
	afterEach(() => { delete window.Dex; });

	it('ranks by real base power first, not usage — Wave Crash (120) beats Aqua Jet (40) despite lower usage (the real reported Basculegion case)', () => {
		mockThreatsDex();
		const moves = [
			{ move: 'Aqua Jet', percent: '80', type: 'Water' }, // higher usage, weaker
			{ move: 'Wave Crash', percent: '60', type: 'Water' }, // lower usage, obviously more threatening
		];
		expect(computeThreatMoveReasons(moves, ['weak'])).toEqual([
			{ move: 'Wave Crash', type: 'Water', percent: 60 },
			{ move: 'Aqua Jet', type: 'Water', percent: 80 },
		]);
	});

	it('ranks by real STAB-adjusted power, not raw power — a Fire-type Charizard\'s Flamethrower (90 * 1.5 STAB = 135) beats its own non-STAB Solar Beam (120 raw)', () => {
		mockThreatsDex();
		const moves = [
			{ move: 'Solar Beam', percent: '90', type: 'Grass' }, // 120 raw power, not one of Charizard's own types
			{ move: 'Flamethrower', percent: '90', type: 'Fire' }, // 90 raw power, but real STAB on a Fire-type attacker
		];
		// 'stabtest' is super effective against both Grass and Fire, so both already qualify —
		// this isolates the ranking itself, not which moves clear the >=2x bar.
		expect(computeThreatMoveReasons(moves, ['stabtest'], '', ['Fire', 'Flying'])).toEqual([
			{ move: 'Flamethrower', type: 'Fire', percent: 90 },
			{ move: 'Solar Beam', type: 'Grass', percent: 90 },
		]);
	});

	it('breaks a real power tie by usage percent', () => {
		mockThreatsDex();
		// Wave Crash and Brave Bird are both real 120-power moves, and 'weak' is super effective
		// against both their types (Water/Flying) — a genuine power tie, broken by usage.
		const moves = [
			{ move: 'Wave Crash', percent: '40', type: 'Water' },
			{ move: 'Brave Bird', percent: '75', type: 'Flying' },
		];
		expect(computeThreatMoveReasons(moves, ['weak']).map((r) => r.move)).toEqual(['Brave Bird', 'Wave Crash']);
	});

	it('caps the result at TEAM_THREATS_MAX_MOVE_REASONS (2) even with more real qualifying moves than that', () => {
		mockThreatsDex();
		const moves = [
			{ move: 'Water Spout', percent: '90', type: 'Water' }, // 150 power
			{ move: 'Wave Crash', percent: '90', type: 'Water' }, // 120 power
			{ move: 'Aqua Jet', percent: '90', type: 'Water' }, // 40 power — should be dropped
		];
		const reasons = computeThreatMoveReasons(moves, ['weak']);
		expect(reasons).toHaveLength(2);
		expect(reasons.map((r) => r.move)).toEqual(['Water Spout', 'Wave Crash']);
	});

	it('ignores a super-effective move below the commonly-used usage threshold', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '10', type: 'Water' }]; // below 20%
		expect(computeThreatMoveReasons(moves, ['weak'])).toEqual([]);
	});

	it('returns [] when nothing is super effective', () => {
		mockThreatsDex();
		const moves = [{ move: 'Protect', percent: '90', type: 'Normal' }];
		expect(computeThreatMoveReasons(moves, ['weak'])).toEqual([]);
	});

	it('never credits a Status move, even one whose own flavor type would otherwise be super effective (the real Detect-vs-Tyranitar bug)', () => {
		mockThreatsDex();
		const moves = [{ move: 'Detect', percent: '90', type: 'Water' }]; // Status — see mockThreatsDex's own comment
		expect(computeThreatMoveReasons(moves, ['weak'])).toEqual([]);
	});

	it('checks a move\'s real effective type, not its bare listed one — Pixilate Sylveon\'s Hyper Voice reads as Fairy', () => {
		mockThreatsDex();
		// Lowercase 'normal', matching real Pikalytics move data exactly (confirmed live) — not
		// 'Normal': an earlier version of this test used the wrong (Titlecase) shape and so
		// didn't actually catch effectiveMoveType's own real case-sensitivity bug.
		const moves = [{ move: 'Hyper Voice', percent: '90', type: 'normal' }];
		// 'fairyweak' is only super effective against Fairy — Normal alone wouldn't qualify.
		expect(computeThreatMoveReasons(moves, ['fairyweak'], 'Pixilate')).toEqual([{ move: 'Hyper Voice', type: 'Fairy', percent: 90 }]);
		expect(computeThreatMoveReasons(moves, ['fairyweak'])).toEqual([]); // no ability given -> stays Normal, doesn't qualify
	});

	it('checks Weather Ball\'s real weather-driven type — Drought Charizard\'s Weather Ball reads as Fire', () => {
		mockThreatsDex();
		const moves = [{ move: 'Weather Ball', percent: '90', type: 'Normal' }];
		expect(computeThreatMoveReasons(moves, ['fireweak'], 'Drought')).toEqual([{ move: 'Weather Ball', type: 'Fire', percent: 90 }]);
		expect(computeThreatMoveReasons(moves, ['fireweak'])).toEqual([]); // no weather-setter -> stays Normal, doesn't qualify
	});

	it('returns [] for empty/missing moves', () => {
		mockThreatsDex();
		expect(computeThreatMoveReasons([], ['weak'])).toEqual([]);
		expect(computeThreatMoveReasons(undefined, ['weak'])).toEqual([]);
	});

	it('excludes a move the defender is flatly immune to via its own real ability, even though it would otherwise be super effective', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '90', type: 'Water' }];
		// 'weak' is super effective (2x) against Water by typing alone — but a real Water Absorb
		// holder is genuinely immune to it regardless, the exact Biggest Threats bug this
		// defenderAbility parameter fixes (it used to be silently dropped entirely).
		expect(computeThreatMoveReasons(moves, ['weak'], '', [], null, 'Water Absorb')).toEqual([]);
	});

	it('credits a move that only qualifies once a real extra-weakness ability (Fluffy) is factored in', () => {
		mockThreatsDex();
		// Fictional 'neutral' defender types make Flamethrower merely neutral (1x) by typing
		// alone — not enough to qualify — but a real Fluffy holder takes double Fire damage.
		const moves = [{ move: 'Flamethrower', percent: '90', type: 'Fire' }];
		expect(computeThreatMoveReasons(moves, ['neutral'], '', [], null, 'Fluffy')).toEqual([
			{ move: 'Flamethrower', type: 'Fire', percent: 90 },
		]);
		expect(computeThreatMoveReasons(moves, ['neutral'])).toEqual([]); // no defender ability -> stays neutral, doesn't qualify
	});
});

describe('threatHasMoveOfCategory', () => {
	afterEach(() => { delete window.Dex; });

	it('is true when a commonly-used move of that category exists', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '40', type: 'Water' }];
		expect(threatHasMoveOfCategory(moves, 'Special')).toBe(true);
	});

	it('is false when the only matching move is below the usage threshold', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '5', type: 'Water' }];
		expect(threatHasMoveOfCategory(moves, 'Special')).toBe(false);
	});

	it('is false when no move of that category is present', () => {
		mockThreatsDex();
		const moves = [{ move: 'Protect', percent: '90', type: 'Normal' }];
		expect(threatHasMoveOfCategory(moves, 'Special')).toBe(false);
	});

	it('is false without window.Dex — an unverifiable claim is worse than a skipped one', () => {
		const moves = [{ move: 'Water Spout', percent: '90', type: 'Water' }];
		expect(threatHasMoveOfCategory(moves, 'Special')).toBe(false);
	});
});

describe('computeThreatSpeedReason', () => {
	afterEach(() => { delete window.Dex; });

	it('credits a natural outspeed backed by a real, commonly-used non-resisted move', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: null };
		const defender = { types: ['neutral'], speed: 100 };
		expect(computeThreatSpeedReason(threat, defender)).toEqual(
			{ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: false });
	});

	it('checks a move\'s real effective type via threat.ability — outspeeding with a Pixilate Hyper Voice reports Fairy, not Normal', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Hyper Voice', percent: '90', type: 'Normal' }], ability: 'Pixilate', baseSpeed: 150, scarfSpeed: null };
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 })).toEqual(
			{ kind: 'speed', move: 'Hyper Voice', type: 'Fairy', percent: 90, viaScarf: false });
	});

	it('never credits an outspeed on a Status move alone — outspeeding and using Detect doesn\'t connect for damage', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Detect', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: null };
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 })).toBeNull();
	});

	it('credits an outspeed that only holds with a real, common-enough Choice Scarf', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 80, scarfSpeed: 120 };
		const defender = { types: ['neutral'], speed: 100 };
		expect(computeThreatSpeedReason(threat, defender)).toEqual(
			{ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: true });
	});

	it('prefers the natural (non-Scarf) outspeed when both would clear it', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: 225 };
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 }).viaScarf).toBe(false);
	});

	it('returns null when not even Scarf is enough to outspeed', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 80, scarfSpeed: 90 };
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 })).toBeNull();
	});

	it('returns null when it outspeeds but every real move is resisted', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: null };
		expect(computeThreatSpeedReason(threat, { types: ['resists'], speed: 100 })).toBeNull();
	});

	it('returns null when it outspeeds but the defender\'s own real ability blocks the only backing move outright', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: null };
		// 'neutral' typing alone would qualify (1x, the >=1 bar this function uses) — but a real
		// Water Absorb holder takes 0, so "outspeeds" alone isn't a real threat here.
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100, ability: 'Water Absorb' })).toBeNull();
	});

	it('returns null when the only backing move is below the commonly-used usage threshold', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '10', type: 'Water' }], baseSpeed: 150, scarfSpeed: null };
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 })).toBeNull();
	});

	it('returns null without a real defender Speed to compare against', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: null };
		expect(computeThreatSpeedReason(threat, { types: ['neutral'], speed: null })).toBeNull();
	});

	it('picks the highest-*power* qualifying move among several, not the highest-usage one', () => {
		mockThreatsDex();
		const threat = {
			moves: [
				{ move: 'Water Spout', percent: '40', type: 'Water' }, // 150 power, lower usage
				{ move: 'Brave Bird', percent: '75', type: 'Flying' }, // 120 power, higher usage
			],
			baseSpeed: 150,
			scarfSpeed: null,
		};
		const reason = computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 });
		expect(reason.move).toBe('Water Spout');
	});

	it('breaks a real power tie by usage percent', () => {
		mockThreatsDex();
		const threat = {
			// Wave Crash and Brave Bird are both real 120-power moves.
			moves: [
				{ move: 'Wave Crash', percent: '40', type: 'Water' },
				{ move: 'Brave Bird', percent: '75', type: 'Flying' },
			],
			baseSpeed: 150,
			scarfSpeed: null,
		};
		const reason = computeThreatSpeedReason(threat, { types: ['neutral'], speed: 100 });
		expect(reason.move).toBe('Brave Bird');
	});

	it('ranks by real STAB-adjusted power, not raw power, when picking the outspeed move', () => {
		mockThreatsDex();
		const threat = {
			moves: [
				{ move: 'Solar Beam', percent: '90', type: 'Grass' }, // 120 raw, no STAB for this attacker
				{ move: 'Flamethrower', percent: '90', type: 'Fire' }, // 90 raw * 1.5 STAB = 135
			],
			types: ['Fire', 'Flying'],
			baseSpeed: 150,
			scarfSpeed: null,
		};
		const reason = computeThreatSpeedReason(threat, { types: ['stabtest'], speed: 100 });
		expect(reason.move).toBe('Flamethrower');
	});
});

describe('computeThreatReasons', () => {
	afterEach(() => { delete window.Dex; });

	it('leads with the named move reason, then a gated physical/special stat reason', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '90', type: 'Water' }]; // Special
		const threat = { moves, atk: 60, spa: 150 };
		const defender = { types: ['weak'], def: 100, spd: 90 }; // spa/spd = 1.67 >= threshold; atk/def doesn't qualify
		const reasons = computeThreatReasons(threat, defender);
		expect(reasons).toEqual([
			{ kind: 'move', move: 'Water Spout', type: 'Water', percent: 90 },
			{ kind: 'stat', text: 'High Special Attack vs Low Special Defense' },
		]);
	});

	it('shows only the speed reason, not also the move reason, when the threat both outspeeds and has a super-effective move', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '90', type: 'Water' }]; // Special
		const threat = { moves, atk: 60, spa: 200, baseSpeed: 150, scarfSpeed: null };
		// Super effective (would otherwise be a move reason), outspeeds (speed reason), and a
		// qualifying special mismatch (stat reason, backed by the same Special move) all at
		// once — the speed reason already shows this exact move (with its own type icon), so
		// restating "also super effective" as a separate line would just be the same fact twice.
		const defender = { types: ['weak'], def: 100, spd: 50, speed: 100 };
		expect(computeThreatReasons(threat, defender)).toEqual([
			{ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: false },
			{ kind: 'stat', text: 'High Special Attack vs Low Special Defense' },
		]);
	});

	it('shows a second, genuinely different move reason alongside the speed reason, excluding only the exact move the speed reason already named', () => {
		mockThreatsDex();
		const moves = [
			{ move: 'Water Spout', percent: '90', type: 'Water' }, // 150 power — top pick for both speed and move reasons
			{ move: 'Brave Bird', percent: '80', type: 'Flying' }, // 120 power — a real second option
		];
		const threat = { moves, baseSpeed: 150, scarfSpeed: null };
		const defender = { types: ['weak'], speed: 100 };
		expect(computeThreatReasons(threat, defender)).toEqual([
			{ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: false },
			{ kind: 'move', move: 'Brave Bird', type: 'Flying', percent: 80 },
		]);
	});

	it('backfills a third, genuinely different move reason when the speed reason\'s own move is one of the top two by power', () => {
		mockThreatsDex();
		const moves = [
			{ move: 'Water Spout', percent: '90', type: 'Water' }, // 150 power — top pick, also the speed reason's move
			{ move: 'Wave Crash', percent: '80', type: 'Water' }, // 120 power — 2nd by power
			{ move: 'Brave Bird', percent: '70', type: 'Flying' }, // 120 power — 3rd by power/percent tiebreak
		];
		const threat = { moves, baseSpeed: 150, scarfSpeed: null };
		const defender = { types: ['weak'], speed: 100 };
		// Excluding Water Spout (already named by the speed reason) has to happen before ranking
		// down to the top two, not after — otherwise Brave Bird would be silently dropped even
		// though there's room to show it alongside Wave Crash.
		expect(computeThreatReasons(threat, defender)).toEqual([
			{ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: false },
			{ kind: 'move', move: 'Wave Crash', type: 'Water', percent: 80 },
			{ kind: 'move', move: 'Brave Bird', type: 'Flying', percent: 70 },
		]);
	});

	it('falls back to the plain move reason when there is no speed reason at all', () => {
		mockThreatsDex();
		const moves = [{ move: 'Water Spout', percent: '90', type: 'Water' }];
		// Super effective, but doesn't outspeed either way (no baseSpeed/scarfSpeed given) — the
		// move reason is the only thing left to show for this matchup.
		const threat = { moves, atk: 60, spa: 60 };
		const defender = { types: ['weak'], def: 100, spd: 100, speed: 100 };
		expect(computeThreatReasons(threat, defender)).toEqual([
			{ kind: 'move', move: 'Water Spout', type: 'Water', percent: 90 },
		]);
	});

	it('omits a stat reason when the ratio does not clear the threshold', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], atk: 60, spa: 100 };
		const defender = { types: ['neutral'], def: 100, spd: 90 }; // 100/90 = 1.11, below 1.5
		expect(computeThreatReasons(threat, defender)).toEqual([]);
	});

	it('omits a stat reason when there is no backing move of that category, even with a big ratio', () => {
		mockThreatsDex();
		const threat = { moves: [{ move: 'Protect', percent: '90', type: 'Normal' }], atk: 60, spa: 200 };
		const defender = { types: ['neutral'], def: 100, spd: 50 }; // 200/50 = 4x, but no Special move on record
		expect(computeThreatReasons(threat, defender)).toEqual([]);
	});

	it('skips stat reasons entirely when the offensive stat is null (no spread data to derive one)', () => {
		mockThreatsDex();
		const threat = { moves: [], atk: null, spa: null };
		expect(computeThreatReasons(threat, { types: ['weak'], def: 10, spd: 10 })).toEqual([]);
	});

	it('reports no reasons at all against a defender whose real ability blocks every qualifying move — the fixed Water Absorb bug', () => {
		mockThreatsDex();
		// 'weak' would otherwise make Water Spout both a speed reason (outspeeds, >=1x) and a
		// move reason (>=2x) — a real Water Absorb holder should show neither, since the move
		// deals 0 damage regardless of typing or Speed.
		const threat = { moves: [{ move: 'Water Spout', percent: '90', type: 'Water' }], baseSpeed: 150, scarfSpeed: null, atk: 60, spa: 60 };
		const defender = { types: ['weak'], def: 100, spd: 100, speed: 100, ability: 'Water Absorb' };
		expect(computeThreatReasons(threat, defender)).toEqual([]);
	});
});

describe('computeThreatOffense', () => {
	afterEach(() => { delete window.Dex; });

	it('derives real atk/spa/baseSpeed from the top spread + nature via tbRoom.getStat, no item', () => {
		mockThreatsDex();
		window.Dex.items = { get: () => ({ exists: false }) };
		const getStat = vi.fn((stat) => (stat === 'atk' ? 120 : stat === 'spa' ? 80 : 999));
		const tbRoom = { curSetList: [{ species: 'Whatever', level: 50 }], getStat };
		const mon = { moves: [], spreads: [{ ev: '252/0/0/0/4/252', percent: '50' }], natures: [{ nature: 'Timid', percent: '50' }] };
		const offense = computeThreatOffense(tbRoom, 'Staraptor', mon);
		expect(getStat).toHaveBeenCalledWith('atk', expect.objectContaining({ species: 'Staraptor', nature: 'Timid' }));
		expect(offense.atk).toBe(120);
		expect(offense.spa).toBe(80);
	});

	it('extracts the species\' own top real ability when it isn\'t commonly built as a Mega', () => {
		mockThreatsDex();
		window.Dex.items = { get: () => ({ exists: false }) };
		const mon = {
			moves: [], spreads: [],
			abilities: [{ ability: 'Pixilate', percent: '95.0' }, { ability: 'Cute Charm', percent: '5.0' }],
		};
		expect(computeThreatOffense({}, 'Sylveon', mon).ability).toBe('Pixilate');
	});

	it('leaves every numeric field null (skipping stat reasons downstream) when there is no spread data', () => {
		mockThreatsDex();
		window.Dex.items = { get: () => ({ exists: false }) };
		const offense = computeThreatOffense({}, 'Staraptor', { moves: [] });
		expect(offense).toMatchObject({ atk: null, spa: null, baseSpeed: null, scarfSpeed: null });
	});

	it('only credits scarfSpeed when the species\' own real Scarf usage clears the threshold', () => {
		mockThreatsDex();
		window.Dex.items = { get: () => ({ exists: false }) };
		const getStat = () => 100;
		const tbRoom = { curSetList: [{ level: 50 }], getStat };
		const baseMon = { moves: [], spreads: [{ ev: '0/0/0/0/0/252', percent: '50' }], natures: [{ nature: 'Timid', percent: '50' }] };

		const belowThreshold = computeThreatOffense(tbRoom, 'Staraptor',
			Object.assign({}, baseMon, { items: [{ item: 'Choice Scarf', percent: '2' }] })); // under the 5% default
		expect(belowThreshold.scarfSpeed).toBeNull();

		const aboveThreshold = computeThreatOffense(tbRoom, 'Staraptor',
			Object.assign({}, baseMon, { items: [{ item: 'Choice Scarf', percent: '30' }] }));
		expect(aboveThreshold.scarfSpeed).toBe(150); // floor(100 * 1.5)
	});

	it('uses the Mega forme\'s own real base stats/types/fixed ability once its Mega Stone clears the threshold', () => {
		mockThreatsDex();
		window.Dex.items = {
			get: (name) => (String(name).toLowerCase() === 'charizardite y' ?
				{ exists: true, megaStone: { Charizard: 'Charizard-Mega-Y' } } : { exists: false }),
		};
		window.Dex.species = {
			get: (name) => (name === 'Charizard-Mega-Y' ?
				{ exists: true, types: ['Fire', 'Flying'], abilities: { 0: 'Drought' } } : { exists: false }),
		};
		const getStat = vi.fn((stat, set) => (set.species === 'Charizard-Mega-Y' ? 140 : 10));
		const tbRoom = { curSetList: [{ level: 50 }], getStat };
		const mon = {
			moves: [], spreads: [{ ev: '0/0/0/252/0/252', percent: '50' }], natures: [{ nature: 'Timid', percent: '50' }],
			// Pikalytics' own usage-sorted ability list still reflects the base forme's own
			// pre-Mega choices (Blaze/Solar Power) — real Mega Evolution always overrides these
			// with its own single fixed ability, so this list must NOT be what wins here.
			abilities: [{ ability: 'Blaze', percent: '60.0' }, { ability: 'Solar Power', percent: '40.0' }],
			items: [{ item: 'Charizardite Y', percent: '55.0' }],
		};
		const offense = computeThreatOffense(tbRoom, 'Charizard', mon);
		expect(offense.ability).toBe('Drought'); // the Mega's own real fixed ability, not Blaze
		expect(offense.types).toEqual(['Fire', 'Flying']);
		expect(offense.baseSpeed).toBe(140); // computed against the Mega forme's own species name
		expect(getStat).toHaveBeenCalledWith('spe', expect.objectContaining({ species: 'Charizard-Mega-Y' }));
		expect(offense.scarfSpeed).toBeNull(); // can't hold a Mega Stone and Choice Scarf at once
	});

	it('ignores a Mega Stone that doesn\'t clear the popularity threshold, staying on the base forme', () => {
		mockThreatsDex();
		window.Dex.items = {
			get: (name) => (String(name).toLowerCase() === 'charizardite y' ?
				{ exists: true, megaStone: { Charizard: 'Charizard-Mega-Y' } } : { exists: false }),
		};
		window.Dex.species = { get: () => ({ exists: true, types: ['Fire', 'Flying'] }) };
		const mon = {
			moves: [], spreads: [{ ev: '0/0/0/252/0/252', percent: '50' }], natures: [{ nature: 'Timid', percent: '50' }],
			abilities: [{ ability: 'Blaze', percent: '90.0' }],
			items: [{ item: 'Charizardite Y', percent: '5.0' }], // under the 15% default megaThresholdPercent
		};
		const tbRoom = { curSetList: [{ level: 50 }], getStat: () => 100 };
		expect(computeThreatOffense(tbRoom, 'Charizard', mon).ability).toBe('Blaze');
	});

	it('picks the base forme with a real Scarf build over a Mega Stone when Scarf is the more popular real item', () => {
		mockThreatsDex();
		window.Dex.items = {
			get: (name) => (String(name).toLowerCase() === 'charizardite y' ?
				{ exists: true, megaStone: { Charizard: 'Charizard-Mega-Y' } } :
				String(name).toLowerCase() === 'choice scarf' ? { exists: true } : { exists: false }),
		};
		window.Dex.species = { get: () => ({ exists: true, types: ['Fire', 'Flying'] }) };
		const mon = {
			moves: [], spreads: [{ ev: '0/0/0/0/0/252', percent: '50' }], natures: [{ nature: 'Timid', percent: '50' }],
			abilities: [{ ability: 'Blaze', percent: '90.0' }],
			items: [{ item: 'Charizardite Y', percent: '30.0' }, { item: 'Choice Scarf', percent: '45.0' }],
		};
		const tbRoom = { curSetList: [{ level: 50 }], getStat: () => 100 };
		const offense = computeThreatOffense(tbRoom, 'Charizard', mon);
		expect(offense.ability).toBe('Blaze'); // base forme's own top real ability, not the Mega's
		expect(offense.scarfSpeed).toBe(150); // floor(100 * 1.5) — the Scarf build IS credited here
	});
});

describe('computeMemberDefense', () => {
	afterEach(() => { delete window.Dex; });

	it('reads real def/spd/types/speed/ability from the member\'s own set, folding its own held item into Speed', () => {
		window.Dex = {
			items: { get: () => ({ exists: false }) },
			species: { get: (name) => (name === 'Sceptile' ? { exists: true, types: ['Grass', 'Poison'] } : { exists: false }) },
		};
		const memberSet = { species: 'Sceptile', item: 'Choice Scarf', ability: 'Overgrow', evs: {}, nature: '' };
		const getStat = (stat, set) => {
			expect(set).toBe(memberSet);
			return stat === 'def' ? 60 : stat === 'spd' ? 90 : 100; // spe: 100
		};
		const tbRoom = { getStat };
		const defense = computeMemberDefense(tbRoom, memberSet);
		expect(defense).toEqual({ types: ['Grass', 'Poison'], def: 60, spd: 90, speed: 150, ability: 'Overgrow' }); // floor(100 * 1.5)
	});

	it('resolves a Mega-Stone holder to the Mega forme\'s own types/stats/ability before reading them', () => {
		window.Dex = {
			items: { get: (name) => (String(name).toLowerCase() === 'blastoisinite' ? { exists: true, megaStone: { Blastoise: 'Blastoise-Mega' } } : { exists: false }) },
			species: { get: (name) => (name === 'Blastoise-Mega' ? { exists: true, types: ['Water'], abilities: { 0: 'Mega Launcher' } } : { exists: false }) },
		};
		// The base build's own chosen ability (Torrent) is irrelevant once it's Mega'd — the Mega
		// forme's own fixed ability (resolveMemberAbility) is what should come back instead, the
		// same override computeTeamDefensiveProfile already applies for the Defensive Profile matrix.
		const memberSet = { species: 'Blastoise', item: 'Blastoisinite', ability: 'Torrent', evs: {}, nature: '' };
		const getStat = (stat, set) => {
			expect(set.species).toBe('Blastoise-Mega');
			return 50;
		};
		const tbRoom = { getStat };
		const defense = computeMemberDefense(tbRoom, memberSet);
		expect(defense.types).toEqual(['Water']);
		expect(defense.ability).toBe('Mega Launcher');
	});
});

describe('buildTeamThreatCounterHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('renders an icon-only square with no visible name, indexed for hover lookup by (member, counter)', () => {
		const html = buildTeamThreatCounterHTML({ pokemon: 'Staraptor', rank: 1, reasons: [] }, 2, 3);
		expect(html).toContain('cf-teamthreats-counter');
		expect(html).toContain('data-cf-teamthreats-member-idx="2"');
		expect(html).toContain('data-cf-teamthreats-counter-idx="3"');
		expect(html).not.toContain('Staraptor'); // no visible name — detail lives in the hover tooltip
	});
});

describe('buildTeamThreatMemberRowHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('renders the member\'s own sprite followed by one counter sprite per real counter', () => {
		const row = {
			member: 'Incineroar',
			counters: [{ pokemon: 'Staraptor', rank: 1, reasons: [] }, { pokemon: 'Sylveon', rank: 2, reasons: [] }],
		};
		const html = buildTeamThreatMemberRowHTML(row, 0);
		expect(html).toContain('cf-teamthreats-row');
		expect(html).toContain('cf-teamthreats-member');
		expect(html).toContain('title="Incineroar"');
		expect((html.match(/cf-teamthreats-counter"/g) || []).length).toBe(2);
		expect(html).toContain('data-cf-teamthreats-counter-idx="0"');
		expect(html).toContain('data-cf-teamthreats-counter-idx="1"');
	});

	it('shows a plain note instead of an empty strip when the member has no counter data', () => {
		const html = buildTeamThreatMemberRowHTML({ member: 'Incineroar', counters: [] }, 0);
		expect(html).toContain('No counter data.');
		expect(html).not.toContain('cf-teamthreats-counter"');
	});
});

describe('buildTeamThreatsSectionHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('shows the empty-state message when there are no rows at all', () => {
		expect(buildTeamThreatsSectionHTML([])).toContain('No threat data for this format.');
	});

	it('renders one row per member, in order, with no cap on how many counters a row can hold', () => {
		const rows = [
			{ member: 'Incineroar', counters: Array.from({ length: 10 }, (_, i) => ({ pokemon: 'Mon' + i, rank: i + 1, reasons: [] })) },
			{ member: 'Garchomp', counters: [{ pokemon: 'Sylveon', rank: 1, reasons: [] }] },
		];
		const html = buildTeamThreatsSectionHTML(rows);
		expect(html).toContain('cf-teamthreats-rows');
		expect((html.match(/cf-teamthreats-row"/g) || []).length).toBe(2);
		expect((html.match(/cf-teamthreats-counter"/g) || []).length).toBe(11); // all 10 + the 1, nothing capped
		expect(html).toContain('data-cf-teamthreats-member-idx="0"');
		expect(html).toContain('data-cf-teamthreats-member-idx="1"');
	});
});

describe('buildTeamThreatReasonCellHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('renders a move reason with its real type icon, name, and usage percent', () => {
		window.Dex = { getTypeIcon: (type) => `<img alt="${type}">` };
		const html = buildTeamThreatReasonCellHTML({ kind: 'move', move: 'Brave Bird', type: 'Flying', percent: 80 });
		expect(html).toContain('<img alt="Flying">');
		expect(html).toContain('Brave Bird');
		expect(html).toContain('80%');
	});

	it('renders a plain stat reason with no icon', () => {
		const html = buildTeamThreatReasonCellHTML({ kind: 'stat', text: 'High Attack vs Low Defense' });
		expect(html).toContain('High Attack vs Low Defense');
		expect(html).toContain('cf-teamthreats-reason-stat');
	});

	it('renders a speed reason with an "Outspeeds" label and no Scarf note when it holds unconditionally', () => {
		window.Dex = { getTypeIcon: (type) => `<img alt="${type}">` };
		const html = buildTeamThreatReasonCellHTML({ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: false });
		expect(html).toContain('Outspeeds');
		expect(html).toContain('<img alt="Water">');
		expect(html).toContain('Water Spout');
		expect(html).toContain('90%');
		expect(html).not.toContain('needs Scarf');
	});

	it('adds a "(needs Scarf)" note right alongside "Outspeeds", not trailing after the move name/percent', () => {
		window.Dex = { getTypeIcon: (type) => `<img alt="${type}">` };
		const html = buildTeamThreatReasonCellHTML({ kind: 'speed', move: 'Water Spout', type: 'Water', percent: 90, viaScarf: true });
		expect(html).toContain('needs Scarf');
		// The qualifier is about the outspeed claim itself, not the move backing it up — it has
		// to land inside/next to the "Outspeeds" label, before the move's own name and percent,
		// not after them where it would read as qualifying the move instead.
		const outspeedsIdx = html.indexOf('Outspeeds');
		const scarfIdx = html.indexOf('needs Scarf');
		const moveNameIdx = html.indexOf('Water Spout');
		const percentIdx = html.indexOf('90%');
		expect(outspeedsIdx).toBeLessThan(scarfIdx);
		expect(scarfIdx).toBeLessThan(moveNameIdx);
		expect(scarfIdx).toBeLessThan(percentIdx);
	});
});

describe('buildTeamThreatTooltipHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('renders a table with one row per reason, for a single (member, counter) pair', () => {
		window.Dex = { getTypeIcon: (type) => `<img alt="${type}">` };
		const counter = {
			pokemon: 'Staraptor',
			rank: 1,
			reasons: [
				{ kind: 'move', move: 'Brave Bird', type: 'Flying', percent: 80 },
				{ kind: 'stat', text: 'High Attack vs Low Defense' },
			],
		};
		const html = buildTeamThreatTooltipHTML(counter);
		expect(html).toContain('Staraptor');
		expect(html).toContain('cf-teamthreats-table');
		expect(html).toContain('Brave Bird');
		expect(html).toContain('High Attack vs Low Defense');
	});

	it('shows "No specific reason found." rather than an empty table when there are no reasons', () => {
		const html = buildTeamThreatTooltipHTML({ pokemon: 'Garchomp', rank: 5, reasons: [] });
		expect(html).toContain('Garchomp');
		expect(html).toContain('No specific reason found.');
	});
});

describe('curRosterSpeciesOrder', () => {
	it('returns real species in slot order, id-normalized, ignoring the blank slot itself', () => {
		const tbRoom = { curSetList: [{ species: 'Incineroar' }, { species: '' }, { species: 'Flutter Mane' }] };
		expect(curRosterSpeciesOrder(tbRoom)).toEqual(['incineroar', 'fluttermane']);
	});
});

describe('alignSimilarTeamPokemon', () => {
	it('places shared species at the roster\'s own index', () => {
		const pokemon = [{ name: 'Garchomp' }, { name: 'Incineroar' }, { name: 'Rillaboom' }];
		const roster = ['incineroar', 'garchomp', 'flutter mane'];
		const aligned = alignSimilarTeamPokemon(pokemon, roster);
		expect(aligned[0].name).toBe('Incineroar'); // roster[0]
		expect(aligned[1].name).toBe('Garchomp'); // roster[1]
	});

	it('loops an unmatched member back into an empty roster slot instead of appending it, keeping the row the same width', () => {
		const pokemon = [{ name: 'Garchomp' }, { name: 'Incineroar' }, { name: 'Rillaboom' }];
		const roster = ['incineroar', 'garchomp', 'flutter mane']; // Flutter Mane not on this team
		const aligned = alignSimilarTeamPokemon(pokemon, roster);
		expect(aligned).toHaveLength(3); // still 3, not 4 — Rillaboom filled Flutter Mane's slot
		expect(aligned[2].name).toBe('Rillaboom');
	});

	it('fills empty slots front to back when there\'s more than one', () => {
		// Roster: A, B, C, D — team only has D; B and C are extras that should loop into A and B's
		// own empty slots in order, front slot first, not into whichever slot happens to be nearest.
		const pokemon = [{ name: 'D' }, { name: 'X' }, { name: 'Y' }];
		const roster = ['a', 'b', 'c', 'd'];
		const aligned = alignSimilarTeamPokemon(pokemon, roster);
		expect(aligned.map((p) => p && p.name)).toEqual(['X', 'Y', null, 'D']);
	});

	it('still spills past the roster length once there are more extras than empty slots (a not-yet-full roster)', () => {
		const pokemon = [{ name: 'Incineroar' }, { name: 'Garchomp' }, { name: 'Rillaboom' }, { name: 'Landorus-Therian' }];
		const roster = ['incineroar']; // only 1 real roster slot so far, 3 extras chasing it
		const aligned = alignSimilarTeamPokemon(pokemon, roster);
		expect(aligned).toHaveLength(4); // the 1 roster slot + 3 that had nowhere to loop back into
		expect(aligned[0].name).toBe('Incineroar');
		expect(aligned.slice(1).map((p) => p.name)).toEqual(['Garchomp', 'Rillaboom', 'Landorus-Therian']);
	});

	it('degrades to plain original order when there\'s no roster to align against', () => {
		const pokemon = [{ name: 'Garchomp' }, { name: 'Incineroar' }];
		expect(alignSimilarTeamPokemon(pokemon, [])).toEqual(pokemon);
		expect(alignSimilarTeamPokemon(pokemon, undefined)).toEqual(pokemon);
	});

	it('sends a repeated roster species past the first match to extras rather than overwriting', () => {
		const pokemon = [{ name: 'Incineroar', item: 'Sitrus Berry' }, { name: 'Incineroar', item: 'Leftovers' }];
		const aligned = alignSimilarTeamPokemon(pokemon, ['incineroar']);
		expect(aligned[0].item).toBe('Sitrus Berry');
		expect(aligned[1].item).toBe('Leftovers');
	});
});

describe('buildSimilarTeamRowHTML / buildSimilarTeamsSectionHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('shows the empty-state message when there are no matches', () => {
		expect(buildSimilarTeamsSectionHTML([])).toContain('No similar teams found yet.');
	});

	it('renders one sprite per team member plus the record, indexed for hover lookup, when there\'s no roster to align to', () => {
		mockDex();
		const match = { record: '13-2', pokemon: [{ name: 'Incineroar' }, { name: 'Garchomp' }] };
		const html = buildSimilarTeamRowHTML(match, 3);
		expect(html).toContain('data-cf-similarteam-idx="3"');
		expect(html).toContain('13-2');
		expect((html.match(/class="picon"/g) || []).length).toBe(2);
		expect(html).not.toContain('cf-similarteam-empty-slot');
	});

	it('fills the row with author + placement + tournament, contextualizing the bare record', () => {
		mockDex();
		const match = {
			record: '13-2', author: 'AyushXD', tournamentRanking: 1,
			tournamentLabel: 'Alpensee x Smogon VGC Tour (Reg M-B) #70',
			pokemon: [{ name: 'Incineroar' }],
		};
		const html = buildSimilarTeamRowHTML(match, 0);
		expect(html).toContain('<span class="cf-similarteam-author">AyushXD</span>');
		expect(html).toContain('1st at Alpensee x Smogon VGC Tour (Reg M-B) #70');
	});

	it('falls back to "Unknown" and omits the tournament line when that data is missing', () => {
		mockDex();
		const html = buildSimilarTeamRowHTML({ pokemon: [{ name: 'Incineroar' }] }, 0);
		expect(html).toContain('<span class="cf-similarteam-author">Unknown</span>');
		expect(html).not.toContain('cf-similarteam-tournament');
	});

	it('column-aligns to the roster order, with an empty-slot placeholder for a roster species this team lacks', () => {
		mockDex();
		const match = { record: '13-2', pokemon: [{ name: 'Garchomp' }] };
		const html = buildSimilarTeamRowHTML(match, 0, ['incineroar', 'garchomp']);
		// roster[0] (Incineroar) unmatched -> placeholder; roster[1] (Garchomp) matched -> real sprite.
		const spanOrder = [...html.matchAll(/<span class="([^"]*)"/g)].map((m) => m[1]);
		expect(spanOrder).toEqual([
			'cf-similarteam-sprites', 'picon cf-similarteam-empty-slot', 'picon',
			'cf-similarteam-meta', 'cf-similarteam-author', 'cf-pika-pct',
		]);
	});

	it('renders every match it\'s given, with no cap of its own — pagination is the caller\'s job', () => {
		mockDex();
		const matches = Array.from({ length: 15 }, (_, i) => ({ record: `${i}-0`, pokemon: [{ name: 'Incineroar' }] }));
		const html = buildSimilarTeamsSectionHTML(matches);
		expect((html.match(/cf-similarteam-row/g) || []).length).toBe(15);
	});
});

describe('buildSimilarTeamTooltipHTML', () => {
	afterEach(() => { delete window.Dex; });

	it('is just the teamsheet — each Pokémon\'s item/ability/moves, no author/record/share-count header', () => {
		mockDex();
		const match = {
			author: 'AyushXD', record: '13-2', shared: 2,
			pokemon: [{ name: 'Incineroar', item: 'Sitrus Berry', ability: 'Intimidate', moves: [{ name: 'Fake Out' }, { name: 'Flare Blitz' }] }],
		};
		const html = buildSimilarTeamTooltipHTML(match);
		expect(html).toContain('Intimidate');
		expect(html).toContain('Fake Out<br>Flare Blitz');
		expect(html).not.toContain('AyushXD');
		expect(html).not.toContain('13-2');
		expect(html).not.toContain('shared Pokémon');
		expect(html).not.toContain('<h2>');
	});

	it('shows the held item as a corner badge on the sprite, not as "@ Item" text', () => {
		mockDex();
		const match = { pokemon: [{ name: 'Incineroar', item: 'Sitrus Berry' }] };
		const html = buildSimilarTeamTooltipHTML(match);
		expect(html).toContain('cf-speedcmp-sprite');
		expect(html).toContain('class="itemicon cf-speedcmp-item-badge" style="background:url(Sitrus Berry)"');
		expect(html).not.toContain('@ Sitrus Berry');
	});

	it('omits the item badge entirely when there\'s no held item', () => {
		mockDex();
		const html = buildSimilarTeamTooltipHTML({ pokemon: [{ name: 'Incineroar' }] });
		expect(html).not.toContain('cf-speedcmp-item-badge');
	});

	it('doesn\'t repeat the species name as text — the column\'s own sprite already identifies it', () => {
		mockDex();
		const match = { pokemon: [{ name: 'Incineroar', ability: 'Intimidate' }] };
		const html = buildSimilarTeamTooltipHTML(match);
		expect(html).not.toContain('<strong>');
		expect(html).not.toContain('>Incineroar<');
	});

	it('lays out one column per Pokémon, side by side, instead of stacked rows', () => {
		mockDex();
		const match = { pokemon: [{ name: 'Incineroar' }, { name: 'Garchomp' }, { name: 'Sinistcha' }] };
		const html = buildSimilarTeamTooltipHTML(match);
		expect(html).toContain('cf-similarteam-tooltip-columns');
		expect((html.match(/cf-similarteam-tooltip-col"/g) || []).length).toBe(3);
	});

	it('lists Pokémon in roster-aligned order, dropping unmatched roster slots rather than showing them blank', () => {
		mockDex();
		const match = { author: 'Ash', pokemon: [{ name: 'Garchomp' }, { name: 'Incineroar' }] };
		const html = buildSimilarTeamTooltipHTML(match, ['incineroar', 'garchomp']);
		expect(html.indexOf('Incineroar')).toBeLessThan(html.indexOf('Garchomp'));
	});
});

describe('ordinalLabel', () => {
	it('appends the right suffix for the common cases', () => {
		expect(ordinalLabel(1)).toBe('1st');
		expect(ordinalLabel(2)).toBe('2nd');
		expect(ordinalLabel(3)).toBe('3rd');
		expect(ordinalLabel(4)).toBe('4th');
	});

	it('special-cases 11th/12th/13th rather than following the last-digit rule', () => {
		expect(ordinalLabel(11)).toBe('11th');
		expect(ordinalLabel(12)).toBe('12th');
		expect(ordinalLabel(13)).toBe('13th');
	});

	it('still applies the last-digit rule past the teens (21st, 22nd, 23rd)', () => {
		expect(ordinalLabel(21)).toBe('21st');
		expect(ordinalLabel(22)).toBe('22nd');
		expect(ordinalLabel(23)).toBe('23rd');
	});

	it('returns an empty string for a missing/zero/non-numeric placement, not "0th"/"NaNth"', () => {
		expect(ordinalLabel(undefined)).toBe('');
		expect(ordinalLabel(0)).toBe('');
		expect(ordinalLabel('not a number')).toBe('');
	});
});

describe('buildSpeciesPreviewTooltipHTML', () => {
	it('shows top moves/ability/item, excluding win rate and Common Teammates entirely', () => {
		const mon = {
			moves: [{ move: 'Fake Out', percent: '99.9' }],
			abilities: [{ ability: 'Intimidate', percent: '99.8' }],
			items: [{ item: 'Sitrus Berry', percent: '59.8' }],
			natures: [{ nature: 'Careful', percent: '40.1' }],
			spreads: [{ ev: '32/0/14/0/20/0', percent: '6.2', nature: '' }],
			stats: { hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 },
			winRate: 0.48189114106389547,
			team: [{ pokemon: 'Sinistcha', rank: 1 }],
		};
		const html = buildSpeciesPreviewTooltipHTML(mon, 'Incineroar');
		expect(html).toContain('Incineroar');
		expect(html).toContain('Fake Out (99.9%)');
		expect(html).toContain('Intimidate (99.8%)');
		expect(html).toContain('Sitrus Berry (59.8%)');
		expect(html).toContain('Spe 60');
		expect(html).not.toContain('48.1');
		expect(html).not.toContain('Sinistcha');
	});

	it('shows Nature and Spread as two separate lines, each with its own percent, not merged into one', () => {
		// VGC's own top nature (40.1%) and top EV spread (6.2%) are two independently-ranked
		// facts, not necessarily the same real build — see this function's own doc comment.
		const mon = {
			natures: [{ nature: 'Careful', percent: '40.1' }],
			spreads: [{ ev: '32/0/14/0/20/0', percent: '6.2', nature: '' }],
		};
		const html = buildSpeciesPreviewTooltipHTML(mon, 'Incineroar');
		expect(html).toContain('<strong>Nature</strong><br>Careful (40.1%)');
		expect(html).toContain('<strong>Spread</strong><br>32/0/14/0/20/0 (6.2%)');
		expect(html).not.toContain('Careful 32/0/14/0/20/0');
	});

	it('falls back to the spread\'s own nature field, with no percent, when there\'s no standalone natures list', () => {
		const mon = { spreads: [{ ev: '32/0/14/0/20/0', percent: '6.2', nature: 'Careful' }] };
		const html = buildSpeciesPreviewTooltipHTML(mon, 'Incineroar');
		expect(html).toContain('<strong>Nature</strong><br>Careful</p>');
	});

	it('falls back to "No data" per section rather than omitting it', () => {
		const html = buildSpeciesPreviewTooltipHTML({}, 'Incineroar');
		expect(html).toContain('No data');
	});

	it('shows the Mega forme\'s own base stats, right after the base forme\'s, when a Mega Stone is the popular item', () => {
		mockBattleDex();
		const mon = {
			stats: { hp: 79, atk: 83, def: 100, spa: 85, spd: 105, spe: 78 },
			items: [{ item: 'Blastoisinite', percent: '20.0' }],
		};
		const html = buildSpeciesPreviewTooltipHTML(mon, 'Blastoise');
		expect(html).toContain('HP 79 &nbsp; Atk 83 &nbsp; Def 100 &nbsp; SpA 85 &nbsp; SpD 105 &nbsp; Spe 78'); // base stats, still shown
		expect(html).toContain('<strong>Blastoise-Mega</strong><br>HP 79 &nbsp; Atk 103 &nbsp; Def 120 &nbsp; SpA 135 &nbsp; SpD 115 &nbsp; Spe 78');
	});

	it('omits the Mega stats block when the popular item isn\'t a Mega Stone', () => {
		mockBattleDex();
		const mon = {
			stats: { hp: 79, atk: 83, def: 100, spa: 85, spd: 105, spe: 78 },
			items: [{ item: 'Choice Scarf', percent: '44.7' }],
		};
		const html = buildSpeciesPreviewTooltipHTML(mon, 'Blastoise');
		expect(html).not.toContain('Blastoise-Mega');
	});

	it('omits the Mega stats block when no item clears its popularity threshold at all', () => {
		mockBattleDex();
		const mon = {
			stats: { hp: 79, atk: 83, def: 100, spa: 85, spd: 105, spe: 78 },
			items: [{ item: 'Blastoisinite', percent: '5.0' }],
		};
		const html = buildSpeciesPreviewTooltipHTML(mon, 'Blastoise');
		expect(html).not.toContain('Blastoise-Mega');
	});
});
