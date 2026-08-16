/**
 * Better Teambuilder for Showdown! — content script.
 *
 * Runs in the page's MAIN world (see manifest.json) so it can see and patch the
 * same DexSearch/BattleMovedex/BattlePokedex/BattleTeambuilderTable globals the
 * site's own bundle defines — an isolated-world content script would not see them.
 *
 * IMPORTANT: the teambuilder's Pokémon search, as actually served in production,
 * is rendered by the legacy jQuery-based `BattleSearch` (play.pokemonshowdown.com/
 * src/oldclient/search.js + client-teambuilder.js), producing `<ul class="utilichart">`
 * rows inside `.teambuilder-results` — NOT the newer Preact `PSSearchResults`
 * (`.dexlist`) component. Both wrap the exact same `DexSearch` model class
 * (`window.DexSearch`), confirmed live: `window.search.engine instanceof DexSearch`.
 * So the filtering mechanism below (patching DexSearch.prototype) is renderer-
 * agnostic and correct either way; the small amount of UI glue (typed-filter row
 * rendering, filter-chip rendering) is written against the renderer actually
 * observed on the live site. See README for how this was determined.
 *
 * UX: there is no separate toolbar. A custom category is typed into the same
 * Pokémon search box as any move/ability/type — typing "priority" (or a prefix)
 * surfaces a clickable suggestion row, and once applied it appears as a normal
 * removable chip in the native "Filters: ..." row, indistinguishable in behavior
 * from a native type/move/ability filter chip.
 *
 * Mechanism:
 *  - DexSearch.prototype.addFilter/setType/find are wrapped (not modified) to add
 *    a parallel ['custom', categoryId] filter type that the native whitelist would
 *    otherwise reject. Native filtering/sorting/ranking is untouched; we only
 *    post-filter the already-computed `search.results` array. Custom filters live
 *    in their own `engine.__cfFilters` array, never in the native `engine.filters`.
 *  - Legality of a move for a species+format is decided by calling
 *    typedSearch.canLearn(speciesId, moveId) — the exact same learnset walk
 *    (prevo/battle-only chains, gen-appropriate learnsets, natdex rules, etc.)
 *    the native moves-tab filter uses. We never reimplement or approximate it.
 *  - Typing a category name works by injecting a synthetic
 *    ['customfilter', categoryId] row (native row types can't carry a real link —
 *    see patchLegacyRenderRow below) that the site's own generic
 *    'click .utilichart a' -> chartClick -> Search.prototype.addFilter(node) chain
 *    picks up automatically, same as any other result row.
 *  - The "Filters: ..." chip row is the site's own existing UI
 *    (Search.prototype.getFilterText/find/removeFilter); we wrap those three to
 *    fold custom filters into the same rendered line and remove flow, rather than
 *    drawing a separate chip UI of our own.
 *  - The hover tooltip is the one piece of UI we render ourselves — an
 *    independent floating element appended to document.body and positioned via
 *    getBoundingClientRect(), never inserted into the search results DOM.
 *  - The Speed filter (below) is a different shape of feature entirely: not a typed
 *    category but a small persistent widget — an operator toggle (>/</-), an "=" toggle,
 *    and a number input — docked directly under the native "Sort: ..." row
 *    (BattleSearch.prototype.renderPokemonSortRow) in Pokémon search, comparing each
 *    result's base Speed stat. See the "Speed filter" section below for the mechanism.
 */
