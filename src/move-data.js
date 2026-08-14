/**
 * Better Teambuilder for Showdown! — editable move-list data module.
 *
 * Each category in CF_MOVE_CATEGORIES describes a custom teambuilder filter.
 * `moves` entries are looked up by move id (Dex.toID form: lowercase, no spaces/hyphens/apostrophes).
 *
 * - `conditional: false` — the move always grants the tag's effect whenever it's chosen.
 * - `conditional: true` — the move can grant the tag's effect, but only under some extra
 *   condition (field state, turn number, opponent's action, etc). `reason` is shown in the
 *   hover tooltip so the user knows not to take it for granted.
 * - `searchTypes` — which search box(es) the category is offered in: `['pokemon', 'move']`
 *   for team-building-level questions ("which Pokémon should I use"), or `['move']` alone
 *   for categories that only make sense once a specific mon/ability is already locked in
 *   (Iron Fist, Strong Jaw, Sheer Force, etc all only benefit the one Pokémon holding them —
 *   filtering the *Pokémon* list by "has a punching move" doesn't answer a real
 *   teambuilding question the way filtering a chosen Iron Fist mon's *move* list does).
 * - `description` — an object keyed by search type, `{ pokemon: '...', move: '...' }` (only
 *   the keys present in `searchTypes` need to exist). The two readings genuinely need
 *   different grammar, not just different words: in Pokémon search the subject is the
 *   *species* being evaluated ("Has a move that hits all adjacent Pokémon"), but in Move
 *   search the subject is the *move itself*, already sitting in a list of moves that species
 *   can learn ("Hits all adjacent Pokémon") — reusing the Pokémon-search phrasing there reads
 *   like the move is being asked whether it has a move.
 * - `negative` — if true, the filter is an exclusion: a row PASSES when it does NOT match
 *   the category, and applying it never lists specific matched moves in the tooltip (there's
 *   nothing to list — the row was kept for the absence of a match). Currently only
 *   `ballbomb`: nobody picks a move *because* it's ballistic, but you might want to see only
 *   the moves that dodge a Bulletproof matchup.
 * - `kind: 'ability'` — opts a category out of the movepool machinery entirely. Every other
 *   category asks "can this species learn a move that does X", walked via canLearn(). An
 *   ability-kind category instead asks "does this species have a declarable ability that does
 *   X" — a `species.abilities` membership check (content.js's computeAbilityMatches), no
 *   canLearn() involved. Its move-shaped list lives in `abilities` instead of `moves` (still
 *   `{ id, name, conditional, reason? }` — same shape the tooltip already reads, just holding
 *   ability ids instead of move ids). Currently `negatesintimidate` and `weathersetter`;
 *   always Pokémon-only in practice (an ability isn't a "move" a Move-search box would ever be
 *   picking).
 *
 * Legality (whether a given species can actually learn a move in the active format) is NOT
 * decided here — that's handled by the client's own canLearn() walk against
 * BattleTeambuilderTable at query time. This file only decides which move ids are worth
 * checking for each tag.
 *
 * Four ways a category's move list gets built (see content.js buildDynamicMoveLists()):
 *
 * 1. Fully curated (priority, redirection, pivoting, hazard) — `moves` below IS the entire
 *    list. Nothing in BattleMovedex reliably flags "this is a priority move" as a single
 *    boolean (the raw `priority` field alone can't distinguish "always +1" from "0 baseline,
 *    +1 only under Grassy Terrain"), so these stay hand-maintained. Pivoting and hazard join
 *    this group for a different reason: the client-side BattleMovedex genuinely doesn't ship
 *    the `selfSwitch` or `sideCondition` fields at all (verified live — every move consistently
 *    comes back `undefined` for both, not just flaky like the boosts/self issue below), so
 *    there's no field to scan even if the category itself were unambiguous.
 * 2. Fully dynamic (spread, wind, sound, sharpness, recoil, sheerforce, contact, punching,
 *    biting, ballbomb, pulse) — `moves` below is empty by default and only used to *annotate*
 *    (mark conditional / add a reason for) a move the dynamic scan already found; it can't add
 *    a move the scan didn't find. The scan itself keys off a real BattleMovedex field:
 *      - spread:     target === 'allAdjacent' | 'allAdjacentFoes'
 *      - wind:       flags.wind
 *      - sound:      flags.sound
 *      - sharpness:  flags.slicing (boosted by the Sharpness ability)
 *      - recoil:     recoil (proportional, e.g. Double-Edge) or mindBlownRecoil (flat 50%
 *                    max HP, e.g. Mind Blown) — NOT hasCrashDamage (Jump Kick/High Jump
 *                    Kick's self-damage on a MISS): Showdown's own data models that as a
 *                    mechanically distinct field from recoil-on-hit, so it's excluded here.
 *      - sheerforce: has a secondary (secondary or secondaries) and isn't a Status move —
 *                    matches Sheer Force's own ability text ("attacks with secondary
 *                    effects")
 *      - contact:    flags.contact
 *      - punching:   flags.punch (boosted by Iron Fist/Punching Glove)
 *      - biting:     flags.bite (boosted by Strong Jaw)
 *      - ballbomb:   flags.bullet (blocked by Bulletproof) — negative filter, see above
 *      - pulse:      flags.pulse (boosted by Mega Launcher)
 * 3. Hybrid (speedcontrol) — deliberately scoped to moves that affect *that turn's* move
 *    order, not general Speed-stat setup. The dynamic scan finds two things: a move that
 *    lowers the *target's* Speed on hit (boosts.spe < 0, or a secondary's boosts.spe < 0 —
 *    explicitly never a move's own *self* Speed boost, so Agility/Dragon Dance/Rock
 *    Polish/etc are excluded on purpose), and dedicated paralysis (status === 'par', or a
 *    100%-chance secondary status of 'par' — not just "has a chance to paralyze": Body Slam
 *    at 30% doesn't count, Nuzzle at 100% does). A handful of moves change turn order
 *    through a mechanic with no field for either of those at all (Trick Room, Tailwind,
 *    Quash, After You), or guarantee a target Speed drop that, as observed live, isn't
 *    consistently exposed as a structured field (Scary Face, String Shot, Cotton Spore, Tar
 *    Shot, Toxic Thread) — those aren't discoverable by scanning BattleMovedex, so `moves`
 *    below is where they're added. Unlike case 2, these entries genuinely extend the list
 *    rather than just annotate it. Sticky Web is deliberately NOT included — it's a hazard
 *    that affects whoever switches in later, not a same-turn move-order effect.
 * 4. Ability-kind, fully curated (negatesintimidate, weathersetter, terrainsetter) — same
 *    hand-maintained shape as case 1, but checked against `species.abilities` instead of
 *    walked against the movepool at all (see the module doc comment's `kind` note above).
 *      - negatesintimidate: scoped to "comes out ahead against Intimidate" rather than
 *        strictly "fully immune": Clear Body/White Smoke/Full Metal Body/Hyper Cutter block
 *        the Attack drop outright; Own Tempo/Inner Focus/Oblivious/Scrappy block Intimidate
 *        specifically (since Gen 8 — originally unrelated abilities); Contrary turns the drop
 *        into a raise; Mirror Armor reflects it back at the Intimidator; Defiant/Competitive/
 *        Guard Dog let the Attack drop apply as normal but immediately overcompensate with a
 *        bigger boost of their own (+2 Atk/+2 SpA/+1 Atk respectively — Guard Dog also blocks
 *        forced switching). Rattled and Flower Veil were deliberately left out: Rattled's
 *        Speed-on-Intimidated boost doesn't counter the Attack loss at all (a different stat,
 *        unrelated to what Intimidate actually does), and Flower Veil is an ally-support
 *        ability (protects Grass-type allies, not reliably the holder itself) rather than a
 *        personal answer to Intimidate the way the others are.
 *      - weathersetter: Drought/Drizzle/Sand Stream/Snow Warning/Desolate Land/Primordial
 *        Sea/Orichalcum Pulse/Delta Stream all set their weather unconditionally on switch-in
 *        (Desolate Land/Primordial Sea/Delta Stream are Primal Groudon/Kyogre/Mega
 *        Rayquaza-exclusive — included anyway despite needing a specific
 *        item/Mega-Evolution to access). Sand Spit is marked conditional — it only sets
 *        Sandstorm in response to being hit by a damaging move, not on switch-in. Terrain-
 *        setters (Electric Surge, Hadron Engine, etc) are a different mechanic from weather
 *        and deliberately excluded (see terrainsetter below); Forecast/Flower Gift/
 *        Protosynthesis/Quark Drive react to weather rather than setting it, also excluded.
 *      - terrainsetter: Electric Surge/Grassy Surge/Misty Surge/Psychic Surge/Hadron Engine
 *        (Miraidon-exclusive, same signature-ability pattern as Orichalcum Pulse) all set
 *        their terrain unconditionally on switch-in. Seed Sower is marked conditional — it
 *        only sets Grassy Terrain in response to being hit by a damaging move, not on
 *        switch-in (the terrain equivalent of Sand Spit above).
 */

