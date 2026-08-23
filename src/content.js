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

	// Same shape as CF_DEFAULT_SETTINGS in defaults.js — this file can't share that module,
	// since it runs in the page's own MAIN-world JS realm (see manifest.json) rather than the
	// isolated world/popup defaults.js is loaded into (see defaults.js's own doc
	// comment for why the other two files DO share it).
	const DEFAULT_SETTINGS = {
		closeSideRoomsOnLoad: true, scarfThresholdPercent: 5, ironballThresholdPercent: 5, megaThresholdPercent: 15,
	};

	/** Reassigned to the real synced settings object once waitForSideRoomSettings (near the
	 *  bottom of this file) resolves — starts out as DEFAULT_SETTINGS so anything reading it
	 *  before that (there shouldn't be anything, in practice, but this is cheap insurance) gets
	 *  sane values rather than undefined. buildSpeedComparisonTooltipHTML
	 *  (patchTeambuilderSidebar, below) reads CF_SETTINGS.scarfThresholdPercent/
	 *  ironballThresholdPercent/megaThresholdPercent fresh on every hover rather than capturing a
	 *  value at page load, so a setting change takes effect on the very next hover after a page
	 *  reload — no need to re-open the teambuilder, just reload once after saving the popup's
	 *  settings. */
	let CF_SETTINGS = DEFAULT_SETTINGS;

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

	/** True for the one state the Add Pokémon column/panel (renderSimilarTeamsPanel, the
	 *  "Popular" speed-tier column) key off of: a real, currently-open slot (tbRoom.curSet
	 *  truthy — same thing updateSplitState's `active` branch already requires before either
	 *  render function is even reached) that has no species/name yet, i.e. the moment right
	 *  after clicking "Add Pokémon", before a species has been typed or picked. Distinct from
	 *  "not editing anything at all" (curSet falsy, isTeamOverview's own team-overview screen
	 *  below), which reaches renderTeamOverviewPanel instead of either of these two. */
	function isBlankSlot(tbRoom) {
		return !!(tbRoom && tbRoom.curSet && !(tbRoom.curSet.species || tbRoom.curSet.name));
	}

	/** True on the team-overview screen: a team is open (tbRoom.curTeam truthy) but no slot
	 *  within it is being edited (tbRoom.curSet falsy) — the screen showing all 6 roster icons
	 *  together. curSet alone isn't enough to detect this, confirmed live: it's also null on
	 *  the outer "all your teams" list screen, before any specific team has been opened at all
	 *  — curTeam is what actually distinguishes the two (null on the list screen, set to
	 *  {name, format, ...} the moment a team is opened, back to null on returning to the list).
	 *  updateSplitState still separately checks window.app.curRoom === tbRoom before treating
	 *  this as active — this only covers the curTeam/curSet half of that condition, same as
	 *  isBlankSlot only covering its own half. */
	function isTeamOverview(tbRoom) {
		return !!(tbRoom && tbRoom.curTeam && !tbRoom.curSet);
	}

	/** Every damaging move currently on every already-added team member (Status moves carry a
	 *  `type` too but deal no damage, so they'd falsely inflate coverage) — the raw input to
	 *  bestTeamCoverageMultiplier below. Reads straight from Dex.moves, not Pikalytics: this is
	 *  about the *real* moves already on your own sets, not a usage statistic. */
	function teamDamagingMoveTypes(tbRoom) {
		const types = [];
		if (!window.Dex) return types;
		(tbRoom.curSetList || []).forEach((set) => {
			if (!set || !set.species || !set.moves) return;
			set.moves.forEach((moveName) => {
				if (!moveName) return;
				const move = window.Dex.moves.get(moveName);
				if (move && move.exists && move.type && move.category !== 'Status') types.push(move.type);
			});
		});
		return types;
	}

	/** Standard type-chart multiplier for one attacking type against a (possibly dual-type)
	 *  defender, via Dex.types' own damageTaken table (battle-dex.ts) rather than a hand-copied
	 *  chart — damageTaken is keyed by the *capitalized* attacking type name (confirmed live:
	 *  Dex.types.get('water').damageTaken['Electric'] === 1, ['electric'] === undefined), so the
	 *  input is normalized to that case regardless of how it arrived (Dex.moves' own `.type` is
	 *  already capitalized, but this is cheap insurance either way). damageTaken's own values are
	 *  an index (0-3) into the real multiplier, not the multiplier itself — see
	 *  DAMAGE_TAKEN_MULTIPLIERS below (mirrors battle-tooltips.ts's own `[1, 2, 0.5, 0]` mapping).
	 *  A dual-type defender's overall multiplier is the product across both of its types, same as
	 *  the real games' own damage formula. */
	const DAMAGE_TAKEN_MULTIPLIERS = [1, 2, 0.5, 0];
	function typeEffectivenessMultiplier(attackType, defenderTypes) {
		if (!window.Dex || !attackType) return 1;
		const cap = attackType.charAt(0).toUpperCase() + attackType.slice(1).toLowerCase();
		let mult = 1;
		(defenderTypes || []).forEach((dType) => {
			const typeData = window.Dex.types.get(dType);
			if (!typeData || !typeData.exists || !typeData.damageTaken) return;
			const code = typeData.damageTaken[cap];
			mult *= DAMAGE_TAKEN_MULTIPLIERS[code || 0];
		});
		return mult;
	}

	/** The best (highest) multiplier any already-added team member's real moves can land on a
	 *  given defender — not an average or a "how many moves work," just whether the team has
	 *  *a* way to hit hard, since a single strong option is what actually matters when picking a
	 *  6th teammate to round out coverage. Returns null (no color, not "neutral") when there's
	 *  nothing to compute from yet — an empty team, or every added member still moveless. */
	function bestTeamCoverageMultiplier(moveTypes, defenderTypes) {
		if (!moveTypes || !moveTypes.length || !defenderTypes || !defenderTypes.length) return null;
		let best = 0;
		moveTypes.forEach((t) => {
			const mult = typeEffectivenessMultiplier(t, defenderTypes);
			if (mult > best) best = mult;
		});
		return best;
	}

	/** Discrete type-chart products only ever land on {0, .25, .5, 1, 2, 4} (each of a dual-type
	 *  defender's two per-type multipliers is one of {0, .5, 1, 2}), so plain threshold buckets
	 *  are exact here, not an approximation. Empty string (no extra class, i.e. the box's default
	 *  neutral styling) for both "genuinely neutral" (1x) and "nothing to compute" (null) — see
	 *  bestTeamCoverageMultiplier's own doc comment for why the latter isn't its own color.
	 *
	 *  .25 (a real, if less common, result — two resisted types stacking on a dual-type defender)
	 *  gets its own `cf-coverage-quadresist` tier, distinct from true 0x immunity — they used to
	 *  share the same "cf-coverage-immune" bucket (this function's `mult >= 0.5` branch falling
	 *  straight through to "everything else is immune"), which was wrong: a species your team can
	 *  still hit, just for a fraction of the damage, read on the Popular column as flatly
	 *  unhittable, exactly as misleading as it sounds. See defensiveTierClass's own doc comment —
	 *  the Defensive Profile matrix hit this same real distinction from the opposite (defensive)
	 *  direction and needed its own five-tier version rather than reusing this one, which is what
	 *  surfaced the gap here in the first place. */
	function coverageTierClass(mult) {
		if (mult === null || mult === undefined) return '';
		if (mult >= 4) return 'cf-coverage-quad';
		if (mult >= 2) return 'cf-coverage-super';
		if (mult >= 1) return '';
		if (mult >= 0.5) return 'cf-coverage-resist';
		if (mult > 0) return 'cf-coverage-quadresist';
		return 'cf-coverage-immune';
	}

	/** Small corner badge on a "Popular" row (buildSpeedTierColumnHTML) flagging a species
	 *  whose Pikalytics data shows it's commonly built with a Speed-relevant item — Choice Scarf,
	 *  or (the most popular of) its own Mega Stone(s) — past the same thresholds
	 *  (CF_SETTINGS.scarfThresholdPercent/megaThresholdPercent) buildSpeedComparisonTooltipHTML
	 *  already uses to decide whether those items are common enough to be worth a dedicated "what
	 *  if" column there. A species can't run both at once, so whichever one actually clears its
	 *  own threshold *and* has the higher real usage percent wins — not "Scarf always wins if
	 *  present," which used to pick Scarf over a Mega Stone run far more often even when the
	 *  Mega was clearly the more common build. Returns null (no badge) rather than a "neither is
	 *  common" marker — same "don't invent data" rule as every other badge/color in this file.
	 *  Returns `{ item, isMega, formeName }` rather than a bare item name — buildSpeedTierColumnHTML
	 *  needs to know it's a Mega Stone (and which forme) to swap the row's Speed stat to the Mega
	 *  forme's own base stat. */
	function topSpeedItemBadge(mon, speciesName) {
		if (!mon) return null;
		const scarf = (mon.items || []).find((it) =>
			toIDSafe(it.item) === 'choicescarf' && (parseFloat(it.percent) || 0) >= CF_SETTINGS.scarfThresholdPercent);
		const scarfPercent = scarf ? (parseFloat(scarf.percent) || 0) : -1;

		let bestMega = null;
		if (window.Dex) {
			for (const it of (mon.items || [])) {
				const itemData = window.Dex.items.get(it.item);
				const forme = itemData && itemData.megaStone && itemData.megaStone[speciesName];
				if (!forme) continue;
				const percent = parseFloat(it.percent) || 0;
				if (percent < CF_SETTINGS.megaThresholdPercent) continue;
				if (!bestMega || percent > bestMega.percent) bestMega = { item: it.item, percent, formeName: forme };
			}
		}

		if (!scarf && !bestMega) return null;
		// A tie goes to Scarf rather than the Mega Stone — an arbitrary but deterministic
		// tiebreak for a case real usage data essentially never produces exactly.
		if (bestMega && bestMega.percent > scarfPercent) {
			return { item: bestMega.item, isMega: true, formeName: bestMega.formeName };
		}
		return { item: scarf.item, isMega: false };
	}

	/** How many Similar Teams matches are detail-fetched and rendered per page — the first page
	 *  loads with the section itself; every later page loads on scroll (see
	 *  loadMoreSimilarTeams/onSimilarTeamsScroll) rather than fetching detail for aggregateTopTeams'
	 *  entire result up front, since with the scaled-down `shared >= 1` threshold (see that
	 *  function's own doc comment) a popular single Pokémon can realistically match dozens of
	 *  the format's ~200 real teams. */
	const SIMILAR_TEAMS_PAGE_SIZE = 10;
	/** Pixels of remaining scroll (scrollHeight - scrollTop - clientHeight) at which the next
	 *  page starts loading — a small positive margin rather than 0, so the next page is already
	 *  in flight before the user actually hits the bottom and sees a dead-end. */
	const SIMILAR_TEAMS_SCROLL_THRESHOLD_PX = 120;

	/** Filters/scores window.CF_Pikalytics.getTopTeams()'s own up-to-200-team list (the
	 *  format's real featured tournament teams, NOT filtered to any one species — see
	 *  pikalytics.js's own module comment on Top Teams for how this differs from and improves
	 *  on the older per-species `/api/p/` `team` sample, capped at ~20 and only ever containing
	 *  teams that happen to include one specific already-added species) down to the ones that
	 *  share species with the current roster.
	 *
	 *  `shared` is a direct intersection count against the roster — how many of THIS team's own
	 *  Pokémon are also on the roster — rather than the older code's indirect trick of counting
	 *  how many times the same team recurred across several per-species fetches; a single bulk
	 *  list makes that recurrence-counting unnecessary, and a direct count is the more obviously
	 *  correct computation of the same real fact.
	 *
	 *  Accepts any real overlap at all (shared >= 1) — deliberately NOT scaled up to "2 once the
	 *  roster has 2+ species," despite that being the right call under the older per-species
	 *  design this replaced (there, every candidate team was already pre-filtered to contain
	 *  *some* roster species by construction — it came from that species' own `/api/p/` sample
	 *  — so "shared >= 1" was trivially true for all of them and only "shared >= 2" meant
	 *  anything). This list isn't pre-filtered at all; it's the format's whole ~200-team pool,
	 *  so "shared >= 1" is already a real, meaningful filter on its own. Requiring 2 once the
	 *  roster has more than one species hid every team that happened to share just your most
	 *  popular single Pokémon with nothing shown for it even when that Pokémon appears in
	 *  dozens of the 200 — confirmed live (Swampert: plenty of real teams run it, but almost
	 *  none of those also happen to run whatever else was on the roster). Sorted by share count
	 *  first (so a team matching more of the roster still surfaces above a single-species one),
	 *  then by wins (recordData.wins, falling back to parsing `record` — "13-2" -> 13 — for
	 *  entries missing the structured field) as a tiebreak — both real numbers already on the
	 *  data, nothing synthesized or blended into a single score. */
	function aggregateTopTeams(teams, rosterSpeciesIds) {
		const rosterSet = new Set(rosterSpeciesIds || []);
		if (!rosterSet.size) return [];

		const wins = (t) => (t.recordData && typeof t.recordData.wins === 'number') ?
			t.recordData.wins : (parseInt((t.record || '').split('-')[0], 10) || 0);

		return (teams || [])
			.filter((team) => team && Array.isArray(team.pokemon))
			.map((team) => {
				const shared = team.pokemon.reduce((n, p) =>
					n + ((p && p.name && rosterSet.has(baseSpeciesID(p.name))) ? 1 : 0), 0);
				return Object.assign({ shared }, team);
			})
			.filter((e) => e.shared >= 1)
			.sort((a, b) => (b.shared !== a.shared) ? b.shared - a.shared : wins(b) - wins(a));
	}

	/** How many of a species' own top-10 `counters` (Pikalytics' per-species ranked "what beats
	 *  this Pokémon" list — see pikalytics.js's own module doc comment, `/api/p/` response
	 *  shape) aggregateTeamThreats below turns into a per-mention weight: rank 1 (the single
	 *  biggest counter) is worth this many points, rank 10 (the last entry Pikalytics returns)
	 *  is worth 1, linearly in between. Matches the real length of the list Pikalytics actually
	 *  sends (confirmed live) rather than an arbitrary round number, so every real entry gets a
	 *  positive weight and nothing past the list's own end is ever reachable. */
	const TEAM_THREATS_MAX_RANK = 10;
	/** aggregateTeamThreats' own output is already fully ranked — this just bounds how many
	 *  rows buildTeamThreatsSectionHTML actually renders, the same "don't show the whole tail"
	 *  role SIMILAR_TEAMS_PAGE_SIZE/getTopUsageList's own `count` play elsewhere. Team-overview's
	 *  panel scrolls internally if it needs to (style.css), so this is about keeping the list a
	 *  quick glance rather than a hard layout constraint. */
	const TEAM_THREATS_MAX_ROWS = 8;

	/** Aggregates the real per-species `counters` list (see TEAM_THREATS_MAX_RANK's own comment)
	 *  Pikalytics returns for every roster member into one ranked list of the biggest threats to
	 *  the *whole* roster at once, for the team-overview screen's Biggest Threats section
	 *  (renderTeamThreatsSection). `perMemberCounters` is one entry per roster member —
	 *  `{member: <that member's species name>, counters: <its own counters array, or null/
	 *  empty if Pikalytics had no data for it>}` — kept as this file's own shape rather than
	 *  passing raw per-species `mon` objects through, so this stays a pure function over plain
	 *  data (same reasoning as aggregateTopTeams above) and unit-testable without a live tbRoom.
	 *
	 *  A counter's score is the sum of its TEAM_THREATS_MAX_RANK-derived weight across every
	 *  member it counters — not just a raw appearance count — so something that's a *severe*
	 *  threat (low rank) to just one or two team members can still outrank something that's a
	 *  *mild* threat (high rank) to several, rather than breadth always trumping severity or
	 *  vice versa; ties broken by how many distinct members it threatens (breadth), then name
	 *  for stable ordering. Grouped by baseSpeciesID — the same Mega/Primal-collapsing
	 *  normalization every other roster/species comparison in this file already uses — so e.g. a
	 *  counter Pikalytics returns as "Blastoise-Mega" against one member and "Blastoise" against
	 *  another is counted as the one real threat it is, not two separate rows. */
	function aggregateTeamThreats(perMemberCounters) {
		const byId = new Map();
		for (const entry of (perMemberCounters || [])) {
			const counters = entry && entry.counters;
			if (!counters) continue;
			for (const c of counters) {
				if (!c || !c.pokemon || !c.rank) continue;
				const weight = TEAM_THREATS_MAX_RANK + 1 - c.rank;
				if (weight <= 0) continue;
				const id = baseSpeciesID(c.pokemon);
				let threat = byId.get(id);
				if (!threat) {
					threat = { pokemon: c.pokemon, score: 0, members: [] };
					byId.set(id, threat);
				}
				threat.score += weight;
				threat.members.push(entry.member);
			}
		}
		return Array.from(byId.values()).sort((a, b) =>
			(b.score !== a.score) ? b.score - a.score :
				(b.members.length !== a.members.length) ? b.members.length - a.members.length :
					a.pokemon.localeCompare(b.pokemon));
	}

	/** How popular a threat's own move has to be (Pikalytics' real per-move usage percent,
	 *  same field buildMovesSection/buildSpeciesPreviewTooltipHTML already read) before
	 *  computeThreatMoveReason below is willing to call it "commonly runs" — low enough to
	 *  catch a real secondary option, high enough that a 3%-usage tech pick doesn't get quoted
	 *  as if it were the norm. A starting guess, not a researched number, same honesty as
	 *  CF_SETTINGS.scarfThresholdPercent's own doc comment about its default. */
	const TEAM_THREATS_MOVE_USAGE_MIN_PERCENT = 20;
	/** How much higher a threat's real computed offensive stat has to be than the defending
	 *  team member's real computed defensive stat before computeThreatReasons below calls it
	 *  out as a stat-based reason (as opposed to genuinely comparable stats that just happen to
	 *  differ a little) — 1.3 meaning "at least 30% higher." Same "starting guess" caveat as
	 *  TEAM_THREATS_MOVE_USAGE_MIN_PERCENT above. */
	const TEAM_THREATS_STAT_RATIO_THRESHOLD = 1.3;
	/** How many distinct super-effective moves computeThreatMoveReasons is willing to name at
	 *  once — a real threat can have more than one genuinely dangerous option (own doc comment
	 *  on why usage alone was the wrong ranking), and showing a couple is worth the extra table
	 *  rows; showing every qualifying move it has would just be a movepool dump, not a reason. */
	const TEAM_THREATS_MAX_MOVE_REASONS = 2;

	/** Whether `moveName` actually deals damage at all — Pikalytics' own per-move data (`{move,
	 *  percent, type}`) carries a type for every move, Status moves included (Detect/Protect are
	 *  "Normal", Toxic is "Poison", etc. — real flavor/interaction typing, not a deal-damage
	 *  flag), so a bare type check alone can't tell a real attack from a Status move that merely
	 *  happens to type-match. Needs window.Dex for the move's own real category — returns false,
	 *  not true, when window.Dex isn't available, same "unverifiable claim is worse than a
	 *  skipped one" reasoning threatHasMoveOfCategory's own doc comment already uses; a threat's
	 *  move reasons should degrade to showing nothing sooner than risk citing Detect as "why"
	 *  something counters a team member. */
	function isDamagingMove(moveName) {
		if (!window.Dex) return false;
		const moveData = window.Dex.moves.get(moveName);
		return !!(moveData && moveData.exists && moveData.category !== 'Status');
	}

	/** A move's own real base power (window.Dex, not Pikalytics — usage% has nothing to do with
	 *  how hard a move actually hits) — 0 for anything window.Dex can't confirm a real numeric
	 *  base power for, the same "can't verify it, don't credit it" fallback isDamagingMove's own
	 *  doc comment already uses, rather than treating an unknown move as maximally threatening.
	 *  This is what computeThreatMoveReasons/computeThreatSpeedReason actually rank candidate
	 *  moves by now, usage only as a tiebreak — real usage percent alone was picking the wrong
	 *  move to lead with (a real, reported case: Basculegion commonly runs both Aqua Jet, base
	 *  power 40, and Wave Crash, base power 120 — Aqua Jet's own real usage can outrank Wave
	 *  Crash's, but Wave Crash is obviously the more threatening of the two, and a reason citing
	 *  "commonly runs Aqua Jet" instead undersold the actual matchup). Not adjusted for STAB,
	 *  the defender's own real bulk, secondary effects, or accuracy — a real, deliberately rough
	 *  proxy for "how hard does this hit," not a full damage calculator; good enough to fix the
	 *  Aqua-Jet-over-Wave-Crash class of misordering without this file growing an actual damage
	 *  formula for a hover tooltip. */
	function movePower(moveName) {
		if (!window.Dex) return 0;
		const moveData = window.Dex.moves.get(moveName);
		return (moveData && moveData.exists && typeof moveData.basePower === 'number') ? moveData.basePower : 0;
	}

	/** Real Same-Type-Attack-Bonus (STAB) — the real 1.5x every move gets when its own effective
	 *  type (the post-effectiveMoveType type, not necessarily the move's bare listed one — a
	 *  Pixilate Sylveon's Hyper Voice really does get STAB as Fairy, since Fairy is genuinely one
	 *  of Sylveon's own types once the move's type is actually Fairy) matches one of the
	 *  attacker's own real types. Folded into the power movePower's own ranking sorts by — raw
	 *  base power alone already ranks the wrong move some of the time (that function's own doc
	 *  comment); ignoring STAB compounds the same mistake in a different direction, a real
	 *  reported case: a non-STAB Solar Beam (120 base power, Grass — not one of Charizard's own
	 *  Fire/Flying types) was outranking a real STAB Fire move that hits harder in practice once
	 *  the 1.5x is actually accounted for, despite the STAB move's own lower *raw* number. Not
	 *  the extra 1.2x Pixilate-family abilities also grant on top of STAB in the real engine — a
	 *  smaller, secondary effect this file doesn't model, unlike the primary STAB multiplier
	 *  every damaging move gets. `attackerTypes` missing/empty (window.Dex or the threat's own
	 *  species entry unavailable) just means no STAB bonus applies, not an error. */
	function stabAdjustedPower(power, type, attackerTypes) {
		return (attackerTypes && attackerTypes.includes(type)) ? power * 1.5 : power;
	}

	/** Real abilities that override a Normal-type move's own type outright — confirmed against
	 *  Pokémon Showdown's own data/abilities.ts (every entry's real onModifyType hook), not
	 *  assumed: a Pixilate Sylveon's Hyper Voice hits as Fairy, not Normal, and
	 *  typeEffectivenessMultiplier needs to know that, not the move's bare listed type. Excludes
	 *  Dragonize (the real source marks it `isNonstandard: "Future"` — not a real, currently
	 *  legal ability anywhere, same reasoning Mountaineer was already excluded from
	 *  DEFENSIVE_ABILITY_IMMUNITIES for). Normalize (any move -> Normal, not just Normal ones)
	 *  and Liquid Voice (sound-flagged moves -> Water, not type-gated at all) don't fit this
	 *  same shape and are handled directly in effectiveMoveType below instead. */
	const NORMAL_CONVERTING_ABILITIES = { aerilate: 'Flying', galvanize: 'Electric', pixilate: 'Fairy', refrigerate: 'Ice' };
	/** Moves the real engine excludes from every one of NORMAL_CONVERTING_ABILITIES/Normalize
	 *  above — each already determines its own type some other way (Judgment/Multi-Attack/
	 *  Natural Gift/Techno Blast from an held item, Revelation Dance from the user's own type,
	 *  Terrain Pulse from active terrain, Weather Ball from weather — effectiveMoveType handles
	 *  that last one directly), so a type-overriding ability never touches them even when
	 *  they're nominally Normal-type. Real Normalize's own exclusion list also adds Hidden
	 *  Power/Struggle — skipped here since neither is a move Pikalytics' own "commonly used"
	 *  data would ever surface with meaningful usage (Struggle is a forced emergency move, no
	 *  one picks it; Hidden Power's type is IV-locked, not a real build choice in this format). */
	const TYPE_CHANGE_EXCLUDED_MOVES = new Set([
		'judgment', 'multiattack', 'naturalgift', 'revelationdance', 'technoblast', 'terrainpulse', 'weatherball',
	]);
	/** Abilities that set a real field weather unconditionally on switch-in — confirmed against
	 *  data/abilities.ts. Simplified on purpose the same way the rest of this file already
	 *  leans on "the best real, unconditional fact about this species" rather than modeling an
	 *  actual battle: a threat's own weather-setting ability is treated as always active for its
	 *  own Weather Ball (effectiveMoveType below), the same spirit enrichTeamThreat's own
	 *  foeSet/Speed math already uses elsewhere (no live battle state exists here to check
	 *  against — a Pokémon isn't on any actual field). */
	const WEATHER_SETTING_ABILITIES = { drought: 'Sun', drizzle: 'Rain', sandstream: 'Sandstorm', snowwarning: 'Snow' };
	/** Weather Ball's own real onModifyType, confirmed against data/moves.ts: Fire in sun,
	 *  Water in rain, Rock in sandstorm, Ice in hail/snow, its own listed Normal otherwise (no
	 *  entry here for that case — effectiveMoveType's own fallback already returns the move's
	 *  unmodified type when nothing in WEATHER_SETTING_ABILITIES matches). */
	const WEATHER_BALL_TYPE = { Sun: 'Fire', Rain: 'Water', Sandstorm: 'Rock', Snow: 'Ice' };

	/** The real effective type a threat's move deals damage as, once its own real ability (or a
	 *  weather that ability sets) is accounted for — not just the move's bare Pikalytics-listed
	 *  type. Two distinct real mechanisms, checked in this order because Weather Ball is itself
	 *  one of TYPE_CHANGE_EXCLUDED_MOVES in the real engine (so it has to be resolved before that
	 *  exclusion check would otherwise just return its bare type unchanged):
	 *   1. Weather Ball's own weather-dependent type (WEATHER_BALL_TYPE) — a Charizard with
	 *      Drought running Weather Ball hits as Fire, not Normal.
	 *   2. A real type-overriding ability — Normalize (any move -> Normal), a
	 *      NORMAL_CONVERTING_ABILITIES entry (a Normal move -> that ability's own type), or
	 *      Liquid Voice (a sound-flagged move -> Water) — none of which apply to a
	 *      TYPE_CHANGE_EXCLUDED_MOVES move (own doc comment).
	 *  Falls back to the move's own real type unchanged when neither applies, `ability` is
	 *  empty/unrecognized, or window.Dex isn't available to check the move's own flags against
	 *  (Liquid Voice only).
	 *
	 *  `moveType` is normalized to Titlecase up front — confirmed live: Pikalytics' own per-move
	 *  data sends it lowercase ("normal", "fairy", ...), not the Titlecase typeEffectivenessMultiplier/
	 *  window.Dex/this file's own constants (NORMAL_CONVERTING_ABILITIES's values, WEATHER_BALL_TYPE's
	 *  values, 'Normal'/'Water' above) all use — a bare `moveType === 'Normal'` check against the
	 *  real, unnormalized value silently never matched anything, the actual live bug this
	 *  comment is here to keep from recurring: every Normal-type-converting ability, Pixilate
	 *  included, quietly never fired against real Pikalytics data despite working in any test
	 *  that (wrongly) typed its own fixture data in Titlecase to begin with.
	 *  typeEffectivenessMultiplier gets away with this because it does its own normalizing
	 *  internally; a raw `===` comparison here does not, so it has to be done explicitly. The
	 *  returned type is always Titlecase too, matching every other type string this file passes
	 *  to window.Dex.getTypeIcon/typeEffectivenessMultiplier, regardless of what case `moveType`
	 *  arrived in. */
	function effectiveMoveType(moveName, moveType, ability) {
		const abilityId = toIDSafe(ability);
		const moveId = toIDSafe(moveName);
		const type = moveType ? moveType.charAt(0).toUpperCase() + moveType.slice(1).toLowerCase() : moveType;

		if (moveId === 'weatherball') {
			const weather = WEATHER_SETTING_ABILITIES[abilityId];
			return weather ? WEATHER_BALL_TYPE[weather] : type;
		}
		if (TYPE_CHANGE_EXCLUDED_MOVES.has(moveId)) return type;

		if (abilityId === 'normalize') return 'Normal';
		if (NORMAL_CONVERTING_ABILITIES[abilityId] && type === 'Normal') return NORMAL_CONVERTING_ABILITIES[abilityId];
		if (abilityId === 'liquidvoice') {
			const moveData = window.Dex && window.Dex.moves.get(moveName);
			if (moveData && moveData.exists && moveData.flags && moveData.flags.sound) return 'Water';
		}
		return type;
	}

	/** Up to TEAM_THREATS_MAX_MOVE_REASONS real, distinct super-effective moves in `moves`
	 *  (Pikalytics' own per-species move list — `{move, percent, type}`, see pikalytics.js's own
	 *  module doc comment) that each clear TEAM_THREATS_MOVE_USAGE_MIN_PERCENT, actually deal
	 *  damage (isDamagingMove — a Status move can't be "super effective," whatever type it's
	 *  flavored as), and are super effective (via the same typeEffectivenessMultiplier every
	 *  other type-chart check in this file uses) against `defenderTypes` once each one's own
	 *  *real effective* type is resolved (effectiveMoveType, `ability` — the threat's own
	 *  real/assumed ability, enrichTeamThreat) — a Pixilate Sylveon's Hyper Voice is checked and
	 *  reported as Fairy, not the move's bare Normal. Returns `[]` if nothing qualifies.
	 *
	 *  Ranked by real STAB-adjusted power first (stabAdjustedPower, `attackerTypes` — the
	 *  threat's own real types, enrichTeamThreat), usage percent only as a tiebreak — NOT by
	 *  usage alone: a real, reported case, Basculegion commonly runs both Aqua Jet (base power
	 *  40) and Wave Crash (base power 120), and Aqua Jet's own real usage can outrank Wave
	 *  Crash's even though Wave Crash is obviously the more threatening of the two (movePower's
	 *  own doc comment) — and STAB *specifically*, not just raw power, since a non-STAB move can
	 *  otherwise still outrank a lower-raw-power move that actually hits harder once its own
	 *  1.5x is accounted for (stabAdjustedPower's own doc comment: a real reported case, a
	 *  non-STAB Solar Beam outranking a real STAB Fire move on a Fire-type attacker). Usage
	 *  still gates which moves are candidates at all (a real, commonly-used move, not just
	 *  anything in the movepool) — it just isn't what orders them once they qualify.
	 *
	 *  `excludeMove` (optional) drops one move id from the candidate pool before ranking/slicing,
	 *  not after — computeThreatReasons uses this to keep the speed reason's own move from also
	 *  showing up as a move reason (see that function's own doc comment) without shrinking the
	 *  result by one whenever that move happens to also be a top-`TEAM_THREATS_MAX_MOVE_REASONS`
	 *  candidate: excluding post-hoc, after the slice, would silently drop a real 3rd-ranked move
	 *  the caller has room to show instead of backfilling it. */
	function computeThreatMoveReasons(moves, defenderTypes, ability, attackerTypes, excludeMove) {
		const candidates = [];
		for (const m of (moves || [])) {
			if (!m || !m.move || !m.type) continue;
			if (excludeMove && m.move === excludeMove) continue;
			const percent = parseFloat(m.percent) || 0;
			if (percent < TEAM_THREATS_MOVE_USAGE_MIN_PERCENT) continue;
			if (!isDamagingMove(m.move)) continue;
			const type = effectiveMoveType(m.move, m.type, ability);
			if (typeEffectivenessMultiplier(type, defenderTypes) < 2) continue;
			const power = stabAdjustedPower(movePower(m.move), type, attackerTypes);
			candidates.push({ move: m.move, type, percent, power });
		}
		candidates.sort((a, b) => (b.power !== a.power) ? b.power - a.power : b.percent - a.percent);
		return candidates.slice(0, TEAM_THREATS_MAX_MOVE_REASONS).map(({ move, type, percent }) => ({ move, type, percent }));
	}

	/** Whether a threat that outspeeds — naturally, or only with a real, common-enough Choice
	 *  Scarf (see enrichTeamThreat's own baseSpeed/scarfSpeed derivation) — also has a real,
	 *  commonly-used, actually-damaging (isDamagingMove — a Status move landing first "connects"
	 *  for zero damage, not a real threat) move that isn't resisted against `defenderTypes`
	 *  (>=1x: neutral or better) once its own real effective type is resolved (effectiveMoveType,
	 *  `threat.ability` — a Charizard with Drought outspeeding and running Weather Ball is
	 *  checked and reported as Fire, not the move's bare Normal). "Moves first and still lands a
	 *  real hit" is its own distinct condition for counting as a real counter, separate from
	 *  (and not requiring) computeThreatMoveReasons' own >=2x bar — even a merely-neutral hit
	 *  that lands before the defender can act at all is a genuine threat that function alone
	 *  would miss entirely. Picks the highest-STAB-adjusted-power qualifying move (`threat.types`
	 *  — the threat's own real types, stabAdjustedPower), same ranking reasoning
	 *  computeThreatMoveReasons' own doc comment gives.
	 *
	 *  `threat` is `{moves, ability, types, baseSpeed, scarfSpeed}` — scarfSpeed is null when
	 *  Scarf isn't common enough on this species to credibly assume (enrichTeamThreat);
	 *  `defender` is `{types, speed}` — the threatened member's own real computed Speed, its own
	 *  held item included, the same number every other Speed comparison in this file already
	 *  uses. Returns null when the threat doesn't outspeed either way, or has no move to back
	 *  the claim with — a bare Speed advantage with nothing that actually connects isn't
	 *  "countering" on its own. */
	function computeThreatSpeedReason(threat, defender) {
		if (!defender.speed) return null;
		let viaScarf;
		if (threat.baseSpeed && threat.baseSpeed > defender.speed) viaScarf = false;
		else if (threat.scarfSpeed && threat.scarfSpeed > defender.speed) viaScarf = true;
		else return null;

		// Ranked by real STAB-adjusted power first, usage only as a tiebreak — same reasoning
		// computeThreatMoveReasons' own doc comment gives (Aqua Jet's real usage can outrank
		// Wave Crash's despite hitting far softer; a non-STAB Solar Beam can outrank a real STAB
		// move on raw power alone despite the STAB move hitting harder in practice): the backing
		// move named here should be the one that actually makes outspeeding matter, not just
		// whichever qualifying option happens to be the most common or the highest *raw* number.
		let best = null;
		for (const m of (threat.moves || [])) {
			if (!m || !m.move || !m.type) continue;
			const percent = parseFloat(m.percent) || 0;
			if (percent < TEAM_THREATS_MOVE_USAGE_MIN_PERCENT) continue;
			if (!isDamagingMove(m.move)) continue;
			const type = effectiveMoveType(m.move, m.type, threat.ability);
			if (typeEffectivenessMultiplier(type, defender.types) < 1) continue;
			const power = stabAdjustedPower(movePower(m.move), type, threat.types);
			if (!best || power > best.power || (power === best.power && percent > best.percent)) {
				best = { move: m.move, type, percent, power };
			}
		}
		if (!best) return null;
		return { kind: 'speed', move: best.move, type: best.type, percent: best.percent, viaScarf };
	}

	/** Whether `moves` includes at least one real, commonly-used (TEAM_THREATS_MOVE_USAGE_MIN_
	 *  PERCENT) move of the given Dex move category ('Physical'/'Special') — the gate
	 *  computeThreatReasons puts in front of its own raw stat-mismatch reasons, so "High Special
	 *  Attack vs. their Special Defense" is never shown for a Pokémon whose actual common
	 *  moveset turns out to be entirely physical (a real stat can be misleading on its own — the
	 *  category of what a species actually runs is the thing that makes the stat relevant).
	 *  Needs window.Dex for each move's own category (Pikalytics' own move data doesn't carry
	 *  one) — returns false, not true, when window.Dex isn't available, since an unverifiable
	 *  claim is worse than a skipped one here. */
	function threatHasMoveOfCategory(moves, category) {
		if (!window.Dex) return false;
		return (moves || []).some((m) => {
			if (!m || !m.move) return false;
			if ((parseFloat(m.percent) || 0) < TEAM_THREATS_MOVE_USAGE_MIN_PERCENT) return false;
			const moveData = window.Dex.moves.get(m.move);
			return moveData && moveData.exists && moveData.category === category;
		});
	}

	/** The actual "why" behind one threat/team-member matchup, for the Biggest Threats hover
	 *  tooltip (buildTeamThreatTooltipHTML). `threat` is `{moves, ability, types, atk, spa,
	 *  baseSpeed, scarfSpeed}` — the threatening species' own Pikalytics move list, real
	 *  most-common ability, and real own types (enrichTeamThreat: `ability` its own top real
	 *  Pikalytics ability, fed to effectiveMoveType inside computeThreatMoveReasons/
	 *  computeThreatSpeedReason so a Pixilate/Aerilate/Galvanize/Refrigerate/Normalize/Liquid
	 *  Voice user's move is checked and reported as its real effective type, and a
	 *  weather-setting ability's own species running Weather Ball is checked and reported as
	 *  that weather's real type, not either move's bare listed type; `types` its own real
	 *  species types, fed to stabAdjustedPower inside those same two functions so a move that
	 *  matches one of the threat's own types is ranked with its real STAB bonus factored in, not
	 *  just its bare base power) plus its real computed offensive stats and Speed
	 *  (enrichTeamThreat below derives those from its top real spread+nature, the same "no item"
	 *  Foe-column technique buildSpeedComparisonTooltipHTML already uses, `scarfSpeed`
	 *  additionally accounting for a real, common-enough Choice Scarf); `defender` is `{types,
	 *  def, spd, speed}` — the threatened team member's own real defensive types/stats and
	 *  Speed.
	 *
	 *  Returns a handful of typed reason objects, ordered most-concrete-first: `{kind: 'speed',
	 *  move, type, percent, viaScarf}` for outspeeding with a real, non-resisted hit
	 *  (computeThreatSpeedReason) when that applies — checked first, since a super-effective
	 *  move that also outspeeds is strictly the more complete fact ("lands first AND hits hard,"
	 *  not just "hits hard") — then up to TEAM_THREATS_MAX_MOVE_REASONS `{kind: 'move', move,
	 *  type, percent}` entries for other real, distinct super-effective moves
	 *  (computeThreatMoveReasons), excluding whichever move the speed reason already named (that
	 *  exact move, already shown with its own type icon in the speed reason's own cell — see
	 *  buildTeamThreatReasonCellHTML — would just be the same underlying fact restated, not a
	 *  second one) but still naming a genuinely *different* strong move when the threat has one.
	 *  Both kept structured (not pre-formatted text) so buildTeamThreatTooltipHTML's table can
	 *  render each move's own type icon next to its name, not just describe it in prose.
	 *
	 *  Then up to two `{kind: 'stat', text}` entries (physical, then special). A stat reason only
	 *  appears when the threat also has a real move of the matching category
	 *  (threatHasMoveOfCategory) backing the raw number up. Any of
	 *  `threat.atk`/`threat.spa`/`threat.baseSpeed` being null (enrichTeamThreat couldn't derive
	 *  a real stat — no spread data for this species) simply skips the reason(s) that depend on
	 *  it rather than guessing. */
	function computeThreatReasons(threat, defender) {
		const reasons = [];
		const speedReason = computeThreatSpeedReason(threat, defender);
		if (speedReason) reasons.push(speedReason);
		const moveReasons = computeThreatMoveReasons(
			threat.moves, defender.types, threat.ability, threat.types, speedReason && speedReason.move);
		for (const r of moveReasons) reasons.push({ kind: 'move', move: r.move, type: r.type, percent: r.percent });
		if (threat.atk && defender.def && (threat.atk / defender.def) >= TEAM_THREATS_STAT_RATIO_THRESHOLD &&
			threatHasMoveOfCategory(threat.moves, 'Physical')) {
			reasons.push({ kind: 'stat', text: 'High Attack vs Low Defense' });
		}
		if (threat.spa && defender.spd && (threat.spa / defender.spd) >= TEAM_THREATS_STAT_RATIO_THRESHOLD &&
			threatHasMoveOfCategory(threat.moves, 'Special')) {
			reasons.push({ kind: 'stat', text: 'High Special Attack vs Low Special Defense' });
		}
		return reasons;
	}

	/** Attaches per-member reasons (computeThreatReasons) to one aggregateTeamThreats() entry,
	 *  for the Biggest Threats hover tooltip — the DOM/tbRoom-touching half of that computation,
	 *  kept separate from the pure functions above the same way computeSpeedSpectrumEntries is
	 *  kept separate from applySpeedModifiers/speedStageMultiplier: still a plain function over
	 *  a passed-in tbRoom (real or a test mock, see that function's own tests) rather than
	 *  reaching for a module-level one, so this stays independently testable.
	 *
	 *  The threat's own offensive stats and base Speed are derived from `mon` (its Pikalytics
	 *  species data — same object renderPikalyticsSidebar already fetches per-species, just for
	 *  the threat instead of a roster member) via its top real spread + nature, through
	 *  tbRoom.getStat — the same "species + real spread/nature, no item" technique
	 *  buildSpeedComparisonTooltipHTML already uses for the Speed comparison's own Foe column,
	 *  just for Attack/Special Attack/Speed together instead of Speed alone. `scarfSpeed` is
	 *  that same base Speed with a real Choice Scarf applied (applySpeedModifiers, the exact
	 *  multiplier every other Speed number in this file already goes through) — but only when
	 *  this species' own real Scarf usage clears CF_SETTINGS.scarfThresholdPercent, the same
	 *  threshold buildSpeedComparisonTooltipHTML's own conditional Scarf column already gates
	 *  on; left null otherwise, so computeThreatSpeedReason never credits an outspeed that would
	 *  require a build nobody's actually running. All four are left null (computeThreatReasons
	 *  then just skips whichever reasons depend on them) when `mon` has no spread data to derive
	 *  a real stat from at all.
	 *
	 *  Each threatened member's own defensive stats/types/Speed come from its *real* set in
	 *  tbRoom.curSetList — actual invested EVs/nature/level/item, not a generic base-stat guess —
	 *  with the same Mega-Stone-holder resolution (resolveSpeedSpectrumSpecies)
	 *  computeSpeedSpectrumEntries already applies (a Mega forme's own boosted bulk/Speed is what
	 *  actually matters, not the base forme's), and the member's own real held item folded into
	 *  its Speed via applySpeedModifiers exactly the way computeSpeedSpectrumEntries' own roster
	 *  dots already do — a member actually holding Scarf/Iron Ball has that reflected in whether
	 *  it actually gets outsped, not just the threat's side of the matchup. */
	function enrichTeamThreat(tbRoom, threat, mon) {
		const moves = (mon && mon.moves) || [];
		// The threat's own single most-common real ability (Pikalytics' own usage-sorted
		// `abilities` list, same shape/ordering as `items`/`natures` — see buildAbilitiesSection)
		// — fed to effectiveMoveType inside computeThreatReasons so a Pixilate/Aerilate/
		// Galvanize/Refrigerate/Normalize/Liquid Voice user's move (or a weather-setter's own
		// Weather Ball) is checked against its real effective type, not its move's bare listed
		// one. Independent of topSpread below — real ability data doesn't need a real spread to
		// be meaningful — so computed unconditionally rather than gated behind that check.
		const topAbility = ((mon && mon.abilities) || [])[0];
		const ability = topAbility && topAbility.ability;
		// The threat's own real species types (window.Dex — the same source the defender side
		// already uses for its own types elsewhere in this function) — fed to stabAdjustedPower
		// inside computeThreatReasons so a move matching one of the threat's own types is ranked
		// with its real 1.5x STAB bonus factored in, not just its bare base power.
		// Named threatTypes, not types — the per-member loop below has its own, unrelated
		// `types` (the *defender's* own types) in a nested scope; sharing the name would shadow
		// this one there without any error, silently feeding the wrong types into
		// stabAdjustedPower.
		const threatSpecies = window.Dex && window.Dex.species.get(threat.pokemon);
		const threatTypes = (threatSpecies && threatSpecies.exists && threatSpecies.types) || [];
		let atk = null;
		let spa = null;
		let baseSpeed = null;
		let scarfSpeed = null;
		const topSpread = mon && (mon.spreads || [])[0];
		if (topSpread) {
			const topNature = (mon.natures || [])[0];
			const level = (tbRoom.curSetList && tbRoom.curSetList[0] && tbRoom.curSetList[0].level) || 50;
			const foeSet = {
				species: threat.pokemon,
				evs: parseEVs(topSpread.ev),
				nature: (topNature && topNature.nature) || '',
				ivs: { atk: 31, spa: 31, spe: 31 },
				level,
			};
			atk = tbRoom.getStat('atk', foeSet);
			spa = tbRoom.getStat('spa', foeSet);
			baseSpeed = tbRoom.getStat('spe', foeSet);

			const scarfItem = (mon.items || []).find((it) =>
				toIDSafe(it.item) === 'choicescarf' && (parseFloat(it.percent) || 0) >= CF_SETTINGS.scarfThresholdPercent);
			if (scarfItem) scarfSpeed = applySpeedModifiers(baseSpeed, 'Choice Scarf', {});
		}

		const memberReasons = threat.members.map((memberSpeciesName) => {
			const memberSet = (tbRoom.curSetList || []).find((s) => s && s.species === memberSpeciesName);
			if (!memberSet) return { member: memberSpeciesName, reasons: [] };
			const { species: resolvedSpecies, isMega } = resolveSpeedSpectrumSpecies(memberSet);
			const statSet = isMega ? Object.assign({}, memberSet, { species: resolvedSpecies }) : memberSet;
			const def = tbRoom.getStat('def', statSet);
			const spd = tbRoom.getStat('spd', statSet);
			const speed = applySpeedModifiers(tbRoom.getStat('spe', statSet), memberSet.item, {});
			const resolved = window.Dex && window.Dex.species.get(resolvedSpecies);
			const types = (resolved && resolved.exists && resolved.types) || [];
			return {
				member: memberSpeciesName,
				reasons: computeThreatReasons(
					{ moves, ability, types: threatTypes, atk, spa, baseSpeed, scarfSpeed },
					{ types, def, spd, speed },
				),
			};
		});

		return Object.assign({}, threat, { memberReasons });
	}

	/** The current roster's own species, base-species-ID'd (same normalization
	 *  curTeamHasSpecies/aggregateTopTeams-adjacent code uses everywhere else), in the
	 *  actual slot order they were added — NOT sorted, unlike rosterSpeciesKey's cache key
	 *  (which sorts on purpose, since a cache key shouldn't care about order). This is the
	 *  reference column order alignSimilarTeamPokemon below aligns every match against, so it
	 *  has to be the real order, not a normalized one. */
	function curRosterSpeciesOrder(tbRoom) {
		return (tbRoom.curSetList || []).filter((s) => s && s.species).map((s) => baseSpeciesID(s.species));
	}

	/** Reorders one similar team's 6 Pokémon to line up column-by-column with the current
	 *  roster, so scanning down a column across several rendered rows compares the same "slot"
	 *  rather than requiring a name-by-name search each time — that's the whole point of
	 *  surfacing these teams at all (see aggregateTopTeams' own doc comment). Species this
	 *  team shares with the roster are placed at the *same index* the roster itself has them at
	 *  (`rosterSpeciesIds[i]`).
	 *
	 *  Anything the team has that isn't on the roster at all (`extras`) loops back into whatever
	 *  roster slots were left empty, front to back, rather than tacking every extra on past the
	 *  end of the row — a real 6-mon team and a full 6-slot roster always leave exactly as many
	 *  empty slots as they have extras (whatever didn't match takes the place of whatever wasn't
	 *  matched), so this keeps every row the same width instead of some rows running one or two
	 *  columns longer than the rest, which is what made the section read as staggered/offsetting
	 *  row to row rather than as a clean grid. A slot only stays `null` (rendered as an empty
	 *  placeholder — see buildSimilarTeamRowHTML) when there are genuinely more empty roster
	 *  slots than extras to fill them with — a shorter, not-yet-full roster is the only case that
	 *  can happen; any leftover past that (more extras than empty slots) still spills after the
	 *  roster-length slots, in whatever order Pikalytics originally returned it. A roster species
	 *  repeated on one team (shouldn't happen in a real, legal team, but nothing here assumes it
	 *  can't) only fills the first matching slot; every later occurrence is treated as an extra
	 *  rather than overwriting an already-filled slot. */
	function alignSimilarTeamPokemon(pokemon, rosterSpeciesIds) {
		const ids = rosterSpeciesIds || [];
		const slots = ids.map(() => null);
		const extras = [];
		(pokemon || []).forEach((p) => {
			if (!p || !p.name) return;
			const idx = ids.indexOf(baseSpeciesID(p.name));
			if (idx !== -1 && !slots[idx]) slots[idx] = p;
			else extras.push(p);
		});
		for (let i = 0; i < slots.length && extras.length; i++) {
			if (!slots[i]) slots[i] = extras.shift();
		}
		return slots.concat(extras);
	}

	/** Single source of truth for Showdown's own HP/Atk/Def/SpA/SpD/Spe stat order/labels —
	 *  STAT_IDS and STAT_LABELS (used by parseEVs below and by buildSpreadsSection/
	 *  natureModifierHTML below) are both derived from this one object rather than each
	 *  being its own hand-typed literal, so the order/spelling can't drift between them. */
	const STAT_LABEL_BY_ID = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
	const STAT_IDS = Object.keys(STAT_LABEL_BY_ID);
	const STAT_LABELS = Object.values(STAT_LABEL_BY_ID);

	/** The 18 real Pokémon types, in the same order Showdown's own Dex/UI lists them — a fixed,
	 *  game-wide fact (every generation since Fairy was added has exactly these 18, regardless of
	 *  format/regulation) rather than anything derived from window.Dex.types itself: unlike
	 *  SPEED_SPECTRUM_FASTEST_NON_MEGA and friends below (which really are format-specific and
	 *  had to be hand-researched), this list doesn't change per format, so there's nothing here
	 *  to keep in sync with a regulation the way that one does. Declared up here rather than next
	 *  to computeTeamDefensiveProfile (down near the other section builders) for the same reason
	 *  the SPEED_SPECTRUM_* constants below are: it has to be assigned before the module.exports
	 *  early-return guard, or it'd stay in the temporal dead zone forever for any closure that
	 *  references it later (see that guard's own comment). */
	const ALL_TYPES = [
		'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
		'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
	];

	/** Real abilities that grant a flat immunity to one specific attacking type — confirmed
	 *  against Pokémon Showdown's own real ability data (github.com/smogon/pokemon-showdown,
	 *  data/abilities.ts, checked directly rather than trusted from memory), not just recalled:
	 *  every ability whose own onTryHit checks a bare `move.type === '…'` and returns null (a
	 *  full block, not a modifier) was walked by hand. Water Absorb, Dry Skin and Storm Drain
	 *  all no-sell a Water-type hit outright this way (the first two heal off it, the third also
	 *  redirects/boosts, but the shared, defensively-relevant fact is the same: 0 damage), same
	 *  idea for the other eight. Levitate is the one exception implemented differently in the
	 *  real engine (sim/pokemon.ts's own isGrounded, not an onTryHit block) but has the identical
	 *  defensive effect — genuinely immune to Ground — so it's included here on that same
	 *  footing. Keyed by ability ID (toIDSafe) -> the one type it blocks. Declared up here rather
	 *  than next to applyDefensiveAbility (down near the other section builders) for the same
	 *  module.exports-TDZ reason ALL_TYPES above is.
	 *
	 *  Deliberately NOT the whole universe of defensively-relevant abilities — checked and
	 *  excluded, not overlooked: Thick Fat/Filter/Solid Rock/Prism Armor all reduce (not zero
	 *  out) certain damage, a different mechanic (a fractional onSourceModifyAtk/SpA modifier,
	 *  not a type-chart override) this table isn't shaped for; Purifying Salt specifically halves
	 *  Ghost-type damage the same way, not a block; Water Bubble halves Fire damage taken but
	 *  doesn't touch Water at all (its own immunity-shaped hook is burn-status only); Wind Rider
	 *  blocks wind-*flagged* moves (Tailwind, Hurricane, Whirlwind…) which span several different
	 *  types, not one — doesn't fit a type-indexed table at all, handled separately by
	 *  applyDefensiveAbility below via Wonder Guard's own different-shaped rule; Mountaineer (a
	 *  real Rock-type immunity, but only versus Stealth Rock and only pre-hazard) is CAP-only
	 *  (`isNonstandard: "CAP"` in the source) and never legal in any real format. */
	const DEFENSIVE_ABILITY_IMMUNITIES = {
		waterabsorb: 'Water', dryskin: 'Water', stormdrain: 'Water',
		voltabsorb: 'Electric', lightningrod: 'Electric', motordrive: 'Electric',
		flashfire: 'Fire', wellbakedbody: 'Fire',
		sapsipper: 'Grass',
		levitate: 'Ground', eartheater: 'Ground',
	};

	/** buildSpeedSpectrumHTML's own tuning constants — declared up here rather than next to that
	 *  function (down near the other section builders) because they have to be assigned before
	 *  the module.exports early-return guard below, same reasoning as this file's other
	 *  module-scope consts: a `const` that's still unassigned when that `return` fires stays in
	 *  the temporal dead zone forever for any closure that references it later (see the guard's
	 *  own comment). */
	/** Greedy lane-packing gap threshold (assignSpeedSpectrumLanes): an icon only opens a new
	 *  lane once every existing lane's most-recently-placed icon is closer than this to it (in
	 *  percent of track *area* width, i.e. after cf-speedspectrum-track-area's own
	 *  SPEED_SPECTRUM_LABEL_RESERVE inset — narrower than the full panel) — so e.g. three icons
	 *  bunched together spread across three lanes only if they genuinely need to, not fewer
	 *  (overlapping) or more (wasted vertical space). Grounded in the actual .picon width (40px,
	 *  Showdown's own sprite size), but this can't be computed exactly without a live DOM
	 *  measurement this pure function doesn't have — no longer capped at 653px on this screen and
	 *  free to grow much wider on a large monitor (see renderTeamOverviewPanel's own comment on
	 *  skipping addPokemonPanelWrapHTML), so 40px is a shrinking fraction of the track area the
	 *  wider it gets. Cut down twice now on direct feedback that it was still too conservative
	 *  (was 10, then 6) — if a wide window still spreads icons out more than their actual 40px
	 *  width needs, this is the number to cut further; there's no way to get it exactly right
	 *  for every window size without passing the track area's real measured width in. */
	const SPEED_SPECTRUM_MIN_GAP_PCT = 4;
	/** Pixel height of one icon lane (sprite + value label stacked), stacked upward from the
	 *  track — assignSpeedSpectrumLanes decides how many lanes a given render actually needs. */
	const SPEED_SPECTRUM_LANE_HEIGHT = 46;
	/** Vertical clearance between the track and the nearest lane above it — kept tight
	 *  deliberately (was 18, cut down here) since a large gap here was just dead space between
	 *  the icons and the line they're plotted against. */
	const SPEED_SPECTRUM_TRACK_GAP = 8;
	/** Vertical room a threshold marker (speedSpectrumThresholdHTML) needs below its own `top`
	 *  (already offset from the track by SPEED_SPECTRUM_TRACK_GAP, mirroring the gap the roster
	 *  icons use above it) — the value text's own line, a small gap, the sprite's real height
	 *  (.picon is 30px tall), and a few px for its item badge's own negative bottom offset
	 *  (cf-speedcmp-item-badge, style.css) poking past it. */
	const SPEED_SPECTRUM_THRESHOLD_HEIGHT = 44;
	/** getStat's own evOverride param for the domain floor/ceiling (computeSpeedSpectrumDomain)
	 *  — Champions VGC's real EV scale is 0-32 (see parseEVs' own comment), so these are the two
	 *  actual legal extremes, not arbitrary round numbers. */
	const SPEED_SPECTRUM_MIN_EV = 0;
	const SPEED_SPECTRUM_MAX_EV = 32;
	/** getStat's own natureOverride param — a direct multiplier (see TeambuilderRoom.getStat's
	 *  own source: natureOverride replaces the plus/minus nature lookup entirely when given),
	 *  not a nature name, so these are Showdown's real minus/plus nature multipliers themselves,
	 *  not this file inventing a rate. */
	const SPEED_SPECTRUM_NEGATIVE_NATURE_MULT = 0.9;
	const SPEED_SPECTRUM_POSITIVE_NATURE_MULT = 1.1;
	/** Horizontal space reserved on each side of the track for the domain-bound labels
	 *  (buildSpeedSpectrumHTML) — the track itself (and every icon's own left:NN% position) is
	 *  inset by this much via cf-speedspectrum-track-area, so the labels sit in the margin that
	 *  frees up beside the line rather than directly on top of its two ends. Wide enough for the
	 *  bound's own config sprite (.picon is 40px wide, plus a few px for its item badge's own
	 *  negative right offset poking past it) — the widest thing that actually needs to fit here,
	 *  wider than a 3-digit Speed number on its own would need. */
	const SPEED_SPECTRUM_LABEL_RESERVE = 48;

	/** The real fastest/slowest legal Pokémon in the format itself — hand-researched once
	 *  against Showdown's own Champions-format species/tier data (BattleTeambuilderTable
	 *  .champions), then confirmed directly for both Reg A and Reg B (they share an identical
	 *  legal roster — confirmed, not assumed). See computeSpeedSpectrumDomain's own doc comment
	 *  for the full reasoning on why this is hardcoded rather than computed live. Base Speeds,
	 *  for reference: Dragapult 142, Alakazam-Mega 150 (tied with Aerodactyl-Mega), Torkoal 20,
	 *  Sableye-Mega 20 (tied with Camerupt-Mega). */
	const SPEED_SPECTRUM_FASTEST_NON_MEGA = 'Dragapult';
	const SPEED_SPECTRUM_FASTEST_MEGA = 'Alakazam-Mega';
	const SPEED_SPECTRUM_SLOWEST_NON_MEGA = 'Torkoal';
	const SPEED_SPECTRUM_SLOWEST_MEGA = 'Sableye-Mega';

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

	/** Items with a known Speed-stat effect, id-keyed (toIDSafe). Deliberately small — just
	 *  the two the feature was scoped around (Choice Scarf, Iron Ball) rather than every
	 *  item that touches turn order in some way (e.g. Lagging Tail/Full Incense change move
	 *  priority, not the Speed *stat*, so a straight stat comparison has nothing to do with
	 *  them; Quick Powder only matters on Ditto, deliberately left out for now rather than
	 *  special-cased for one species). Extend this table, not the comparison logic below,
	 *  when another Speed-affecting item needs covering. */
	const SPEED_ITEM_MULTIPLIERS = { choicescarf: 1.5, ironball: 0.5 };

	/** Standard Pokémon stat-stage multiplier: positive stages boost by (2+n)/2, negative
	 *  stages cut by 2/(2-n) — e.g. -1 -> 2/3, -2 -> 1/2. Only -1/-2 are ever passed in by
	 *  the scenario table below, but the general formula is no more code than hardcoding
	 *  just those two ratios would be. */
	function speedStageMultiplier(stage) {
		if (!stage) return 1;
		return stage > 0 ? (2 + stage) / 2 : 2 / (2 - stage);
	}

	/** Applies item/status/stage/Tailwind on top of an already-computed base Speed stat
	 *  (tbRoom.getStat('spe', ...) — see buildSpeedComparisonTooltipHTML). Two separate floors,
	 *  not one at the very end — matching Pokemon Showdown's own sim, confirmed against source:
	 *  Pokemon.prototype.getStat (sim/pokemon.ts) applies the stat *stage* first and floors it
	 *  immediately (`Math.floor(stat * boostTable[boost])` / `Math.floor(stat / boostTable[-boost])`)
	 *  — that always resolves before any item/ability/status modifier runs. Everything else
	 *  (item, paralysis, Tailwind, abilities) is instead combined into a single running
	 *  multiplier via Battle.prototype.chainModify and only applied/floored ONCE, together, via
	 *  Battle.prototype.modify — not floored after each individual modifier. Every multiplier
	 *  used here (1.5, 0.5, 2, and the -1/-2 stage ratios) is "nice" enough in Showdown's 4096-
	 *  denominator fixed-point chain math that this plain-float two-floor version matches it
	 *  exactly for every case this feature actually presents; it's only fixed-point-vs-float
	 *  edge cases with uglier fractions (irrelevant here) where the two could diverge. */
	function applySpeedModifiers(baseStat, itemName, modifiers) {
		let stat = baseStat;
		if (modifiers.stage) stat = Math.floor(stat * speedStageMultiplier(modifiers.stage));

		let otherMult = 1;
		const itemMult = itemName && SPEED_ITEM_MULTIPLIERS[toIDSafe(itemName)];
		if (itemMult) otherMult *= itemMult;
		if (modifiers.paralyzed) otherMult *= 0.5;
		if (modifiers.tailwind) otherMult *= 2;
		if (otherMult !== 1) stat = Math.floor(stat * otherMult);

		return stat;
	}

	/** Maps "how many conditional columns (Mega + Scarf + Iron Ball) is
	 *  buildSpeedComparisonTooltipHTML actually rendering" to the CSS class that widens
	 *  #cf-tooltipwrapper .cf-tooltip enough to fit them (see style.css's
	 *  cf-speedcmp-tooltip-wide/-widest/-widest2/-widest3 rules, each sized for one more column
	 *  than the last). Clamped via Math.min, NOT `array[n] || fallback` — the n===0 entry is the
	 *  empty string '', which is falsy, so an `||` fallback would wrongly replace the correct
	 *  "no extra columns" case with the widest tier instead of leaving it alone (confirmed live:
	 *  every tooltip with zero conditional columns — most of them, any species without a real
	 *  Mega Stone or popular Scarf/Iron Ball usage — rendered stretched to the widest tier with
	 *  nothing on the right side to fill it). */
	const SPEED_CMP_WIDTH_TIER_CLASSES = [
		'', ' cf-speedcmp-tooltip-wide', ' cf-speedcmp-tooltip-widest', ' cf-speedcmp-tooltip-widest2', ' cf-speedcmp-tooltip-widest3',
	];
	function speedCmpTooltipWidthClass(extraCols) {
		return SPEED_CMP_WIDTH_TIER_CLASSES[Math.min(extraCols, SPEED_CMP_WIDTH_TIER_CLASSES.length - 1)];
	}

	/** Test-only export hook. In the real extension there's no bundler/CommonJS, so `module`
	 *  is undefined and this branch never runs — a no-op in production, same as every other
	 *  content script here. Under Node/Vitest (see test/content.test.js), requiring this file
	 *  hits this branch and returns before any of the DOM-patching/Showdown-global wiring
	 *  below runs, none of which means anything outside a live Showdown page anyway. Every
	 *  exported name here is either a hoisted `function` declaration (safe to reference from
	 *  any point in this scope) or a `const` already initialized by the time execution reaches
	 *  this line — this guard has to sit *after* those consts (STAT_LABEL_BY_ID/SPEED_ITEM_
	 *  MULTIPLIERS/etc, above), not before, since an unevaluated `const` stays in the temporal
	 *  dead zone forever once a `return` skips its declaration. */
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = {
			escapeHTML, toIDSafe, curSetHasMove, curSetMovesFull, baseSpeciesID,
			curTeamHasSpecies, curTeamFull, isBlankSlot, isTeamOverview, parseEVs, natureModifierHTML, speedNatureIndicator,
			formatSpeedEvText, speedStageMultiplier, applySpeedModifiers, speedCmpTooltipWidthClass,
			normalizeMoveRowId, cycleSpeedOp, speedFilterActive, passesSpeedFilter, rawPrefixLengthForIdLength,
			teamDamagingMoveTypes, typeEffectivenessMultiplier, bestTeamCoverageMultiplier, coverageTierClass,
			topSpeedItemBadge, aggregateTopTeams, curRosterSpeciesOrder, alignSimilarTeamPokemon, ordinalLabel,
			STAT_LABEL_BY_ID, STAT_IDS, STAT_LABELS,
			CATEGORY_ORDER, DYNAMIC_CATEGORIES,
			pikaSectionHTML, pikaRowAttrs, pikaRowDivHTML, iconOrSpacer,
			buildMovesSection, buildAbilitiesSection, buildNaturesSection, buildItemsSection,
			buildSpreadsSection, buildTeammatesSection,
			computeSpeedSpectrumEntries, computeSpeedSpectrumDomain, resolveSpeedSpectrumSpecies,
			assignSpeedSpectrumLanes, buildSpeedSpectrumHTML,
			ALL_TYPES, DEFENSIVE_ABILITY_IMMUNITIES, applyDefensiveAbility, resolveMemberAbility,
			computeTeamDefensiveProfile, defensiveTierClass, defensiveCellText, buildTeamDefensiveProfileHTML,
			aggregateTeamThreats, isDamagingMove, movePower, stabAdjustedPower, effectiveMoveType,
			computeThreatMoveReasons, computeThreatSpeedReason,
			threatHasMoveOfCategory,
			computeThreatReasons,
			enrichTeamThreat, buildTeamThreatSquareHTML, buildTeamThreatsSectionHTML,
			buildTeamThreatReasonCellHTML, buildTeamThreatTooltipHTML,
			buildSimilarTeamRowHTML, buildSimilarTeamsSectionHTML, buildSimilarTeamTooltipHTML,
			buildSpeciesPreviewTooltipHTML, patchDexSearch,
		};
		return;
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

	/** Fills the currently-open blank slot (the "Popular" column, see isBlankSlot) with the
	 *  clicked species — unlike applyTeammate above, this completes the slot already open rather
	 *  than adding a new one, since that's the slot being looked at when this list is even
	 *  showing. Goes through Showdown's own setPokemon() (confirmed live: the exact entry point
	 *  the native species search box itself calls) rather than a plain `set.species = ...`
	 *  write, so it picks up the same defaults a real pick would — format-appropriate level,
	 *  default gender/ability, a required item if the species has exactly one — instead of
	 *  leaving the set half-filled. setPokemon() already calls updateSetTop() itself; save() is
	 *  the one thing it doesn't do on its own, matching every other click-to-apply handler here.
	 *  Guarded to only ever act on a genuinely still-blank slot, since a stale render (e.g. a
	 *  double-click) could otherwise re-fire after the first click already filled it. */
	function applySpeciesToBlankSlot(tbRoom, speciesName) {
		const set = tbRoom.curSet;
		if (!set || set.species || typeof tbRoom.setPokemon !== 'function') return;
		tbRoom.setPokemon(speciesName);
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

	/** Handles both real click-to-apply rows (data-cf-pika-action, the switch below) and the
	 *  Defensive Profile toggle (data-cf-defmatrix-member-idx) — checked first and returned from
	 *  early, deliberately ahead of the `!tbRoom.curSet` guard the pika-action branch needs:
	 *  that guard requires a real slot being edited, which is never true on the team-overview
	 *  screen the matrix only ever renders on, so folding the toggle into the switch below
	 *  (behind that same guard) would make it permanently unreachable. One shared listener
	 *  rather than two separate document.addEventListener('click', …) registrations for the same
	 *  event type — CF.toggleDefMatrixMember itself lives in patchTeambuilderSidebar's own
	 *  closure (defMatrixBaseFormeSlots' own doc comment), reached here the same cross-scope-
	 *  handoff way CF.getSimilarTeamMatch/CF.getTeamThreat already are elsewhere in this file. */
	function onPikaSidebarClick(ev) {
		const defMatrixCell = ev.target.closest('[data-cf-defmatrix-member-idx]');
		if (defMatrixCell) {
			const idx = parseInt(defMatrixCell.getAttribute('data-cf-defmatrix-member-idx'), 10);
			if (!Number.isNaN(idx) && CF.toggleDefMatrixMember) CF.toggleDefMatrixMember(idx);
			return;
		}
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
			case 'addspecies': applySpeciesToBlankSlot(tbRoom, value); break;
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
	/** matchLength (see injectTypedFilterSuggestions below) is measured in toID'd characters —
	 *  the query has already had spaces/punctuation stripped — but renderRow bolds a substring
	 *  of the real, un-stripped label via plain `label.substr(matchStart, matchLength)`. For a
	 *  multi-word/punctuated label ("Hazard Removal", "Ball/Bomb") those two lengths diverge:
	 *  using the toID length directly as a raw-string offset bolds the wrong characters the
	 *  moment the match reaches past a stripped space/slash. This walks the raw label counting
	 *  only the characters that survive toID (letters/digits — matching toID's own
	 *  `[^a-z0-9]` strip), and returns the raw-string length needed to consume `idLength` of
	 *  them, so the returned offset always lines up with the real label's characters. */
	function rawPrefixLengthForIdLength(label, idLength) {
		if (!idLength) return 0;
		let idCount = 0;
		for (let i = 0; i < label.length; i++) {
			if (/[a-zA-Z0-9]/.test(label[i])) {
				idCount++;
				if (idCount === idLength) return i + 1;
			}
		}
		return label.length;
	}

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
				// renderRow below) — always a prefix match at position 0, but matchLength
				// has to be translated from toID'd-character count to a real raw-string
				// offset (see rawPrefixLengthForIdLength) since several labels below
				// contain spaces/punctuation that toID strips out.
				suggestions.push(['customfilter', catId, 0, rawPrefixLengthForIdLength(cat.label, q.length)]);
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
				// The real find() short-circuits as a no-op (returns false, leaves
				// this.results untouched) when the query hasn't changed and results are
				// already populated — from an earlier call this same wrapper already
				// post-processed. Skipping the block below on that branch matters: both
				// applyCustomFilters and injectTypedFilterSuggestions mutate
				// this.results by appending to it, so re-running them against an
				// already-post-processed array would inject a second cf-speedrow/
				// "Custom Filters" header on top of the one already there. A real
				// native path hits exactly this — content.js's own removeFilter patch
				// (below) calls find('') itself when popping the last custom filter,
				// and the native chartKeydown handler that invoked removeFilter() then
				// calls find('') again with the same now-unchanged query.
				if (changed) {
					applyCustomFilters(this);
					injectTypedFilterSuggestions(this, this.query);
				}
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
		if (speedRow) {
			// On a blank slot ("Popular" mode) this row has no real ally to compare Speed
			// against, so a species preview (its own moves/item/ability/spread) is shown
			// instead — CF.buildAddPokemonPreviewTooltipHTML itself returns null outside that
			// state, falling through to the ordinary Speed comparison popup unchanged.
			if (CF.buildAddPokemonPreviewTooltipHTML) {
				const previewHtml = CF.buildAddPokemonPreviewTooltipHTML(speedRow);
				if (previewHtml) {
					Tooltip.show(speedRow, previewHtml);
					return;
				}
			}
			if (CF.buildSpeedComparisonTooltipHTML) {
				const html = CF.buildSpeedComparisonTooltipHTML(speedRow);
				if (html) Tooltip.show(speedRow, html);
			}
			return;
		}

		const similarTeamRow = ev.target.closest ? ev.target.closest('.cf-similarteam-row') : null;
		// buildSimilarTeamTooltipHTML is a plain top-level function (unlike
		// buildAddPokemonPreviewTooltipHTML/buildSpeedComparisonTooltipHTML above, it doesn't
		// close over any patchTeambuilderSidebar-local state) — called directly, same as
		// buildFilterMatchTooltipHTML near the top of this function. Only the *lookup* by row
		// index (CF.getSimilarTeamMatch) needs the CF cross-scope handoff, since
		// lastSimilarTeamsMatches itself lives inside that closure.
		if (similarTeamRow && CF.getSimilarTeamMatch) {
			const idx = parseInt(similarTeamRow.getAttribute('data-cf-similarteam-idx'), 10);
			const match = CF.getSimilarTeamMatch(idx);
			// Recomputed fresh here rather than reusing whatever renderSimilarTeamsPanel last
			// aligned against — cheap, and stays correct if the roster changed since that render
			// (e.g. a click-to-apply elsewhere) without needing its own cache invalidation.
			const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
			if (match && tbRoom) Tooltip.show(similarTeamRow, buildSimilarTeamTooltipHTML(match, curRosterSpeciesOrder(tbRoom)));
			return;
		}

		// Biggest Threats square (buildTeamThreatSquareHTML/renderTeamThreatsSection) — same
		// by-index lookup pattern as Similar Teams just above, but buildTeamThreatTooltipHTML
		// needs no extra live state (the threat's own reasons were already computed once, at
		// render time, by enrichTeamThreat) so there's nothing to recompute fresh here.
		const teamThreatSquare = ev.target.closest ? ev.target.closest('.cf-teamthreats-square') : null;
		if (teamThreatSquare && CF.getTeamThreat) {
			const idx = parseInt(teamThreatSquare.getAttribute('data-cf-teamthreats-idx'), 10);
			const threat = CF.getTeamThreat(idx);
			if (threat) Tooltip.show(teamThreatSquare, buildTeamThreatTooltipHTML(threat));
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
			return;
		}

		const similarTeamRow = ev.target.closest ? ev.target.closest('.cf-similarteam-row') : null;
		if (similarTeamRow) {
			if (ev.relatedTarget && similarTeamRow.contains(ev.relatedTarget)) return;
			Tooltip.hide();
			return;
		}

		const teamThreatSquare = ev.target.closest ? ev.target.closest('.cf-teamthreats-square') : null;
		if (teamThreatSquare) {
			if (ev.relatedTarget && teamThreatSquare.contains(ev.relatedTarget)) return;
			Tooltip.hide();
		}
	}

	/** Pagination on scroll for the Similar Teams section (see loadMoreSimilarTeams, defined
	 *  inside patchTeambuilderSidebar and bridged out via CF the same way
	 *  buildSpeedComparisonTooltipHTML is). 'scroll' doesn't bubble, so this has to be a
	 *  capture-phase document listener (registered at the bottom of this file, alongside every
	 *  other document-level listener) rather than something attached directly to
	 *  `.cf-pika-rows` itself, which also wouldn't survive that element being replaced whenever
	 *  the panel re-renders. `ev.target` is already the scrolling element itself for a real
	 *  scroll event (not a descendant needing `.closest()` upward) — the `.closest('#cf-pika-panel')`
	 *  check only exists to rule out the *other* five-or-so `.cf-pika-rows` boxes elsewhere in
	 *  the sidebar (the six-section per-species grid, the Popular column) sharing the same
	 *  class name. */
	function onSimilarTeamsScroll(ev) {
		const el = ev.target;
		if (!el || !el.classList || !el.classList.contains('cf-pika-rows')) return;
		if (!el.closest || !el.closest('#cf-pika-panel')) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight > SIMILAR_TEAMS_SCROLL_THRESHOLD_PX) return;

		const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
		if (!tbRoom || !isBlankSlot(tbRoom)) return;
		const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
		if (!formatId || !CF.loadMoreSimilarTeams) return;
		CF.loadMoreSimilarTeams(tbRoom, formatId);
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
			// If the user already clicked/tabbed elsewhere before this fired, refreshSearch's
			// rebuild must not steal focus back to the (now-recreated) speed input out from
			// under whatever they're doing now — only restore focus/cursor when this box was
			// still the thing focused the instant the debounce actually ran.
			const hadFocus = document.activeElement === input;
			refreshSearch();
			if (!hadFocus) return;
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
	 *  "closeSideRoomsOnLoad" option (see settings-bridge.js/popup.html) — on by default,
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
	 *  currently docked, AND a specific team is currently open (room.curTeam set — same state
	 *  the room's own template checks to decide whether to render a team's contents at all, i.e.
	 *  either the `.teamchartbox.individual` single-slot editor or the team-overview roster list,
	 *  vs. the outer "all your teams" list screen where room.curTeam is null and there's nothing
	 *  useful to split against; see isTeamOverview for the further curSet split between those
	 *  first two). Checked directly rather than inferred from #room-teambuilder's own rendered
	 *  width (which the CSS override would make circular: forcing the room to 50% would make it
	 *  immediately measure as "too narrow," undoing the very state that set it, flip-flopping
	 *  every frame). Re-evaluated on window resize, and by wrapping seven TeambuilderRoom-family
	 *  methods (via wrapWithSplitUpdate below) in two groups:
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
	 *  TeambuilderRoom.prototype.natureChange (the nature <select>) AND
	 *  TeambuilderRoom.prototype.updateNature (confirmed live against Showdown's own source: the
	 *  EV box's own "252+"/"252-" nature-shortcut syntax — typing a leading/trailing +/- into an
	 *  EV number field — is handled entirely inside statChange, which sets curSet.nature via a
	 *  *direct* call to this.updateNature() rather than going through natureChange() at all; the
	 *  Natures section's equipped-highlight (buildNaturesSection, keyed on curSet.nature) would
	 *  otherwise desync from a real, commonly-used nature-setting path that has nothing to do
	 *  with the nature <select>). Deliberately NOT statChange/statSlide themselves (the EV number
	 *  box and slider): none of the sidebar's own clickable/disabled/equipped checks read
	 *  curSet.evs at all (Spreads never gets an equipped highlight — see buildSpreadsSection's
	 *  own comment), so there is nothing in the sidebar for a plain EV value edit to desync;
	 *  hooking either of those wholesale would rebuild the full 6-section sidebar on every
	 *  keystroke (statChange is bound to both keyup and input) and every drag frame (statSlide
	 *  is bound to the slider's own input event, which fires continuously) for zero visible
	 *  benefit — pure, avoidable jank. updateNature itself doesn't have this problem: inside
	 *  statChange it's only reached when the +/- suffix actually toggles (a deliberate, rare
	 *  edit), not on every keystroke of a plain numeric EV value.
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

	/** Shared by every Moves/Abilities/Items/Teammates/Natures row below — the outer
	 *  `<div class="cf-pika-row...">` markup (icon cell, then a `.cf-pika-name` cell, then a
	 *  `.cf-pika-pct` cell) is byte-identical across all five sections; only what goes inside
	 *  those three cells differs per section, so that's what each section still builds itself. */
	function pikaRowDivHTML(cls, attrs, iconHTML, nameHTML, pctHTML) {
		return `<div class="${cls}"${attrs}>${iconHTML}` +
			`<span class="cf-pika-name">${nameHTML}</span>` +
			`<span class="cf-pika-pct">${pctHTML}</span></div>`;
	}

	/** Moves/Items both fall back to the same blank `.cf-pika-icon-spacer` placeholder when
	 *  there's no real icon to show, so every row's name column still lines up regardless. */
	function iconOrSpacer(iconHTML) {
		return iconHTML || '<span class="cf-pika-icon-spacer"></span>';
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
			const icon = iconOrSpacer(m.type ? window.Dex.getTypeIcon(m.type) : '');
			const equipped = curSetHasMove(set, m.move);
			const { cls, attrs } = pikaRowAttrs('move', m.move, equipped, !equipped && full);
			return pikaRowDivHTML(cls, attrs, icon, escapeHTML(m.move), `${escapeHTML(m.percent)}%`);
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
			return pikaRowDivHTML(cls, attrs, '', escapeHTML(a.ability), `${escapeHTML(a.percent)}%`);
		}).join('');
		return pikaSectionHTML('Common Abilities', rows);
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
			const nameHTML = `<span class="cf-pika-nature-name">${escapeHTML(n.nature)}</span>${natureModifierHTML(n.nature)}`;
			return pikaRowDivHTML(cls, attrs, '', nameHTML, `${escapeHTML(String(pct))}%`);
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
			const icon = iconOrSpacer(iconStyle ? `<span class="itemicon" style="${escapeHTML(iconStyle)}"></span>` : '');
			const equipped = !!(set && set.item && toIDSafe(set.item) === toIDSafe(it.item));
			const { cls, attrs } = pikaRowAttrs('item', it.item, equipped, false);
			return pikaRowDivHTML(cls, attrs, icon, escapeHTML(it.item), `${escapeHTML(it.percent)}%`);
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
		// Same base-species-ID comparison curTeamHasSpecies does per call, just computed once
		// for the whole team up front instead of re-walking curSetList (and re-resolving each
		// member's Mega/Primal base species) for every one of the up-to-20 rows below.
		const teamSpeciesIds = new Set(
			(tbRoom.curSetList || []).filter((s) => s.species).map((s) => baseSpeciesID(s.species))
		);
		const rows = team.map((t, i) => {
			const icon = `<span class="picon" style="${escapeHTML(window.Dex ? window.Dex.getPokemonIcon(t.pokemon) : '')}"></span>`;
			let pct;
			if (t.percent !== undefined && t.percent !== null) pct = `${escapeHTML(String(t.percent))}%`;
			else if (t.rank !== undefined && t.rank !== null) pct = `#${escapeHTML(String(t.rank))}`;
			else pct = `#${i + 1}`;
			const equipped = teamSpeciesIds.has(baseSpeciesID(t.pokemon));
			const { cls, attrs } = pikaRowAttrs('teammate', t.pokemon, equipped, equipped || full);
			return pikaRowDivHTML(cls, attrs, icon, escapeHTML(t.pokemon), pct);
		}).join('');
		return pikaSectionHTML('Common Teammates', rows);
	}

	/** Resolves a real set to its Mega forme when its own held item is a matching Mega Stone —
	 *  Mega Evolution changes the base Speed stat, so a Mega-Stone holder's real Speed (for both
	 *  the plotted dot and the domain's own floor/ceiling) has to come from the Mega forme's base
	 *  stat, not the base forme's, the same substitution buildSpeedComparisonTooltipHTML's own
	 *  Mega columns already make (see that function's own megaOptions comment). Covers both real
	 *  ways to build a Mega on this file's own account (topSpeedItemBadge's own comment): built
	 *  manually (base species, Mega Stone set as a separate item — window.Dex.items.get(item)
	 *  .megaStone, keyed by the *base* species name, matches) or picked directly from the
	 *  species-search "-Mega" entry (set.species already says so, confirmed via species.battleOnly
	 *  — the megaStone lookup alone can't catch this case, since that map is keyed by the base
	 *  species name, not the Mega forme's own). Returns `{species, isMega}` rather than just the
	 *  name — callers need to know *whether* a substitution happened, not just its result (see
	 *  computeSpeedSpectrumDomain's own Mega-vs-Scarf comparison, and computeTeamDefensiveProfile's
	 *  own canToggle, which needs isMega true for a directly-picked Mega just as much as for one
	 *  built via a separate Mega Stone item). */
	function resolveSpeedSpectrumSpecies(set) {
		if (window.Dex && set.item) {
			const itemData = window.Dex.items.get(set.item);
			const forme = itemData && itemData.megaStone && itemData.megaStone[set.species];
			if (forme) return { species: forme, isMega: true };
		}
		if (window.Dex) {
			const species = window.Dex.species.get(set.species);
			if (species && species.exists && species.battleOnly) return { species: set.species, isMega: true };
		}
		return { species: set.species, isMega: false };
	}

	/** Team-overview screen only (see isTeamOverview/renderTeamOverviewPanel) — real per-member
	 *  data collection, kept separate from buildSpeedSpectrumHTML below so the actual layout math
	 *  stays pure and unit-testable without a live tbRoom. tbRoom.getStat('spe', set) is the same
	 *  method every other Speed number in this file already goes through (README: "Speed math...
	 *  always goes through TeambuilderRoom.prototype.getStat") for the base stat, with
	 *  resolveSpeedSpectrumSpecies' Mega substitution applied first where it applies — but unlike
	 *  buildSpeedComparisonTooltipHTML's base Foe column (which deliberately never applies an
	 *  item, since Pikalytics' "most common item" is a population statistic, not a fact about a
	 *  specific build), this set's own held item IS a fact about this specific, real build, so
	 *  applySpeedModifiers runs it through the same Choice Scarf/Iron Ball multiplier every other
	 *  Speed number in this file applies — without this, equipping a Scarf never moved the dot at
	 *  all, since the raw stat it's built from doesn't include the item. `hasScarf`/`hasIronBall`
	 *  feed the small item badge buildSpeedSpectrumHTML/speedSpectrumIconHTML renders on the
	 *  icon itself — mutually exclusive in practice (a real set can only hold one item), but
	 *  tracked as two independent booleans rather than one "which item" field, matching the
	 *  same shape buildSpeedComparisonTooltipHTML's own allyHasScarf/allyHasIronBall use.
	 *  `name` falls back to the resolved species (Mega forme included) for the hover title when
	 *  the set has no nickname. */
	function computeSpeedSpectrumEntries(tbRoom) {
		return (tbRoom.curSetList || []).filter((s) => s && s.species).map((set) => {
			const { species, isMega } = resolveSpeedSpectrumSpecies(set);
			const statSet = isMega ? Object.assign({}, set, { species }) : set;
			const rawSpeed = tbRoom.getStat('spe', statSet);
			const itemId = toIDSafe(set.item);
			return {
				species,
				name: set.name || species,
				speed: applySpeedModifiers(rawSpeed, set.item, {}),
				hasScarf: itemId === 'choicescarf',
				hasIronBall: itemId === 'ironball',
			};
		});
	}

	/** Adjusts a raw typeEffectivenessMultiplier result for one real, defensively-relevant
	 *  ability. Two real mechanics modeled: DEFENSIVE_ABILITY_IMMUNITIES' flat type immunities
	 *  (own doc comment), and Wonder Guard specifically — the one ability that changes the rule
	 *  itself rather than blocking one type: every attacking type that wouldn't already be
	 *  super effective (rawMult < 2) deals 0 damage, not just one named type. Both checked by
	 *  ability ID (toIDSafe) against the set's own real chosen ability, not a guess — an empty/
	 *  unrecognized ability just returns `rawMult` unchanged. */
	function applyDefensiveAbility(rawMult, attackType, ability) {
		const abilityId = toIDSafe(ability);
		if (abilityId === 'wonderguard') return rawMult >= 2 ? rawMult : 0;
		const immuneType = DEFENSIVE_ABILITY_IMMUNITIES[abilityId];
		if (immuneType && toIDSafe(immuneType) === toIDSafe(attackType)) return 0;
		return rawMult;
	}

	/** The real ability a member's own Mega Evolution overrides its base forme's chosen ability
	 *  with — e.g. Mega Blastoise is always Mega Launcher regardless of whether the base
	 *  Blastoise build actually picked Torrent or Rain Dish; Mega Gyarados is always Mold
	 *  Breaker regardless of Intimidate/Moxie. Confirmed against Pokémon Showdown's own real
	 *  species data (data/pokedex.ts, checked directly, not assumed): every real Mega forme's
	 *  own `abilities` entry has exactly one slot, `0` — no alternate/hidden slot to choose
	 *  between the way a base forme can have — so that slot alone is always the complete,
	 *  correct answer for a Mega, never just one candidate among several. Returns the set's own
	 *  plain chosen ability unchanged when `isMega` is false (a real, ordinary set — nothing to
	 *  override), or as a defensive fallback if window.Dex or the Mega's own species entry is
	 *  somehow unavailable. */
	function resolveMemberAbility(set, resolvedSpecies, isMega) {
		if (!isMega) return set.ability;
		const speciesData = window.Dex && window.Dex.species.get(resolvedSpecies);
		const megaAbility = speciesData && speciesData.exists && speciesData.abilities && speciesData.abilities['0'];
		return megaAbility || set.ability;
	}

	/** Team-overview screen's Defensive Profile section (renderTeamOverviewPanel,
	 *  buildTeamDefensiveProfileHTML) — for every real roster member (Mega-resolved by default,
	 *  same as computeSpeedSpectrumEntries, unless toggled back to its base forme — see below)
	 *  and every real attacking type, the real type-chart multiplier that type lands against that
	 *  member's own defensive typing, via the exact same typeEffectivenessMultiplier every other
	 *  type-chart check in this file already uses, then adjusted for the member's own real
	 *  ability (applyDefensiveAbility) — a Water Absorb holder reads as genuinely immune to Water
	 *  here, not just resistant/neutral by typing alone. That ability is the set's own chosen one
	 *  for an ordinary member, but a real Mega Evolution's own fixed ability
	 *  (resolveMemberAbility) for one actually displaying as its Mega forme — the same
	 *  Mega-Stone-holder resolution (resolveSpeedSpectrumSpecies) that already swaps in the Mega
	 *  forme's own types/stats elsewhere in this file has to swap in its own fixed ability too,
	 *  or a Mega Blastoise built by holding Blastoisinite on a Torrent/Rain-Dish set would
	 *  wrongly check Torrent/Rain Dish here instead of the Mega's own real Mega Launcher.
	 *  Entirely synchronous — no Pikalytics fetch, no loading state needed, same as
	 *  computeSpeedSpectrumEntries. Rows for a type every member takes exactly 1x from (nothing
	 *  to call out) are left out of `rows` entirely — buildTeamDefensiveProfileHTML's own job,
	 *  not this function's, since "which rows are interesting" is a rendering decision about
	 *  this same data, not a different computation.
	 *
	 *  `baseFormeSlots` (a Set of 0-based indices into the *filtered* real-species roster, same
	 *  indexing buildTeamDefensiveProfileHTML's own data-cf-defmatrix-member-idx uses) is the
	 *  UI's own per-slot toggle state (renderDefensiveProfileSection/onDefMatrixClick) for
	 *  clicking a Mega member's sprite back to its base forme — a Pokémon actually IS still its
	 *  base forme until it Mega Evolves mid-battle, so seeing both matchup profiles matters, not
	 *  just the post-Mega one. Only ever affects a slot that's genuinely Mega-capable in the
	 *  first place (`isMega` true) — real base-forme members build their own type/stat/ability
	 *  data the exact same way whether or not their (irrelevant) index happens to be in the set,
	 *  so a stale index left over from a since-changed roster slot is a harmless no-op, not
	 *  something this function needs to detect and clear itself. */
	function computeTeamDefensiveProfile(tbRoom, baseFormeSlots) {
		const sets = (tbRoom.curSetList || []).filter((s) => s && s.species);
		const naturalResolved = sets.map((set) => resolveSpeedSpectrumSpecies(set));
		const members = naturalResolved.map((r, i) => {
			const showBase = r.isMega && baseFormeSlots && baseFormeSlots.has(i);
			// NOT sets[i].species — that's only the real base forme name when the Mega was built
			// as base species + a separate held Mega Stone item. Picked directly from search, the
			// set's own species field already IS the Mega forme name (there's no separate base
			// name stored anywhere on the set), so that fallback would toggle between the exact
			// same string both ways — the actual live bug this replacement fixes: clicking a
			// directly-picked Mega's header never changed its sprite/typing/ability at all.
			// window.Dex's own `.baseSpecies` field (present on every real Mega forme entry) is the
			// one source that's correct either way a Mega was built.
			let species = r.species;
			if (showBase) {
				const megaSpeciesData = window.Dex && window.Dex.species.get(r.species);
				species = (megaSpeciesData && megaSpeciesData.exists && megaSpeciesData.baseSpecies) || sets[i].species;
			}
			return { species, name: sets[i].name || species, canToggle: r.isMega, displayAsMega: r.isMega && !showBase };
		});
		const memberTypes = members.map((m) => {
			const resolved = window.Dex && window.Dex.species.get(m.species);
			return (resolved && resolved.exists && resolved.types) || [];
		});
		const memberAbilities = members.map((m, i) => resolveMemberAbility(sets[i], m.species, m.displayAsMega));
		const rows = ALL_TYPES.map((type) => ({
			type,
			multipliers: memberTypes.map((types, i) =>
				applyDefensiveAbility(typeEffectivenessMultiplier(type, types), type, memberAbilities[i])),
		})).filter((row) => row.multipliers.some((m) => m !== 1));
		return { members, rows };
	}

	/** Discrete type-chart products only ever land on {0, .25, .5, 1, 2, 4} for a real dual-type
	 *  defender (same reasoning as coverageTierClass's own doc comment) — but unlike that
	 *  function (which only ever sees the *best* of several attacking move types, so a .25 result
	 *  is rare enough it was never worth its own tier), every one of those six values is a real,
	 *  common outcome here: this walks every type against every member directly, and a
	 *  double-resist (.25x, two resisted types stacking) is an entirely ordinary, frequent result
	 *  — worth its own distinct color from a single resist, not folded into
	 *  coverageTierClass's own "resist" catch-all (which would otherwise misclassify it as
	 *  immune, since coverageTierClass's last branch assumes anything below .5 must be 0). */
	function defensiveTierClass(mult) {
		if (mult >= 4) return 'cf-defmatrix-quadweak';
		if (mult >= 2) return 'cf-defmatrix-weak';
		if (mult >= 1) return '';
		if (mult >= 0.5) return 'cf-defmatrix-resist';
		if (mult > 0) return 'cf-defmatrix-quadresist';
		return 'cf-defmatrix-immune';
	}

	/** Plain text for one defensive matrix cell — '0' for immune (not '0×', shorter reads better
	 *  in a narrow cell) and a fraction glyph for a sub-1 multiplier (¼/½) rather than '0.25×'/
	 *  '0.5×', matching how Showdown's own UI and the wider competitive community write these
	 *  numbers, not a decimal a player would have to stop and parse. */
	function defensiveCellText(mult) {
		if (mult === 0) return '0';
		if (mult === 0.25) return '¼×';
		if (mult === 0.5) return '½×';
		return `${mult}×`;
	}

	/** The spectrum's axis bounds — the real fastest and slowest things in the *format itself*,
	 *  not anything derived from the current roster at all. Hardcoded, not computed live: this
	 *  was researched by hand against Showdown's own Champions-format species/tier data
	 *  (BattleTeambuilderTable.champions — confirmed against the live client, not Smogon) and
	 *  confirmed by hand for both Reg A and Reg B specifically, which turn out to share an
	 *  identical roster of legal Pokémon (confirmed directly — not assumed). Showdown's client
	 *  has no reliable way to derive this live: BattleTeambuilderTable.champions is shared
	 *  across every Champions-branded format (singles ladder, VGC, National Dex alike) with no
	 *  per-regulation breakdown, and there's no TeamValidator loaded in the teambuilder page —
	 *  real format legality only gets checked server-side, via an actual round trip through the
	 *  teambuilder's own Validate button. A format is a fixed, known thing, not something to
	 *  re-derive on every render — this is a one-time fact, not a computation.
	 *
	 *  Ties (SPEED_SPECTRUM_FASTEST_MEGA/SPEED_SPECTRUM_SLOWEST_MEGA's own comments) are broken
	 *  by picking one representative species; the other tied species would plot at the exact
	 *  same number either way.
	 *
	 *  Mega Stone and any other held item (Iron Ball for the floor, Choice Scarf for the
	 *  ceiling) can never coexist on the same Pokémon — a Mega-Stone holder's item slot is
	 *  taken — so each bound is whichever of two fixed candidates is more extreme: the format's
	 *  fastest/slowest Mega actually Mega Evolving (no item possible), or the format's
	 *  fastest/slowest non-Mega holding the relevant item instead. Uses tbRoom.getStat (the same
	 *  method every other Speed number in this file goes through) against a minimal synthetic
	 *  set for each reference species — real EVs/IVs/nature aren't relevant here, only the species'
	 *  own base stat at the format-legal EV/nature extreme, via the same evOverride/natureOverride
	 *  params computeSpeedSpectrumEntries' own callers use elsewhere. */
	// SPEED_SPECTRUM_FASTEST_NON_MEGA/FASTEST_MEGA/SLOWEST_NON_MEGA/SLOWEST_MEGA are declared up
	// near STAT_LABEL_BY_ID, not here — see that declaration's own comment for why (the
	// module.exports TDZ guard below).
	function computeSpeedSpectrumDomain(tbRoom) {
		const referenceStat = (species, ev, natureMult) => tbRoom.getStat('spe', { species, level: 50 }, ev, natureMult);

		const scarfedCeiling = applySpeedModifiers(
			referenceStat(SPEED_SPECTRUM_FASTEST_NON_MEGA, SPEED_SPECTRUM_MAX_EV, SPEED_SPECTRUM_POSITIVE_NATURE_MULT),
			'Choice Scarf', {}
		);
		const megaCeiling = referenceStat(SPEED_SPECTRUM_FASTEST_MEGA, SPEED_SPECTRUM_MAX_EV, SPEED_SPECTRUM_POSITIVE_NATURE_MULT);
		const ironBalledFloor = applySpeedModifiers(
			referenceStat(SPEED_SPECTRUM_SLOWEST_NON_MEGA, SPEED_SPECTRUM_MIN_EV, SPEED_SPECTRUM_NEGATIVE_NATURE_MULT),
			'Iron Ball', {}
		);
		const megaFloor = referenceStat(SPEED_SPECTRUM_SLOWEST_MEGA, SPEED_SPECTRUM_MIN_EV, SPEED_SPECTRUM_NEGATIVE_NATURE_MULT);

		const maxIsMega = megaCeiling >= scarfedCeiling;
		const minIsMega = megaFloor <= ironBalledFloor;

		return {
			min: minIsMega ? megaFloor : ironBalledFloor,
			minSpecies: minIsMega ? SPEED_SPECTRUM_SLOWEST_MEGA : SPEED_SPECTRUM_SLOWEST_NON_MEGA,
			minIsMega,
			max: maxIsMega ? megaCeiling : scarfedCeiling,
			maxSpecies: maxIsMega ? SPEED_SPECTRUM_FASTEST_MEGA : SPEED_SPECTRUM_FASTEST_NON_MEGA,
			maxIsMega,
		};
	}

	/** Greedy first-fit interval packing: sorted ascending by real position, each entry takes
	 *  the lowest-numbered lane whose most-recently-placed icon already sits at least
	 *  SPEED_SPECTRUM_MIN_GAP_PCT away, opening a new lane only once every existing one is still
	 *  too close. Returns a new array (does not mutate `entries`), each entry augmented with
	 *  `pos` (0-100, see posOf) and `lane` (0 = closest to the track). SPEED_SPECTRUM_MIN_GAP_PCT
	 *  is declared up near STAT_LABEL_BY_ID, not here — see that declaration's own comment for
	 *  why (the module.exports TDZ guard below). */
	function assignSpeedSpectrumLanes(entries, posOf) {
		const lastPosByLane = [];
		return entries.slice().sort((a, b) => a.speed - b.speed).map((e) => {
			const pos = posOf(e.speed);
			let lane = lastPosByLane.findIndex((lastPos) => pos - lastPos >= SPEED_SPECTRUM_MIN_GAP_PCT);
			if (lane === -1) {
				lane = lastPosByLane.length;
				lastPosByLane.push(-Infinity);
			}
			lastPosByLane[lane] = pos;
			return Object.assign({}, e, { pos, lane });
		});
	}

	/** SPEED_SPECTRUM_LANE_HEIGHT/SPEED_SPECTRUM_TRACK_GAP/SPEED_SPECTRUM_THRESHOLD_HEIGHT/
	 *  SPEED_SPECTRUM_LABEL_RESERVE are declared up near STAT_LABEL_BY_ID, not here — see that
	 *  declaration's own comment for why (the module.exports TDZ guard below). The Scarf badge
	 *  reuses .cf-speedcmp-sprite/.cf-speedcmp-item-badge verbatim — the same "small item icon
	 *  pinned to a sprite's bottom-right corner" markup/CSS the Speed comparison popup already
	 *  established, not a new bespoke badge for this one section. */
	function speedSpectrumIconHTML(e) {
		const icon = window.Dex ? window.Dex.getPokemonIcon(e.species) : '';
		let badge = '';
		if (window.Dex) {
			if (e.hasScarf) badge = `<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon('Choice Scarf'))}"></span>`;
			else if (e.hasIronBall) badge = `<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon('Iron Ball'))}"></span>`;
		}
		return `<div class="cf-speedspectrum-icon" style="left:${e.pos.toFixed(1)}%;top:${e.top}px" ` +
			`title="${escapeHTML(e.name)}: ${e.speed} Speed">` +
			`<span class="cf-speedcmp-sprite"><span class="picon" style="${escapeHTML(icon)}"></span>${badge}</span>` +
			`<span class="cf-speedspectrum-value">${e.speed}</span>` +
			`</div>`;
	}

	/** Real per-member Speed stats laid out on a low-to-high spectrum against `domain` (see
	 *  computeSpeedSpectrumDomain — the format-legal floor/ceiling for this roster, not padding
	 *  around their invested Speeds) — how bunched or spread the team's Speed tiers are within
	 *  that legal range reads at a glance from the icons' spacing alone. Lane assignment
	 *  (assignSpeedSpectrumLanes) keeps icons whose real Speed values land close together from
	 *  overlapping, opening as many lanes as the roster's own clustering actually needs rather
	 *  than a fixed guess — the container's own height follows from that same lane count,
	 *  computed per render rather than a fixed constant. */
	/** One threshold marker — the format's real fastest/slowest species (computeSpeedSpectrumDomain
	 *  — Mega forme included where that's the winner) plotted at the exact same `left:0%`/`100%`
	 *  coordinate space every roster icon uses (inside cf-speedspectrum-track-area, not the outer
	 *  margin), so a real roster Pokémon actually built to match the format's own ceiling/floor
	 *  visibly lines up with the marker instead of sitting in an entirely different coordinate
	 *  system. `posPercent` is always exactly 0 or 100 — the two ends of the domain, not
	 *  something posOf needs to compute, since a threshold marker's value *is* domainMin/domainMax
	 *  by definition. Reuses cf-speedspectrum-icon's own box/centering, just anchored below the
	 *  track (icons stack upward from it) and in reverse content order — value first, sprite
	 *  second — so the number still ends up the element closest to the track either way (see
	 *  cf-speedspectrum-icon's own CSS comment for why content order flips depending on which
	 *  side of the track a box sits on). A non-Mega winner gets the item badge that got it there
	 *  (`badgeItemName` — Iron Ball for the floor, Scarf for the ceiling); a Mega winner gets no
	 *  badge at all — holding the Mega Stone is already implicit in Mega Evolving. */
	function speedSpectrumThresholdHTML(value, species, isMega, badgeItemName, posPercent, top) {
		const icon = window.Dex ? window.Dex.getPokemonIcon(species) : '';
		const badge = (!isMega && window.Dex) ?
			`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon(badgeItemName))}"></span>` : '';
		return `<div class="cf-speedspectrum-icon cf-speedspectrum-threshold" style="left:${posPercent}%;top:${top}px" ` +
			`title="Format ${posPercent === 0 ? 'floor' : 'ceiling'}: ${escapeHTML(species)}, ${value} Speed">` +
			`<span class="cf-speedspectrum-value">${value}</span>` +
			`<span class="cf-speedcmp-sprite"><span class="picon" style="${escapeHTML(icon)}"></span>${badge}</span>` +
			`</div>`;
	}

	function buildSpeedSpectrumHTML(entries, domain) {
		if (!entries.length) {
			return pikaSectionHTML('Speed Spread', '<p class="cf-pika-empty">No Pokémon on your team yet.</p>');
		}
		const domainMin = Math.max(0, domain.min);
		const domainMax = domain.max;
		const span = domainMax - domainMin || 1;
		// Clamped to [0, 100] as cheap defensive insurance, not to paper over a known gap —
		// computeSpeedSpectrumDomain's own floor/ceiling both already account for Iron Ball/
		// Scarf, so every real entry is guaranteed inside [domainMin, domainMax] by construction
		// (see that function's own comment). This just keeps a genuinely out-of-range point
		// (e.g. a future modifier this file doesn't know about yet, or float rounding at the
		// exact boundary) visibly pinned at the track's edge instead of rendering off it.
		const posOf = (speed) => Math.min(100, Math.max(0, ((speed - domainMin) / span) * 100));

		const positioned = assignSpeedSpectrumLanes(entries, posOf);
		const laneCount = Math.max(1, positioned.reduce((max, e) => Math.max(max, e.lane + 1), 0));
		const blockHeight = laneCount * SPEED_SPECTRUM_LANE_HEIGHT;
		const trackY = blockHeight + SPEED_SPECTRUM_TRACK_GAP;
		const thresholdTop = trackY + SPEED_SPECTRUM_TRACK_GAP;
		const containerHeight = thresholdTop + SPEED_SPECTRUM_THRESHOLD_HEIGHT;

		const icons = positioned.map((e) => speedSpectrumIconHTML(
			Object.assign({}, e, { top: blockHeight - (e.lane + 1) * SPEED_SPECTRUM_LANE_HEIGHT })
		)).join('');

		// Threshold markers (speedSpectrumThresholdHTML) are children of the SAME
		// cf-speedspectrum-track-area the roster icons are, at left:0%/100% — the two domain
		// endpoints by definition — so a real roster Pokémon built to actually match the
		// format's own ceiling/floor lines up with the marker exactly, both sharing one
		// coordinate space instead of the marker floating in a separate outer margin.
		const thresholds =
			speedSpectrumThresholdHTML(Math.round(domainMin), domain.minSpecies, domain.minIsMega, 'Iron Ball', 0, thresholdTop) +
			speedSpectrumThresholdHTML(Math.round(domainMax), domain.maxSpecies, domain.maxIsMega, 'Choice Scarf', 100, thresholdTop);

		const spectrum = `<div class="cf-speedspectrum" style="height:${containerHeight}px">` +
			`<div class="cf-speedspectrum-track-area" style="left:${SPEED_SPECTRUM_LABEL_RESERVE}px;right:${SPEED_SPECTRUM_LABEL_RESERVE}px">` +
				`<div class="cf-speedspectrum-track" style="top:${trackY}px"></div>` +
				icons +
				thresholds +
			`</div>` +
			`</div>`;
		return pikaSectionHTML('Speed Spread', spectrum);
	}

	/** Team-overview screen's Defensive Profile section — computeTeamDefensiveProfile's output as
	 *  a real matrix table: one column per roster member (sprite only, header row — same "icon
	 *  reads faster than a name at a glance" reasoning as the Biggest Threats squares), one row
	 *  per attacking type that isn't neutral against every single member (computeTeamDefensiveProfile
	 *  already filtered those out), each cell colored and labeled by defensiveTierClass/
	 *  defensiveCellText. A genuinely neutral cell (1x) renders as an empty, uncolored cell rather
	 *  than "1×" — in a row that already means "at least one member deviates from neutral here,"
	 *  the *exceptions* are what's worth reading; spelling out "1×" next to them for every member
	 *  who's simply unremarkable against this type would just be visual noise repeated up to six
	 *  times per row.
	 *
	 *  A Mega-capable member's own header cell (`m.canToggle`) gets `data-cf-defmatrix-member-idx`
	 *  and a clickable class — onDefMatrixClick reads that index back to toggle
	 *  renderDefensiveProfileSection's own baseFormeSlots and re-render, flipping that one
	 *  column between its Mega forme (the default — computeTeamDefensiveProfile's own
	 *  `displayAsMega`) and its real base forme, sprite/typing/ability and all. Marked with a
	 *  small persistent corner badge on the sprite itself (cf-defmatrix-toggle-badge) rather than
	 *  a hover-only treatment or a native `title` tooltip — a hover/tooltip-only affordance is
	 *  invisible until the user happens to mouse over a specific sprite among six, so nothing
	 *  actually signals *which* members are Mega-capable at a glance. An ordinary member gets no
	 *  badge at all — nothing to toggle, so no affordance implying otherwise. */
	function buildTeamDefensiveProfileHTML(profile) {
		if (!profile.members.length) {
			return pikaSectionHTML('Defensive Profile', '<p class="cf-pika-empty">No Pokémon on your team yet.</p>');
		}
		if (!profile.rows.length) {
			return pikaSectionHTML('Defensive Profile', '<p class="cf-pika-empty">No notable team-wide weaknesses or resistances.</p>');
		}
		const headerCells = profile.members.map((m, i) => {
			const icon = window.Dex ? window.Dex.getPokemonIcon(m.species) : '';
			const cls = m.canToggle ? ' cf-defmatrix-member-toggleable' : '';
			const attrs = m.canToggle ? ` data-cf-defmatrix-member-idx="${i}"` : '';
			const badge = m.canToggle ? '<span class="cf-defmatrix-toggle-badge">⇄</span>' : '';
			return `<th class="cf-defmatrix-member${cls}"${attrs}>` +
				`<span class="cf-defmatrix-sprite-wrap"><span class="picon" style="${escapeHTML(icon)}"></span>${badge}</span></th>`;
		}).join('');
		const bodyRows = profile.rows.map((row) => {
			const typeIcon = window.Dex ? window.Dex.getTypeIcon(row.type) : '';
			const cells = row.multipliers.map((mult) => {
				const cls = defensiveTierClass(mult);
				const text = mult === 1 ? '' : defensiveCellText(mult);
				return `<td class="cf-defmatrix-cell${cls ? ` ${cls}` : ''}">${text}</td>`;
			}).join('');
			return `<tr><th class="cf-defmatrix-type">${typeIcon}</th>${cells}</tr>`;
		}).join('');
		const table = `<table class="cf-defmatrix-table"><thead><tr><th></th>${headerCells}</tr></thead>` +
			`<tbody>${bodyRows}</tbody></table>`;
		return pikaSectionHTML('Defensive Profile', table);
	}

	/** One Biggest Threats square (buildTeamThreatsSectionHTML) — icon only, no name or count
	 *  visible by default (unlike every row-shaped Pikalytics section elsewhere in this file):
	 *  side-by-side icon squares read as a quick "here's who to watch out for" glance, the same
	 *  way the roster's own six icons on this exact screen already do, where a name/number per
	 *  entry would just be visual noise at this size. `idx` is this threat's position in
	 *  lastTeamThreats (see renderTeamThreatsSection) — not a stable id, just an index into
	 *  whatever's currently rendered, the same convention buildSimilarTeamRowHTML's own
	 *  data-cf-similarteam-idx already uses for the identical reason (both are rebuilt together
	 *  on every render). All the real detail — which of your team it threatens, and why — lives
	 *  in the hover tooltip (buildTeamThreatTooltipHTML) via the shared floating overlay, not a
	 *  plain `title` attribute: reasons run to multiple lines per member, more than a native
	 *  tooltip reads well. */
	function buildTeamThreatSquareHTML(threat, idx) {
		const icon = `<span class="picon" style="${escapeHTML(window.Dex ? window.Dex.getPokemonIcon(threat.pokemon) : '')}"></span>`;
		return `<div class="cf-teamthreats-square" data-cf-teamthreats-idx="${idx}">${icon}</div>`;
	}

	/** Biggest Threats section: aggregateTeamThreats' ranked output as a row of side-by-side
	 *  squares (buildTeamThreatSquareHTML) rather than the name/count rows every other
	 *  Pikalytics-derived section in this file uses — see that function's own comment for why.
	 *  Still capped at TEAM_THREATS_MAX_ROWS defensively, even though renderTeamThreatsSection
	 *  already only enriches (and so only ever passes in) that many — the single place that
	 *  actually decides "this many are shown," not duplicated logic. */
	function buildTeamThreatsSectionHTML(threats) {
		if (!threats.length) return pikaSectionHTML('Biggest Threats', '<p class="cf-pika-empty">No threat data for this format.</p>');
		const squares = threats.slice(0, TEAM_THREATS_MAX_ROWS)
			.map((t, i) => buildTeamThreatSquareHTML(t, i)).join('');
		return pikaSectionHTML('Biggest Threats', `<div class="cf-teamthreats-grid">${squares}</div>`);
	}

	/** One <td> for a single computeThreatReasons() entry, inside buildTeamThreatTooltipHTML's
	 *  table. A `move` reason gets its own three-part cell — the real type icon
	 *  (window.Dex.getTypeIcon, same call buildMovesSection already makes for the six-section
	 *  sidebar's own Moves list), the move's name, and its real usage percent (`.cf-pika-pct`,
	 *  reused verbatim rather than a new percent style) — so it reads the same way a move
	 *  already does everywhere else in this file, not a new "moves as prose" idiom. A `speed`
	 *  reason (computeThreatSpeedReason) gets the same move-shaped cell plus an "Outspeeds" label
	 *  up front, and — only when `viaScarf` is true, i.e. it doesn't outspeed on a bare stat
	 *  spread alone — a small muted "(needs Scarf)" note, so a Speed advantage that depends on a
	 *  build choice reads differently from one that's true regardless of item. A `stat` reason is
	 *  just its own plain text, no icon — there's nothing to show an icon of. */
	function buildTeamThreatReasonCellHTML(reason) {
		if (reason.kind === 'move' || reason.kind === 'speed') {
			const typeIcon = window.Dex ? window.Dex.getTypeIcon(reason.type) : '';
			const label = reason.kind === 'speed' ? '<span class="cf-teamthreats-reason-label">Outspeeds</span>' : '';
			const scarfNote = (reason.kind === 'speed' && reason.viaScarf) ?
				'<span class="cf-teamthreats-scarf-note">(needs Scarf)</span>' : '';
			return `<td class="cf-teamthreats-reason">${label}` +
				`<span class="cf-teamthreats-move-type">${typeIcon}</span>` +
				`<span class="cf-teamthreats-move-name">${escapeHTML(reason.move)}</span>` +
				`<span class="cf-pika-pct">${escapeHTML(String(reason.percent))}%</span>${scarfNote}` +
				`</td>`;
		}
		return `<td class="cf-teamthreats-reason cf-teamthreats-reason-stat">${escapeHTML(reason.text)}</td>`;
	}

	/** Biggest Threats hover tooltip content — a table, one row per (threatened team member,
	 *  reason) pair rather than the free-form per-member text blocks every other tooltip in this
	 *  file uses: a move reason needs its own type-icon/name/percent cells (see
	 *  buildTeamThreatReasonCellHTML), which reads as a real table row far more naturally than
	 *  as prose. The member's own sprite (`.cf-teamthreats-sprite`) spans every row a given
	 *  member needs via `rowspan` — one row when it has a single reason (or none: still one row,
	 *  with a "No specific reason found." cell rather than being silently dropped, since it IS a
	 *  real ranked counter even when this file can't explain why from the data it has), up to
	 *  three when computeThreatReasons found a move reason plus both stat reasons. */
	function buildTeamThreatTooltipHTML(threat) {
		const rows = (threat.memberReasons || []).map(({ member, reasons }) => {
			const icon = `<span class="picon" style="${escapeHTML(window.Dex ? window.Dex.getPokemonIcon(member) : '')}"></span>`;
			const reasonCells = reasons.length ? reasons.map(buildTeamThreatReasonCellHTML) :
				['<td class="cf-teamthreats-reason cf-teamthreats-reason-none">No specific reason found.</td>'];
			return reasonCells.map((cellHTML, i) => {
				const spriteCell = i === 0 ?
					`<td class="cf-teamthreats-sprite" rowspan="${reasonCells.length}">${icon}</td>` : '';
				return `<tr>${spriteCell}${cellHTML}</tr>`;
			}).join('');
		}).join('');
		return `<div class="cf-tooltip cf-teamthreats-tooltip"><h2>${escapeHTML(threat.pokemon)}</h2>` +
			`<table class="cf-teamthreats-table"><tbody>${rows}</tbody></table></div>`;
	}

	/** "1st"/"2nd"/"3rd"/"4th"/"11th"/"21st"/... from a plain placement number —
	 *  buildSimilarTeamRowHTML's own tournamentRanking label. The 11-13 special case matters:
	 *  without it, the generic last-digit rule would misname 11th/12th/13th as "11st"/"12nd"/
	 *  "13rd". Returns '' for a missing/non-numeric/zero placement rather than "0th" or "NaNth"
	 *  — the row just omits the placement clause entirely in that case (see the join below). */
	function ordinalLabel(n) {
		const num = parseInt(n, 10);
		if (!num) return '';
		const rem100 = num % 100;
		if (rem100 >= 11 && rem100 <= 13) return `${num}th`;
		return `${num}${['th', 'st', 'nd', 'rd'][num % 10] || 'th'}`;
	}

	/** One row per aggregateTopTeams() match: the team's 6 Pokémon as a strip of sprites,
	 *  column-aligned to the current roster's own order (alignSimilarTeamPokemon — an empty
	 *  roster slot neither the roster nor this team can fill renders as a blank placeholder,
	 *  cf-similarteam-empty-slot, rather than being skipped, so later columns don't shift and
	 *  lose their alignment), plus the context that actually explains *why* this team is worth
	 *  looking at and what its record even means: who built it, where they placed, and at what
	 *  event — filling what would otherwise be a lot of dead horizontal space next to a short
	 *  sprite strip. Full per-Pokémon detail (item/ability/moves) stays in the hover tooltip
	 *  (buildSimilarTeamTooltipHTML), not inline, so the row itself stays a compact glance.
	 *  `idx` is this match's position in the same `matches` array the caller keeps around for
	 *  hover lookups (see renderSimilarTeamsPanel's lastSimilarTeamsMatches) — not a stable id,
	 *  just an index into whatever's currently rendered, which is exactly what's needed since
	 *  both are rebuilt together on every render. */
	function buildSimilarTeamRowHTML(match, idx, rosterSpeciesIds) {
		const aligned = alignSimilarTeamPokemon(match.pokemon, rosterSpeciesIds);
		const sprites = aligned.map((p) => p ?
			`<span class="picon" style="${escapeHTML(window.Dex ? window.Dex.getPokemonIcon(p.name) : '')}"></span>` :
			`<span class="picon cf-similarteam-empty-slot"></span>`
		).join('');

		const author = match.author || match.authorId || 'Unknown';
		const placement = ordinalLabel(match.tournamentRanking);
		const tournament = match.tournamentLabel || '';
		// "1st at Alpensee x Smogon VGC Tour (Reg M-B) #70", or just whichever half is actually
		// present — both are optional fields on the underlying Pikalytics payload.
		const placementLine = placement && tournament ? `${placement} at ${tournament}` : (placement || tournament);

		return `<div class="cf-similarteam-row" data-cf-similarteam-idx="${idx}">` +
			`<span class="cf-similarteam-sprites">${sprites}</span>` +
			`<span class="cf-similarteam-meta">` +
				`<span class="cf-similarteam-author">${escapeHTML(author)}</span>` +
				(placementLine ? `<span class="cf-similarteam-tournament" title="${escapeHTML(placementLine)}">${escapeHTML(placementLine)}</span>` : '') +
			`</span>` +
			`<span class="cf-pika-pct">${escapeHTML(match.record || '')}</span>` +
			`</div>`;
	}

	/** Renders exactly the matches it's given — no internal cap. Pagination (loading matches
	 *  a page at a time as the user scrolls, rather than all of aggregateTopTeams' full result
	 *  at once) is the caller's job (renderSimilarTeamsPanel/loadMoreSimilarTeams): the first
	 *  call here renders one page's worth via this function, and every later page is appended
	 *  straight to the existing `.cf-pika-rows` DOM node instead of re-calling this and
	 *  replacing everything (which would both refetch nothing new *and* reset scroll position
	 *  back to the top on every page — exactly what "pagination on scroll" shouldn't do).
	 *  `rosterSpeciesIds` (curRosterSpeciesOrder(tbRoom)) is threaded through to every row so
	 *  they all align to the same reference order — computed once by the caller rather than per
	 *  row, since it's identical for every match being rendered together. */
	function buildSimilarTeamsSectionHTML(matches, rosterSpeciesIds) {
		if (!matches || !matches.length) return pikaSectionHTML('Similar Teams', '<p class="cf-pika-empty">No similar teams found yet.</p>');
		const rows = matches.map((m, i) => buildSimilarTeamRowHTML(m, i, rosterSpeciesIds)).join('');
		return pikaSectionHTML('Similar Teams', rows);
	}

	/** Full team-sheet hover popup for one buildSimilarTeamRowHTML row — just the roster itself
	 *  (each of the team's 6 Pokémon with item/ability/moves, the same shape building that
	 *  Pokémon yourself would show), no author/tournament/record header: that context now lives
	 *  in the row itself (buildSimilarTeamRowHTML), so repeating it here would just be the same
	 *  three facts a second time. Read-only: no click-to-apply here, this is someone else's real
	 *  team shown for reference, not a template.
	 *
	 *  One column per Pokémon, all 6 side by side in a single row, rather than one stacked
	 *  paragraph per Pokémon — mirrors the row's own sprite strip (buildSimilarTeamRowHTML) and
	 *  makes the same roster-aligned column position (alignSimilarTeamPokemon) legible in the
	 *  tooltip too, not just the compact row. Same alignment, just without the row's own blank
	 *  placeholders — an empty roster slot has nothing to list here, so it's dropped
	 *  (`.filter(Boolean)`) rather than rendered as an empty column. */
	function buildSimilarTeamTooltipHTML(match, rosterSpeciesIds) {
		const ordered = alignSimilarTeamPokemon(match.pokemon, rosterSpeciesIds).filter(Boolean);
		const columns = ordered.map((p) => {
			// Held item as a corner badge on the sprite (cf-speedcmp-sprite/cf-speedcmp-item-badge
			// — the same pairing already used for the ally's Scarf badge and the "Popular" row's
			// own item badge) rather than "@ Item" text, since the item is a property of this
			// specific Pokémon, same as its species — showing it as a badge on the sprite keeps it
			// visually tied to the right icon instead of floating as a separate text line.
			const itemBadge = (p.item && window.Dex) ?
				`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon(p.item))}"></span>` : '';
			const sprite = `<span class="cf-speedcmp-sprite">` +
				`<span class="picon" style="${escapeHTML(window.Dex ? window.Dex.getPokemonIcon(p.name) : '')}"></span>` +
				itemBadge +
				`</span>`;
			const abilityText = p.ability ? `<em>${escapeHTML(p.ability)}</em>` : '';
			const moveNames = (p.moves || []).map((m) => escapeHTML(typeof m === 'string' ? m : (m && m.name) || ''));
			return `<div class="cf-similarteam-tooltip-col">` +
				sprite +
				(abilityText ? `<span>${abilityText}</span>` : '') +
				(moveNames.length ? `<span class="cf-similarteam-tooltip-moves">${moveNames.join('<br>')}</span>` : '') +
				`</div>`;
		}).join('');
		return `<div class="cf-tooltip cf-similarteam-tooltip"><div class="cf-similarteam-tooltip-columns">${columns}</div></div>`;
	}

	/** Hover preview for a "Popular" row (buildSpeedTierColumnHTML, blank-slot state) — a
	 *  condensed read of the exact same per-species payload the full 6-section grid shows once
	 *  the species is actually picked (see buildPikalyticsSidebarHTML), so hovering previews what
	 *  selecting it would show rather than presenting different data. Deliberately excludes
	 *  win rate (confounded by mirror matches and team/skill variance — see the conversation this
	 *  was scoped in) and Common Teammates (already shown per-species once you actually add it,
	 *  so repeating it here would just be the same list one click early). Top few of each
	 *  category only — this is a glance, not the full grid.
	 *
	 *  Nature and Spread are shown as two separate lines, each with its own usage percent, not
	 *  merged into one "Careful 32/0/14/0/20/0 (6.2%)"-style line — confirmed live, VGC's own
	 *  `natures` and `spreads` are two independently-ranked lists (a spread entry's own `nature`
	 *  field is empty for these formats; see buildSpreadsSection's `hasNature` check), so the
	 *  #1 nature and #1 EV spread aren't necessarily ever run together on the same real set. A
	 *  single combined line with one percent would misrepresent that percent as covering both,
	 *  when it's really only the EV spread's own ranking.
	 *
	 *  Also shows the Mega forme's own base stats, right under the base forme's, when a Mega
	 *  Stone is actually the species' popular item (topSpeedItemBadge — same "is this actually
	 *  relevant" check buildSpeedTierColumnHTML's own Speed-stat swap already uses, so this
	 *  tooltip and that row's Speed number stay consistent about which forme is the one worth
	 *  showing). Read from Dex.species directly, not Pikalytics — the per-species payload here is
	 *  queried under the base species name (see pikalytics.js's own resolveQuerySpecies), so it
	 *  never carries the Mega forme's own base stats itself. */
	function buildSpeciesPreviewTooltipHTML(mon, speciesName) {
		const moveText = (mon.moves || []).slice(0, 4)
			.map((m) => `${escapeHTML(m.move)} (${escapeHTML(m.percent)}%)`).join(', ') || 'No data';
		const abilityText = (mon.abilities || []).slice(0, 2)
			.map((a) => `${escapeHTML(a.ability)} (${escapeHTML(a.percent)}%)`).join(', ') || 'No data';
		const itemText = (mon.items || []).slice(0, 2)
			.map((it) => `${escapeHTML(it.item)} (${escapeHTML(it.percent)}%)`).join(', ') || 'No data';
		const topSpread = (mon.spreads || [])[0];
		const topNature = (mon.natures || [])[0];
		// Falls back to the spread's own `nature` field only when there's no standalone
		// `natures` list at all (a format-shape gap, not the VGC norm) — with no percent
		// attached in that case, since there'd be nothing real to attach it to.
		const natureText = topNature ? `${escapeHTML(topNature.nature)} (${escapeHTML(topNature.percent)}%)` :
			((topSpread && topSpread.nature) ? escapeHTML(topSpread.nature) : 'No data');
		const spreadText = topSpread ? `${escapeHTML(topSpread.ev)} (${escapeHTML(topSpread.percent)}%)` : 'No data';
		const statsText = mon.stats ?
			STAT_IDS.map((id) => `${STAT_LABEL_BY_ID[id]} ${mon.stats[id]}`).join(' &nbsp; ') : '';

		const badge = topSpeedItemBadge(mon, speciesName);
		let megaStatsText = '';
		let megaFormeName = '';
		if (badge && badge.isMega && window.Dex) {
			const megaSpecies = window.Dex.species.get(badge.formeName);
			if (megaSpecies && megaSpecies.exists && megaSpecies.baseStats) {
				megaFormeName = badge.formeName;
				megaStatsText = STAT_IDS.map((id) => `${STAT_LABEL_BY_ID[id]} ${megaSpecies.baseStats[id]}`).join(' &nbsp; ');
			}
		}

		return `<div class="cf-tooltip cf-addpokemon-preview-tooltip">` +
			`<h2>${escapeHTML(speciesName)}</h2>` +
			(statsText ? `<p class="tooltip-section">${statsText}</p>` : '') +
			(megaStatsText ? `<p class="tooltip-section"><strong>${escapeHTML(megaFormeName)}</strong><br>${megaStatsText}</p>` : '') +
			`<p class="tooltip-section"><strong>Moves</strong><br>${moveText}</p>` +
			`<p class="tooltip-section"><strong>Ability</strong><br>${abilityText}</p>` +
			`<p class="tooltip-section"><strong>Item</strong><br>${itemText}</p>` +
			`<p class="tooltip-section"><strong>Nature</strong><br>${natureText}</p>` +
			`<p class="tooltip-section"><strong>Spread</strong><br>${spreadText}</p>` +
			`</div>`;
	}

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

		/** Team-overview screen's own three independent sub-panels within #cf-pika-panel — same
		 *  reasoning as ensureTeambuilderSidebarEl's own split above: the Speed Spread diagram and
		 *  Defensive Profile matrix are both cheap, synchronous, and safe to fully rebuild on every
		 *  renderTeamOverviewPanel call (window resize included), but Biggest Threats needs a real
		 *  Pikalytics fetch per roster member — rebuilding its markup unconditionally alongside the
		 *  other two would flash it back to "Loading…" (and refire that fetch) on every one of
		 *  those calls even when the roster hasn't actually changed.
		 *
		 *  #cf-defmatrix-wrap and #cf-teamthreats-section sit side by side inside a shared row
		 *  (#cf-teamoverview-row, style.css: display:flex), not stacked under Speed Spread the way
		 *  an earlier version had them — the Defensive Profile matrix only ever needs its own
		 *  natural content width (a handful of narrow sprite columns), so stacking it as its own
		 *  full-width block left most of that block's width empty; letting Biggest Threats' own
		 *  square grid share the row instead uses that space, with #cf-teamthreats-section's own
		 *  `flex: 1 1 auto` (style.css) taking whatever the matrix doesn't need.
		 *
		 *  Only rebuilds the panel's own wrapper structure when any piece is missing or has been
		 *  detached (e.g. the very first entry into the team-overview screen, or after
		 *  ensurePikaPanelEl above had to recreate #cf-pika-panel from scratch) — otherwise reuses
		 *  the existing set so renderTeamThreatsSection's own key-based skip (see its own doc
		 *  comment) actually has undisturbed content to skip past. */
		function ensureTeamOverviewPanelEls(panelEl) {
			let spectrumEl = document.getElementById('cf-speedspectrum-wrap');
			let rowEl = document.getElementById('cf-teamoverview-row');
			let defMatrixEl = document.getElementById('cf-defmatrix-wrap');
			let threatsEl = document.getElementById('cf-teamthreats-section');
			if (!spectrumEl || !rowEl || !defMatrixEl || !threatsEl || spectrumEl.parentElement !== panelEl ||
				rowEl.parentElement !== panelEl || defMatrixEl.parentElement !== rowEl || threatsEl.parentElement !== rowEl) {
				panelEl.innerHTML = '<div id="cf-speedspectrum-wrap"></div>' +
					'<div id="cf-teamoverview-row"><div id="cf-defmatrix-wrap"></div>' +
					'<div id="cf-teamthreats-section"></div></div>';
				spectrumEl = document.getElementById('cf-speedspectrum-wrap');
				defMatrixEl = document.getElementById('cf-defmatrix-wrap');
				threatsEl = document.getElementById('cf-teamthreats-section');
			}
			return { spectrumEl, threatsEl, defMatrixEl };
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
		 *  padding, and border as every other section — nothing bespoke to keep in sync.
		 *
		 *  On a blank slot (isBlankSlot — "Add Pokémon", before a species is picked yet) this
		 *  column repurposes itself as "Popular": the header changes, every box gets a
		 *  type-coverage-colored border (does *any* already-added team member's real damaging
		 *  moves hit this one hard? — bestTeamCoverageMultiplier/coverageTierClass, purely a
		 *  fact about your own moves' types, not a judgment call), a corner badge for whichever of
		 *  Choice Scarf or a Mega Stone is actually the more commonly run item (topSpeedItemBadge
		 *  — real usage percent decides which one wins, not "Scarf always wins if present"), and
		 *  its expected Speed stat (top spread + top nature, the same computation
		 *  buildSpeedComparisonTooltipHTML already does for the hover popup, just always shown
		 *  here instead of only on hover). When the badge is a Mega Stone, the shown Speed stat
		 *  is the *Mega forme's* own base Speed rather than the base forme's — usually
		 *  meaningfully different, and that's the number actually relevant to a Speed
		 *  comparison once you know it's commonly Mega'd — with the base forme's own Speed kept
		 *  alongside it, dimmed in parentheses, rather than dropped. Every row becomes
		 *  a click-to-fill target for that same still-open slot (applySpeciesToBlankSlot via the
		 *  'addspecies' action). There's no real ally Pokémon yet to usefully compare Speed
		 *  against one-on-one (buildSpeedComparisonTooltipHTML already no-ops without one), but
		 *  the *expected* Speed stat and "most popular in this format" are both still exactly
		 *  what they say regardless. Species already on the team get the equipped look
		 *  (cf-pika-row-equipped, no data-cf-pika-action) rather than cf-pika-row-disabled —
		 *  deliberately NOT the same treatment buildTeammatesSection gives an equipped teammate
		 *  (equipped AND disabled together there): cf-pika-row-disabled's `pointer-events: none`
		 *  would block hover here too, and unlike a plain teammate suggestion this row's hover
		 *  preview (buildAddPokemonPreviewTooltipHTML) is exactly as useful for a species
		 *  already on the team as for any other — there's no reason to lose it just because
		 *  clicking wouldn't do anything. Team-full is never a reason to disable here either
		 *  way, since clicking fills the slot already open rather than adding a new one. */
		function speedTierColumnHTML(headerText, rowsHTML) {
			return `<h3 class="cf-pika-header">${escapeHTML(headerText)}</h3><div class="cf-pika-rows">${rowsHTML}</div>`;
		}
		function buildSpeedTierColumnHTML(list, tbRoom) {
			const blank = isBlankSlot(tbRoom);
			const header = blank ? 'Popular' : 'Speed';
			if (!list || !list.length) return speedTierColumnHTML(header, '<p class="cf-sidebar-placeholder">No data.</p>');

			const moveTypes = blank ? teamDamagingMoveTypes(tbRoom) : null;
			const rows = list.map((entry) => {
				const iconStyle = window.Dex ? window.Dex.getPokemonIcon(entry.name) : '';
				const rankCls = entry.rank >= 1 && entry.rank <= 3 ? ` cf-speedtier-rank-${entry.rank}` : '';
				let rowCls = 'cf-speedtier-row';
				let rowAttrs = ` data-cf-species="${escapeHTML(entry.name)}"`;
				let boxCls = 'cf-speedtier-box';
				let badgeHTML = '';
				let speedHTML = '';

				if (blank) {
					const alreadyOnTeam = curTeamHasSpecies(tbRoom, entry.name);
					if (alreadyOnTeam) {
						rowCls += ' cf-pika-row-equipped';
					} else {
						rowCls += ' cf-pika-row-clickable';
						rowAttrs += ` data-cf-pika-action="addspecies" data-cf-pika-value="${escapeHTML(entry.name)}"`;
					}

					if (entry.mon) {
						const mult = bestTeamCoverageMultiplier(moveTypes, entry.mon.types);
						const tierCls = coverageTierClass(mult);
						if (tierCls) boxCls += ' ' + tierCls;

						const badge = topSpeedItemBadge(entry.mon, entry.name);
						if (badge && window.Dex) {
							badgeHTML = `<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon(badge.item))}"></span>`;
						}

						const topSpread = (entry.mon.spreads || [])[0];
						if (topSpread && tbRoom && typeof tbRoom.getStat === 'function') {
							const topNature = (entry.mon.natures || [])[0];
							const natureName = (topNature && topNature.nature) || '';
							const speEv = parseEVs(topSpread.ev).spe;
							const baseSet = {
								species: entry.name,
								evs: { spe: speEv },
								nature: natureName,
								ivs: { spe: 31 },
								level: 50,
							};
							const baseSpe = tbRoom.getStat('spe', baseSet);
							const evText = formatSpeedEvText(speEv, speedNatureIndicator(natureName));

							// The popular item being a Mega Stone (not Scarf) means the Mega
							// forme's own base Speed — usually different, sometimes very
							// different, from the base forme's — is what a real Speed
							// comparison against this row actually needs; the base forme's own
							// number is kept alongside it, dimmed, rather than dropped, since
							// it's still a real fact about the species (and what it'd be
							// running any *other* item).
							if (badge && badge.isMega) {
								const megaSet = { species: badge.formeName, evs: { spe: speEv }, nature: natureName, ivs: { spe: 31 }, level: 50 };
								const megaSpe = tbRoom.getStat('spe', megaSet);
								speedHTML = `<div class="cf-speedtier-speed">${megaSpe}` +
									`<span class="cf-speedtier-speed-base">(${baseSpe})</span>` +
									`<span class="cf-speedtier-speed-ev">${escapeHTML(evText)}</span></div>`;
							} else {
								speedHTML = `<div class="cf-speedtier-speed">${baseSpe}<span class="cf-speedtier-speed-ev">${escapeHTML(evText)}</span></div>`;
							}
						}
					}
				}

				return `<div class="${rowCls}"${rowAttrs}>` +
					`<div class="${boxCls}">` +
						`<span class="picon" style="${escapeHTML(iconStyle)}"></span>` +
						`<span class="cf-speedtier-rank${rankCls}">${escapeHTML(String(entry.rank))}</span>` +
						badgeHTML +
					`</div>${speedHTML}</div>`;
			}).join('');
			return speedTierColumnHTML(header, rows);
		}

		/** Minimum Pikalytics usage percent for Choice Scarf/Iron Ball/Mega Stone before
		 *  buildSpeedComparisonTooltipHTML bothers showing the corresponding "what if" column at
		 *  all — user-adjustable (CF_SETTINGS.scarfThresholdPercent/ironballThresholdPercent/
		 *  megaThresholdPercent, set in the toolbar popup), since these started as a guess rather
		 *  than a researched number and different players reasonably draw that line in different
		 *  places. The real percent is always shown in the column's own header either way, so a
		 *  borderline case stays visible to judge yourself rather than getting silently hidden by
		 *  wherever the threshold sits. Deliberately never changes the base Foe column itself (see
		 *  buildSpeedComparisonTooltipHTML's own comment for why a species with dominant Mega
		 *  Stone usage still keeps its base forme as the main Foe column) — a Pokémon holding a
		 *  Mega Stone can't simultaneously hold Choice Scarf or Iron Ball, so Scarf/Iron Ball/Mega
		 *  are three independent, mutually exclusive "what if" columns sitting alongside the same
		 *  unchanged base column, never merged into it. */

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

			// An extra "what if it ran Scarf instead" column (rendered after any Mega columns —
			// see megaOptions below), only when Scarf usage is actually non-trivial for this
			// species (see CF_SETTINGS.scarfThresholdPercent's own doc comment, above) —
			// otherwise it's a hypothetical nobody's really building, and the column would just
			// be noise.
			const scarfItemEntry = foeItems.find((it) => toIDSafe(it.item) === 'choicescarf');
			const scarfPercent = scarfItemEntry ? parseFloat(scarfItemEntry.percent) || 0 : 0;
			const showScarfColumn = scarfPercent >= CF_SETTINGS.scarfThresholdPercent;

			// Same shape as the Scarf column above, mirrored for Iron Ball — expected to clear
			// this threshold far less often in practice (a Trick Room-oriented item, nowhere
			// near as universal a pick as Scarf), but there's no principled reason to leave it
			// unwired just because it'll show up less: real Iron Ball usage is exactly as real a
			// fact about a species as real Scarf usage, whenever it does clear the bar.
			const ironBallItemEntry = foeItems.find((it) => toIDSafe(it.item) === 'ironball');
			const ironBallPercent = ironBallItemEntry ? parseFloat(ironBallItemEntry.percent) || 0 : 0;
			const showIronBallColumn = ironBallPercent >= CF_SETTINGS.ironballThresholdPercent;

			// One "what if it ran its Mega Stone instead" column per Mega Stone that crosses
			// CF_SETTINGS.megaThresholdPercent — never a row-identity swap on the base Foe
			// column itself (see the earlier, reverted approach that tried overriding the base
			// row directly — a Pokémon holding a Mega Stone can't also hold Scarf, so collapsing
			// the row broke exactly that: a "Mega + Scarf" combination that can't exist in the
			// real game). A species can have more than one real Mega Stone (Charizard X/Y,
			// Mewtwo X/Y) — and confirmed live on Raichu, X and Y can BOTH comfortably clear the
			// threshold (18.2%/60.5%) rather than one dominating, so keeping only the single most
			// popular one was silently hiding a real, comparably-popular build rather than the
			// "genuinely rare case" this was originally scoped around. Sorted by usage descending
			// so the more common one still reads first, left to right. getStat resolves each
			// Mega forme's own real base stat from Dex once the *species name* passed in is the
			// Mega forme itself — same mechanism as every other stat lookup here, not a
			// separately maintained stats field.
			const megaOptions = [];
			if (window.Dex) {
				for (const it of foeItems) {
					const itemData = window.Dex.items.get(it.item);
					const forme = itemData && itemData.megaStone && itemData.megaStone[speciesName];
					if (!forme) continue;
					const percent = parseFloat(it.percent) || 0;
					if (percent < CF_SETTINGS.megaThresholdPercent) continue;
					const megaSet = { species: forme, evs: foeSet.evs, nature: foeSet.nature, ivs: foeSet.ivs, level: foeSet.level };
					megaOptions.push({ formeName: forme, percent, itemName: it.item, base: tbRoom.getStat('spe', megaSet) });
				}
				megaOptions.sort((a, b) => b.percent - a.percent);
			}

			// No win/lose coloring — with several independent Speed numbers per row (ally, foe,
			// and any number of foe "what if" variants) a single "winner" no longer means
			// anything; reading the plain numbers against each other is unambiguous without it.
			const rows = SPEED_COMPARISON_SCENARIOS.map((sc) => {
				const allySpeed = applySpeedModifiers(allyBase, allySet.item, sc.ally);
				// No item — see the comment above foeBase's own computation for why the base
				// Foe column never applies one.
				const foeSpeed = applySpeedModifiers(foeBase, null, sc.foe);
				// No item passed to any Mega cell — a Mega Stone isn't in SPEED_ITEM_MULTIPLIERS
				// (it doesn't multiply Speed, each entry's own `base` already covers its effect),
				// and the holder can't also be running Scarf/Iron Ball anyway.
				const megaCells = megaOptions.map((m) => `<td>${applySpeedModifiers(m.base, null, sc.foe)}</td>`).join('');
				const scarfCell = showScarfColumn ?
					// Same base stat as the main foe column (items don't change EVs/nature) —
					// only the item plugged into applySpeedModifiers changes, so this is
					// "what if" against an otherwise-identical spread, not a different build.
					`<td>${applySpeedModifiers(foeBase, 'Choice Scarf', sc.foe)}</td>` : '';
				const ironBallCell = showIronBallColumn ?
					`<td>${applySpeedModifiers(foeBase, 'Iron Ball', sc.foe)}</td>` : '';
				return `<tr><td>${escapeHTML(sc.label)}</td><td>${allySpeed}</td><td>${foeSpeed}</td>${megaCells}${scarfCell}${ironBallCell}</tr>`;
			}).join('');

			const allyIcon = window.Dex ? window.Dex.getPokemonIcon(allySet.species) : '';
			const foeIcon = window.Dex ? window.Dex.getPokemonIcon(speciesName) : '';
			const allyEvText = formatSpeedEvText((allySet.evs && allySet.evs.spe) || 0, speedNatureIndicator(allySet.nature));
			const foeEvText = formatSpeedEvText(foeSet.evs.spe, speedNatureIndicator(foeNature));
			const scarfIconStyle = window.Dex ? window.Dex.getItemIcon('Choice Scarf') : '';
			const ironBallIconStyle = window.Dex ? window.Dex.getItemIcon('Iron Ball') : '';

			// Only the ally sprite gets an unconditional held-item badge — the popup is scoped
			// to "what's actually on my set" for that side (see applySpeedModifiers' own doc
			// comment: the item is baseline-only, not a per-row toggle). The foe's own most-
			// common item is Pikalytics' population statistic rather than something really
			// "held," so badging it the same way would misleadingly imply the same certainty —
			// Scarf/Iron Ball/Mega specifically get their own conditional columns instead
			// (above), with their real usage percent shown rather than asserted. Scarf and Iron
			// Ball are checked as two independent, mutually-exclusive booleans (a real set can
			// only hold one item) rather than one "which item" branch, matching how
			// computeSpeedSpectrumEntries' own hasScarf/hasIronBall are shaped.
			const allyHasScarf = toIDSafe(allySet.item) === 'choicescarf';
			const allyHasIronBall = toIDSafe(allySet.item) === 'ironball';
			const allyItemBadgeHTML = (allyHasScarf || allyHasIronBall) && window.Dex ?
				`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon(allySet.item))}"></span>` : '';
			const allySpriteHTML = `<span class="cf-speedcmp-sprite">` +
				`<span class="picon" style="${escapeHTML(allyIcon)}"></span>` +
				allyItemBadgeHTML +
				`</span>`;
			// Bottom-right badge matches the ally sprite's own Scarf badge above; bottom-left
			// (otherwise empty on this sprite — nothing else claims that corner) carries the
			// real usage percent, so each column reads as "here's the item, and here's how
			// common it actually is" at a glance rather than needing a caption line underneath.
			// The Mega columns use each Mega forme's own sprite (not the base species') since
			// that's genuinely a different-looking Pokémon, unlike Scarf which doesn't change
			// what the foe looks like.
			const megaColumnHeadersHTML = megaOptions.map((m) =>
				`<th><span class="cf-speedcmp-sprite">` +
					`<span class="picon" style="${escapeHTML(window.Dex.getPokemonIcon(m.formeName))}"></span>` +
					`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(window.Dex.getItemIcon(m.itemName))}"></span>` +
					`<span class="cf-speedcmp-usage-badge">${Math.round(m.percent)}%</span>` +
					`</span></th>`
			).join('');
			const scarfColumnHeaderHTML = showScarfColumn ?
				`<th><span class="cf-speedcmp-sprite">` +
					`<span class="picon" style="${escapeHTML(foeIcon)}"></span>` +
					`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(scarfIconStyle)}"></span>` +
					`<span class="cf-speedcmp-usage-badge">${Math.round(scarfPercent)}%</span>` +
					`</span></th>` : '';
			const ironBallColumnHeaderHTML = showIronBallColumn ?
				`<th><span class="cf-speedcmp-sprite">` +
					`<span class="picon" style="${escapeHTML(foeIcon)}"></span>` +
					`<span class="itemicon cf-speedcmp-item-badge" style="${escapeHTML(ironBallIconStyle)}"></span>` +
					`<span class="cf-speedcmp-usage-badge">${Math.round(ironBallPercent)}%</span>` +
					`</span></th>` : '';

			// Width tiers scale with however many conditional columns are actually showing —
			// 0-2 Mega columns (see megaOptions above) plus 0-1 Scarf plus 0-1 Iron Ball, so up
			// to 4 extra columns in practice (a species with 3+ real Mega Stones, or both Scarf
			// and Iron Ball simultaneously clearing their thresholds at the *population* level,
			// doesn't realistically happen — speedCmpTooltipWidthClass's own clamp handles it
			// gracefully either way if it ever did).
			const extraCols = megaOptions.length + (showScarfColumn ? 1 : 0) + (showIronBallColumn ? 1 : 0);
			const widthCls = speedCmpTooltipWidthClass(extraCols);

			return `<div class="cf-tooltip cf-speedcmp-tooltip${widthCls}">` +
				`<h2>${escapeHTML(allySet.species)} ` +
				`<span class="cf-speedcmp-evinfo">(${escapeHTML(allyEvText)})</span> vs. ${escapeHTML(speciesName)} ` +
				`<span class="cf-speedcmp-evinfo">(${escapeHTML(foeEvText)})</span></h2>` +
				`<table class="cf-speedcmp-table"><thead><tr><th>Scenario</th>` +
				`<th>${allySpriteHTML}</th>` +
				`<th><span class="picon" style="${escapeHTML(foeIcon)}"></span></th>` +
				`${megaColumnHeadersHTML}${scarfColumnHeaderHTML}${ironBallColumnHeaderHTML}</tr></thead>` +
				`<tbody>${rows}</tbody></table></div>`;
		}
		// onMouseOver (outer scope, near Tooltip) needs to call this, but it's defined here
		// (inside patchTeambuilderSidebar) since it depends on things scoped to this function's
		// own closure. CF is this file's existing cross-scope handoff — same pattern
		// CF.lastEngine already uses for patchDexSearch -> onMouseOver.
		CF.buildSpeedComparisonTooltipHTML = buildSpeedComparisonTooltipHTML;

		/** Blank-slot counterpart to buildSpeedComparisonTooltipHTML above, tried first by
		 *  onMouseOver (see the dispatch there) — returns null outside a blank slot so that
		 *  branch falls through to the ordinary Speed comparison popup unchanged. Looks the
		 *  hovered row's species up in lastSpeedTierList (populated by renderSpeedTierColumn)
		 *  the same way buildSpeedComparisonTooltipHTML already does, since the row's own
		 *  `mon` payload — already fetched for the coverage color / item badge / expected Speed
		 *  this row is already showing — is exactly what buildSpeciesPreviewTooltipHTML needs
		 *  too; no extra fetch. */
		function buildAddPokemonPreviewTooltipHTML(rowEl) {
			const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
			if (!isBlankSlot(tbRoom)) return null;
			const speciesName = rowEl.getAttribute('data-cf-species');
			if (!speciesName) return null;
			const entry = lastSpeedTierList && lastSpeedTierList.find((e) => e.name === speciesName);
			if (!entry || !entry.mon) return null;
			return buildSpeciesPreviewTooltipHTML(entry.mon, speciesName);
		}
		CF.buildAddPokemonPreviewTooltipHTML = buildAddPokemonPreviewTooltipHTML;

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
		/** Distinguishes *why* lastMon is still null for the current lastRenderKey: 'pending'
		 *  while the fetch is still in flight (don't retrigger — the in-flight promise will
		 *  resolve and render on its own), 'empty' once Pikalytics genuinely returned no data
		 *  for this species (a stable answer — asking again would just get the same answer),
		 *  or 'failed' once the fetch itself errored. Only 'failed' allows retrying on the next
		 *  call for the same key (see renderPikalyticsSidebar below) — without this, a transient
		 *  network hiccup left the sidebar stuck on "Failed to load" until the user switched to
		 *  a different team slot and back (the only thing that reset lastRenderKey). */
		let lastFetchState = null;
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

		/** Single-cell override of the six-section `.cf-pika-grid` (style.css) — reusing that
		 *  class rather than a bespoke one means the Similar Teams section standing alone in
		 *  #cf-pika-panel gets the exact same `height: 100%` fill + internal-scroll behavior the
		 *  real six-section grid already relies on (see that class's own comment: a lone
		 *  `.cf-pika-section` dropped straight into #cf-pika-panel, a plain block container,
		 *  wouldn't get a bounded height to scroll within at all otherwise), just with the 2x3
		 *  track template collapsed to a single cell. */
		function addPokemonPanelWrapHTML(innerHTML) {
			return `<div class="cf-pika-grid" style="grid-template-columns:1fr;grid-template-rows:1fr;">${innerHTML}</div>`;
		}

		/** Identifies the current roster's species composition (Mega/Primal collapsed to base,
		 *  same as everywhere else this file compares team membership) for renderSimilarTeamsPanel's
		 *  own cache key — order-independent (sorted) since which slot a species sits in doesn't
		 *  change which real teams share it. */
		function rosterSpeciesKey(tbRoom) {
			return (tbRoom.curSetList || [])
				.filter((s) => s && s.species)
				.map((s) => baseSpeciesID(s.species))
				.sort()
				.join(',');
		}

		let lastSimilarTeamsKey = null;
		/** The full aggregateTopTeams() result for lastSimilarTeamsKey — light detail only
		 *  (species+item, no ability/moves), never trimmed. lastSimilarTeamsMatches (below) is
		 *  the prefix of this that's actually been detail-fetched and rendered so far; the two
		 *  only ever differ while more pages remain to load. */
		let lastSimilarTeamsAllMatches = null;
		let lastSimilarTeamsMatches = null;
		/** Distinguishes *why* lastSimilarTeamsMatches is still null for the current
		 *  lastSimilarTeamsKey: a fetch still in flight (don't restart it — the in-flight
		 *  promise will resolve and render on its own) vs. a settled failure (only this case
		 *  allows retrying on the next call for the same key). Same "pending vs. failed" split
		 *  renderPikalyticsSidebar's own lastFetchState and renderSpeedTierColumn's own
		 *  lastSpeedTierFailed already use — without it, the cache-hit check below had no way
		 *  to tell "still loading" apart from "nothing cached yet," so *any* re-render while a
		 *  fetch was pending (e.g. rapid resize events, with no debounce on that listener) fell
		 *  through to the fetch block below and restarted the request under a new token,
		 *  cancelling the one already in flight — confirmed live, this could leave the panel
		 *  stuck on "Loading…" indefinitely under fast repeated re-renders. */
		let lastSimilarTeamsFailed = false;
		/** True only while a loadMoreSimilarTeams() page fetch is actually in flight — guards
		 *  against a second scroll-triggered call starting an overlapping page fetch before the
		 *  first one lands, which would otherwise let two pages race to both read the same
		 *  lastSimilarTeamsMatches.length as their start offset and append duplicate rows. */
		let lastSimilarTeamsLoadingMore = false;
		let similarTeamsRenderToken = 0;

		/** Shared by renderSimilarTeamsPanel's first page and loadMoreSimilarTeams' later ones:
		 *  backfills one match's ability/moves via getTopTeamDetail, falling back to the match's
		 *  own light pokemon list (species+item only) if that lookup fails — a detail-fetch
		 *  failure for one team (network hiccup, or a team the detail endpoint doesn't
		 *  recognize) degrades that one row to "sprites and item badges only"
		 *  (buildSimilarTeamRowHTML/buildSimilarTeamTooltipHTML already render missing ability/
		 *  moves as simply absent, not broken) rather than dropping the row entirely. */
		function fetchAndMergeTeamDetail(formatId, match) {
			return window.CF_Pikalytics.getTopTeamDetail(formatId, match.tournamentId, match.authorId)
				.then((detail) => ((detail && Array.isArray(detail.pokemon)) ? Object.assign({}, match, { pokemon: detail.pokemon }) : match));
		}

		/** Fills #cf-pika-panel on a blank slot (see isBlankSlot) with real tournament teams
		 *  that share species with the current roster — see aggregateTopTeams for how "similar"
		 *  is decided. Two-step fetch: one window.CF_Pikalytics.getTopTeams(formatId) call for
		 *  the format's whole ~200-team pool (light detail — species+item only, no ability/
		 *  moves; already cached inside pikalytics.js itself, so a warm call here is cheap),
		 *  aggregated down to whichever ones actually share species with the roster, then one
		 *  getTopTeamDetail() call per surviving match in the *first page only*
		 *  (SIMILAR_TEAMS_PAGE_SIZE) to backfill ability/moves for just those — see
		 *  pikalytics.js's own Top Teams module comment for why detail is a separate per-team
		 *  fetch. Every later page loads on scroll instead (loadMoreSimilarTeams), so a species
		 *  that matches dozens of the 200-team pool doesn't front-load dozens of detail
		 *  requests before the section can even render. Cached here by roster composition
		 *  (rosterSpeciesKey) so re-renders triggered by something unrelated (a resize, a click
		 *  elsewhere) don't redo either fetch, or lose whatever pages had already been scrolled
		 *  in, every time.
		 *
		 *  The reference order every row/tooltip aligns against (alignSimilarTeamPokemon) is
		 *  read fresh via curRosterSpeciesOrder(tbRoom) at each actual render point below,
		 *  rather than captured once into a variable up here and reused inside the async
		 *  callback — reordering existing slots doesn't change rosterSpeciesKey (sorted, so
		 *  order-independent) and so doesn't invalidate the cache/restart the fetch, but the
		 *  order itself can still have changed by the time that fetch resolves; reading it at
		 *  render time instead of fetch-start time keeps the alignment correct either way. */
		function renderSimilarTeamsPanel(tbRoom, formatId) {
			const panelEl = ensurePikaPanelEl();
			const roster = (tbRoom.curSetList || []).filter((s) => s && s.species);
			if (!roster.length) {
				panelEl.innerHTML = addPokemonPanelWrapHTML(pikaSectionHTML('Similar Teams', '<p class="cf-pika-empty">No Pokémon on your team yet.</p>'));
				lastSimilarTeamsKey = null;
				lastSimilarTeamsAllMatches = null;
				lastSimilarTeamsMatches = null;
				lastSimilarTeamsFailed = false;
				// Invalidates any fetch still in flight from before the roster was emptied —
				// without this, that fetch's own token still matched on resolve, so its (now
				// stale) results would overwrite this "no team" message once it landed.
				similarTeamsRenderToken++;
				return;
			}

			const key = formatId + '|' + rosterSpeciesKey(tbRoom);
			if (key === lastSimilarTeamsKey && !lastSimilarTeamsFailed) {
				// Same roster composition as last time AND that lookup didn't fail: if the first
				// page has already resolved, just redraw (cheap) against the current slot order
				// — rendering whatever's in lastSimilarTeamsMatches, however many pages that
				// already grew to via scrolling, not just the first page again. If it's still in
				// flight, there's nothing new to do — let it resolve on its own.
				if (lastSimilarTeamsMatches) {
					// Reachable from a plain window resize (updateSplitState re-renders on every
					// one) with no roster change at all, so this redraw needs the same two things
					// the actual fetch paths (above, and loadMoreSimilarTeams) already get right:
					// preserve scroll position instead of snapping back to the top, and re-check
					// whether the box still needs more pages loaded — a resize can make an
					// already-scrolled box tall enough to stop overflowing, which would otherwise
					// silently stall pagination since no more `scroll` events would ever fire.
					//
					// Also invalidates any loadMoreSimilarTeams fetch already in flight — it
					// captured the *old* `.cf-pika-rows` node before this redraw replaces it below,
					// so letting that fetch's own now-stale token still match on resolve would have
					// it insertAdjacentHTML onto a detached node: the fetched page would be silently
					// invisible even though it's still concatenated into lastSimilarTeamsMatches,
					// desyncing every later row's data-cf-similarteam-idx from its real array index.
					// Bumping the token here makes that fetch's own staleness check correctly no-op
					// instead — the next scroll/fill re-fetches that same page against a fresh node.
					similarTeamsRenderToken++;
					const oldRowsEl = panelEl.querySelector('.cf-pika-rows');
					const oldScrollTop = oldRowsEl ? oldRowsEl.scrollTop : 0;
					panelEl.innerHTML = addPokemonPanelWrapHTML(buildSimilarTeamsSectionHTML(lastSimilarTeamsMatches, curRosterSpeciesOrder(tbRoom)));
					const newRowsEl = panelEl.querySelector('.cf-pika-rows');
					if (newRowsEl && oldScrollTop) newRowsEl.scrollTop = oldScrollTop;
					fillSimilarTeamsIfNotScrollable(tbRoom, formatId);
				}
				return;
			}
			if (!window.CF_Pikalytics || !window.CF_Pikalytics.getTopTeams) {
				panelEl.innerHTML = addPokemonPanelWrapHTML(pikaSectionHTML('Similar Teams', '<p class="cf-pika-empty">No data for this format.</p>'));
				return;
			}

			lastSimilarTeamsKey = key;
			lastSimilarTeamsAllMatches = null;
			lastSimilarTeamsMatches = null;
			lastSimilarTeamsFailed = false;
			const token = ++similarTeamsRenderToken;
			panelEl.innerHTML = addPokemonPanelWrapHTML(pikaSectionHTML('Similar Teams', '<p class="cf-sidebar-placeholder">Loading…</p>'));

			window.CF_Pikalytics.getTopTeams(formatId).then((teams) => {
				if (token !== similarTeamsRenderToken) return; // superseded by a newer request
				const allMatches = aggregateTopTeams(teams, curRosterSpeciesOrder(tbRoom));
				lastSimilarTeamsAllMatches = allMatches;
				if (!allMatches.length) {
					lastSimilarTeamsMatches = allMatches;
					panelEl.innerHTML = addPokemonPanelWrapHTML(buildSimilarTeamsSectionHTML(allMatches, curRosterSpeciesOrder(tbRoom)));
					return null;
				}
				const firstPage = allMatches.slice(0, SIMILAR_TEAMS_PAGE_SIZE);
				return Promise.all(firstPage.map((m) => fetchAndMergeTeamDetail(formatId, m))).then((detailedMatches) => {
					if (token !== similarTeamsRenderToken) return;
					lastSimilarTeamsMatches = detailedMatches;
					panelEl.innerHTML = addPokemonPanelWrapHTML(buildSimilarTeamsSectionHTML(detailedMatches, curRosterSpeciesOrder(tbRoom)));
					fillSimilarTeamsIfNotScrollable(tbRoom, formatId);
				});
			}).catch((e) => {
				if (token !== similarTeamsRenderToken) return;
				lastSimilarTeamsFailed = true;
				console.error('[Better Teambuilder] Similar teams lookup failed:', e);
				panelEl.innerHTML = addPokemonPanelWrapHTML(pikaSectionHTML('Similar Teams', '<p class="cf-pika-empty">Failed to load.</p>'));
			});
		}

		/** Pagination on scroll (onSimilarTeamsScroll, below) — appends the next
		 *  SIMILAR_TEAMS_PAGE_SIZE matches straight onto the existing `.cf-pika-rows` DOM node
		 *  via insertAdjacentHTML, rather than rebuilding the whole section through
		 *  renderSimilarTeamsPanel again: a full rebuild would both refetch nothing new *and*
		 *  reset scroll position back to the top on every page, defeating the point of
		 *  pagination-on-scroll. A trailing "Loading more…" placeholder is appended before the
		 *  fetch and removed once it settles either way, so the user always sees *something* at
		 *  the bottom while a page is in flight rather than a dead scrollbar. No-ops (rather
		 *  than erroring) if nothing has loaded yet, a page is already in flight, or every match
		 *  is already loaded — all real, reachable states from a scroll event that can fire at
		 *  any time. Calls fillSimilarTeamsIfNotScrollable again once the new page lands, same
		 *  as the first page's own render does — see that function's own doc comment for why. */
		function loadMoreSimilarTeams(tbRoom, formatId) {
			if (lastSimilarTeamsLoadingMore || !lastSimilarTeamsAllMatches || !lastSimilarTeamsMatches) return;
			const start = lastSimilarTeamsMatches.length;
			if (start >= lastSimilarTeamsAllMatches.length) return;

			const rowsEl = document.querySelector('#cf-pika-panel .cf-pika-rows');
			if (!rowsEl) return;

			const nextPage = lastSimilarTeamsAllMatches.slice(start, start + SIMILAR_TEAMS_PAGE_SIZE);
			lastSimilarTeamsLoadingMore = true;
			const token = similarTeamsRenderToken;
			const loadingEl = document.createElement('p');
			loadingEl.className = 'cf-sidebar-placeholder';
			loadingEl.textContent = 'Loading more…';
			rowsEl.appendChild(loadingEl);

			Promise.all(nextPage.map((m) => fetchAndMergeTeamDetail(formatId, m))).then((detailed) => {
				lastSimilarTeamsLoadingMore = false;
				loadingEl.remove();
				if (token !== similarTeamsRenderToken) return; // superseded by a newer render
				const startIdx = lastSimilarTeamsMatches.length;
				const rosterSpeciesIds = curRosterSpeciesOrder(tbRoom);
				lastSimilarTeamsMatches = lastSimilarTeamsMatches.concat(detailed);
				const newRowsHTML = detailed.map((m, i) => buildSimilarTeamRowHTML(m, startIdx + i, rosterSpeciesIds)).join('');
				rowsEl.insertAdjacentHTML('beforeend', newRowsHTML);
				fillSimilarTeamsIfNotScrollable(tbRoom, formatId);
			}).catch((e) => {
				lastSimilarTeamsLoadingMore = false;
				loadingEl.remove();
				console.error('[Better Teambuilder] Loading more similar teams failed:', e);
			});
		}

		/** Pagination-on-scroll only ever loads a *later* page in response to an actual `scroll`
		 *  event on `.cf-pika-rows` — but that event can only ever fire once the box is already
		 *  tall enough to need scrolling in the first place. Confirmed live: with a small enough
		 *  match count (or a tall enough sidebar), the first page's rows can fit entirely within
		 *  the visible area without ever overflowing `.cf-pika-rows` at all — no scrollbar ever
		 *  appears, no `scroll` event ever fires, and pagination silently stalls on page 1 no
		 *  matter how many more matches exist. Called right after every page renders (both the
		 *  first, in renderSimilarTeamsPanel, and every later one, in loadMoreSimilarTeams): if
		 *  the box still doesn't overflow after this page and more match data remains, this loads
		 *  the next page immediately rather than waiting for a scroll that may never come — and,
		 *  since it's called again after that page too, keeps doing so until either the box
		 *  actually becomes scrollable (at which point onSimilarTeamsScroll takes over) or every
		 *  match has been loaded. */
		function fillSimilarTeamsIfNotScrollable(tbRoom, formatId) {
			const rowsEl = document.querySelector('#cf-pika-panel .cf-pika-rows');
			if (!rowsEl || rowsEl.scrollHeight > rowsEl.clientHeight) return;
			loadMoreSimilarTeams(tbRoom, formatId);
		}
		// onMouseOver needs the currently-rendered matches by row index (data-cf-similarteam-idx)
		// to build the hover tooltip; onSimilarTeamsScroll needs to trigger the next page — same
		// CF cross-scope handoff as buildSpeedComparisonTooltipHTML (both live outside this
		// closure, since document-level listener registration happens in one place, see the
		// bottom of this file).
		CF.getSimilarTeamMatch = (idx) => lastSimilarTeamsMatches && lastSimilarTeamsMatches[idx];
		CF.loadMoreSimilarTeams = loadMoreSimilarTeams;

		function renderPikalyticsSidebar(tbRoom) {
			const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
			const speciesName = tbRoom.curSet && (tbRoom.curSet.species || tbRoom.curSet.name);
			if (!formatId) {
				ensurePikaPanelEl().innerHTML = '<p class="cf-sidebar-placeholder">Nothing here yet.</p>';
				lastRenderKey = null;
				lastMon = null;
				lastFetchState = null;
				// Invalidates any per-species fetch still in flight from before this state was
				// reached — without this, that fetch's token still matched on resolve, so its
				// (now stale) grid could land here and overwrite this placeholder.
				renderToken++;
				return;
			}
			if (!speciesName) {
				// A freshly-added blank team slot (right after "Add Pokémon", before a species
				// is typed) has a truthy curSet with an empty .species — updateSplitState's
				// isTeamOverview check (curSet falsy) is false here since curSet itself IS set,
				// so this function still gets called rather than renderTeamOverviewPanel. Shows
				// real teams that share species with the roster built so far
				// (renderSimilarTeamsPanel) instead of leaving the panel showing whichever
				// species was rendered last.
				renderSimilarTeamsPanel(tbRoom, formatId);
				lastRenderKey = null;
				lastMon = null;
				lastFetchState = null;
				// Same reasoning as the !formatId branch above — a very reachable path here:
				// type a species (starting a getSpeciesData fetch), then clear the field again
				// before it resolves. Without this, that fetch's stale per-species grid could
				// land on top of the Similar Teams panel this branch just rendered.
				renderToken++;
				return;
			}

			const key = formatId + '|' + speciesName;
			const sidebarEl = ensurePikaPanelEl();

			if (key === lastRenderKey) {
				// Same species/format as the last call. If lastMon is already populated, that's
				// the click-to-apply/native-edit fast path: just re-derive clickable/disabled/
				// equipped state against the (possibly just-changed) current set, no refetch.
				if (lastMon) {
					rebuildSidebarPreservingScroll(sidebarEl, buildPikalyticsSidebarHTML(lastMon, tbRoom));
					return;
				}
				// lastMon is still null: either a fetch for this exact key is already in flight
				// ('pending' — nothing new to do, a duplicate request here would be redundant and
				// resetting the placeholder back to "Loading…" would be pointless churn), or it
				// already settled as genuinely empty ('empty' — Pikalytics has no data for this
				// species; asking again would just get the same answer). Only a settled failure
				// ('failed') falls through below to retry — a transient network hiccup shouldn't
				// permanently strand the sidebar on "Failed to load" until the user switches team
				// slots away and back.
				if (lastFetchState !== 'failed') return;
			}
			lastRenderKey = key;
			lastMon = null;
			lastFetchState = 'pending';

			const token = ++renderToken;
			sidebarEl.innerHTML = '<p class="cf-sidebar-placeholder">Loading Pikalytics data…</p>';

			if (!window.CF_Pikalytics) {
				lastFetchState = 'empty';
				sidebarEl.innerHTML = '<p class="cf-sidebar-placeholder">No data for this format.</p>';
				return;
			}

			window.CF_Pikalytics.getSpeciesData(formatId, speciesName).then((mon) => {
				if (token !== renderToken) return; // superseded by a newer request
				const isEmpty = !mon || (!(mon.moves || []).length && !(mon.abilities || []).length &&
					!(mon.items || []).length && !(mon.natures || []).length &&
					!(mon.team || []).length && !(mon.spreads || []).length);
				if (isEmpty) {
					lastFetchState = 'empty';
					sidebarEl.innerHTML = `<p class="cf-sidebar-placeholder">No data for ${escapeHTML(speciesName)} in this format.</p>`;
					return;
				}
				lastFetchState = 'success';
				lastMon = mon;
				sidebarEl.innerHTML = buildPikalyticsSidebarHTML(mon, tbRoom);
			}).catch((e) => {
				if (token !== renderToken) return; // superseded by a newer request
				lastFetchState = 'failed';
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
		/** True once a lookup for lastSpeedTierFormatId has settled with nothing to show — either
		 *  an outright failure, or (functionally the same thing here: getTopUsageList's own doc
		 *  comment says it "never rejects," so a total failure surfaces as an empty array, not a
		 *  rejected promise) a resolved-but-empty list. Every format in FORMAT_SLUG_MAP is a real,
		 *  actively-tracked Pikalytics format, so a genuinely empty result here is never a stable,
		 *  meaningful answer the way "this one species has no data" is for renderPikalyticsSidebar
		 *  — it always means the lookup didn't actually work (most commonly: getFormatMeta's
		 *  discovery fetch failed because the species used to bootstrap it, see speciesHint below,
		 *  isn't indexed at Pikalytics' AI-pokedex endpoint). Without this flag, `formatId ===
		 *  lastSpeedTierFormatId` alone permanently blocked any retry for that format — even after
		 *  switching to a completely different, definitely-indexed species — since nothing but a
		 *  format change or leaving the teambuilder ever reset lastSpeedTierFormatId. */
		let lastSpeedTierFailed = false;
		/** Whether the last render was for a blank slot — tracked alongside
		 *  lastSpeedTierFormatId (not folded into one composite key) because the two need
		 *  different staleness rules: a format change always means genuinely new data to fetch,
		 *  but a blank-state flip within the *same* format (e.g. picking a species finishes the
		 *  slot, or backing out of that pick reopens a blank one) is just redrawing the exact
		 *  same already-fetched lastSpeedTierList with a different header/coloring/clickability
		 *  — no refetch needed, see the branch below. */
		let lastSpeedTierBlank = null;
		function renderSpeedTierColumn(tbRoom) {
			const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
			// Falls back to any already-added roster member's species when the currently-open
			// slot is blank (curSet.species/.name empty) — confirmed live: an empty species
			// hint sends discoverMonthAndCutoff's discovery fetch to Pikalytics' plain FORMAT
			// overview page (no species in the URL) rather than a per-species one, and that
			// page has "**Data Date**" but no "{slug}-{cutoff}" pattern anywhere on it, so the
			// cutoff regex never matches and the whole discovery throws — silently emptying
			// out the "Popular" list on the very first "Add Pokémon" click of a cold format
			// (before any real species has ever been queried in it), even though the roster
			// already has a perfectly good real species sitting right there to discover
			// through instead. Only genuinely unrecoverable when the roster itself is *also*
			// empty (no species anywhere to discover through at all) — same case
			// renderSimilarTeamsPanel already shows "No Pokémon on your team yet." for.
			const speciesHint = (tbRoom.curSet && (tbRoom.curSet.species || tbRoom.curSet.name)) ||
				((tbRoom.curSetList || []).find((s) => s && s.species) || {}).species;
			const colEl = document.getElementById('cf-speedtier-col');
			if (!colEl) return;
			const blank = isBlankSlot(tbRoom);

			if (!formatId || !window.CF_Pikalytics || !window.CF_Pikalytics.getTopUsageList) {
				colEl.innerHTML = speedTierColumnHTML(blank ? 'Popular' : 'Speed', '<p class="cf-sidebar-placeholder">No data.</p>');
				lastSpeedTierFormatId = null;
				lastSpeedTierBlank = null;
				lastSpeedTierList = null;
				lastSpeedTierFailed = false;
				// Invalidates any fetch still in flight from before this state was reached (e.g.
				// a brief no-team moment mid team-switch) — without this, that fetch's token
				// still matched on resolve, so its (now stale) results could land here and
				// overwrite this "No data" placeholder, the same class of bug fixed in
				// renderSimilarTeamsPanel's own empty-roster branch above.
				speedTierRenderToken++;
				return;
			}
			// Same format as last time AND that lookup didn't fail: nothing new to *fetch*,
			// whether it's still in flight (lastSpeedTierFailed hasn't had a chance to flip yet)
			// or already succeeded (lastSpeedTierList is already showing). Still redrawn from the
			// already-fetched list (cheap, no refetch) whenever `blank` is true — unlike the
			// "Speed" comparison view, blank-slot rendering (coverage coloring, already-on-team
			// disabling, click targets) reads live tbRoom.curSetList, which can change without
			// `blank` itself ever flipping (e.g. switching from one team to a same-format, empty
			// one while both happen to be sitting on a blank "Add Pokémon" slot) — confirmed
			// live: without this, the column kept showing the previous team's coverage
			// colors/disabled species after switching teams. Also redrawn on a blank-state flip
			// even when *not* currently blank, to redraw once back to the plain "Speed" header/
			// non-clickable rows.
			if (formatId === lastSpeedTierFormatId && !lastSpeedTierFailed) {
				if (lastSpeedTierList && (blank || blank !== lastSpeedTierBlank)) {
					lastSpeedTierBlank = blank;
					colEl.innerHTML = buildSpeedTierColumnHTML(lastSpeedTierList, tbRoom);
				}
				return;
			}
			lastSpeedTierFormatId = formatId;
			lastSpeedTierBlank = blank;

			const token = ++speedTierRenderToken;
			colEl.innerHTML = speedTierColumnHTML(blank ? 'Popular' : 'Speed', '<p class="cf-sidebar-placeholder">Loading…</p>');
			lastSpeedTierList = null;
			lastSpeedTierFailed = false;

			window.CF_Pikalytics.getTopUsageList(formatId, speciesHint, 20).then((list) => {
				if (token !== speedTierRenderToken) return; // superseded by a newer request
				lastSpeedTierFailed = !list || !list.length;
				lastSpeedTierList = list;
				colEl.innerHTML = buildSpeedTierColumnHTML(list, tbRoom);
			}).catch((e) => {
				if (token !== speedTierRenderToken) return;
				lastSpeedTierFailed = true;
				console.error('[Better Teambuilder] Speed tier usage list lookup failed:', e);
				colEl.innerHTML = speedTierColumnHTML(isBlankSlot(tbRoom) ? 'Popular' : 'Speed', '<p class="cf-sidebar-placeholder">Failed to load.</p>');
			});
		}

		/** Team-overview screen (isTeamOverview: a team is open, curRoom is the teambuilder room,
		 *  but no slot within it is being edited — the screen showing all 6 roster icons
		 *  together). The left column is hidden entirely here (updateSplitState's
		 *  cf-teambuilder-team-overview body class + style.css), so this function only ever
		 *  touches #cf-pika-panel, via its own three independent sub-panels (see
		 *  ensureTeamOverviewPanelEls): the Speed Spread section and the Defensive Profile matrix
		 *  — both real per-member data, entirely synchronous (curSetList + tbRoom.getStat/
		 *  window.Dex, no Pikalytics fetch, no loading state needed) — and the Biggest Threats
		 *  section, which does need a real fetch and is handed off to renderTeamThreatsSection
		 *  below rather than built inline here.
		 *
		 *  Still resets every piece of per-slot render state (lastRenderKey/lastMon/
		 *  lastSpeedTier.../lastSimilarTeams... — see their own doc comments above) the same way
		 *  leaving `active` entirely already did, so switching from here into editing a real slot
		 *  can't fast-path off of stale cached state from before the team-overview screen was
		 *  reached. */
		function renderTeamOverviewPanel(tbRoom) {
			lastRenderKey = null;
			lastMon = null;
			lastFetchState = null;
			renderToken++;
			lastSimilarTeamsKey = null;
			lastSimilarTeamsAllMatches = null;
			lastSimilarTeamsMatches = null;
			lastSimilarTeamsFailed = false;
			similarTeamsRenderToken++;

			const panelEl = ensurePikaPanelEl();
			const { spectrumEl, threatsEl, defMatrixEl } = ensureTeamOverviewPanelEls(panelEl);
			// Deliberately NOT addPokemonPanelWrapHTML — that exists to give a lone section the
			// height:100%-fill + internal-scroll behavior a genuinely scrollable list (Similar
			// Teams) needs, via .cf-pika-grid, which also caps width at
			// --cf-teambuilder-max-width (653px) so the *other*, row-based sections' name/percent
			// columns don't stretch apart awkwardly on a wide window. The Speed Spread diagram is
			// neither scrollable (its own height is already computed to fit its content, see
			// buildSpeedSpectrumHTML) nor row-based — it's a diagram that gets clearer with more
			// width, not less — so it's dropped straight into its own wrapper instead, free to use
			// the panel's own full width now that the narrow column next to it is gone too (see
			// updateSplitState's cf-teambuilder-team-overview body class). The Defensive Profile
			// matrix and Biggest Threats instead share a row (#cf-teamoverview-row,
			// ensureTeamOverviewPanelEls' own comment) — the matrix sized to its own natural
			// content width, Threats' square grid taking whatever room that leaves.
			spectrumEl.innerHTML = buildSpeedSpectrumHTML(computeSpeedSpectrumEntries(tbRoom), computeSpeedSpectrumDomain(tbRoom));
			renderDefensiveProfileSection(tbRoom, defMatrixEl);
			renderTeamThreatsSection(tbRoom, threatsEl);
		}

		/** Per-slot UI toggle state for the Defensive Profile matrix (renderDefensiveProfileSection/
		 *  onDefMatrixClick) — 0-based indices into the *filtered* real-species roster (same
		 *  indexing computeTeamDefensiveProfile's own `baseFormeSlots` param and
		 *  buildTeamDefensiveProfileHTML's own data-cf-defmatrix-member-idx use) of a Mega-capable
		 *  member currently toggled to show its base forme instead of the default Mega. Module-
		 *  level, not reset on every renderTeamOverviewPanel call (a window resize, say) the way
		 *  lastRenderKey/lastSimilarTeamsKey/etc. above are — those guard against fast-pathing off
		 *  stale *fetched* data, but there's nothing to invalidate here: a toggled index that no
		 *  longer points at a real Mega-capable slot (the roster changed) is already a harmless
		 *  no-op by construction (computeTeamDefensiveProfile's own doc comment), so there's
		 *  nothing gained by clearing it — and clearing it here would instead throw away a real,
		 *  still-valid user choice on every unrelated re-render, which is exactly the bug class
		 *  the "don't refetch/redraw when nothing actually changed" pattern elsewhere in this file
		 *  exists to avoid. */
		let defMatrixBaseFormeSlots = new Set();

		function renderDefensiveProfileSection(tbRoom, defMatrixEl) {
			defMatrixEl.innerHTML = buildTeamDefensiveProfileHTML(computeTeamDefensiveProfile(tbRoom, defMatrixBaseFormeSlots));
		}

		/** Toggles one Defensive Profile member (buildTeamDefensiveProfileHTML's own
		 *  data-cf-defmatrix-member-idx, only present on a Mega-capable member's header cell)
		 *  in/out of defMatrixBaseFormeSlots and redraws just this section — not the whole
		 *  team-overview panel, since Speed Spread/Biggest Threats have nothing to do with this
		 *  toggle. Exposed on CF (cross-scope handoff, same as CF.getSimilarTeamMatch/
		 *  CF.getTeamThreat above) rather than becoming its own registered document listener:
		 *  onPikaSidebarClick (top-level, already registered at the bottom of this file) is where
		 *  this actually gets called from — see that function's own updated doc comment. */
		CF.toggleDefMatrixMember = (idx) => {
			if (defMatrixBaseFormeSlots.has(idx)) defMatrixBaseFormeSlots.delete(idx);
			else defMatrixBaseFormeSlots.add(idx);
			const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
			const defMatrixEl = document.getElementById('cf-defmatrix-wrap');
			if (tbRoom && defMatrixEl) renderDefensiveProfileSection(tbRoom, defMatrixEl);
		};

		/** Biggest Threats: the team-overview screen's second sub-panel (see
		 *  ensureTeamOverviewPanelEls/renderTeamOverviewPanel above). Fetches every roster
		 *  member's own `counters` list (window.CF_Pikalytics.getSpeciesData — the same call
		 *  renderPikalyticsSidebar already makes per-species, just fired once per roster member
		 *  here instead of once for whichever single Pokémon is being edited) and hands the
		 *  results to the pure aggregateTeamThreats to rank.
		 *
		 *  Keyed the same way renderSimilarTeamsPanel is (format + rosterSpeciesKey, order-
		 *  independent) so an unrelated re-render of this screen — most commonly a window resize,
		 *  since nothing on the team-overview screen itself can edit a slot — redraws for free
		 *  rather than refetching: getSpeciesData's own two-tier cache would make a refetch cheap
		 *  anyway, but skipping it here also avoids flashing the section back to "Loading…" for
		 *  no reason. The key lives on threatsEl's own dataset, NOT a module-level variable —
		 *  confirmed live: renderPikalyticsSidebar (editing a real slot) reuses this exact
		 *  #cf-pika-panel via ensurePikaPanelEl and fully replaces its innerHTML, destroying
		 *  threatsEl (and ensureTeamOverviewPanelEls' sibling wrapper) outright. A module-level
		 *  key surviving that round trip would then wrongly match against a brand-new, still-
		 *  empty threatsEl the next time the team-overview screen is reached with the same
		 *  roster/format — "already showing this" would be true of the key but false of the
		 *  actual DOM, permanently skipping the render. Tying the key to the element itself makes
		 *  that impossible: a fresh element has no dataset key at all, so it can never falsely
		 *  match. Both "no roster yet" and "no data for this format" clear the key (rather than
		 *  caching a negative result under it) for the same reason renderSpeedTierColumn's own
		 *  no-formatId branch does — neither is a stable answer worth blocking a later real
		 *  attempt on, and both also bump the render token to invalidate any fetch still in
		 *  flight from before that state was reached.
		 *
		 *  Two fetch stages, not one: the first Promise.all gets every roster member's own
		 *  `counters` (just enough for aggregateTeamThreats to rank every real threat), and only
		 *  once that ranking picks the top TEAM_THREATS_MAX_ROWS does a second Promise.all fetch
		 *  *those* threats' own species data (moves/spreads/natures — enrichTeamThreat's raw
		 *  material for computeThreatReasons) — fetching that for every threat that shows up
		 *  anywhere in anyone's counters list, most of which will never make the visible cut,
		 *  would be real wasted network/compute for no visible benefit. lastTeamThreats (module-
		 *  level, alongside CF.getTeamThreat below) is the enriched result of that second stage —
		 *  what the hover tooltip (onMouseOver's own .cf-teamthreats-square branch) actually
		 *  reads, by the same by-index convention buildSimilarTeamRowHTML's own hover lookup
		 *  already uses. */
		let lastTeamThreats = null;
		let teamThreatsRenderToken = 0;
		function renderTeamThreatsSection(tbRoom, threatsEl) {
			const roster = (tbRoom.curSetList || []).filter((s) => s && s.species);
			if (!roster.length) {
				threatsEl.innerHTML = pikaSectionHTML('Biggest Threats', '<p class="cf-pika-empty">No Pokémon on your team yet.</p>');
				delete threatsEl.dataset.cfTeamThreatsKey;
				lastTeamThreats = null;
				teamThreatsRenderToken++;
				return;
			}
			const formatId = tbRoom.curTeam && tbRoom.curTeam.format;
			if (!formatId || !window.CF_Pikalytics || !window.CF_Pikalytics.getSpeciesData) {
				threatsEl.innerHTML = pikaSectionHTML('Biggest Threats', '<p class="cf-pika-empty">No data for this format.</p>');
				delete threatsEl.dataset.cfTeamThreatsKey;
				lastTeamThreats = null;
				teamThreatsRenderToken++;
				return;
			}

			const key = formatId + '|' + rosterSpeciesKey(tbRoom);
			if (key === threatsEl.dataset.cfTeamThreatsKey) return; // already showing (or loading) this exact roster

			threatsEl.dataset.cfTeamThreatsKey = key;
			const token = ++teamThreatsRenderToken;
			threatsEl.innerHTML = pikaSectionHTML('Biggest Threats', '<p class="cf-sidebar-placeholder">Loading…</p>');

			Promise.all(roster.map((set) =>
				window.CF_Pikalytics.getSpeciesData(formatId, set.species).then((mon) => ({
					member: set.species,
					counters: mon && Array.isArray(mon.counters) ? mon.counters : null,
				}))
			)).then((perMemberCounters) => {
				if (token !== teamThreatsRenderToken) return; // superseded by a newer render
				const ranked = aggregateTeamThreats(perMemberCounters).slice(0, TEAM_THREATS_MAX_ROWS);
				if (!ranked.length) {
					lastTeamThreats = [];
					threatsEl.innerHTML = buildTeamThreatsSectionHTML([]);
					return;
				}
				// Returned (not fire-and-forget) so a rejection/throw in here is caught by the
				// .catch below too, not just the outer Promise.all's own — without this, an error
				// here would be an unhandled rejection this function never learns about at all.
				return Promise.all(ranked.map((t) => window.CF_Pikalytics.getSpeciesData(formatId, t.pokemon))).then((mons) => {
					if (token !== teamThreatsRenderToken) return; // superseded by a newer render
					lastTeamThreats = ranked.map((t, i) => enrichTeamThreat(tbRoom, t, mons[i]));
					threatsEl.innerHTML = buildTeamThreatsSectionHTML(lastTeamThreats);
				});
			}).catch((e) => {
				if (token !== teamThreatsRenderToken) return; // superseded by a newer render
				// Clears the key (rather than leaving it set) so the next real render attempt —
				// a roster/format change, or just reopening this screen — retries from scratch
				// instead of the guard at this function's own top silently treating the failed
				// key as "already showing (or loading)" forever.
				delete threatsEl.dataset.cfTeamThreatsKey;
				lastTeamThreats = null;
				console.error('[Better Teambuilder] Team threats lookup failed:', e);
				threatsEl.innerHTML = pikaSectionHTML('Biggest Threats', '<p class="cf-pika-empty">Failed to load.</p>');
			});
		}
		// onMouseOver needs the currently-rendered, already-enriched threats by square index
		// (data-cf-teamthreats-idx) to build the hover tooltip — same CF cross-scope handoff as
		// CF.getSimilarTeamMatch above, since lastTeamThreats itself lives inside this closure.
		CF.getTeamThreat = (idx) => lastTeamThreats && lastTeamThreats[idx];

		function updateSplitState() {
			const tbRoom = window.app.rooms && window.app.rooms['teambuilder'];
			// tbRoom.curTeam is truthy once a specific team is open (whether or not a slot within
			// it is also being edited — see isTeamOverview's own doc comment) and null on the
			// outer "all your teams" list screen, confirmed live — required here so the split
			// doesn't turn on (and fall through to renderPikalyticsSidebar/renderSpeedTierColumn
			// or renderTeamOverviewPanel, none of which have anything real to show) on that outer
			// list screen, which curSet alone can't tell apart from the team-overview screen.
			const teamIsOpen = !!(window.app.curRoom === tbRoom && tbRoom && tbRoom.curTeam);
			const active = teamIsOpen && !window.app.sideRoom && window.innerWidth >= SPLIT_THRESHOLD;
			if (active) {
				ensureTeambuilderSidebarEl();
				if (isTeamOverview(tbRoom)) {
					try { renderTeamOverviewPanel(tbRoom); } catch (e) {
						console.error('[Better Teambuilder] renderTeamOverviewPanel failed:', e);
					}
				} else {
					try { renderPikalyticsSidebar(tbRoom); } catch (e) {
						console.error('[Better Teambuilder] renderPikalyticsSidebar failed:', e);
					}
					try { renderSpeedTierColumn(tbRoom); } catch (e) {
						console.error('[Better Teambuilder] renderSpeedTierColumn failed:', e);
					}
				}
			} else {
				lastRenderKey = null; // force a fresh render next time the sidebar becomes active
			}
			document.body.classList.toggle('cf-teambuilder-split', active);
			// Hides #cf-speedtier-col entirely on the team-overview screen (style.css) — there's
			// nothing assigned to that column there (see renderTeamOverviewPanel's own comment),
			// and #cf-pika-panel's existing `flex: 1 1 auto` already expands to take the freed
			// width on its own once the column is gone, no extra sizing rule needed here.
			document.body.classList.toggle('cf-teambuilder-team-overview', active && isTeamOverview(tbRoom));
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
		// updateNature, not just natureChange: the EV box's own "252+"/"252-" nature-shortcut
		// syntax sets curSet.nature via a direct call to updateNature() that never touches
		// natureChange() at all — see the doc comment above for how this was confirmed against
		// Showdown's own statChange source.
		wrapWithSplitUpdate(window.TeambuilderRoom.prototype, 'updateNature');

		window.addEventListener('resize', updateSplitState);

		// Check on initial load: if the teambuilder is already the active room by the time
		// this patches in (e.g. extension loaded on an already-open /teambuilder page),
		// neither hook above will fire again on its own until the next state change.
		updateSplitState();
	}

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
		CF_SETTINGS = settings;
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
		document.addEventListener('scroll', onSimilarTeamsScroll, true);
		document.addEventListener('click', onSpeedFilterClick, true);
		document.addEventListener('input', onSpeedFilterInput, true);
		document.addEventListener('focusin', onPikaSidebarFocusChange, true);
		document.addEventListener('focusout', onPikaSidebarFocusChange, true);
		document.addEventListener('click', onPikaSidebarClick, true);
	});
})();