(function () {
	if (window.__CF_MOVEPOOL_FILTERS_LOADED) return;
	window.__CF_MOVEPOOL_FILTERS_LOADED = true;

	const CATEGORY_ORDER = [
		'priority', 'redirection', 'spread',
		'wind', 'sound', 'sharpness', 'recoil', 'sheerforce', 'speedcontrol',
		'pivoting', 'contact', 'punching', 'biting', 'ballbomb', 'pulse', 'hazard', 'hazardremoval',
		'nevermiss', 'negatesintimidate', 'weathersetter', 'terrainsetter',
	];
	/** Categories whose move list is computed from BattleMovedex rather than fully
	 *  hand-curated — see move-data.js's module doc comment for how each one is scanned. */
	const DYNAMIC_CATEGORIES = [
		'spread', 'wind', 'sound', 'sharpness', 'recoil', 'sheerforce', 'speedcontrol',
		'contact', 'punching', 'biting', 'ballbomb', 'pulse', 'nevermiss',
	];

	const CF = {
		/** The most recently active pokemon- or move-search DexSearch instance — single-
		 *  focus UI, so there's only ever one relevant at a time regardless of which. */
		lastEngine: null,
		dynamicMoveLists: {},
	};

	function escapeHTML(text) {
		if (text === null || text === undefined) return '';
		return String(text)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function toIDSafe(s) {
		return (window.toID || ((x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')))(s);
	}

	/** Shared by both the Pikalytics sidebar's build*Section functions (to decide a row's
	 *  clickable/disabled/equipped styling) and its click-to-apply handlers (to decide whether
	 *  a click actually does anything) — see patchTeambuilderSidebar's own doc comment for the
	 *  full click-to-apply design. A move "slot" is index 0-3 of curSet.moves regardless of the
	 *  array's actual length (addPokemon starts it at [], client-teambuilder.js's own chartSet
	 *  leaves gaps as undefined/''), so slot-emptiness is checked by index, not by array length. */
	function curSetHasMove(set, moveName) {
		return !!(set && set.moves && set.moves.some((m) => m && toIDSafe(m) === toIDSafe(moveName)));
	}
	function curSetMovesFull(set) {
		if (!set || !set.moves) return false;
		for (let i = 0; i < 4; i++) if (!set.moves[i]) return false;
		return true;
	}
	/** Mega/Primal species collapse to their base species (Blastoise-Mega -> Blastoise) via
	 *  pikalytics.js's own resolveQuerySpecies — the same collapsing it already does when
	 *  querying Pikalytics, since Pikalytics only ever reports Mega usage under the base
	 *  species name (see pikalytics.js's doc comment), so a teammate suggestion never actually
	 *  reads "Blastoise-Mega". Without this, a team that already has Mega Blastoise wouldn't
	 *  grey out a "Blastoise" teammate suggestion, since "blastoisemega" !== "blastoise". */
	function baseSpeciesID(speciesName) {
		const resolved = (window.CF_Pikalytics && window.CF_Pikalytics.resolveQuerySpecies)
			? window.CF_Pikalytics.resolveQuerySpecies(speciesName)
			: speciesName;
		return toIDSafe(resolved);
	}
	function curTeamHasSpecies(tbRoom, speciesName) {
		const team = tbRoom.curSetList || [];
		const target = baseSpeciesID(speciesName);
		return team.some((s) => s.species && baseSpeciesID(s.species) === target);
	}
	function curTeamFull(tbRoom) {
		const team = tbRoom.curSetList || [];
		const capacity = (tbRoom.curTeam && tbRoom.curTeam.capacity) || 6;
		return team.length >= capacity;
	}

	/** Single source of truth for Showdown's own HP/Atk/Def/SpA/SpD/Spe stat order/labels —
	 *  STAT_IDS and STAT_LABELS (used by parseEVs below and by buildSpreadsSection/
	 *  natureModifierHTML further down) are both derived from this one object rather than each
	 *  being its own hand-typed literal, so the order/spelling can't drift between them. */
	const STAT_LABEL_BY_ID = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
	const STAT_IDS = Object.keys(STAT_LABEL_BY_ID);
	const STAT_LABELS = Object.values(STAT_LABEL_BY_ID);

	/** EVs in Champions VGC run 0-32 (not the old 0-252 scale — confirmed live), enforced by
	 *  every native EV control (statChange/statSlide in client-teambuilder.js both clamp to
	 *  `usesStatPoints ? 32 : 252`). Pikalytics' own data should already be in range, but this
	 *  clamps anyway rather than trusting it — cheap insurance against a malformed API value
	 *  getting written straight into the set with no validation. */
	function parseEVs(evString) {
		const parts = String(evString).split('/');
		const evs = {};
		STAT_IDS.forEach((id, i) => {
			const val = parseInt(parts[i], 10) || 0;
			evs[id] = Math.min(Math.max(val, 0), 32);
		});
		return evs;
	}

	/** Applies a Pikalytics value straight to the currently-edited set/team, the same fields
	 *  client-teambuilder.js's own chartSet()/addPokemon() write (curSet.moves[i]/.ability/
	 *  .item/.nature/.evs, curSetList) — not a reimplementation of Showdown's own set-editing
	 *  logic, just direct field writes followed by the same redraw call our own sidebar-refresh
	 *  hooks already use (updateSetTop), so the real set editor and our sidebar both reflect
	 *  the change in one pass without navigating anywhere. Deliberately skips chartSet's
	 *  companion chooseMove()/unChooseMove() calls (Hidden Power IVs, minAtk/minSpe IV
	 *  optimization, Gyro Ball's speed-IV reset): the specific minAtk/minSpe optimization block
	 *  is genuinely dead for `format.includes('champions')` — our only supported formats —
	 *  since chooseMove early-returns before reaching it. The Hidden Power IV block and the
	 *  Return/Frustration `happiness` assignment earlier in chooseMove are NOT behind that
	 *  early-return, so applyMove clicking "Return"/"Frustration" does leave curSet.happiness
	 *  unset where the native chart-click path would set it to 255/0 — accepted as a real,
	 *  narrow gap rather than fixed, since happiness-dependent moves are essentially never used
	 *  in competitive VGC and Hidden Power has had no in-game source since Generation 8, so
	 *  neither case is reachable through this extension's actual Gen 9 Pikalytics data. Each
	 *  function no-ops (and does NOT call save()) if there's no room to apply the change —
	 *  belt-and-suspenders alongside the CSS pointer-events:none on rows already rendered
	 *  disabled for the same reason. */

	/** updateSetTop() (always called) redraws move1-4/item/ability/pokemon — the .teamchart
	 *  fields renderSet() covers — from curSet, so those always reflect a click-to-apply change
	 *  immediately. Two OTHER native views are rendered separately and don't get touched by
	 *  that call at all, so each needs its own explicit refresh, only when actually open:
	 *
	 *  - The move/ability/item/pokemon SEARCH CHART (the dropdown of suggestions under
	 *    whichever field is focused) has its "already selected" `.cur` markers computed once,
	 *    when the chart opens (TeambuilderRoom.prototype.updateChart's own `cur` map, built
	 *    from DOM input values at that moment) — without a refresh, a move applied via our
	 *    sidebar wouldn't show as selected there until the user focused a different field and
	 *    back. `updateChart(true)` is the exact call selectPokemon() itself uses to force that
	 *    rebuild; gated on curChartType being one of the four searchable types
	 *    (searchChartTypes) so this doesn't poke at chart state that isn't set up for it.
	 *  - The Stats/EV panel (nature <select>, EV sliders — curChartType === 'stats') is a
	 *    wholly separate view built by updateStatForm(), which updateChart()'s own 'stats'
	 *    branch calls but which our updateChart(true) call above never reaches, since 'stats'
	 *    isn't in searchChartTypes. Without calling it directly too, applying a nature (or a
	 *    spread's nature+EVs) from the sidebar while the Stats panel is open left its nature
	 *    dropdown and sliders showing the old values until the user left the panel and back. */
	function commitApply(tbRoom) {
		tbRoom.updateSetTop();
		if (tbRoom.curChartType && tbRoom.searchChartTypes && (tbRoom.curChartType in tbRoom.searchChartTypes)) {
			if (typeof tbRoom.updateChart === 'function') tbRoom.updateChart(true);
		} else if (tbRoom.curChartType === 'stats' && typeof tbRoom.updateStatForm === 'function') {
			tbRoom.updateStatForm();
		}
		tbRoom.save();
	}

	/** Toggle, not just add: clicking a move already on the set removes it (clearing the slot
	 *  to '', matching the empty-slot convention chartSet itself uses) rather than being a
	 *  no-op — this is also the one reliable way to clear a move slot at all, since backspacing
	 *  it out through the native move1-4 text inputs doesn't reliably clear curSet.moves (a
	 *  separate, native-UI issue this sidesteps rather than fixes). Clicking a move NOT already
	 *  on the set fills the first empty slot, or no-ops if all 4 are already filled with other
	 *  moves. */
	function applyMove(tbRoom, moveName) {
		const set = tbRoom.curSet;
		if (!set) return;
		const moves = set.moves || (set.moves = []);
		const existingSlot = moves.findIndex((m) => m && toIDSafe(m) === toIDSafe(moveName));
		if (existingSlot !== -1) {
			moves[existingSlot] = '';
			commitApply(tbRoom);
			return;
		}
		let slot = -1;
		for (let i = 0; i < 4; i++) {
			if (!moves[i]) { slot = i; break; }
		}
		if (slot === -1) return;
		moves[slot] = moveName;
		commitApply(tbRoom);
	}
	/** Shared by the three single-field apply* calls (ability/item/nature) in onPikaSidebarClick
	 *  below — each is the same "read curSet, write one field, commitApply" shape, differing
	 *  only in which field, so one helper takes the field name rather than three near-identical
	 *  functions. */
	function applySetField(tbRoom, fieldName, value) {
		const set = tbRoom.curSet;
		if (!set) return;
		set[fieldName] = value;
		commitApply(tbRoom);
	}
	function applySpread(tbRoom, natureName, evString) {
		const set = tbRoom.curSet;
		if (!set) return;
		if (natureName) set.nature = natureName;
		set.evs = parseEVs(evString);
		commitApply(tbRoom);
	}
	/** Appends a new team slot with just the species (and level) filled in — the same shape
	 *  addPokemon()'s own template uses ({name:'', item:'', nature:'', evs:{}, ivs:{},
	 *  moves:[]}) — WITHOUT touching curSet/curSetLoc the way addPokemon() itself does (which
	 *  navigates the editor to the new blank slot). updateSetTop()'s own renderTeambar() still
	 *  picks up the new team member's icon in the top bar; the currently-open editor is
	 *  untouched. Doesn't go through commitApply: adding a teammate never changes the currently
	 *  open chart's own `cur` map (that's scoped to the set being edited, not curSetList).
	 *
	 *  `level: 50` is hardcoded rather than derived the way setPokemon() itself derives it
	 *  (stripping a `gen9`/`bdsp`/etc. prefix off the format id, then checking the stripped
	 *  string against `champions`/`battlespot`/`bss`/`vgc`/`battlefestival`) because every
	 *  format this extension supports (pikalytics.js's FORMAT_SLUG_MAP allowlist) is already a
	 *  Champions VGC format — level 50 always, not conditionally. Without this, a teammate added
	 *  through the sidebar had no `level` key at all (defaulting to 100 elsewhere), producing an
	 *  invalid set for every format this extension actually runs in. */
	function applyTeammate(tbRoom, speciesName) {
		if (curTeamFull(tbRoom) || curTeamHasSpecies(tbRoom, speciesName)) return;
		tbRoom.curSetList.push({ name: '', species: speciesName, item: '', nature: '', evs: {}, ivs: {}, level: 50, moves: [] });
		tbRoom.updateSetTop();
		tbRoom.save();
	}

	/** Clicking a sidebar row while a chart text input (move1-4/ability/item/pokemon) has focus
	 *  fires that input's native blur handler (chartChange, bound to `blur .chartinput`) BEFORE
	 *  our own click handler runs — browsers blur the previously-focused element as part of a
	 *  mousedown's default action, ahead of the click event that follows on mouseup. Since
	 *  chartChange can itself call into chartSet (now hooked, see patchTeambuilderSidebar's own
	 *  doc comment), that blur can trigger a sidebar re-render that replaces the very row being
	 *  clicked before the click event fires, so the first click just defocuses the input and a
	 *  second click (nothing left to blur) is what actually applies. preventDefault()-on-
	 *  mousedown would suppress the blur entirely, but that turned out to break other native
	 *  behavior that depends on the blur actually happening — so instead of fixing the race,
	 *  this just makes it visible: while any .chartinput is focused, hovering a clickable row
	 *  drops from `cursor: pointer` to `cursor: default` (cf-pika-blur-pending on <body>,
	 *  style.css) as a "this click will just refocus — click again" cue — deliberately not
	 *  `cursor: wait`, which reads as the page being busy/lagging rather than "click again" (see
	 *  that CSS rule's own comment) — via delegated focusin/focusout (not focus/blur, which
	 *  don't bubble and so can't be caught with a single document-level listener). */
	function onPikaSidebarFocusChange(ev) {
		document.body.classList.toggle('cf-pika-blur-pending', document.activeElement instanceof Element &&
			document.activeElement.classList.contains('chartinput'));
	}

	function onPikaSidebarClick(ev) {
		const el = ev.target.closest('[data-cf-pika-action]');
		if (!el) return;
		const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
		if (!tbRoom || !tbRoom.curSet) return;
		const value = el.dataset.cfPikaValue;
		switch (el.dataset.cfPikaAction) {
			case 'move': applyMove(tbRoom, value); break;
			case 'ability': applySetField(tbRoom, 'ability', value); break;
			case 'item': applySetField(tbRoom, 'item', value); break;
			case 'nature': applySetField(tbRoom, 'nature', value); break;
			case 'spread': applySpread(tbRoom, el.dataset.cfPikaNature || '', el.dataset.cfPikaEv); break;
			case 'teammate': applyTeammate(tbRoom, value); break;
		}
	}

	function buildOverridesMap(catId) {
		const overrides = {};
		const cat = window.CF_MOVE_CATEGORIES[catId];
		if (cat) for (const entry of cat.moves) overrides[entry.id] = entry;
		return overrides;
	}

	function moveEntry(id, move, overrides) {
		const override = overrides[id];
		return {
			id,
			name: move.name,
			conditional: !!(override && override.conditional),
			reason: override ? override.reason : undefined,
		};
	}

	/** Scans BattleMovedex once to build the move list for every dynamic/hybrid category.
	 *  See move-data.js's module doc comment for exactly what field each one keys off. */
	function buildDynamicMoveLists() {
		const lists = {
			spread: [], wind: [], sound: [], sharpness: [], recoil: [], sheerforce: [], speedcontrol: [],
			contact: [], punching: [], biting: [], ballbomb: [], pulse: [], nevermiss: [],
		};
		const overrides = {
			spread: buildOverridesMap('spread'),
			wind: buildOverridesMap('wind'),
			sound: buildOverridesMap('sound'),
			sharpness: buildOverridesMap('sharpness'),
			recoil: buildOverridesMap('recoil'),
			sheerforce: buildOverridesMap('sheerforce'),
			contact: buildOverridesMap('contact'),
			punching: buildOverridesMap('punching'),
			biting: buildOverridesMap('biting'),
			ballbomb: buildOverridesMap('ballbomb'),
			pulse: buildOverridesMap('pulse'),
			nevermiss: buildOverridesMap('nevermiss'),
		};

		// speedcontrol's curated entries (Trick Room, Tailwind, etc — see move-data.js)
		// genuinely extend the list rather than annotate it, since the scan below has no
		// stat-boost field to find them by. Seed them first so the scan never overwrites one.
		const speedControlOverrides = buildOverridesMap('speedcontrol');
		for (const id in speedControlOverrides) {
			const entry = speedControlOverrides[id];
			lists.speedcontrol.push({ id, name: entry.name, conditional: !!entry.conditional, reason: entry.reason });
		}
		const speedControlSeen = new Set(lists.speedcontrol.map(e => e.id));

		for (const id in window.BattleMovedex) {
			const move = window.BattleMovedex[id];

			if (move.target === 'allAdjacent' || move.target === 'allAdjacentFoes') {
				lists.spread.push(moveEntry(id, move, overrides.spread));
			}
			if (move.flags && move.flags.wind) lists.wind.push(moveEntry(id, move, overrides.wind));
			if (move.flags && move.flags.sound) lists.sound.push(moveEntry(id, move, overrides.sound));
			if (move.flags && move.flags.slicing) lists.sharpness.push(moveEntry(id, move, overrides.sharpness));
			if (move.recoil || move.mindBlownRecoil) lists.recoil.push(moveEntry(id, move, overrides.recoil));
			// Matches Sheer Force's own ability text ("attacks with secondary effects");
			// category !== 'Status' keeps this to damaging moves, same as the ability itself.
			if (move.category !== 'Status' && (move.secondary || move.secondaries)) {
				lists.sheerforce.push(moveEntry(id, move, overrides.sheerforce));
			}
			if (move.flags && move.flags.contact) lists.contact.push(moveEntry(id, move, overrides.contact));
			if (move.flags && move.flags.punch) lists.punching.push(moveEntry(id, move, overrides.punching));
			if (move.flags && move.flags.bite) lists.biting.push(moveEntry(id, move, overrides.biting));
			if (move.flags && move.flags.bullet) lists.ballbomb.push(moveEntry(id, move, overrides.ballbomb));
			if (move.flags && move.flags.pulse) lists.pulse.push(moveEntry(id, move, overrides.pulse));
			if (move.accuracy === true && move.category !== 'Status') lists.nevermiss.push(moveEntry(id, move, overrides.nevermiss));

			if (!speedControlSeen.has(id)) {
				let chance = null;

				// Foe-directed Speed drop only — deliberately excludes any move that raises
				// the *user's own* Speed (Agility, Dragon Dance, Flame Charge's self-boost,
				// etc): those are sweeper setup, not "control" over the match the way the
				// rest of this category is.
				if (move.target !== 'self' && move.boosts && move.boosts.spe < 0) {
					chance = 100;
				} else {
					const secondaries = move.secondaries || (move.secondary ? [move.secondary] : []);
					for (const s of secondaries) {
						if (s.boosts && s.boosts.spe < 0) {
							chance = (s.chance == null) ? 100 : s.chance;
							break;
						}
					}
				}

				// Dedicated paralysis — 100%-when-it-connects only (Thunder Wave, Stun Spore,
				// Glare, Nuzzle, Zap Cannon), not merely "has a chance to paralyze" (excludes
				// Body Slam 30%, Thunderbolt 10%, etc — a deliberate, narrower scope than
				// "any paralysis chance" would give). Paralysis halves Speed unconditionally
				// once inflicted, so this is treated the same as a guaranteed Speed drop.
				if (chance === null) {
					if (move.status === 'par') {
						chance = 100;
					} else {
						const secondaries = move.secondaries || (move.secondary ? [move.secondary] : []);
						for (const s of secondaries) {
							if (s.status === 'par' && (s.chance == null || s.chance === 100)) {
								chance = 100;
								break;
							}
						}
					}
				}

				if (chance !== null) {
					const conditional = chance < 100;
					lists.speedcontrol.push({
						id,
						name: move.name,
						conditional,
						reason: conditional ? `Only ${chance}% chance to affect Speed` : undefined,
					});
					speedControlSeen.add(id);
				}
			}
		}
		return lists;
	}

	function getCategoryMoveList(catId) {
		if (DYNAMIC_CATEGORIES.includes(catId)) return CF.dynamicMoveLists[catId] || [];
		const cat = window.CF_MOVE_CATEGORIES[catId];
		return (cat && cat.moves) || [];
	}

	/** Ability-kind categories (currently only negatesintimidate) match against a species'
	 *  declarable abilities instead of its movepool — no canLearn() walk, just membership
	 *  against Dex.species.get(speciesId).abilities (the 0/1/H/S slots). */
	function computeAbilityMatches(speciesId, catId) {
		const cat = window.CF_MOVE_CATEGORIES[catId];
		const species = window.Dex.species.get(speciesId);
		const abilityIds = new Set(
			species && species.abilities ? Object.values(species.abilities).map(a => window.toID(a)) : []
		);
		return (cat.abilities || []).filter(entry => abilityIds.has(entry.id));
	}

	/** Lets a custom category be typed into the search box like a move/type/ability,
	 *  the same way typing "fire" surfaces a clickable Fire-type filter, complete with
	 *  its own section header — exactly like the "Pokémon" / "Moves" / "Abilities" /
	 *  "Illegal Pokémon" headers a query like "heat" already produces. We can't reuse
	 *  BattleSearchIndex (a static generated file) or the native row renderers (their
	 *  'html' row type HTML-escapes everything except <em>/<strong>, so a real
	 *  data-entry link can't be smuggled through it) — instead we inject synthetic
	 *  ['header', 'Custom Filters'] and ['customfilter', categoryId] rows that a patched
	 *  renderRow() (below) knows how to draw, the header via the native, unmodified
	 *  'header' case and the row as a real `<a data-entry="custom|categoryId">`.
	 *  Clicking it is then handled entirely by the site's own existing
	 *  'click .utilichart a' -> chartClick -> Search.prototype.addFilter(node) chain —
	 *  no click handler of our own needed.
	 *
	 *  Positioning: native textSearch() only ever falls back to a fuzzy pass — the
	 *  `['html', "No exact match found..."]` notice plus a couple of alphabetically-
	 *  nearest, functionally irrelevant results (e.g. "prio" → Primeape/Primarina) —
	 *  when NOTHING in the real index starts with the typed query at all. That means
	 *  whenever we have a custom-category match and that fallback fired, the query was
	 *  actually aimed at us; the fuzzy guess is just noise burying the real match, so we
	 *  drop it and show only our "Custom Filters" section. If the fallback didn't fire
	 *  (real prefix matches exist), our section is prepended in front of them as usual —
	 *  the same slot the "Pokémon"/"Moves"/etc. buckets start at. */
	function injectTypedFilterSuggestions(engine, query) {
		if (!query) return;
		const q = window.toID(query);
		if (!q) return;
		const searchType = engine.typedSearch && engine.typedSearch.searchType;
		const active = engine.__cfFilters || [];
		const suggestions = [];
		for (const catId of CATEGORY_ORDER) {
			if (active.includes(catId)) continue;
			const cat = window.CF_MOVE_CATEGORIES[catId];
			if (!cat) continue;
			if (!cat.searchTypes.includes(searchType)) continue;
			if (catId.startsWith(q) || window.toID(cat.label).startsWith(q)) {
				// matchStart/matchLength: same [type, id, matchStart, matchLength] shape
				// native rows use to bold the matched substring of the name (see
				// renderRow below). Our labels are single plain words, so the toID'd
				// query always lines up with the same character positions in the
				// display label — a straight prefix match at position 0.
				suggestions.push(['customfilter', catId, 0, q.length]);
			}
		}
		if (!suggestions.length) return;
		const block = [['header', 'Custom Filters'], ...suggestions];
		const results = engine.results || [];
		const isFuzzyFallbackOnly = results.length > 0 && results[0][0] === 'html';
		engine.results = isFuzzyFallbackOnly ? block : [...block, ...results];
	}

	/** Wraps the legacy renderer (the one actually live, see file header) so it knows how
	 *  to draw our synthetic 'customfilter' row type. Every other row type — including
	 *  'header', used for the "Custom Filters" heading above — is delegated to the
	 *  original, unmodified.
	 *
	 *  Row aesthetic: the native renderer already has a pattern for a result whose own
	 *  type differs from the current search type (e.g. a move suggested while searching
	 *  Pokémon) — it renders as just the name plus a green-bordered "Filter" pill
	 *  (`Search.prototype.filterLabel` → `<span class="col filtercol"><em>Filter</em>
	 *  </span>`, styled by the site's own `.utilichart .filtercol em`; see e.g. typing
	 *  "reflect" while searching Pokémon: "Reflect [Filter]"). We follow that same
	 *  pill — same markup, same class — but, unlike a native cross-type row, also keep a
	 *  description column after it (`.col.movedesccol`, the same class an Egg Group or
	 *  Tier row uses for its trailing text), since our filters don't have their own
	 *  dedicated page a user could click through to for more detail. And like every
	 *  other result row, the substring that was actually typed gets bolded via `<b>`
	 *  (styled blue+underlined by the site's own `.utilichart b`), using the
	 *  matchStart/matchLength the row was given — the same two parameters a native
	 *  row's own name-matching logic reads. */
	function patchLegacyRenderRow() {
		const BattleSearch = window.BattleSearch;
		if (!BattleSearch || BattleSearch.prototype.__cfRowPatched) return;
		const origRenderRow = BattleSearch.prototype.renderRow;
		BattleSearch.prototype.renderRow = function (id, type, matchStart, matchLength, errorMessage, attrs) {
			if (type === 'cf-speedrow') {
				return renderSpeedFilterRow(this.engine);
			}
			if (type === 'customfilter') {
				const cat = window.CF_MOVE_CATEGORIES[id];
				if (!cat) return '<li class="result">Unknown filter</li>';
				const label = cat.label;
				let name;
				if (matchLength) {
					name = escapeHTML(label.substr(0, matchStart)) +
						`<b>${escapeHTML(label.substr(matchStart, matchLength))}</b>` +
						escapeHTML(label.substr(matchStart + matchLength));
				} else {
					name = escapeHTML(label);
				}
				// description is keyed by search type ({ pokemon: '...', move: '...' } — see
				// move-data.js) since the two contexts need different grammar: "Has a move
				// that..." (subject = the species) only makes sense in Pokémon search, while
				// Move search is already looking at the move itself.
				const searchType = this.engine && this.engine.typedSearch && this.engine.typedSearch.searchType;
				const description = (cat.description && cat.description[searchType]) || '';
				return `<li class="result"><a href="#" data-entry="custom|${escapeHTML(id)}">` +
					`<span class="col namecol">${name}</span>` +
					`<span class="col filtercol"><em>Filter</em></span>` +
					`<span class="col movedesccol" title="${escapeHTML(description)}">${escapeHTML(description)}</span>` +
					`</a></li>`;
			}
			return origRenderRow.call(this, id, type, matchStart, matchLength, errorMessage, attrs);
		};
		BattleSearch.prototype.__cfRowPatched = true;
	}

	/** Folds custom filters into the site's own "Filters: ..." chip row
	 *  (Search.prototype.getFilterText/find/removeFilter) so an applied custom filter
	 *  looks and behaves exactly like a native type/move/ability/tier/egggroup filter
	 *  chip — same markup, same place, same "click the × to remove" / "backspace to
	 *  delete last filter" behavior — instead of drawing separate UI of our own. */
	function patchLegacyFilterChips() {
		const BattleSearch = window.BattleSearch;
		if (!BattleSearch || BattleSearch.prototype.__cfChipsPatched) return;

		BattleSearch.prototype.getFilterText = function () {
			const engine = this.engine;
			const filters = this.filters || [];
			let buf = '<p>Filters: ';
			for (let i = 0; i < filters.length; i++) {
				let text = filters[i][1];
				if (filters[i][0] === 'move') text = window.Dex.moves.get(text).name;
				if (filters[i][0] === 'pokemon') text = window.Dex.species.get(text).name;
				buf += `<button class="filter" value="${escapeHTML(filters[i].join(':'))}">` +
					`${escapeHTML(text)} <i class="fa fa-times-circle"></i></button> `;
			}
			const custom = engine.__cfFilters || [];
			for (const catId of custom) {
				const cat = window.CF_MOVE_CATEGORIES[catId];
				const label = cat ? cat.label : catId;
				// Negative categories (currently only ballbomb) are an exclusion, not an
				// inclusion — flagged red via .cf-negative-filter (style.css) rather than a
				// text prefix, so it reads as "this is an exclusion" at a glance the same way
				// a native chip's color/shape would, instead of adding words to parse.
				const cls = cat && cat.negative ? ' cf-negative-filter' : '';
				buf += `<button class="filter${cls}" value="${escapeHTML(`custom:${catId}`)}">` +
					`${escapeHTML(label)} <i class="fa fa-times-circle"></i></button> `;
			}
			buf += '<small style="color: #888">(backspace = delete filter)</small>';
			return buf + '</p>';
		};

		// Native find() only prepends the "Filters: ..." row when this.filters (native
		// filters) is truthy. If only custom filters are active, that check is false, so
		// the row (now custom-inclusive, per the patch above) would never appear without
		// this: replicate the same prepend+redraw for the custom-only case.
		const origFind = BattleSearch.prototype.find;
		BattleSearch.prototype.find = function (query, firstElem) {
			const ret = origFind.call(this, query, firstElem);
			if (ret === true && !this.filters && this.engine.__cfFilters && this.engine.__cfFilters.length) {
				this.resultSet = [['html', this.getFilterText()]].concat(this.resultSet);
				this.renderedIndex = 0;
				this.renderingDone = false;
				this.updateScroll();
			}
			return ret;
		};

		const origRemoveFilter = BattleSearch.prototype.removeFilter;
		BattleSearch.prototype.removeFilter = function (e) {
			const engine = this.engine;
			if (e) {
				const parts = e.currentTarget.value.split(':');
				if (parts[0] === 'custom') {
					const idx = (engine.__cfFilters || []).indexOf(parts[1]);
					if (idx >= 0) engine.__cfFilters.splice(idx, 1);
					engine.results = null;
					this.filters = engine.filters;
					this.find('');
					return true;
				}
				return origRemoveFilter.call(this, e);
			}
			// No-arg call: box is empty and the user hit backspace/esc to delete the
			// last filter. Prefer native behavior (pop the last native filter) when one
			// exists; otherwise fall back to popping the last custom filter, so backspace
			// still works when only custom filters are active.
			if (this.filters && this.filters.length) {
				return origRemoveFilter.call(this, e);
			}
			if (engine.__cfFilters && engine.__cfFilters.length) {
				engine.__cfFilters.pop();
				engine.results = null;
				this.filters = engine.filters;
				this.find('');
				return true;
			}
			return origRemoveFilter.call(this, e);
		};

		BattleSearch.prototype.__cfChipsPatched = true;
	}

	/** Pokémon search: for each active category, which of its moves can this species
	 *  actually learn (via the real canLearn() walk)? Same shape computeMoveCategoryMatches
	 *  below produces (category -> array of matched moveDefs), so both feed the same
	 *  Tooltip.show() unmodified. Ability-kind categories (see move-data.js's `kind` note)
	 *  skip canLearn() entirely and defer to computeAbilityMatches instead. */
	function computeCategoryMatches(typedSearch, speciesId, activeCats) {
		const result = {};
		for (const catId of activeCats) {
			const cat = window.CF_MOVE_CATEGORIES[catId];
			if (cat && cat.kind === 'ability') {
				result[catId] = computeAbilityMatches(speciesId, catId);
				continue;
			}
			const matched = [];
			for (const moveDef of getCategoryMoveList(catId)) {
				if (typedSearch.canLearn(speciesId, moveDef.id)) matched.push(moveDef);
			}
			result[catId] = matched;
		}
		return result;
	}

	/** Move search: for each active category, is this specific move tagged with it? No
	 *  canLearn() involved here — a move row only appears at all if the native engine
	 *  already considers it legal for the set's species, so this is a plain membership
	 *  check against the category's move list. Wrapped in a 0-or-1-element array so the
	 *  result has the exact same shape as computeCategoryMatches above. */
	function computeMoveCategoryMatches(moveId, activeCats) {
		const result = {};
		for (const catId of activeCats) {
			const found = getCategoryMoveList(catId).find(m => m.id === moveId);
			result[catId] = found ? [found] : [];
		}
		return result;
	}

	/** A move row's id is normally the plain move id ('quickattack'), but the row
	 *  representing a set's *currently filled* move slot can appear as '_SLOT_moveid'
	 *  (see DexSearch.getResultName's own handling of the same prefix) — strip that down
	 *  to the real move id so both the category-membership check and the __cfMatches map
	 *  key (which the tooltip looks up by plain move id) line up correctly. */
	function normalizeMoveRowId(rawId) {
		if (rawId.charAt(0) === '_') {
			const parts = rawId.slice(1).split('_');
			return parts[1] || '';
		}
		return rawId;
	}

	// ---------------------------------------------------------------------
	// Speed filter: a small persistent widget docked under the native
	// "Sort: ..." row in Pokémon search, comparing each result's base Speed
	// stat against a number the user types in. Not a typed category — there's
	// nothing to type into the search box for this one, it's just always
	// there (like the sort row itself) whenever a sort row is.
	//
	// State lives on the engine as `__cfSpeedFilter = { op, orEqual, value }`:
	//  - `op`: '>' | '<' | null (null = the "-" state — op-wise inactive)
	//  - `orEqual`: boolean, toggled independently by the "=" button
	//  - `value`: number | null (null = nothing typed yet)
	// The two buttons combine into five active comparisons plus one fully-off
	// state, matching what was asked for (> < = >= <=):
	//   op='-' (null), eq=off  -> filter OFF entirely
	//   op='-' (null), eq=on   -> exactly equal
	//   op='>',        eq=off  -> greater than
	//   op='>',        eq=on   -> greater than or equal
	//   op='<',        eq=off  -> less than
	//   op='<',        eq=on   -> less than or equal
	// A filter with no number typed yet behaves as OFF regardless of op/eq,
	// so toggling the buttons before typing a number never hides everything.
	// ---------------------------------------------------------------------

	function getSpeedFilter(engine) {
		return engine.__cfSpeedFilter || (engine.__cfSpeedFilter = { op: null, orEqual: false, value: null });
	}

	function speedFilterActive(sf) {
		if (sf.value === null || sf.value === undefined || Number.isNaN(sf.value)) return false;
		return sf.op !== null || sf.orEqual;
	}

	function passesSpeedFilter(sf, baseSpe) {
		if (baseSpe === null || baseSpe === undefined) return true;
		if (sf.op === null) return baseSpe === sf.value; // eq-only ("=")
		if (sf.op === '>') return sf.orEqual ? baseSpe >= sf.value : baseSpe > sf.value;
		if (sf.op === '<') return sf.orEqual ? baseSpe <= sf.value : baseSpe < sf.value;
		return true;
	}

	function cycleSpeedOp(op) {
		if (op === '>') return '<';
		if (op === '<') return null;
		return '>';
	}

	/** Renders the widget: a single rounded-rect pill (same border-radius as the native
	 *  Pokémon textbox) — not a full colored row. Unselected is the default look for both
	 *  buttons (flat gray); tier-header blue is reserved for whichever button is actually
	 *  engaged, via `.active` — so e.g. with op='>' and eq off, only the op button is blue.
	 *  Button labels/state reflect the engine's current __cfSpeedFilter so a re-render
	 *  (e.g. after clicking a button) shows the new state immediately.
	 *
	 *  Alignment: floated flush to the row's own right edge would overshoot past where the
	 *  native sort columns actually end — `.utilichart li` rows are wider than the sum of
	 *  the native .numsortcol/.pnamesortcol/.typesortcol/.abilitysortcol/.statsortcol
	 *  widths, so there's real empty space to their right. colsWidth reproduces that same
	 *  sum (see the matching widths in style.css's comment) so the pill's right edge lines
	 *  up with the BST column above it instead of straying further right. statCols drops
	 *  from 7 to 6 in Gen 1, matching renderPokemonSortRow's own SpA/SpD → single "Spc"
	 *  column collapse. */
	function renderSpeedFilterRow(engine) {
		const sf = getSpeedFilter(engine);
		const opLabel = sf.op === '>' ? '&gt;' : sf.op === '<' ? '&lt;' : '−';
		const opActiveCls = sf.op !== null ? ' active' : '';
		const eqActiveCls = sf.orEqual ? ' active' : '';
		const valStr = (sf.value === null || sf.value === undefined) ? '' : String(sf.value);
		const gen = engine.dex && engine.dex.gen;
		const statCols = (gen && gen < 2) ? 6 : 7;
		const colsWidth = 80 + 127 + 70 + 172 + statCols * 24;
		return `<li class="result"><div class="cf-speedrow">` +
			`<div class="cf-speedrow-align" style="width:${colsWidth}px">` +
			`<span class="cf-pill">` +
			`<button type="button" class="cf-speedop-btn${opActiveCls}" data-cf-role="op">${opLabel}</button>` +
			`<button type="button" class="cf-speedeq-btn${eqActiveCls}" data-cf-role="eq">=</button>` +
			`<input type="text" inputmode="numeric" autocomplete="off" class="cf-speedval-input" ` +
			`data-cf-role="val" placeholder="Spe" value="${escapeHTML(valStr)}" />` +
			`</span>` +
			`</div>` +
			`</div></li>`;
	}

	/** Post-filters an already-computed engine.results in place, mirroring the header
	 *  dedup/trim behavior of BattleTypedSearch.getResults()'s own filter pass so the
	 *  narrowed list still reads naturally (no dangling/duplicate headers). Handles both
	 *  Pokémon search (row = ['pokemon', speciesId]) and move search
	 *  (row = ['move', moveId]) — see the two compute*Matches functions above. Also
	 *  injects the Speed filter row (see above) right after any native sort row, and
	 *  applies it to Pokémon rows — this runs unconditionally now (no more bailing out
	 *  when no typed category filter is active), since the Speed row needs to appear
	 *  any time there's a sort row to dock under, filters or not.
	 *
	 *  A `negative: true` category (currently only ballbomb) inverts the pass condition: the
	 *  row passes when it did NOT match. `matches` still stores the raw (un-inverted)
	 *  per-category result either way, since that's what the tooltip reads — for a negative
	 *  category on a passing row, that's always an empty array (nothing to explain: the row
	 *  was kept for the *absence* of a match), which the tooltip already skips like any other
	 *  empty result. */
	function applyCustomFilters(engine) {
		const active = engine.__cfFilters || [];
		const matches = new Map();
		engine.__cfMatches = matches;
		if (!engine.results) return;

		const sf = getSpeedFilter(engine);
		const sfActive = speedFilterActive(sf);
		const typedSearch = engine.typedSearch;
		const filtered = [];
		for (const row of engine.results) {
			const type = row[0];
			if (type === 'sortpokemon') {
				filtered.push(row);
				filtered.push(['cf-speedrow']);
			} else if (type === 'pokemon' || type === 'move') {
				const rowId = type === 'move' ? normalizeMoveRowId(row[1]) : row[1];
				let allMatch = true;
				if (active.length) {
					const rowMatches = (type === 'pokemon')
						? computeCategoryMatches(typedSearch, rowId, active)
						: computeMoveCategoryMatches(rowId, active);
					allMatch = active.every(catId => {
						const cat = window.CF_MOVE_CATEGORIES[catId];
						const matched = !!(rowMatches[catId] && rowMatches[catId].length);
						return (cat && cat.negative) ? !matched : matched;
					});
					if (allMatch) matches.set(rowId, rowMatches);
				}
				if (allMatch && type === 'pokemon' && sfActive) {
					const species = window.Dex.species.get(rowId);
					const baseSpe = species && species.baseStats ? species.baseStats.spe : null;
					allMatch = passesSpeedFilter(sf, baseSpe);
				}
				if (!allMatch) continue;
				filtered.push(row);
			} else if (type === 'header' || type === 'html') {
				if (filtered.length && filtered[filtered.length - 1][0] === 'header') {
					filtered[filtered.length - 1] = row;
				} else {
					filtered.push(row);
				}
			} else {
				filtered.push(row);
			}
		}
		if (filtered.length && filtered[filtered.length - 1][0] === 'header') filtered.pop();
		engine.results = filtered;
	}

	function patchDexSearch() {
		const DexSearch = window.DexSearch;

		const origSetType = DexSearch.prototype.setType;
		DexSearch.prototype.setType = function (searchType, format, speciesOrSet) {
			if (searchType !== (this.typedSearch && this.typedSearch.searchType)) {
				this.__cfFilters = null;
				this.__cfMatches = null;
				this.__cfSpeedFilter = null;
			}
			return origSetType.call(this, searchType, format, speciesOrSet);
		};

		const origAddFilter = DexSearch.prototype.addFilter;
		DexSearch.prototype.addFilter = function (entry) {
			const type = entry[0];
			if (type === 'custom') {
				const searchType = this.typedSearch && this.typedSearch.searchType;
				if (searchType !== 'pokemon' && searchType !== 'move') return false;
				const cat = window.CF_MOVE_CATEGORIES[entry[1]];
				if (!cat || !cat.searchTypes.includes(searchType)) return false;
				this.__cfFilters = this.__cfFilters || [];
				if (!this.__cfFilters.includes(entry[1])) {
					this.__cfFilters.push(entry[1]);
					this.results = null;
				}
				return true;
			}
			return origAddFilter.call(this, entry);
		};

		const origFind = DexSearch.prototype.find;
		DexSearch.prototype.find = function (query) {
			const changed = origFind.call(this, query);
			const searchType = this.typedSearch && this.typedSearch.searchType;
			if (searchType === 'pokemon' || searchType === 'move') {
				CF.lastEngine = this;
				applyCustomFilters(this);
				injectTypedFilterSuggestions(this, this.query);
			}
			return changed;
		};
	}

	// ---------------------------------------------------------------------
	// Tooltip: a single floating overlay shared by two unrelated hover features — which
	// custom filter(s) a hovered search result matched (buildFilterMatchTooltipHTML), and the
	// speed comparison popup (buildSpeedComparisonTooltipHTML, further down). DOM/CSS mirrors
	// battle-tooltips.ts's #tooltipwrapper structure but under our own id so it can never
	// collide with the native singleton's lifecycle (BattleTooltips.isLocked/elem/etc). Tooltip
	// itself only knows how to show/position/hide a pre-built `.cf-tooltip` HTML string — it
	// has no idea what's inside, so a third hover feature can reuse it later the same way
	// without Tooltip itself needing to change.
	// ---------------------------------------------------------------------
	const Tooltip = {
		wrapperEl: null,

		show(anchorEl, html) {
			if (!this.wrapperEl) {
				this.wrapperEl = document.createElement('div');
				this.wrapperEl.id = 'cf-tooltipwrapper';
				document.body.appendChild(this.wrapperEl);
			}
			this.wrapperEl.innerHTML = html;
			this.wrapperEl.style.display = '';
			this.position(anchorEl);
		},

		/** Width is measured from the actual rendered `.cf-tooltip` (offsetWidth) rather than
		 *  assumed, since callers aren't all the same width — the filter-match tooltip is the
		 *  base 300px, but the speed comparison one widens itself via an extra modifier class
		 *  (cf-speedcmp-tooltip, style.css) to fit its table. */
		position(anchorEl) {
			const rect = anchorEl.getBoundingClientRect();
			const tooltipEl = this.wrapperEl.querySelector('.cf-tooltip');

			this.wrapperEl.style.visibility = 'hidden';
			this.wrapperEl.style.left = '0px';
			this.wrapperEl.style.top = '0px';
			const width = tooltipEl.offsetWidth;
			const height = tooltipEl.offsetHeight;
			this.wrapperEl.style.visibility = '';

			let left = Math.max(rect.left - 2, 0);
			left = Math.min(left, window.innerWidth - width - 4);
			this.wrapperEl.style.left = Math.max(4, left) + 'px';

			let top = rect.top - 5 - height;
			if (top < 4) top = rect.bottom + 5;
			top = Math.max(4, Math.min(top, window.innerHeight - height - 4));
			this.wrapperEl.style.top = top + 'px';
		},

		hide() {
			if (this.wrapperEl) this.wrapperEl.style.display = 'none';
		},
	};

	function findResultLi(target) {
		return target.closest ? target.closest('li.result') : null;
	}

	/** Extracted verbatim from Tooltip's own old show() — building this HTML is filter-match
	 *  business logic, not Tooltip's job (see Tooltip's own doc comment above). */
	function buildFilterMatchTooltipHTML(matches) {
		let html = `<div class="cf-tooltip"><h2>Matched custom filters</h2>`;
		for (const catId of CATEGORY_ORDER) {
			const moveDefs = matches[catId];
			if (!moveDefs || !moveDefs.length) continue;
			const cat = window.CF_MOVE_CATEGORIES[catId];
			const moveHtml = moveDefs.map(md => {
				if (md.conditional) {
					return `${escapeHTML(md.name)}` +
						`<span class="cf-conditional-tag" title="${escapeHTML(md.reason || 'Conditional')}">conditional</span>`;
				}
				return escapeHTML(md.name);
			}).join(', ');
			html += `<p class="tooltip-section"><strong>${escapeHTML(cat ? cat.label : catId)}</strong><br />` +
				`<span class="cf-movelist">${moveHtml}</span></p>`;
		}
		html += `</div>`;
		return html;
	}

	// Pokémon-search rows only: a species can match a filter through any of several moves in
	// its pool, so the tooltip is the only way to see *which* one(s) actually qualified. A
	// move-search row IS a specific move already sitting in a pre-filtered list — hovering it
	// would just repeat what's already on screen (its own name, next to the active filter
	// chip), so there's deliberately no tooltip for move rows.
	function onMouseOver(ev) {
		const li = findResultLi(ev.target);
		if (li) {
			const engine = CF.lastEngine;
			if (!engine || !engine.__cfFilters || !engine.__cfFilters.length) return;
			const pokemonLink = li.querySelector('a[data-entry^="pokemon|"]');
			if (pokemonLink) {
				const name = pokemonLink.getAttribute('data-entry').slice('pokemon|'.length);
				const speciesId = window.toID(name);
				const matches = engine.__cfMatches && engine.__cfMatches.get(speciesId);
				if (matches) Tooltip.show(li, buildFilterMatchTooltipHTML(matches));
			}
			return;
		}

		const speedRow = ev.target.closest ? ev.target.closest('.cf-speedtier-row') : null;
		if (speedRow && CF.buildSpeedComparisonTooltipHTML) {
			const html = CF.buildSpeedComparisonTooltipHTML(speedRow);
			if (html) Tooltip.show(speedRow, html);
		}
	}

	function onMouseOut(ev) {
		const li = findResultLi(ev.target);
		if (li) {
			if (ev.relatedTarget && li.contains(ev.relatedTarget)) return;
			Tooltip.hide();
			return;
		}

		const speedRow = ev.target.closest ? ev.target.closest('.cf-speedtier-row') : null;
		if (speedRow) {
			if (ev.relatedTarget && speedRow.contains(ev.relatedTarget)) return;
			Tooltip.hide();
		}
	}

	/** Forces a full re-filter + redraw of whatever search box is currently active, the
	 *  same way applying/removing a typed filter chip already does elsewhere in this file
	 *  (patchLegacyFilterChips's removeFilter, DexSearch.prototype.addFilter): null out
	 *  engine.results first so DexSearch.prototype.find()'s own "nothing changed" guard
	 *  (`this.query === query && this.results`) can't short-circuit and skip recomputing,
	 *  then re-run find() with whatever query text is already in the box so it's preserved
	 *  rather than cleared. */
	function refreshSearch() {
		const s = window.search;
		if (!s || !s.engine) return;
		s.engine.results = null;
		s.find(s.q || '');
	}

	/** The Speed filter's buttons/input aren't native `<a data-entry>` links, so they need
	 *  their own delegated handlers rather than riding the site's existing chartClick chain.
	 *  Every state change forces a full redraw (see refreshSearch) — which, since the
	 *  renderer rebuilds these `<li>` rows from scratch each time (no DOM diffing), destroys
	 *  and recreates the <input> on every keystroke. Without restoring focus/cursor after
	 *  that rebuild, the number field would lose focus after each character typed. */
	function onSpeedFilterClick(ev) {
		const opBtn = ev.target.closest('.cf-speedop-btn');
		const eqBtn = ev.target.closest('.cf-speedeq-btn');
		if (!opBtn && !eqBtn) return;
		ev.preventDefault();
		const s = window.search;
		if (!s || !s.engine) return;
		const sf = getSpeedFilter(s.engine);
		if (opBtn) {
			sf.op = cycleSpeedOp(sf.op);
		} else {
			sf.orEqual = !sf.orEqual;
		}
		refreshSearch();
	}

	let _speedInputTimer = null;
	function onSpeedFilterInput(ev) {
		const input = ev.target.closest('.cf-speedval-input');
		if (!input) return;
		const s = window.search;
		if (!s || !s.engine) return;
		const sf = getSpeedFilter(s.engine);
		const raw = input.value.trim();
		const parsed = raw === '' ? null : Number(raw);
		sf.value = (parsed === null || Number.isNaN(parsed)) ? null : parsed;

		// Debounce: avoid a full filter recomputation + DOM rebuild on every
		// keystroke while the user is typing a multi-digit number.
		const cursorPos = input.selectionStart;
		if (_speedInputTimer) clearTimeout(_speedInputTimer);
		_speedInputTimer = setTimeout(() => {
			_speedInputTimer = null;
			refreshSearch();
			const newInput = document.querySelector('.cf-speedval-input');
			if (newInput) {
				newInput.focus();
				const pos = Math.min(cursorPos, newInput.value.length);
				newInput.setSelectionRange(pos, pos);
			}
		}, 80);
	}

	// 4g: bounded retry — give up after ~15 seconds (~900 frames at 60fps)
	// instead of looping forever if Showdown renames/removes a required global.
	const WAIT_MAX_RETRIES = 900;

	/** Shared bounded-retry polling shape behind both waitForGlobals and
	 *  waitForSideRoomSettings below: check condition() every animation frame, call
	 *  cb(value) with condition()'s own (truthy) return value once it succeeds, or
	 *  onGiveUp(cb) after WAIT_MAX_RETRIES frames (~15s) with no success — condition
	 *  itself is re-run on that final frame, so onGiveUp always sees the same "still
	 *  false" state that triggered it. */
	function pollUntil(condition, onGiveUp, cb, retries) {
		if (retries === undefined) retries = 0;
		const value = condition();
		if (value) {
			cb(value);
		} else if (retries >= WAIT_MAX_RETRIES) {
			onGiveUp(cb);
		} else {
			requestAnimationFrame(() => pollUntil(condition, onGiveUp, cb, retries + 1));
		}
	}

	function waitForGlobals(cb) {
		pollUntil(
			() => !!(window.DexSearch && window.BattleMovedex && window.BattleTeambuilderTable &&
				window.BattlePokedex && window.toID && window.Dex && window.CF_MOVE_CATEGORIES && window.BattleSearch),
			() => {
				console.warn('[Better Teambuilder] Gave up waiting for Showdown globals after ~15 s. ' +
					'The extension will not activate — the site may have changed its bundle layout.');
			},
			cb
		);
	}

	/** One-time startup tidy: closes whatever side rooms the client restored from the previous
	 *  session (Showdown reopens them automatically on load) so the layout starts clean. Not
	 *  hooked to joinRoom and doesn't run again after — this only fires once, right after
	 *  load, not every time the teambuilder (or anything else) is opened. Gated by the
	 *  "closeSideRoomsOnLoad" option (see settings-bridge.js/options.html) — on by default,
	 *  matching prior always-on behavior, but the user can turn it off. */
	function closeSideRoomsOnLoad() {
		if (!window.app) return;
		// 1. Leave any chat rooms that are open on the right side
		if (window.app.sideRoomList) {
			const sideRooms = window.app.sideRoomList.slice();
			for (const room of sideRooms) {
				if (window.app.leaveRoom) {
					window.app.leaveRoom(room.id);
				}
			}
		}
		// 2. Hide the main lobby chat if it is the active side room
		if (window.app.sideRoom && typeof window.app.sideRoom.closeHide === 'function') {
			window.app.sideRoom.closeHide();
		} else {
			const hideBtn = document.querySelector('button[name="closeHide"]');
			if (hideBtn) hideBtn.click();
		}
	}

	/** Docks a small extension-owned panel to the right of the teambuilder's own content —
	 *  see style.css's matching comment for the full picture (the !important override that
	 *  actually shrinks #room-teambuilder itself, and why the sidebar can't just be inserted
	 *  as a DOM child of it: TeambuilderRoom.update() wipes that whole subtree via $el.html()
	 *  on nearly every interaction). This function's only job is deciding when
	 *  body.cf-teambuilder-split should be on: window width large enough, no side room
	 *  currently docked, AND a specific Pokémon is currently being edited (room.curSet set —
	 *  same state the room's own template checks to decide whether to render the individual
	 *  editor, i.e. the `.teamchartbox.individual` markup, vs. the team-overview list; there's
	 *  nothing useful to split against on the list screen). Checked directly rather than
	 *  inferred from #room-teambuilder's own rendered width (which the CSS override would
	 *  make circular: forcing the room to 50% would make it immediately measure as "too
	 *  narrow," undoing the very state that set it, flip-flopping every frame). Re-evaluated
	 *  on window resize, and by wrapping six TeambuilderRoom-family methods (via
	 *  wrapWithSplitUpdate below) in two groups:
	 *
	 *  Group 1 — does curSet/the room's focus itself need re-evaluating (species changed, room
	 *  changed, split should turn on/off)? app.updateLayout (room focus / side-room changes),
	 *  TeambuilderRoom.prototype.update (in-room navigation, e.g. selecting a Pokémon or
	 *  backing out to the list), TeambuilderRoom.prototype.updateSetTop (changing the species
	 *  *within* the current slot via setPokemon() — this one only re-renders .teambar/
	 *  .teamchart directly, it never calls update() at all, so without this hook the sidebar
	 *  kept showing the previous species until the user left and re-entered the slot), and
	 *  TeambuilderRoom.prototype.updatePokemonSprite (the same gap again through a different
	 *  entry point: AltFormPopup.setForm(), picking an alt cosmetic form from the species-icon
	 *  popup, mutates curSet.species and calls only updatePokemonSprite() when a set is
	 *  already being edited, never update()/updateSetTop()).
	 *
	 *  Group 2 — does the *sidebar's own clickable/disabled/equipped state* need refreshing,
	 *  because the user edited a move/ability/item/nature directly through the NATIVE
	 *  teambuilder fields rather than clicking something in our sidebar? None of these write
	 *  paths go through any Group 1 method (except item, which happens to call
	 *  updatePokemonSprite already) — without hooking them too, e.g. typing a new move into the
	 *  native move1 box wouldn't grey/un-grey that move in our own Moves section until
	 *  something else (switching slots, resizing) happened to trigger a re-render.
	 *  TeambuilderRoom.prototype.chartSet (the single commit point both chartClick — picking a
	 *  result from the native search dropdown — and chartChange — typing a value and blurring
	 *  the field — funnel through, for the pokemon/ability/item/move1-4 chart fields), and
	 *  TeambuilderRoom.prototype.natureChange (the nature <select>). Deliberately NOT
	 *  statChange/statSlide (the EV number box and slider): none of the sidebar's own
	 *  clickable/disabled/equipped checks read curSet.evs at all (Spreads never gets an equipped
	 *  highlight — see buildSpreadsSection's own comment), so there is nothing in the sidebar
	 *  for an EV edit to desync; hooking them anyway would rebuild the full 6-section sidebar on
	 *  every keystroke (statChange is bound to both keyup and input) and every drag frame
	 *  (statSlide is bound to the slider's own input event, which fires continuously) for zero
	 *  visible benefit — pure, avoidable jank.
	 *
	 *  Across both groups the wraps themselves never modify what the wrapped method does, only
	 *  observe that it ran (updateSplitState() afterward) — with one intentional exception:
	 *  this file's own click-to-apply handlers (applyMove/applySetField/etc., near
	 *  onPikaSidebarClick) mutate curSet/curSetList directly and then call
	 *  tbRoom.updateSetTop() themselves, reusing Showdown's own set-editor redraw rather than
	 *  hand-rolling one — which conveniently also re-triggers this same hook chain to refresh
	 *  the sidebar in the same pass. Whenever the split turns (or stays) on, this also populates
	 *  the sidebar with Pikalytics data for the currently-edited species/format — see
	 *  renderPikalyticsSidebar and pikalytics.js. */
	function patchTeambuilderSidebar() {
		if (!window.app || typeof window.app.updateLayout !== 'function' || !window.TeambuilderRoom ||
			typeof window.TeambuilderRoom.prototype.update !== 'function' ||
			typeof window.TeambuilderRoom.prototype.updateSetTop !== 'function' ||
			typeof window.TeambuilderRoom.prototype.updatePokemonSprite !== 'function' ||
			typeof window.TeambuilderRoom.prototype.chartSet !== 'function' ||
			typeof window.TeambuilderRoom.prototype.natureChange !== 'function') return;

		// The set-editor card and movepool list are both built with fixed-pixel CSS (e.g.
		// teambuilder.css's `.set-form .set-stats { width: 138px; }`) that doesn't reflow
		// below Room's own default bestWidth (659, unmodified by TeambuilderRoom — the same
		// number Showdown's own updateLayout() uses to decide a room needs its non-cramped
		// width) — short of that, buttons/columns clip rather than wrap. There's no graceful
		// middle ground to degrade into either: Showdown's only narrower alternative is
		// .tiny-layout, which doesn't reflow this card, it hides it in favor of a separate
		// full-screen mobile sub-editor. So the split has to switch off *before* either column
		// would drop under 659, not partway through — 2 x 659 = 1318, rounded up to 1320.
		const SPLIT_THRESHOLD = 1320;

		/** Two independent sub-panels rather than one innerHTML blob, so a species switch
		 *  (which only needs to redraw the right-hand Pikalytics grid) doesn't wipe and reset
		 *  the scroll position of the left-hand speed-tier column, and vice versa — the two
		 *  update on entirely different triggers (species/format vs. format-only, see
		 *  renderPikalyticsSidebar and renderSpeedTierColumn respectively). */
		function ensureTeambuilderSidebarEl() {
			let el = document.getElementById('cf-teambuilder-sidebar');
			if (el) return el;
			el = document.createElement('div');
			el.id = 'cf-teambuilder-sidebar';
			el.innerHTML =
				'<div id="cf-speedtier-col" class="cf-pika-section">' +
					'<h3 class="cf-pika-header">Speed</h3>' +
					'<div class="cf-pika-rows"><p class="cf-sidebar-placeholder">Loading…</p></div>' +
				'</div>' +
				'<div id="cf-pika-panel"><p class="cf-sidebar-placeholder">Nothing here yet.</p></div>';
			document.body.appendChild(el);
			return el;
		}

		function ensurePikaPanelEl() {
			ensureTeambuilderSidebarEl();
			return document.getElementById('cf-pika-panel');
		}

		function pikaSectionHTML(title, rowsHTML) {
			return `<div class="cf-pika-section"><h3 class="cf-pika-header">${escapeHTML(title)}</h3>` +
				`<div class="cf-pika-rows">${rowsHTML}</div></div>`;
		}

		/** Click-to-apply row markup shared by every clickable section below: `equipped` just
		 *  controls the highlight (cf-pika-row-equipped); `disabled` is decided independently
		 *  per section — e.g. an equipped move stays clickable (removes it, see applyMove's
		 *  toggle) while an equipped teammate is disabled (nothing sensible to do re-clicking
		 *  it). Disabled rows get no `data-cf-pika-action` at all (nothing for
		 *  onPikaSidebarClick to match) on top of the CSS `pointer-events: none` — belt and
		 *  suspenders. */
		function pikaRowAttrs(action, value, equipped, disabled) {
			let cls = 'cf-pika-row';
			cls += disabled ? ' cf-pika-row-disabled' : ' cf-pika-row-clickable';
			if (equipped) cls += ' cf-pika-row-equipped';
			const attrs = disabled ? '' : ` data-cf-pika-action="${action}" data-cf-pika-value="${escapeHTML(value)}"`;
			return { cls, attrs };
		}

		/** "Other" is Pikalytics' bucket for everything below its per-move cutoff — real
		 *  aggregate data, not a specific move, so it's kept (dropping it would silently
		 *  understate usage) but has no `type` of its own, hence the blank spacer. Click-to-
		 *  apply: a move already in the set stays clickable (highlighted as equipped) —
		 *  clicking it removes it (see applyMove's toggle behavior). A move NOT in the set
		 *  fills the first empty slot, or is disabled (greyed out) only once all 4 slots are
		 *  already taken by *other* moves — an equipped move is never greyed out, since it's
		 *  always clickable to remove regardless of how full the set is. */
		function buildMovesSection(mon, tbRoom) {
			const moves = mon.moves || [];
			if (!moves.length) return pikaSectionHTML('Common Moves', '<p class="cf-pika-empty">No move data.</p>');
			const set = tbRoom.curSet;
			const full = curSetMovesFull(set);
			const rows = moves.map((m) => {
				const icon = m.type ? window.Dex.getTypeIcon(m.type) : '<span class="cf-pika-icon-spacer"></span>';
				const equipped = curSetHasMove(set, m.move);
				const { cls, attrs } = pikaRowAttrs('move', m.move, equipped, !equipped && full);
				return `<div class="${cls}"${attrs}>${icon}` +
					`<span class="cf-pika-name">${escapeHTML(m.move)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(m.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Moves', rows);
		}

		/** Same shape as buildNaturesSection's own rows ({ability, percent}) — confirmed live
		 *  via the /api/p/ endpoint. Click-to-apply: always clickable (re-applying the current
		 *  ability is a harmless no-op), just highlighted when it matches the set's current
		 *  ability. */
		function buildAbilitiesSection(mon, tbRoom) {
			const abilities = (mon.abilities || []).filter((a) => (parseFloat(a.percent) || 0) > 0);
			if (!abilities.length) return pikaSectionHTML('Common Abilities', '<p class="cf-pika-empty">No ability data.</p>');
			const set = tbRoom.curSet;
			const rows = abilities.map((a) => {
				const equipped = !!(set && set.ability && toIDSafe(set.ability) === toIDSafe(a.ability));
				const { cls, attrs } = pikaRowAttrs('ability', a.ability, equipped, false);
				return `<div class="${cls}"${attrs}><span class="cf-pika-name">${escapeHTML(a.ability)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(a.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Abilities', rows);
		}

		/** The classic community "(+Atk/-SpA)" annotation, via Showdown's own
		 *  window.BattleNatures — the same nature/stat-modifier table the client's own stat UI
		 *  reads (see battle-dex-data.ts), not a hand-maintained copy of it. Empty string for a
		 *  neutral nature (no plus/minus) or if BattleNatures isn't available for some reason —
		 *  not one of the globals waitForGlobals already gates on, so this degrades to no
		 *  annotation rather than being a hard dependency. */
		function natureModifierHTML(natureName) {
			const nature = window.BattleNatures && window.BattleNatures[natureName];
			if (!nature || !nature.plus || !nature.minus) return '';
			return ` <span class="cf-pika-nature-mod">(+${STAT_LABEL_BY_ID[nature.plus]}/-${STAT_LABEL_BY_ID[nature.minus]})</span>`;
		}

		/** Nature usage is tracked two different ways depending on the format: some give a
		 *  standalone `natures` array; others (e.g. gen9ou) only bundle a nature into each
		 *  `spreads` entry, with no separate breakdown — so when `natures` is missing/empty,
		 *  it's derived here by summing spread percentages per nature instead of showing
		 *  nothing. Click-to-apply: always clickable, sets curSet.nature only (not the EVs —
		 *  see buildSpreadsSection for nature+EVs together), highlighted when it's already the
		 *  set's current nature. */
		function buildNaturesSection(mon, tbRoom) {
			let natures = mon.natures;
			if (!natures || !natures.length) {
				const byNature = new Map();
				for (const s of (mon.spreads || [])) {
					if (!s.nature) continue;
					byNature.set(s.nature, (byNature.get(s.nature) || 0) + (parseFloat(s.percent) || 0));
				}
				natures = Array.from(byNature, ([nature, percent]) => ({ nature, percent }))
					.sort((a, b) => b.percent - a.percent);
			}
			natures = natures.filter((n) => (parseFloat(n.percent) || 0) > 0);
			if (!natures.length) return pikaSectionHTML('Common Natures', '<p class="cf-pika-empty">No nature data.</p>');
			const set = tbRoom.curSet;
			const rows = natures.map((n) => {
				const pct = typeof n.percent === 'number' ? n.percent.toFixed(1) : n.percent;
				const equipped = !!(set && set.nature && toIDSafe(set.nature) === toIDSafe(n.nature));
				const { cls, attrs } = pikaRowAttrs('nature', n.nature, equipped, false);
				return `<div class="${cls}"${attrs}><span class="cf-pika-name"><span class="cf-pika-nature-name">${escapeHTML(n.nature)}</span>${natureModifierHTML(n.nature)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(String(pct))}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Natures', rows);
		}

		/** "Other" bucket, same as buildMovesSection — kept, no icon. Click-to-apply: always
		 *  clickable, highlighted when it matches the set's current item. */
		function buildItemsSection(mon, tbRoom) {
			const items = mon.items || [];
			if (!items.length) return pikaSectionHTML('Common Items', '<p class="cf-pika-empty">No item data.</p>');
			const set = tbRoom.curSet;
			const rows = items.map((it) => {
				const iconStyle = (it.item && window.Dex) ? window.Dex.getItemIcon(it.item) : '';
				const icon = iconStyle ? `<span class="itemicon" style="${escapeHTML(iconStyle)}"></span>` : '<span class="cf-pika-icon-spacer"></span>';
				const equipped = !!(set && set.item && toIDSafe(set.item) === toIDSafe(it.item));
				const { cls, attrs } = pikaRowAttrs('item', it.item, equipped, false);
				return `<div class="${cls}"${attrs}>${icon}` +
					`<span class="cf-pika-name">${escapeHTML(it.item)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(it.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Items', rows);
		}

		/** A real <table> — one cell per stat — rather than a joined string, so columns line
		 *  up via normal table layout instead of monospace-font character padding. Nature only
		 *  gets its own leading column when at least one spread actually has one; Champions VGC
		 *  spreads never do (confirmed live, `nature` is always ""), so in practice this column
		 *  is omitted rather than showing empty on every row. Click-to-apply: always clickable,
		 *  sets curSet.nature (if this spread carries one) AND curSet.evs together (see
		 *  applySpread) — no equipped highlight, since "does this row's nature+EVs exactly
		 *  match the current set" is a fuzzier match than the other sections' single-value
		 *  equality checks. */
		function buildSpreadsSection(mon) {
			const spreads = mon.spreads || [];
			if (!spreads.length) return pikaSectionHTML('Common Spreads', '<p class="cf-pika-empty">No spread data.</p>');

			const hasNature = spreads.some((s) => s.nature);
			const headerCells = (hasNature ? '<th class="cf-spread-nature">Nature</th>' : '') +
				STAT_LABELS.map((label) => `<th>${label}</th>`).join('') + '<th>Usage</th>';

			const bodyRows = spreads.map((s) => {
				const natureCell = hasNature ? `<td class="cf-spread-nature"><span class="cf-pika-nature-name">${escapeHTML(s.nature)}</span>${natureModifierHTML(s.nature)}</td>` : '';
				const evCells = String(s.ev).split('/').map((v) => `<td>${escapeHTML(v)}</td>`).join('');
				return `<tr class="cf-pika-row-clickable" data-cf-pika-action="spread" data-cf-pika-nature="${escapeHTML(s.nature || '')}" data-cf-pika-ev="${escapeHTML(s.ev)}">` +
					`${natureCell}${evCells}<td class="cf-pika-pct">${escapeHTML(s.percent)}%</td></tr>`;
			}).join('');

			const table = `<table class="cf-spread-table"><thead><tr>${headerCells}</tr></thead>` +
				`<tbody>${bodyRows}</tbody></table>`;
			return pikaSectionHTML('Common Spreads', table);
		}

		/** Teammate rows don't consistently carry a usage percent (confirmed live: gen9ou's
		 *  do, VGC's generally don't) or a `rank` (the reverse can also happen), so this falls
		 *  back through percent -> explicit rank -> the row's own position in the list — which
		 *  is itself real rank information, the list is already most- to least-common — rather
		 *  than ever leaving a row blank. Click-to-apply: appends a new blank team slot with
		 *  just this species filled in (see applyTeammate) — disabled (and shown as already-
		 *  equipped) if it's already on the team (species clause — no competitive VGC format
		 *  allows a duplicate anyway), disabled without the equipped look if the team's already
		 *  full. */
		function buildTeammatesSection(mon, tbRoom) {
			const team = mon.team || [];
			if (!team.length) return pikaSectionHTML('Common Teammates', '<p class="cf-pika-empty">No teammate data.</p>');
			const full = curTeamFull(tbRoom);
			const rows = team.map((t, i) => {
				const iconStyle = window.Dex ? window.Dex.getPokemonIcon(t.pokemon) : '';
				let pct;
				if (t.percent !== undefined && t.percent !== null) pct = `${escapeHTML(String(t.percent))}%`;
				else if (t.rank !== undefined && t.rank !== null) pct = `#${escapeHTML(String(t.rank))}`;
				else pct = `#${i + 1}`;
				const equipped = curTeamHasSpecies(tbRoom, t.pokemon);
				const { cls, attrs } = pikaRowAttrs('teammate', t.pokemon, equipped, equipped || full);
				return `<div class="${cls}"${attrs}><span class="picon" style="${escapeHTML(iconStyle)}"></span>` +
					`<span class="cf-pika-name">${escapeHTML(t.pokemon)}</span>` +
					`<span class="cf-pika-pct">${pct}</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Teammates', rows);
		}

		/** Speed-tier column (style.css #cf-speedtier-col): the top-20-by-usage species'
		 *  sprites, top to bottom in rank order, each boxed with its usage rank in the top-left
		 *  corner. Same `.picon`/getPokemonIcon() as buildTeammatesSection above, so a
		 *  Mega/regional-forme sprite resolves exactly the same way. Ranks 1-3 get a
		 *  gold/silver/bronze rank badge (cf-speedtier-rank-1/2/3, style.css) instead of the
		 *  plain semi-transparent-black one every other rank gets. `data-cf-species` (not
		 *  `title`) carries the name for buildSpeedComparisonTooltipHTML's hover lookup below —
		 *  deliberately not a native title tooltip, since hovering now shows the real speed
		 *  comparison popup instead and a native tooltip stacked on top of that would just be
		 *  visual noise.
		 *
		 *  speedTierColumnHTML wraps every state (loading/empty/error/loaded — see
		 *  renderSpeedTierColumn) in the exact same `.cf-pika-header`/`.cf-pika-rows` markup
		 *  pikaSectionHTML uses for the other six sections, just without pikaSectionHTML's own
		 *  outer `.cf-pika-section` div — #cf-speedtier-col carries that class directly instead
		 *  (see ensureTeambuilderSidebarEl) since it's a real element with its own id, not a
		 *  disposable wrapper. Same header/row classes end up meaning the same fonts, colors,
		 *  padding, and border as every other section — nothing bespoke to keep in sync. */
		function speedTierColumnHTML(rowsHTML) {
			return `<h3 class="cf-pika-header">Speed</h3><div class="cf-pika-rows">${rowsHTML}</div>`;
		}
		function buildSpeedTierColumnHTML(list) {
			if (!list || !list.length) return speedTierColumnHTML('<p class="cf-sidebar-placeholder">No data.</p>');
			const rows = list.map((entry) => {
				const iconStyle = window.Dex ? window.Dex.getPokemonIcon(entry.name) : '';
				const rankCls = entry.rank >= 1 && entry.rank <= 3 ? ` cf-speedtier-rank-${entry.rank}` : '';
				return `<div class="cf-speedtier-row" data-cf-species="${escapeHTML(entry.name)}">` +
					`<div class="cf-speedtier-box">` +
						`<span class="picon" style="${escapeHTML(iconStyle)}"></span>` +
						`<span class="cf-speedtier-rank${rankCls}">${escapeHTML(String(entry.rank))}</span>` +
					`</div></div>`;
			}).join('');
			return speedTierColumnHTML(rows);
		}

		/** Items with a known Speed-stat effect, id-keyed (toIDSafe). Deliberately small — just
		 *  the two the feature was scoped around (Choice Scarf, Iron Ball) rather than every
		 *  item that touches turn order in some way (e.g. Lagging Tail/Full Incense change move
		 *  priority, not the Speed *stat*, so a straight stat comparison has nothing to do with
		 *  them; Quick Powder only matters on Ditto, deliberately left out for now rather than
		 *  special-cased for one species). Extend this table, not the comparison logic below,
		 *  when another Speed-affecting item needs covering. */
		const SPEED_ITEM_MULTIPLIERS = { choicescarf: 1.5, ironball: 0.5 };

		/** Minimum Pikalytics usage percent for Choice Scarf before buildSpeedComparisonTooltipHTML
		 *  bothers showing the "what if it ran Scarf" column at all — a starting guess, not a
		 *  researched number. The real percent is always shown in that column's own header
		 *  either way, so a borderline case stays visible to judge yourself rather than getting
		 *  silently hidden by wherever this number happens to sit. */
		const SCARF_POPULARITY_THRESHOLD_PERCENT = 5;

		/** Same idea as SCARF_POPULARITY_THRESHOLD_PERCENT, for the "what if it ran its Mega
		 *  Stone" column — a starting guess, not a researched number, with the real percent
		 *  always shown in the column's own header regardless. Deliberately never changes the
		 *  base Foe column itself (see buildSpeedComparisonTooltipHTML's own comment for why a
		 *  species with dominant Mega Stone usage still keeps its base forme as the main Foe
		 *  column) — a Pokémon holding a Mega Stone can't simultaneously hold Choice Scarf, so
		 *  this and the Scarf column are two independent, mutually exclusive "what if" columns
		 *  sitting alongside the same unchanged base column, never merged into it. */
		const MEGA_POPULARITY_THRESHOLD_PERCENT = 15;

		/** Standard Pokémon stat-stage multiplier: positive stages boost by (2+n)/2, negative
		 *  stages cut by 2/(2-n) — e.g. -1 -> 2/3, -2 -> 1/2. Only -1/-2 are ever passed in by
		 *  the scenario table below, but the general formula is no more code than hardcoding
		 *  just those two ratios would be. */
		function speedStageMultiplier(stage) {
			if (!stage) return 1;
			return stage > 0 ? (2 + stage) / 2 : 2 / (2 - stage);
		}

		/** Applies item/status/stage/Tailwind on top of an already-computed base Speed stat
		 *  (tbRoom.getStat('spe', ...) — see buildSpeedComparisonTooltipHTML). All multiplicative,
		 *  so order doesn't change the result; floored once at the end, matching how a single
		 *  displayed stat number is always a whole number in-game (this is an approximation of
		 *  the real battle engine's own multi-step rounding, same simplification tools like the
		 *  Smogon damage calc make — not meant to be bit-exact in extreme edge cases). */
		function applySpeedModifiers(baseStat, itemName, modifiers) {
			let stat = baseStat;
			const itemMult = itemName && SPEED_ITEM_MULTIPLIERS[toIDSafe(itemName)];
			if (itemMult) stat *= itemMult;
			if (modifiers.paralyzed) stat *= 0.5;
			if (modifiers.tailwind) stat *= 2;
			if (modifiers.stage) stat *= speedStageMultiplier(modifiers.stage);
			return Math.floor(stat);
		}

		/** The 9-row scenario table: an ally/foe modifier pair per row, one modifier changed at a
		 *  time (never combined — see the conversation this was scoped in) against an otherwise-
		 *  identical baseline. Row order mirrors how the badges on the speed-tier boxes
		 *  themselves are grouped (Tailwind, then PAR, then stage drops). */
		const SPEED_COMPARISON_SCENARIOS = [
			{ label: 'Base', ally: {}, foe: {} },
			{ label: 'Tailwind (ally)', ally: { tailwind: true }, foe: {} },
			{ label: 'Tailwind (foe)', ally: {}, foe: { tailwind: true } },
			{ label: 'PAR (ally)', ally: { paralyzed: true }, foe: {} },
			{ label: 'PAR (foe)', ally: {}, foe: { paralyzed: true } },
			{ label: '-1 (ally)', ally: { stage: -1 }, foe: {} },
			{ label: '-1 (foe)', ally: {}, foe: { stage: -1 } },
			{ label: '-2 (ally)', ally: { stage: -2 }, foe: {} },
			{ label: '-2 (foe)', ally: {}, foe: { stage: -2 } },
		];

		/** Populated by renderSpeedTierColumn whenever it successfully loads a format's top-20
		 *  list — buildSpeedComparisonTooltipHTML (below) looks up the hovered species' already-
		 *  fetched `mon` payload (base stats, spreads, items) here on hover, rather than
		 *  refetching or threading the list through the DOM some other way. */
		let lastSpeedTierList = null;

		/** "+"/"−"/"" for a Speed EV count — same plus/minus concept as natureModifierHTML above,
		 *  but collapsed to just Speed (that's the only stat this table cares about) instead of
		 *  spelling out which two stats a nature touches. */
		function speedNatureIndicator(natureName) {
			const nature = window.BattleNatures && window.BattleNatures[natureName];
			if (!nature) return '';
			if (nature.plus === 'spe') return '+';
			if (nature.minus === 'spe') return '−';
			return '';
		}

		/** "32 EV" when neutral, "32 EV / +" (or "/ −") when speedNatureIndicator found a boost
		 *  or drop — the slash keeps the EV count and the +/- visually separate rather than
		 *  running them together as "32+". */
		function formatSpeedEvText(ev, indicator) {
			return indicator ? `${ev} EV / ${indicator}` : `${ev} EV`;
		}

		/** Builds the hover popup comparing the currently-edited Pokémon's real Speed against a
		 *  hovered top-20-usage species' *expected* Speed (its base stat + most common EV spread
		 *  + most common nature — the single most-common spread only, not a blend of several).
		 *  Both go through tbRoom.getStat, the exact same method the native Stats/EV panel uses
		 *  to compute the number it displays — not a reimplementation of Pokemon Champions' own
		 *  stat formula (confirmed live: Champions replaced the classic 0-252 EV/IV/level formula
		 *  with a flat `base + ev + 20` scaled by nature, no level or IV involved at all — using
		 *  the real method sidesteps needing to have gotten that right by hand).
		 *
		 *  Items are asymmetric between the two sides, deliberately: the ally's currently-
		 *  equipped item is folded into its base stat once (not a per-row toggle — see
		 *  SPEED_COMPARISON_SCENARIOS' own comment for why only Tailwind/PAR/stage vary per row),
		 *  since it's a real, known fact about the set actually being built. The foe's base
		 *  column never applies an item at all — see the comment above foeBase's own computation
		 *  for why guessing Pikalytics' "most common item" into that baseline caused real
		 *  confusion; item hypotheticals for the foe live exclusively in the conditional
		 *  Mega/Scarf columns instead. Returns null (no popup) if the current set has no species
		 *  yet, or the hovered species has no spread data to build a baseline from. */
		function buildSpeedComparisonTooltipHTML(rowEl) {
			const speciesName = rowEl.getAttribute('data-cf-species');
			if (!speciesName) return null;
			const entry = lastSpeedTierList && lastSpeedTierList.find((e) => e.name === speciesName);
			if (!entry || !entry.mon) return null;

			const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
			const allySet = tbRoom && tbRoom.curSet;
			if (!tbRoom || !allySet || !allySet.species) return null;

			const topSpread = (entry.mon.spreads || [])[0];
			if (!topSpread) return null;
			const topNature = (entry.mon.natures || [])[0];
			const foeNature = (topNature && topNature.nature) || '';
			const foeSet = {
				species: speciesName,
				evs: { spe: parseEVs(topSpread.ev).spe },
				nature: foeNature,
				ivs: { spe: 31 },
				level: allySet.level || 50,
			};

			const allyBase = tbRoom.getStat('spe', allySet);
			const foeBase = tbRoom.getStat('spe', foeSet);
			const foeItems = entry.mon.items || [];

			// The base Foe column NEVER applies an item — Pikalytics' "most common item" is a
			// population statistic about the whole spread's usage, not a fact about any specific
			// hovered build, so guessing one into the baseline was never asked for and only
			// caused confusion (a species whose top item happened to be Scarf made the base
			// column and the dedicated "Foe [Scarf]" column below show the exact same number,
			// reading as "the Scarf column isn't doing anything" even though the multiplier was
			// firing correctly in both — confirmed live on Basculegion, 44.7% Scarf). Item
			// hypotheticals live exclusively in the Mega/Scarf columns; the base column is base
			// stat + spread + nature and nothing else. foeItems itself is still needed below, for
			// the Scarf/Mega *detection* — just never fed into this column's own speed calc.

			// 4th "what if it ran Scarf instead" column, only when Scarf usage is actually
			// non-trivial for this species (see SCARF_POPULARITY_THRESHOLD_PERCENT's own doc
			// comment) — otherwise it's a hypothetical nobody's really building, and the column
			// would just be noise.
			const scarfItemEntry = foeItems.find((it) => toIDSafe(it.item) === 'choicescarf');
			const scarfPercent = scarfItemEntry ? parseFloat(scarfItemEntry.percent) || 0 : 0;
			const showScarfColumn = scarfPercent >= SCARF_POPULARITY_THRESHOLD_PERCENT;

			// A 5th "what if it ran its Mega Stone instead" column, same "additional column,
			// never a row-identity swap" treatment as Scarf above (see the earlier, reverted
			// approach that tried overriding the base row itself — a Pokémon holding a Mega
			// Stone can't also hold Scarf, so collapsing the row broke exactly that: a "Mega +
			// Scarf" combination that can't exist in the real game). If a species has more than
			// one Mega Stone (Charizard X/Y, Mewtwo X/Y), only the more popular one gets a
			// column — showing both would need a 6th column for a genuinely rare case.
			// getStat resolves the real Mega base stat from Dex once the *species name* is the
			// Mega forme (see megaSet below) — same mechanism as every other stat lookup here,
			// not a separately maintained stats field.
			let megaFormeName = null;
			let megaPercent = 0;
			let megaItemName = null;
			if (window.Dex) {
				for (const it of foeItems) {
					const itemData = window.Dex.items.get(it.item);
					const forme = itemData && itemData.megaStone && itemData.megaStone[speciesName];
					if (!forme) continue;
					const percent = parseFloat(it.percent) || 0;
					if (percent > megaPercent) {
						megaFormeName = forme;
						megaPercent = percent;
						megaItemName = it.item;
					}
				}
			}
			const showMegaColumn = megaFormeName && megaPercent >= MEGA_POPULARITY_THRESHOLD_PERCENT;
			const megaSet = showMegaColumn ?
				{ species: megaFormeName, evs: foeSet.evs, nature: foeSet.nature, ivs: foeSet.ivs, level: foeSet.level } : null;
			const foeMegaBase = megaSet ? tbRoom.getStat('spe', megaSet) : 0;

			// No win/lose coloring — with several independent Speed numbers per row (ally, foe,
			// and up to two foe "what if" variants) a single "winner" no longer means anything;
			// reading the plain numbers against each other is unambiguous without it anyway.
			const rows = SPEED_COMPARISON_SCENARIOS.map((sc) => {
				const allySpeed = applySpeedModifiers(allyBase, allySet.item, sc.ally);
				// No item — see the comment above foeBase's own computation for why the base
				// Foe column never applies one.
				const foeSpeed = applySpeedModifiers(foeBase, null, sc.foe);
				const megaCell = showMegaColumn ?
					// No item passed — a Mega Stone isn't in SPEED_ITEM_MULTIPLIERS (it doesn't
					// multiply Speed, the different base stat from foeMegaBase already covers
					// its effect), and the holder can't also be running Scarf/Iron Ball anyway.
					`<td>${applySpeedModifiers(foeMegaBase, null, sc.foe)}</td>` : '';
				const scarfCell = showScarfColumn ?
					// Same base stat as the main foe column (items don't change EVs/nature) —
					// only the item plugged into applySpeedModifiers changes, so this is
					// "what if" against an otherwise-identical spread, not a different build.
					`<td>${applySpeedModifiers(foeBase, 'Choice Scarf', sc.foe)}</td>` : '';
				return `<tr><td>${escapeHTML(sc.label)}</td><td>${allySpeed}</td><td>${foeSpeed}</td>${megaCell}${scarfCell}</tr>`;
			}).join('');

			const allyIcon = window.Dex ? window.Dex.getPokemonIcon(allySet.species) : '';
			const foeIcon = window.Dex ? window.Dex.getPokemonIcon(speciesName) : '';
			const allyEvText = formatSpeedEvText((allySet.evs && allySet.evs.spe) || 0, speedNatureIndicator(allySet.nature));
			const foeEvText = formatSpeedEvText(foeSet.evs.spe, speedNatureIndicator(foeNature));
			const scarfIconStyle = window.Dex ? window.Dex.getItemIcon('Choice Scarf') : '';

			// Only the ally sprite gets an unconditional held-item badge — the popup is scoped
			// to "what's actually on my set" for that side (see applySpeedModifiers' own doc
			// comment: the item is baseline-only, not a per-row toggle). The foe's own most-
			// common item is Pikalytics' population statistic rather than something really
			// "held," so badging it the same way would misleadingly imply the same certainty —
			// Scarf/Mega specifically get their own conditional columns instead (above), with
			// their real usage percent shown rather than asserted.
			const allyHasScarf = toIDSafe(allySet.item) === 'choicescarf';
			const allySpriteHTML = `<span class="cf-speedcmp-sprite">` +
				`<span class="picon" style="${escapeHTML(allyIcon)}"></span>` +
				(allyHasScarf && window.Dex ?
					`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon('Choice Scarf'))}"></span>` : '') +
				`</span>`;
			// Bottom-right badge matches the ally sprite's own Scarf badge above; bottom-left
			// (otherwise empty on this sprite — nothing else claims that corner) carries the
			// real usage percent, so each column reads as "here's the item, and here's how
			// common it actually is" at a glance rather than needing a caption line underneath.
			// The Mega column uses the Mega forme's own sprite (not the base species') since
			// that's genuinely a different-looking Pokémon, unlike Scarf which doesn't change
			// what the foe looks like.
			const megaColumnHeaderHTML = showMegaColumn ?
				`<th><span class="cf-speedcmp-sprite">` +
					`<span class="picon" style="${escapeHTML(window.Dex.getPokemonIcon(megaFormeName))}"></span>` +
					`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon(megaItemName))}"></span>` +
					`<span class="cf-speedcmp-usage-badge">${Math.round(megaPercent)}%</span>` +
					`</span></th>` : '';
			const scarfColumnHeaderHTML = showScarfColumn ?
				`<th><span class="cf-speedcmp-sprite">` +
					`<span class="picon" style="${escapeHTML(foeIcon)}"></span>` +
					`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(scarfIconStyle)}"></span>` +
					`<span class="cf-speedcmp-usage-badge">${Math.round(scarfPercent)}%</span>` +
					`</span></th>` : '';

			const extraCols = (showMegaColumn ? 1 : 0) + (showScarfColumn ? 1 : 0);
			const widthCls = extraCols === 2 ? ' cf-speedcmp-tooltip-widest' : extraCols === 1 ? ' cf-speedcmp-tooltip-wide' : '';

			return `<div class="cf-tooltip cf-speedcmp-tooltip${widthCls}">` +
				`<h2>${escapeHTML(allySet.species)} ` +
				`<span class="cf-speedcmp-evinfo">(${escapeHTML(allyEvText)})</span> vs. ${escapeHTML(speciesName)} ` +
				`<span class="cf-speedcmp-evinfo">(${escapeHTML(foeEvText)})</span></h2>` +
				`<table class="cf-speedcmp-table"><thead><tr><th>Scenario</th>` +
				`<th>${allySpriteHTML}</th>` +
				`<th><span class="picon" style="${escapeHTML(foeIcon)}"></span></th>` +
				`${megaColumnHeaderHTML}${scarfColumnHeaderHTML}</tr></thead>` +
				`<tbody>${rows}</tbody></table></div>`;
		}
		// onMouseOver (outer scope, near Tooltip) needs to call this, but it's defined here
		// (inside patchTeambuilderSidebar) since it depends on things scoped to this function's
		// own closure. CF is this file's existing cross-scope handoff — same pattern
		// CF.lastEngine already uses for patchDexSearch -> onMouseOver.
		CF.buildSpeedComparisonTooltipHTML = buildSpeedComparisonTooltipHTML;

		/** Laid out as a 3-row x 2-col grid (.cf-pika-grid, style.css) rather than one long
		 *  scrolling column — DOM order here IS grid row-major order (row 1: Moves/Abilities,
		 *  row 2: Items/Teammates, row 3: Natures/Spreads), since the grid has no explicit
		 *  per-item placement. Every cell is the same fixed size regardless of how much data it
		 *  holds — Teammates can run to 10-20 rows where Abilities is usually 2-3, so equal
		 *  sizing (each cell scrolling internally past its own bound) keeps one long section
		 *  from dominating the panel at every other section's expense. */
		function buildPikalyticsSidebarHTML(mon, tbRoom) {
			return `<div class="cf-pika-grid">` +
				buildMovesSection(mon, tbRoom) + buildAbilitiesSection(mon, tbRoom) +
				buildItemsSection(mon, tbRoom) + buildTeammatesSection(mon, tbRoom) +
				buildNaturesSection(mon, tbRoom) + buildSpreadsSection(mon) +
				`</div>`;
		}

		/** Populates the sidebar with Pikalytics data for whatever species/format is
		 *  currently being edited. `renderToken` is bumped on every call and captured by the
		 *  async lookups below; if a slower, older request resolves after a newer one has
		 *  already started (e.g. the user flips through several Pokémon quickly), its result
		 *  is discarded on arrival — this is the "format [and species] matches always when
		 *  showing data" guarantee, since without it a stale response could otherwise land
		 *  after the UI has already moved on and overwrite what's currently showing with data
		 *  for a species/format the user isn't even looking at anymore.
		 *
		 *  `lastMon` caches the last successfully-rendered payload for the current
		 *  `lastRenderKey`. Click-to-apply (applyMove/applySetField/etc, above) mutates curSet
		 *  and then calls tbRoom.updateSetTop(), which is one of the hooks that calls back into
		 *  this function via updateSplitState — but the species/format haven't changed, so
		 *  without this cache every single click-to-apply would trigger a needless refetch just
		 *  to redraw the same data with updated clickable/disabled/equipped states. The fast
		 *  path below rebuilds the HTML synchronously from `lastMon` against the *current*
		 *  curSet/curSetList instead. */
		let renderToken = 0;
		let lastRenderKey = null;
		let lastMon = null;
		/** Rebuilds sidebarEl's content while keeping each section's own scroll position — a
		 *  plain `innerHTML =` (as every other render path here still does) throws away the old
		 *  DOM nodes entirely, resetting every .cf-pika-rows box back to scrollTop 0. Only used
		 *  for the "same species/format, just refreshing after a click-to-apply or native edit"
		 *  case (renderPikalyticsSidebar's lastMon fast path) — an actual species/format switch
		 *  is new content, where jumping back to the top of each section is the right behavior,
		 *  not something to preserve. Matched up by index rather than any per-section id: the
		 *  six sections always render in the same fixed order (see buildPikalyticsSidebarHTML),
		 *  so the Nth .cf-pika-rows before the rebuild is always the same section as the Nth
		 *  after it, even though a section's own row *count* can change between renders (e.g.
		 *  a move toggled on/off doesn't add or remove a row, but nothing here assumes it
		 *  couldn't). */
		function rebuildSidebarPreservingScroll(sidebarEl, html) {
			const oldScrollTops = Array.from(sidebarEl.querySelectorAll('.cf-pika-rows'), (el) => el.scrollTop);
			sidebarEl.innerHTML = html;
			sidebarEl.querySelectorAll('.cf-pika-rows').forEach((el, i) => {
				if (oldScrollTops[i]) el.scrollTop = oldScrollTops[i];
			});
		}

		function renderPikalyticsSidebar(tbRoom) {
			const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
			const speciesName = tbRoom.curSet && (tbRoom.curSet.species || tbRoom.curSet.name);
			if (!formatId || !speciesName) {
				// A freshly-added blank team slot (right after "Add Pokémon", before a species
				// is typed) has a truthy curSet with an empty .species — updateSplitState's
				// editingAPokemon check only looks at curSet's truthiness, so the split still
				// turns on and this function still gets called. Without clearing here, the
				// sidebar would keep showing whichever species was rendered last, appearing
				// "stuck" until something else (switching slots and back) forced a real
				// re-render — nothing short of reloading the extension would clear it otherwise.
				ensurePikaPanelEl().innerHTML = '<p class="cf-sidebar-placeholder">Nothing here yet.</p>';
				lastRenderKey = null;
				lastMon = null;
				return;
			}

			const key = formatId + '|' + speciesName;
			const sidebarEl = ensurePikaPanelEl();

			if (key === lastRenderKey) {
				// Same species/format as the last call. If lastMon is already populated, that's
				// the click-to-apply/native-edit fast path: just re-derive clickable/disabled/
				// equipped state against the (possibly just-changed) current set, no refetch. If
				// lastMon is still null, a fetch for this exact key is either already in flight
				// or already resolved to "no data"/"failed" — either way there is nothing new to
				// do, so this must still be an unconditional no-op (not gated on lastMon) or a
				// second call arriving before the first fetch resolves would otherwise reset the
				// placeholder back to "Loading…" and fire a redundant duplicate request.
				if (lastMon) rebuildSidebarPreservingScroll(sidebarEl, buildPikalyticsSidebarHTML(lastMon, tbRoom));
				return;
			}
			lastRenderKey = key;
			lastMon = null;

			const token = ++renderToken;
			sidebarEl.innerHTML = '<p class="cf-sidebar-placeholder">Loading Pikalytics data…</p>';

			if (!window.CF_Pikalytics) {
				sidebarEl.innerHTML = '<p class="cf-sidebar-placeholder">No data for this format.</p>';
				return;
			}

			window.CF_Pikalytics.getSpeciesData(formatId, speciesName).then((mon) => {
				if (token !== renderToken) return; // superseded by a newer request
				const isEmpty = !mon || (!(mon.moves || []).length && !(mon.abilities || []).length &&
					!(mon.items || []).length && !(mon.natures || []).length &&
					!(mon.team || []).length && !(mon.spreads || []).length);
				if (isEmpty) {
					sidebarEl.innerHTML = `<p class="cf-sidebar-placeholder">No data for ${escapeHTML(speciesName)} in this format.</p>`;
					return;
				}
				lastMon = mon;
				sidebarEl.innerHTML = buildPikalyticsSidebarHTML(mon, tbRoom);
			}).catch((e) => {
				if (token !== renderToken) return; // superseded by a newer request
				console.error('[Better Teambuilder] Pikalytics lookup failed:', e);
				sidebarEl.innerHTML = '<p class="cf-sidebar-placeholder">Failed to load Pikalytics data.</p>';
			});
		}

		/** Populates #cf-speedtier-col with the format's top-20-by-usage species. Keyed on
		 *  formatId alone, not species — unlike renderPikalyticsSidebar this doesn't need to
		 *  refetch every time the user switches which Pokémon they're editing, only when the
		 *  format itself changes, since the top-20 usage list is format-wide. speciesHint only
		 *  feeds getTopUsageList's cold-cache bootstrap (see that function's own doc comment) —
		 *  by the time this runs, renderPikalyticsSidebar has usually already warmed the same
		 *  format-meta cache entry via the exact same hint, so this is typically a cache hit with
		 *  no extra discovery request.
		 *
		 *  lastSpeedTierList (module-level, above) is kept in sync with whatever's actually
		 *  rendered — cleared alongside the placeholder states, populated alongside the real
		 *  list — so buildSpeedComparisonTooltipHTML's hover lookup can never find a species from
		 *  a format that's no longer showing (e.g. mid-fetch, or after a failed request). */
		let lastSpeedTierFormatId = null;
		let speedTierRenderToken = 0;
		function renderSpeedTierColumn(tbRoom) {
			const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
			const speciesHint = tbRoom.curSet && (tbRoom.curSet.species || tbRoom.curSet.name);
			const colEl = document.getElementById('cf-speedtier-col');
			if (!colEl) return;

			if (!formatId || !window.CF_Pikalytics || !window.CF_Pikalytics.getTopUsageList) {
				colEl.innerHTML = speedTierColumnHTML('<p class="cf-sidebar-placeholder">No data.</p>');
				lastSpeedTierFormatId = null;
				lastSpeedTierList = null;
				return;
			}
			if (formatId === lastSpeedTierFormatId) return; // already loaded/loading for this format
			lastSpeedTierFormatId = formatId;

			const token = ++speedTierRenderToken;
			colEl.innerHTML = speedTierColumnHTML('<p class="cf-sidebar-placeholder">Loading…</p>');
			lastSpeedTierList = null;

			window.CF_Pikalytics.getTopUsageList(formatId, speciesHint, 20).then((list) => {
				if (token !== speedTierRenderToken) return; // superseded by a newer request
				lastSpeedTierList = list;
				colEl.innerHTML = buildSpeedTierColumnHTML(list);
			}).catch((e) => {
				if (token !== speedTierRenderToken) return;
				console.error('[Better Teambuilder] Speed tier usage list lookup failed:', e);
				colEl.innerHTML = speedTierColumnHTML('<p class="cf-sidebar-placeholder">Failed to load.</p>');
			});
		}

		function updateSplitState() {
			const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
			const editingAPokemon = !!(window.app.curRoom === tbRoom && tbRoom && tbRoom.curSet);
			const active = editingAPokemon && !window.app.sideRoom && window.innerWidth >= SPLIT_THRESHOLD;
			if (active) {
				ensureTeambuilderSidebarEl();
				try { renderPikalyticsSidebar(tbRoom); } catch (e) {
					console.error('[Better Teambuilder] renderPikalyticsSidebar failed:', e);
				}
				try { renderSpeedTierColumn(tbRoom); } catch (e) {
					console.error('[Better Teambuilder] renderSpeedTierColumn failed:', e);
				}
			} else {
				lastRenderKey = null; // force a fresh render next time the sidebar becomes active
			}
			document.body.classList.toggle('cf-teambuilder-split', active);
		}

		/** Wraps obj[methodName] so every call also triggers updateSplitState() afterward,
		 *  without changing what the original does or returns — the four hooks below only
		 *  differ in *which* Showdown state-mutating method each is watching. */
		function wrapWithSplitUpdate(obj, methodName) {
			const orig = obj[methodName];
			obj[methodName] = function () {
				const ret = orig.apply(this, arguments);
				updateSplitState();
				return ret;
			};
		}

		wrapWithSplitUpdate(window.app, 'updateLayout');
		wrapWithSplitUpdate(window.TeambuilderRoom.prototype, 'update');

		// setPokemon() (species field change, e.g. swapping the species within the *same*
		// slot rather than navigating to a different one) calls only updateSetTop(), not
		// update() — it re-renders .teambar/.teamchart directly via jQuery .html() without
		// ever going through update(). Without this hook, changing species in place left the
		// sidebar showing the previous species' data until the user left and re-entered the
		// slot (which does go through update(), via selectPokemon()).
		wrapWithSplitUpdate(window.TeambuilderRoom.prototype, 'updateSetTop');

		// AltFormPopup.setForm() (picking an alt cosmetic form from the species-icon popup)
		// mutates curSet.species and calls only updatePokemonSprite() when a set is already
		// being edited — the same gap as updateSetTop() above, through a different Showdown
		// entry point that never calls update()/updateSetTop().
		wrapWithSplitUpdate(window.TeambuilderRoom.prototype, 'updatePokemonSprite');

		// Group 2 (see this function's own doc comment above): keeps the sidebar's clickable/
		// disabled/equipped states in sync when the user edits a move/ability/item/nature
		// directly through the native teambuilder fields, instead of through our own sidebar.
		// Deliberately excludes statChange/statSlide (EVs) — see the doc comment for why.
		wrapWithSplitUpdate(window.TeambuilderRoom.prototype, 'chartSet');
		wrapWithSplitUpdate(window.TeambuilderRoom.prototype, 'natureChange');

		window.addEventListener('resize', updateSplitState);

		// Check on initial load: if the teambuilder is already the active room by the time
		// this patches in (e.g. extension loaded on an already-open /teambuilder page),
		// neither hook above will fire again on its own until the next state change.
		updateSplitState();
	}

	// Same shape as CF_DEFAULT_SETTINGS in defaults.js — this file can't share that module,
	// since it runs in the page's own MAIN-world JS realm (see manifest.json) rather than the
	// isolated world/options page defaults.js is loaded into (see defaults.js's own doc
	// comment for why the other two files DO share it).
	const DEFAULT_SETTINGS = { closeSideRoomsOnLoad: true };

	/** settings-bridge.js (isolated world, document_start — see manifest.json) reads
	 *  chrome.storage.sync, which this MAIN-world script has no access to, and writes it as a
	 *  JSON attribute on <html> once it resolves — normally within a frame or two, well before
	 *  this script reaches document_idle. Polled with the same bounded-retry shape (pollUntil,
	 *  above) as waitForGlobals rather than a one-shot check, and independent of it: the
	 *  side-room tidy only needs window.app, not DexSearch/BattleMovedex/etc, so it shouldn't
	 *  be stuck waiting on unrelated bundle globals. Fails open to DEFAULT_SETTINGS (matching
	 *  the prior always-on behavior) if the bridge script is missing/broken or storage never
	 *  resolves. */
	function waitForSideRoomSettings(cb) {
		pollUntil(
			() => {
				if (!window.app) return null;
				const raw = document.documentElement.getAttribute('data-cf-settings');
				try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
			},
			(cb2) => {
				if (window.app) cb2(DEFAULT_SETTINGS);
			},
			cb
		);
	}

	waitForSideRoomSettings((settings) => {
		if (!settings.closeSideRoomsOnLoad) return;
		try { closeSideRoomsOnLoad(); } catch (e) {
			console.error('[Better Teambuilder] closeSideRoomsOnLoad failed:', e);
		}
	});

	waitForGlobals(() => {
		CF.dynamicMoveLists = buildDynamicMoveLists();
		// 4a: wrap each monkey-patch in try/catch so one failure doesn't prevent
		// the rest of the extension from loading.
		try { patchDexSearch(); } catch (e) {
			console.error('[Better Teambuilder] patchDexSearch failed:', e);
		}
		try { patchLegacyRenderRow(); } catch (e) {
			console.error('[Better Teambuilder] patchLegacyRenderRow failed:', e);
		}
		try { patchLegacyFilterChips(); } catch (e) {
			console.error('[Better Teambuilder] patchLegacyFilterChips failed:', e);
		}
		try { patchTeambuilderSidebar(); } catch (e) {
			console.error('[Better Teambuilder] patchTeambuilderSidebar failed:', e);
		}
		document.addEventListener('mouseover', onMouseOver, true);
		document.addEventListener('mouseout', onMouseOut, true);
		document.addEventListener('click', onSpeedFilterClick, true);
		document.addEventListener('input', onSpeedFilterInput, true);
		document.addEventListener('focusin', onPikaSidebarFocusChange, true);
		document.addEventListener('focusout', onPikaSidebarFocusChange, true);
		document.addEventListener('click', onPikaSidebarClick, true);
	});
})();