window.CF_MOVE_CATEGORIES = {
	priority: {
		id: 'priority',
		label: 'Priority',
		description: {
			pokemon: 'Has a priority-granting attacking move.',
			move: 'Attacks with increased priority.',
		},
		searchTypes: ['pokemon', 'move'],
		moves: [
			{ id: 'quickattack', name: 'Quick Attack', conditional: false },
			{ id: 'machpunch', name: 'Mach Punch', conditional: false },
			{ id: 'aquajet', name: 'Aqua Jet', conditional: false },
			{ id: 'bulletpunch', name: 'Bullet Punch', conditional: false },
			{ id: 'iceshard', name: 'Ice Shard', conditional: false },
			{ id: 'shadowsneak', name: 'Shadow Sneak', conditional: false },
			{ id: 'vacuumwave', name: 'Vacuum Wave', conditional: false },
			{ id: 'watershuriken', name: 'Water Shuriken', conditional: false },
			{ id: 'accelerock', name: 'Accelerock', conditional: false },
			{ id: 'extremespeed', name: 'Extreme Speed', conditional: false },
			{ id: 'feint', name: 'Feint', conditional: false },
			{ id: 'jetpunch', name: 'Jet Punch', conditional: false },
			{ id: 'zippyzap', name: 'Zippy Zap', conditional: false },
			{
				id: 'suckerpunch', name: 'Sucker Punch', conditional: true,
				reason: "Fails unless the target has selected a damaging, non-priority move this turn",
			},
			{
				id: 'fakeout', name: 'Fake Out', conditional: true,
				reason: "Only usable the turn the user switches in",
			},
			{
				id: 'firstimpression', name: 'First Impression', conditional: true,
				reason: "Only usable the turn the user switches in",
			},
			{
				id: 'thunderclap', name: 'Thunderclap', conditional: true,
				reason: "Fails unless the target has selected a damaging move this turn",
			},
			{
				id: 'upperhand', name: 'Upper Hand', conditional: true,
				reason: "Fails unless the target has selected a priority move this turn and hasn't moved yet",
			},
			{
				id: 'grassyglide', name: 'Grassy Glide', conditional: true,
				reason: "Only gains +1 priority while Grassy Terrain is active",
			},
		],
	},

	redirection: {
		id: 'redirection',
		label: 'Redirection',
		description: {
			pokemon: 'Has a move that redirects attacks.',
			move: 'Redirects opposing attacks.',
		},
		searchTypes: ['pokemon', 'move'],
		moves: [
			{ id: 'followme', name: 'Follow Me', conditional: false },
			{ id: 'ragepowder', name: 'Rage Powder', conditional: false },
			{
				id: 'spotlight', name: 'Spotlight', conditional: true,
				reason: "Redirects attacks at the target for the turn rather than the user, and only works while the target hasn't already moved",
			},
		],
	},

	spread: {
		id: 'spread',
		label: 'Spread',
		description: {
			pokemon: 'Has a move that hits all adjacent Pokémon.',
			move: 'Hits all adjacent Pokémon.',
		},
		searchTypes: ['pokemon', 'move'],
		dynamic: true,
		moves: [],
	},

	wind: {
		id: 'wind',
		label: 'Wind',
		description: {
			pokemon: 'Has a wind move (triggers Wind Power/Wind Rider).',
			move: 'Is a wind move (triggers Wind Power/Wind Rider).',
		},
		searchTypes: ['pokemon', 'move'],
		dynamic: true,
		moves: [],
	},

	sound: {
		id: 'sound',
		label: 'Sound',
		description: {
			pokemon: 'Has a sound-based move.',
			move: 'Is a sound-based move.',
		},
		searchTypes: ['pokemon', 'move'],
		dynamic: true,
		moves: [],
	},

	sharpness: {
		id: 'sharpness',
		label: 'Sharpness',
		description: { move: 'Is a slicing move (Sharpness-boosted).' },
		// Only benefits the one Pokémon holding the Sharpness ability — a move-picking
		// question, not a team-building one. See the module doc comment's `searchTypes` note.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	recoil: {
		id: 'recoil',
		label: 'Recoil',
		description: { move: 'Damages the user on a hit.' },
		// Move-picking question (Rock Head/Reckless synergy, or avoiding recoil on a
		// specific set) rather than a team-building one.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	sheerforce: {
		id: 'sheerforce',
		label: 'Sheer Force',
		description: { move: 'Deals damage and has a secondary effect.' },
		// Only benefits the one Pokémon holding the Sheer Force ability.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	speedcontrol: {
		id: 'speedcontrol',
		label: 'Speed Control',
		description: {
			pokemon: "Has a move that changes move order.",
			move: "Changes move order.",
		},
		searchTypes: ['pokemon', 'move'],
		dynamic: true,
		moves: [
			// No Speed-stat-boost field for the dynamic scan to key off (Trick Room/Tailwind/
			// Quash/After You manipulate turn order through a mechanic with no stat field at
			// all; Scary Face/String Shot/Cotton Spore/Tar Shot/Toxic Thread guarantee a
			// target Speed drop but, as observed live, that effect isn't consistently exposed
			// as a structured field on BattleMovedex — only in prose shortDesc/desc). Unlike
			// other dynamic categories, these entries genuinely add to the list, not just
			// annotate it.
			{ id: 'trickroom', name: 'Trick Room', conditional: false },
			{ id: 'tailwind', name: 'Tailwind', conditional: false },
			{ id: 'quash', name: 'Quash', conditional: false },
			{ id: 'afteryou', name: 'After You', conditional: false },
			{ id: 'scaryface', name: 'Scary Face', conditional: false },
			{ id: 'stringshot', name: 'String Shot', conditional: false },
			{ id: 'cottonspore', name: 'Cotton Spore', conditional: false },
			{ id: 'tarshot', name: 'Tar Shot', conditional: false },
			{ id: 'toxicthread', name: 'Toxic Thread', conditional: false },
		],
	},

	pivoting: {
		id: 'pivoting',
		label: 'Pivoting',
		description: {
			pokemon: 'Has a move that switches the user out after use.',
			move: 'Switches the user out after use.',
		},
		searchTypes: ['pokemon', 'move'],
		// selfSwitch isn't exposed in the client's BattleMovedex (verified live), so this is
		// hand-curated rather than scanned — see the module doc comment above.
		moves: [
			{ id: 'uturn', name: 'U-turn', conditional: false },
			{ id: 'voltswitch', name: 'Volt Switch', conditional: false },
			{ id: 'flipturn', name: 'Flip Turn', conditional: false },
			{ id: 'batonpass', name: 'Baton Pass', conditional: false },
			{ id: 'partingshot', name: 'Parting Shot', conditional: false },
			{ id: 'teleport', name: 'Teleport', conditional: false },
			{ id: 'chillyreception', name: 'Chilly Reception', conditional: false },
			{
				id: 'shedtail', name: 'Shed Tail', conditional: true,
				reason: "Fails unless the user has more than half its max HP (needed to leave behind a Substitute)",
			},
		],
	},

	contact: {
		id: 'contact',
		label: 'Contact',
		description: { move: 'Makes contact.' },
		// Matchup-awareness question (Rocky Helmet/Rough Skin/Static/etc) for a move already
		// tied to a specific Pokémon, not a team-building one.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	punching: {
		id: 'punching',
		label: 'Punching',
		description: { move: 'Is a punching move (Iron Fist-boosted).' },
		// Only benefits the one Pokémon holding the Iron Fist ability.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	biting: {
		id: 'biting',
		label: 'Biting',
		description: { move: 'Is a biting move (Strong Jaw-boosted).' },
		// Only benefits the one Pokémon holding the Strong Jaw ability.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	ballbomb: {
		id: 'ballbomb',
		label: 'Ball/Bomb',
		description: { move: 'Hides ballistic moves (Bulletproof-blocked)' },
		// Move-only, and a NEGATIVE filter — see the module doc comment's `negative` note.
		// Nobody picks a move because it's ballistic; you pick one to avoid it.
		searchTypes: ['move'],
		negative: true,
		dynamic: true,
		moves: [],
	},

	pulse: {
		id: 'pulse',
		label: 'Pulse',
		description: { move: 'Is a pulse move (Mega Launcher-boosted).' },
		// Only benefits the one Pokémon holding the Mega Launcher ability.
		searchTypes: ['move'],
		dynamic: true,
		moves: [],
	},

	hazard: {
		id: 'hazard',
		label: 'Hazard',
		description: {
			pokemon: 'Has a move that sets an entry hazard.',
			move: 'Sets an entry hazard.',
		},
		searchTypes: ['pokemon', 'move'],
		// sideCondition isn't exposed in the client's BattleMovedex (verified live), so this
		// is hand-curated rather than scanned — see the module doc comment above. Ceaseless
		// Edge/Stone Axe are primarily damaging moves that set a hazard as a secondary effect
		// (and only if one isn't already there), so they're marked conditional; the four
		// dedicated hazard moves always set/stack their hazard when used. G-Max Steelsurge is
		// conditional for a different reason — it only exists while Gigantamaxed, and only
		// Copperajah can Gigantamax into it.
		moves: [
			{ id: 'stealthrock', name: 'Stealth Rock', conditional: false },
			{ id: 'spikes', name: 'Spikes', conditional: false },
			{ id: 'toxicspikes', name: 'Toxic Spikes', conditional: false },
			{ id: 'stickyweb', name: 'Sticky Web', conditional: false },
			{
				id: 'ceaselessedge', name: 'Ceaseless Edge', conditional: true,
				reason: "Sets Spikes only if the attack hits and Spikes isn't already at max layers",
			},
			{
				id: 'stoneaxe', name: 'Stone Axe', conditional: true,
				reason: "Sets Stealth Rock only if the attack hits and it isn't already active",
			},
			// G-Max Steelsurge was removed — the client's BattleMovedex doesn't include G-Max
			// moves in standard learnsets, so typedSearch.canLearn('copperajah', 'gmaxsteelsurge')
			// always returns false and Copperajah would never match the Hazard filter through it.
		],
	},

	negatesintimidate: {
		id: 'negatesintimidate',
		label: 'Negates Intimidate',
		description: {
			pokemon: "Has an ability that blocks, reverses, or comes out ahead of Intimidate's Attack drop.",
		},
		// Ability-kind: matched against species.abilities, not the movepool — see the module
		// doc comment's `kind` note. Always Pokémon-only (there's no "ability" to pick in Move
		// search).
		searchTypes: ['pokemon'],
		kind: 'ability',
		abilities: [
			{ id: 'clearbody', name: 'Clear Body', conditional: false },
			{ id: 'whitesmoke', name: 'White Smoke', conditional: false },
			{ id: 'fullmetalbody', name: 'Full Metal Body', conditional: false },
			{ id: 'hypercutter', name: 'Hyper Cutter', conditional: false },
			{ id: 'owntempo', name: 'Own Tempo', conditional: false },
			{ id: 'innerfocus', name: 'Inner Focus', conditional: false },
			{ id: 'oblivious', name: 'Oblivious', conditional: false },
			{ id: 'scrappy', name: 'Scrappy', conditional: false },
			{ id: 'contrary', name: 'Contrary', conditional: false },
			{ id: 'defiant', name: 'Defiant', conditional: false },
			{ id: 'competitive', name: 'Competitive', conditional: false },
			{ id: 'guarddog', name: 'Guard Dog', conditional: false },
			{ id: 'mirrorarmor', name: 'Mirror Armor', conditional: false },
			{
				id: 'neutralizinggas', name: 'Neutralizing Gas', conditional: true,
				reason: "Suppresses all abilities on the field (including the holder's own) — blocks Intimidate entirely, but at the cost of also disabling the holder's other ability effects",
			},
		],
	},

	weathersetter: {
		id: 'weathersetter',
		label: 'Weather Setter',
		description: {
			pokemon: 'Has an ability that sets weather.',
		},
		// Ability-kind: matched against species.abilities, not the movepool — see the module
		// doc comment's `kind` note. Always Pokémon-only.
		searchTypes: ['pokemon'],
		kind: 'ability',
		abilities: [
			{ id: 'drought', name: 'Drought', conditional: false },
			{ id: 'drizzle', name: 'Drizzle', conditional: false },
			{ id: 'sandstream', name: 'Sand Stream', conditional: false },
			{ id: 'snowwarning', name: 'Snow Warning', conditional: false },
			{ id: 'desolateland', name: 'Desolate Land', conditional: false },
			{ id: 'primordialsea', name: 'Primordial Sea', conditional: false },
			{ id: 'orichalcumpulse', name: 'Orichalcum Pulse', conditional: false },
			{ id: 'deltastream', name: 'Delta Stream', conditional: false },
			{
				id: 'sandspit', name: 'Sand Spit', conditional: true,
				reason: "Only sets Sandstorm when the holder is hit by a damaging move, not on switch-in",
			},
		],
	},

	terrainsetter: {
		id: 'terrainsetter',
		label: 'Terrain Setter',
		description: {
			pokemon: 'Has an ability that sets terrain.',
		},
		// Ability-kind: matched against species.abilities, not the movepool — see the module
		// doc comment's `kind` note. Always Pokémon-only.
		searchTypes: ['pokemon'],
		kind: 'ability',
		abilities: [
			{ id: 'electricsurge', name: 'Electric Surge', conditional: false },
			{ id: 'grassysurge', name: 'Grassy Surge', conditional: false },
			{ id: 'mistysurge', name: 'Misty Surge', conditional: false },
			{ id: 'psychicsurge', name: 'Psychic Surge', conditional: false },
			{ id: 'hadronengine', name: 'Hadron Engine', conditional: false },
			{
				id: 'seedsower', name: 'Seed Sower', conditional: true,
				reason: "Only sets Grassy Terrain when the holder is hit by a damaging move, not on switch-in",
			},
		],
	},
};
