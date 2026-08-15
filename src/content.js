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
	// Tooltip: explains which custom filter(s) a hovered result matched, and
	// with which move(s). DOM/CSS mirrors battle-tooltips.ts's #tooltipwrapper
	// structure but under our own id so it can never collide with the native
	// singleton's lifecycle (BattleTooltips.isLocked/elem/etc). This is the one
	// piece of UI we render ourselves, kept as a floating overlay appended to
	// document.body rather than inserted into the results DOM.
	// ---------------------------------------------------------------------
	const Tooltip = {
		wrapperEl: null,

		show(li, matches) {
			if (!this.wrapperEl) {
				this.wrapperEl = document.createElement('div');
				this.wrapperEl.id = 'cf-tooltipwrapper';
				document.body.appendChild(this.wrapperEl);
			}
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
			this.wrapperEl.innerHTML = html;
			this.wrapperEl.style.display = '';
			this.position(li);
		},

		position(li) {
			const rect = li.getBoundingClientRect();
			const tooltipEl = this.wrapperEl.querySelector('.cf-tooltip');
			const width = 300;
			let left = Math.max(rect.left - 2, 0);
			left = Math.min(left, window.innerWidth - width - 4);
			this.wrapperEl.style.left = left + 'px';

			this.wrapperEl.style.visibility = 'hidden';
			this.wrapperEl.style.top = '0px';
			const height = tooltipEl.offsetHeight;
			this.wrapperEl.style.visibility = '';

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

	// Pokémon-search rows only: a species can match a filter through any of several moves in
	// its pool, so the tooltip is the only way to see *which* one(s) actually qualified. A
	// move-search row IS a specific move already sitting in a pre-filtered list — hovering it
	// would just repeat what's already on screen (its own name, next to the active filter
	// chip), so there's deliberately no tooltip for move rows.
	function onMouseOver(ev) {
		const li = findResultLi(ev.target);
		if (!li) return;
		const engine = CF.lastEngine;
		if (!engine || !engine.__cfFilters || !engine.__cfFilters.length) return;

		const pokemonLink = li.querySelector('a[data-entry^="pokemon|"]');
		if (pokemonLink) {
			const name = pokemonLink.getAttribute('data-entry').slice('pokemon|'.length);
			const speciesId = window.toID(name);
			const matches = engine.__cfMatches && engine.__cfMatches.get(speciesId);
			if (matches) Tooltip.show(li, matches);
		}
	}

	function onMouseOut(ev) {
		const li = findResultLi(ev.target);
		if (!li) return;
		if (ev.relatedTarget && li.contains(ev.relatedTarget)) return;
		Tooltip.hide();
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
	 *  on window resize, and by wrapping four TeambuilderRoom-family methods (via
	 *  wrapWithSplitUpdate below), each catching a different way curSet can change without the
	 *  others firing: app.updateLayout (room focus / side-room changes),
	 *  TeambuilderRoom.prototype.update (in-room navigation, e.g. selecting a Pokémon or
	 *  backing out to the list), TeambuilderRoom.prototype.updateSetTop (changing the species
	 *  *within* the current slot via setPokemon() — this one only re-renders .teambar/
	 *  .teamchart directly, it never calls update() at all, so without this hook the sidebar
	 *  kept showing the previous species until the user left and re-entered the slot), and
	 *  TeambuilderRoom.prototype.updatePokemonSprite (the same gap again through a different
	 *  entry point: AltFormPopup.setForm(), picking an alt cosmetic form from the species-icon
	 *  popup, mutates curSet.species and calls only updatePokemonSprite() when a set is
	 *  already being edited, never update()/updateSetTop()) — all four read-only, purely to
	 *  notice state might have changed, never modifying what they do. Whenever the split turns
	 *  (or stays) on, it also populates the sidebar with Pikalytics data for the
	 *  currently-edited species/format — see renderPikalyticsSidebar and pikalytics.js. */
	function patchTeambuilderSidebar() {
		if (!window.app || typeof window.app.updateLayout !== 'function' || !window.TeambuilderRoom ||
			typeof window.TeambuilderRoom.prototype.update !== 'function' ||
			typeof window.TeambuilderRoom.prototype.updateSetTop !== 'function' ||
			typeof window.TeambuilderRoom.prototype.updatePokemonSprite !== 'function') return;

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

		function ensureTeambuilderSidebarEl() {
			let el = document.getElementById('cf-teambuilder-sidebar');
			if (el) return el;
			el = document.createElement('div');
			el.id = 'cf-teambuilder-sidebar';
			el.innerHTML = '<p class="cf-sidebar-placeholder">Nothing here yet.</p>';
			document.body.appendChild(el);
			return el;
		}

		function pikaSectionHTML(title, rowsHTML) {
			return `<div class="cf-pika-section"><h3 class="cf-pika-header">${escapeHTML(title)}</h3>` +
				`<div class="cf-pika-rows">${rowsHTML}</div></div>`;
		}

		/** "Other" is Pikalytics' bucket for everything below its per-move cutoff — real
		 *  aggregate data, not a specific move, so it's kept (dropping it would silently
		 *  understate usage) but has no `type` of its own, hence the blank spacer. */
		function buildMovesSection(mon) {
			const moves = mon.moves || [];
			if (!moves.length) return pikaSectionHTML('Common Moves', '<p class="cf-pika-empty">No move data.</p>');
			const rows = moves.map((m) => {
				const icon = m.type ? window.Dex.getTypeIcon(m.type) : '<span class="cf-pika-icon-spacer"></span>';
				return `<div class="cf-pika-row">${icon}` +
					`<span class="cf-pika-name">${escapeHTML(m.move)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(m.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Moves', rows);
		}

		/** Same shape as buildNaturesSection's own rows ({ability, percent}) — confirmed live
		 *  via the /api/p/ endpoint. */
		function buildAbilitiesSection(mon) {
			const abilities = (mon.abilities || []).filter((a) => (parseFloat(a.percent) || 0) > 0);
			if (!abilities.length) return pikaSectionHTML('Common Abilities', '<p class="cf-pika-empty">No ability data.</p>');
			const rows = abilities.map((a) => {
				return `<div class="cf-pika-row"><span class="cf-pika-name">${escapeHTML(a.ability)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(a.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Abilities', rows);
		}

		/** Nature usage is tracked two different ways depending on the format: some give a
		 *  standalone `natures` array; others (e.g. gen9ou) only bundle a nature into each
		 *  `spreads` entry, with no separate breakdown — so when `natures` is missing/empty,
		 *  it's derived here by summing spread percentages per nature instead of showing
		 *  nothing. */
		function buildNaturesSection(mon) {
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
			const rows = natures.map((n) => {
				const pct = typeof n.percent === 'number' ? n.percent.toFixed(1) : n.percent;
				return `<div class="cf-pika-row"><span class="cf-pika-name">${escapeHTML(n.nature)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(String(pct))}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Natures', rows);
		}

		/** "Other" bucket, same as buildMovesSection — kept, no icon. */
		function buildItemsSection(mon) {
			const items = mon.items || [];
			if (!items.length) return pikaSectionHTML('Common Items', '<p class="cf-pika-empty">No item data.</p>');
			const rows = items.map((it) => {
				const iconStyle = (it.item && window.Dex) ? window.Dex.getItemIcon(it.item) : '';
				const icon = iconStyle ? `<span class="itemicon" style="${escapeHTML(iconStyle)}"></span>` : '<span class="cf-pika-icon-spacer"></span>';
				return `<div class="cf-pika-row">${icon}` +
					`<span class="cf-pika-name">${escapeHTML(it.item)}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(it.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Items', rows);
		}

		function buildSpreadsSection(mon) {
			const spreads = mon.spreads || [];
			if (!spreads.length) return pikaSectionHTML('Common Spreads', '<p class="cf-pika-empty">No spread data.</p>');
			const rows = spreads.map((s) => {
				const label = s.nature ? `${escapeHTML(s.nature)}: ${escapeHTML(s.ev)}` : escapeHTML(s.ev);
				return `<div class="cf-pika-row"><span class="cf-pika-name cf-pika-spread">${label}</span>` +
					`<span class="cf-pika-pct">${escapeHTML(s.percent)}%</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Spreads', rows);
		}

		/** Teammate rows don't consistently carry a usage percent (confirmed live: gen9ou's
		 *  do, VGC's generally don't) or a `rank` (the reverse can also happen), so this falls
		 *  back through percent -> explicit rank -> the row's own position in the list — which
		 *  is itself real rank information, the list is already most- to least-common — rather
		 *  than ever leaving a row blank. */
		function buildTeammatesSection(mon) {
			const team = mon.team || [];
			if (!team.length) return pikaSectionHTML('Common Teammates', '<p class="cf-pika-empty">No teammate data.</p>');
			const rows = team.map((t, i) => {
				const iconStyle = window.Dex ? window.Dex.getPokemonIcon(t.pokemon) : '';
				let pct;
				if (t.percent !== undefined && t.percent !== null) pct = `${escapeHTML(String(t.percent))}%`;
				else if (t.rank !== undefined && t.rank !== null) pct = `#${escapeHTML(String(t.rank))}`;
				else pct = `#${i + 1}`;
				return `<div class="cf-pika-row"><span class="picon" style="${escapeHTML(iconStyle)}"></span>` +
					`<span class="cf-pika-name">${escapeHTML(t.pokemon)}</span>` +
					`<span class="cf-pika-pct">${pct}</span></div>`;
			}).join('');
			return pikaSectionHTML('Common Teammates', rows);
		}

		function buildPikalyticsSidebarHTML(mon) {
			return buildMovesSection(mon) + buildAbilitiesSection(mon) + buildItemsSection(mon) +
				buildNaturesSection(mon) + buildSpreadsSection(mon) + buildTeammatesSection(mon);
		}

		/** Populates the sidebar with Pikalytics data for whatever species/format is
		 *  currently being edited. `renderToken` is bumped on every call and captured by the
		 *  async lookups below; if a slower, older request resolves after a newer one has
		 *  already started (e.g. the user flips through several Pokémon quickly), its result
		 *  is discarded on arrival — this is the "format [and species] matches always when
		 *  showing data" guarantee, since without it a stale response could otherwise land
		 *  after the UI has already moved on and overwrite what's currently showing with data
		 *  for a species/format the user isn't even looking at anymore. */
		let renderToken = 0;
		let lastRenderKey = null;
		function renderPikalyticsSidebar(tbRoom) {
			const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
			const speciesName = tbRoom.curSet && (tbRoom.curSet.species || tbRoom.curSet.name);
			if (!formatId || !speciesName) return;

			const key = formatId + '|' + speciesName;
			if (key === lastRenderKey) return;
			lastRenderKey = key;

			const token = ++renderToken;
			const sidebarEl = ensureTeambuilderSidebarEl();
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
				sidebarEl.innerHTML = buildPikalyticsSidebarHTML(mon);
			}).catch((e) => {
				if (token !== renderToken) return; // superseded by a newer request
				console.error('[Better Teambuilder] Pikalytics lookup failed:', e);
				sidebarEl.innerHTML = '<p class="cf-sidebar-placeholder">Failed to load Pikalytics data.</p>';
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
	});
})();
