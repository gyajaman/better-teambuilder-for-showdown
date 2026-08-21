/**
 * Better Teambuilder for Showdown! — Pikalytics data client.
 *
 * Runs in the page's MAIN world alongside content.js (see manifest.json), which is why this
 * uses plain web-platform fetch()/localStorage rather than chrome.storage: MAIN-world content
 * scripts have no access to chrome.* extension APIs (that's why settings-bridge.js has to run
 * in the isolated world and hand data across via a DOM attribute) but fetch/localStorage are
 * just page APIs, available here the same as they'd be to Showdown's own script. localStorage
 * entries are kept under clearly namespaced key prefixes (FORMAT_META_PREFIX,
 * SPECIES_CACHE_PREFIX) so they can never collide with Showdown's own use of the same
 * origin's localStorage (e.g. Storage.teams).
 *
 * Pikalytics (https://pikalytics.com) publishes competitive usage stats behind three
 * different endpoints:
 *
 *   GET /api/l/{YYYY-MM}/{slug}-{cutoff}          — bulk JSON, meant to cover every Pokémon
 *                                                    in a format in one request, BUT
 *                                                    (confirmed live, both gen9ou and VGC)
 *                                                    only the single #1-ranked-by-usage entry
 *                                                    actually has move/item/ability/nature/
 *                                                    spread/teammate data — every other
 *                                                    entry, however popular, only has name/
 *                                                    rank/winrate/types. Useless for a given
 *                                                    species' own data (that's what /api/p/
 *                                                    below is for) but that name+rank list is
 *                                                    exactly the ranked usage order
 *                                                    getTopUsageList needs, and it's the only
 *                                                    endpoint that gives the whole format's
 *                                                    ranking in one request — see
 *                                                    fetchUsageList.
 *   GET /ai/pokedex/{slug}/{species}              — lightweight per-species Markdown, does
 *                                                    have full data for any rank, BUT only a
 *                                                    single "top build" nature+EV spread (one
 *                                                    FAQ sentence) rather than a ranked list,
 *                                                    doesn't include a move's type, and has
 *                                                    real gaps for some formats (confirmed
 *                                                    live: VGC teammates render as the literal
 *                                                    text "undefined%" in this endpoint).
 *   GET /api/p/{YYYY-MM}/{slug}-{cutoff}/{species} — per-species JSON — what the real
 *                                                    pikalytics.com per-Pokémon page itself
 *                                                    fetches. Same rich shape the bulk
 *                                                    endpoint gives its one lucky #1 entry
 *                                                    (full moves-with-type, full ranked
 *                                                    natures, full ranked spreads, structured
 *                                                    teammates/counters/faq), but for *any*
 *                                                    Pokémon regardless of rank — confirmed
 *                                                    live for a rank-34 VGC Pokémon. This is
 *                                                    the one actually used below.
 *
 * The catch with /api/p/ is it needs the same {YYYY-MM} month and {cutoff} the bulk endpoint
 * does, neither of which is derivable from today's date or guessable reliably (see
 * discoverMonthAndCutoff). The /ai/pokedex/{slug}/{species} response — otherwise not used for
 * its own data anymore, per above — conveniently states both in plain text ("**Data Date**:
 * YYYY-MM" and a "## FAQ for {species} in {slug}-{cutoff}" heading), so it's fetched first
 * purely to extract those two values, then /api/p/ is fetched for the actual data. Two
 * requests per species on a cold fetch, but both are small and it's all cached afterward.
 *
 * CORS is wide open on all of these, confirmed reachable directly from
 * play.pokemonshowdown.com's own page context (no host_permissions needed: this is a plain
 * fetch(), subject to the page's own CSP, which already allows it — not a privileged
 * cross-origin bypass).
 */
(function () {
	if (window.__CF_PIKALYTICS_LOADED) return;
	window.__CF_PIKALYTICS_LOADED = true;

	/** Deliberate, explicit allowlist — NOT a "matches unless overridden" default. A format
	 *  not listed here is "no data," full stop, even if Pikalytics happens to have a
	 *  same-named slug (e.g. gen9championsvgc2026regma matches Pikalytics' own
	 *  "gen9championsvgc2026regma" — Showdown-ladder data — directly, but is deliberately
	 *  NOT used that way; see below). Scoped to Pokemon Champions VGC regulations only —
	 *  Smogon tiers (OU/UU/etc, any gen), National Dex, Battle Spot Singles, are all out of
	 *  scope by choice, not oversight.
	 *
	 *  Bo1 and Bo3 deliberately use different data sources, not just different slugs of the
	 *  same source, because they're actually played in different places: Bo1 is the official
	 *  matchmaking ladder, so ranked battle data (official Nintendo game data, the
	 *  "battledatareg*" slugs — Pikalytics' own primary/default source for current VGC, with
	 *  a far larger sample than the Showdown-specific ladder data) is the right fit. Bo3 is
	 *  NOT played on that ladder at all — it's tournament-only — so it's mapped to
	 *  Pikalytics' tournament-aggregate data instead ("championstournaments" for the
	 *  *current* regulation, "championstournamentsregma" pinned specifically to Reg M-A —
	 *  confirmed live, its title literally reads "...TournamentsREGMA").
	 *
	 *  Only Reg M-A and Reg M-B are mapped. Reg M-A is realistically dead (nobody's playing
	 *  it anymore) — it's kept anyway as the base pattern for whoever adds Reg M-C when it
	 *  ships: same shape, one more {regX -> ranked data, regXbo3 -> tournament data} pair.
	 *  Note "championstournaments" (no reg suffix) tracks whatever the *current* regulation
	 *  is — it'll silently start meaning Reg M-C's tournaments the moment that regulation
	 *  goes live, at which point gen9championsvgc2026regmbbo3 below should be re-pointed to
	 *  a still-to-exist "championstournamentsregmb"-shaped pin (mirroring regma's), the same
	 *  way battledataregmbs3 will eventually need succeeding by a Reg M-C ranked-data slug. */
	const FORMAT_SLUG_MAP = {
		gen9championsvgc2026regmb: 'battledataregmbs3',
		gen9championsvgc2026regmbbo3: 'championstournaments',
		gen9championsvgc2026regma: 'battledataregmas2',
		gen9championsvgc2026regmabo3: 'championstournamentsregma',
	};

	const FORMAT_META_PREFIX = 'cf_pikalytics_meta_';
	const SPECIES_CACHE_PREFIX = 'cf_pikalytics_cache_';
	const USAGE_LIST_CACHE_PREFIX = 'cf_pikalytics_usagelist_';
	/** Fields the /api/p/ payload carries as arrays (confirmed live) — fetchSpeciesData
	 *  rejects a response where one of these is present but not actually an array, since
	 *  content.js's `mon.moves || []`-style guards only catch a falsy value, not a truthy
	 *  non-array, and would throw trying to .map/.filter/for-of it otherwise. */
	const ARRAY_FIELDS = ['moves', 'items', 'abilities', 'natures', 'spreads', 'team'];
	/** How long a cache entry is used without checking for a fresher one — applies to both
	 *  tiers below. Generous on purpose: Pikalytics' own data is labeled by month ("2026-05")
	 *  and, confirmed live, does not move faster than that. This does NOT mean up to a day of
	 *  staleness once a new month actually goes live, though — see the two-tier design below. */
	const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

	/** Bumped whenever a code change could make an old cache entry wrong in a way TTL expiry
	 *  alone wouldn't catch — e.g. changing a FORMAT_SLUG_MAP entry, or (this file has now
	 *  been through several of these) switching data sources/shapes entirely. An entry
	 *  written under an older version is treated the same as no entry at all (readCache just
	 *  returns null), so a change like that takes effect immediately for every user on next
	 *  lookup — no manual "clear your cache" step, and nothing to remember to do for the next
	 *  fix either. Shared by both cache tiers — bump it for either kind of change. */
	const CACHE_VERSION = 8;

	/** Two-tier cache, so a new month goes live for everyone within CACHE_TTL_MS, not up to
	 *  CACHE_TTL_MS *per species already looked up*:
	 *
	 *   1. Format-level {month, cutoff} (getFormatMeta) — one entry per format, TTL-checked
	 *      independently of any species. Cheap to refresh (a single small request).
	 *   2. Per-species data (getSpeciesData) — records which {month, cutoff} it was fetched
	 *      under. Even within its own TTL, a species entry is treated as stale the moment the
	 *      format-level check (tier 1) discovers a *different* month/cutoff than the one it
	 *      was fetched under — so a month rollover invalidates every cached species in that
	 *      format as soon as it's next noticed, not on each species' own independent clock.
	 *
	 *  In steady state (no new month) this costs exactly one extra small request per format
	 *  per CACHE_TTL_MS window, shared across every species looked up in that format — not
	 *  one per species. */

	/** Returns the Pikalytics slug for a Showdown format id, or undefined if it's not in the
	 *  allowlist above — deliberately no "assume it matches" fallback (see FORMAT_SLUG_MAP's
	 *  doc comment). */
	function slugFor(formatId) {
		return FORMAT_SLUG_MAP[formatId];
	}

	/** Mega Evolution and Primal Reversion are in-battle-only transformations — you build the
	 *  set as the base species holding the Mega Stone, Showdown just auto-fills that item and
	 *  labels the species with its Mega name when you pick it from the species search
	 *  (species.battleOnly is how Showdown's own Dex marks this — a lot of players build
	 *  Megas exactly this way, via that species-search entry, rather than manually setting
	 *  the item). Pikalytics tracks usage under the base species for the same reason:
	 *  confirmed live, Mega Blastoise's moves/items — including Blastoisinite itself — show
	 *  up under the plain "Blastoise" page, there's no separate "Blastoise-Mega" entry at
	 *  all. Regional formes and Gmax are deliberately NOT collapsed here — they're
	 *  independently viable, independently tiered Pokémon with their own usage entries
	 *  (confirmed live: e.g. "Ninetales-Alola" has its own page, distinct from "Ninetales"). */
	function resolveQuerySpecies(speciesName) {
		const species = window.Dex && window.Dex.species.get(speciesName);
		if (!species || !species.exists) return speciesName;
		return species.battleOnly ? species.baseSpecies : species.name;
	}

	function toID(s) {
		return (window.toID || ((x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '')))(s);
	}

	function readEntry(prefix, key) {
		try {
			const raw = localStorage.getItem(prefix + key);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			return parsed.version === CACHE_VERSION ? parsed : null;
		} catch (e) {
			return null;
		}
	}

	function writeEntry(prefix, key, entry) {
		entry = Object.assign({ version: CACHE_VERSION }, entry);
		try {
			localStorage.setItem(prefix + key, JSON.stringify(entry));
		} catch (e) {
			// Storage full/unavailable (e.g. private browsing) — degrade to no caching
			// rather than breaking the feature.
		}
		return entry;
	}

	function escapeRegExp(s) {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/** Extracts {month, cutoff} from the /ai/pokedex/{slug}/{species} Markdown response — see
	 *  the module doc comment for why this indirection exists. Both are plain-text-embedded:
	 *  "**Data Date** | YYYY-MM" and a "## FAQ for {species} in {slug}-{cutoff}" heading.
	 *  Throws if either can't be found (caller treats that as "no data"). */
	function discoverMonthAndCutoff(slug, querySpecies) {
		return fetch(`https://pikalytics.com/ai/pokedex/${slug}/${encodeURIComponent(querySpecies)}`)
			.then((r) => (r.ok ? r.text() : Promise.reject(new Error('status ' + r.status))))
			.then((text) => {
				const monthMatch = text.match(/\*\*Data Date\*\*:?\s*\|?\s*(\d{4}-\d{2})/);
				const cutoffMatch = text.match(new RegExp(escapeRegExp(slug) + '-(\\d+)'));
				if (!monthMatch || !cutoffMatch) throw new Error('could not find Data Date / rating cutoff in AI pokedex response');
				return { month: monthMatch[1], cutoff: cutoffMatch[1] };
			});
	}

	/** Tier 1 of the cache (see the module comment above) — {month, cutoff} for a format,
	 *  shared across every species lookup in it. `querySpeciesHint` only matters on a cache
	 *  miss, as the species to discover *through* (see discoverMonthAndCutoff — there's no
	 *  format-only variant of that endpoint). Falls back to a stale meta entry (rather than
	 *  null) if discovery fails, so a transient Pikalytics hiccup doesn't take down lookups
	 *  for species that already have their own valid cache.
	 *
	 *  Also dedups concurrent discovery requests for the same slug via formatMetaInFlight:
	 *  switching between two species in the same format faster than one discovery fetch
	 *  resolves would otherwise start a second, redundant /ai/pokedex/ request for a slug
	 *  already being looked up. */
	const formatMetaInFlight = new Map();
	function getFormatMeta(slug, querySpeciesHint) {
		const cached = readEntry(FORMAT_META_PREFIX, slug);
		if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
			return Promise.resolve(cached);
		}
		if (formatMetaInFlight.has(slug)) return formatMetaInFlight.get(slug);
		const promise = discoverMonthAndCutoff(slug, querySpeciesHint)
			.then(({ month, cutoff }) => writeEntry(FORMAT_META_PREFIX, slug, { month, cutoff, fetchedAt: Date.now() }))
			.catch(() => cached || null)
			.finally(() => formatMetaInFlight.delete(slug));
		formatMetaInFlight.set(slug, promise);
		return promise;
	}

	/** Fetches the real per-species data. Confirmed live: this "succeeds" (HTTP 200) even for
	 *  a wrong cutoff or a nonexistent species, just with a body that isn't a real data object
	 *  — a wrong cutoff returns the 5-byte literal text "false", a nonexistent species returns
	 *  an empty body — so both are treated as failure here rather than trusting the status
	 *  code alone. */
	function fetchSpeciesData(month, slug, cutoff, querySpecies) {
		return fetch(`https://pikalytics.com/api/p/${month}/${slug}-${cutoff}/${encodeURIComponent(querySpecies)}`)
			.then((r) => (r.ok ? r.text() : null))
			.then((text) => {
				if (!text) return null;
				let data;
				try { data = JSON.parse(text); } catch (e) { return null; }
				if (!data || typeof data !== 'object' || !data.name) return null;
				for (const field of ARRAY_FIELDS) {
					if (data[field] !== undefined && !Array.isArray(data[field])) return null;
				}
				return data;
			})
			.catch(() => null);
	}

	/** Returns a Promise resolving to the raw Pikalytics per-species object (moves/items/
	 *  abilities/natures/spreads/team/counters/teams/faq — see the module doc comment) for a
	 *  Showdown format id + species name, or null if unavailable. Never rejects. A format not
	 *  in FORMAT_SLUG_MAP resolves to null immediately, no network at all — that's the
	 *  allowlist doing its job, not a fallback for a missing mapping. Mega/Primal species are
	 *  resolved to their base species first (see resolveQuerySpecies) before either querying
	 *  or reading/writing the cache, so e.g. "Blastoise-Mega" and "Blastoise" share one cache
	 *  entry.
	 *
	 *  Tier 2 of the cache (see the module comment above): a cached entry is only served as-is
	 *  when it's both within CACHE_TTL_MS *and* still matches the format's current
	 *  {month, cutoff} per tier 1 — so it can go stale earlier than its own TTL if a new
	 *  month/cutoff shows up first. Falls back to a stale species entry (rather than nothing)
	 *  if the refetch fails, e.g. Pikalytics is briefly down. */
	/** Shared tier-2 cache/fetch sequence behind getSpeciesData and getUsageList below (see the
	 *  module doc comment's two-tier cache design) — both need the identical "check format meta
	 *  -> serve a still-current cached entry -> otherwise fetch, cache, and return the fresh
	 *  result, falling back to a stale cached entry if the fetch fails" sequence, differing only
	 *  in which cache prefix/key they read/write and which endpoint they fetch. `fetchFn(meta)`
	 *  is that one varying piece — call the actual /api/p/ or /api/l/ endpoint and resolve to its
	 *  parsed result, or null on failure. */
	function getCachedOrFetch(slug, cachePrefix, cacheKey, querySpeciesHint, fetchFn) {
		return getFormatMeta(slug, querySpeciesHint).then((meta) => {
			const cached = readEntry(cachePrefix, cacheKey);
			if (!meta) return cached ? cached.data : null;

			const cacheIsCurrent = cached &&
				cached.month === meta.month && cached.cutoff === meta.cutoff &&
				(Date.now() - cached.fetchedAt) < CACHE_TTL_MS;
			if (cacheIsCurrent) return cached.data;

			return fetchFn(meta).then((data) => {
				if (!data) return cached ? cached.data : null;
				writeEntry(cachePrefix, cacheKey, { month: meta.month, cutoff: meta.cutoff, data, fetchedAt: Date.now() });
				return data;
			});
		});
	}

	function getSpeciesData(formatId, speciesName) {
		const slug = slugFor(formatId);
		if (!slug) return Promise.resolve(null);

		const querySpecies = resolveQuerySpecies(speciesName);
		const speciesKey = formatId + '|' + toID(querySpecies);

		return getCachedOrFetch(slug, SPECIES_CACHE_PREFIX, speciesKey, querySpecies,
			(meta) => fetchSpeciesData(meta.month, slug, meta.cutoff, querySpecies));
	}

	/** Fetches the bulk /api/l/ list purely for its name+rank ordering (see the module doc
	 *  comment — every other field on a non-#1 entry is missing/unusable). Confirmed live: the
	 *  208 entries already arrive in rank order, but sorted defensively here anyway rather than
	 *  trusting that to stay true. Same "200 OK with garbage body" failure mode as
	 *  fetchSpeciesData (wrong cutoff, etc.) — treated as null the same way. */
	function fetchUsageList(month, slug, cutoff) {
		return fetch(`https://pikalytics.com/api/l/${month}/${slug}-${cutoff}`)
			.then((r) => (r.ok ? r.text() : null))
			.then((text) => {
				if (!text) return null;
				let data;
				try { data = JSON.parse(text); } catch (e) { return null; }
				if (!Array.isArray(data)) return null;
				const list = data
					.filter((entry) => entry && entry.name)
					.map((entry) => ({ name: entry.name, rank: parseInt(entry.rank, 10) || 0 }));
				list.sort((a, b) => a.rank - b.rank);
				return list;
			})
			.catch(() => null);
	}

	/** Tier 2 sibling of getSpeciesData, same shape/reasoning (see the module comment's
	 *  two-tier cache design) — just keyed by slug instead of by species, and holding a
	 *  name+rank list instead of a mon object. Kept as its own function/cache entry rather than
	 *  folded into getSpeciesData's cache because it's fetched once per format lookup, not once
	 *  per species. */
	function getUsageList(formatId, querySpeciesHint) {
		const slug = slugFor(formatId);
		if (!slug) return Promise.resolve(null);

		return getCachedOrFetch(slug, USAGE_LIST_CACHE_PREFIX, slug, querySpeciesHint,
			(meta) => fetchUsageList(meta.month, slug, meta.cutoff));
	}

	/** Returns a Promise resolving to the top `count` most-used Pokémon in a format, each as
	 *  `{ rank, name, mon }` — `mon` is the exact same per-species payload getSpeciesData
	 *  returns for any other lookup (stats.spe, items, natures, spreads, ...), just fetched and
	 *  attached here too rather than left for the caller to look up separately, since it's
	 *  already going through the same cached per-species path either way. `querySpeciesHint`
	 *  only matters on a cold cache — same bootstrapping need as getSpeciesData, see
	 *  discoverMonthAndCutoff, and typically already warm by the time this is called (the
	 *  currently-edited species' own sidebar lookup runs first). Never rejects — a missing
	 *  format, failed list fetch, or individual species lookup failure all just shrink or empty
	 *  the result rather than throwing (a null `mon` on one entry doesn't drop that entry — the
	 *  speed-tier column only needs `name` to render its sprite, so a missing `mon` there just
	 *  means that one entry's hover comparison popup won't have spread/item data to work with,
	 *  not that the row disappears). */
	function getTopUsageList(formatId, querySpeciesHint, count) {
		return getUsageList(formatId, querySpeciesHint).then((list) => {
			if (!list) return [];
			const top = list.slice(0, count || 20);
			return Promise.all(top.map((entry) =>
				getSpeciesData(formatId, entry.name).then((mon) => ({ rank: entry.rank, name: entry.name, mon }))
			));
		});
	}

	// ---------------------------------------------------------------------
	// Top Teams: a real REST resource behind /api/topteams/, entirely separate from the
	// /api/p/, /api/l/, /ai/pokedex/ endpoints above and NOT keyed by the {month, cutoff} pair
	// those need — confirmed live, GET /api/topteams/{slug} 200s directly with no discovery
	// step, so this gets its own flat single-tier TTL cache rather than reusing getCachedOrFetch
	// (built specifically around that two-tier month/cutoff staleness problem, which doesn't
	// exist here).
	//
	//   GET /api/topteams/{slug}                          — up to 200 real, currently-featured
	//                                                        tournament teams for the format,
	//                                                        each with author/record/tournament
	//                                                        info and every Pokémon's species +
	//                                                        item — confirmed live, NOT full
	//                                                        detail: no ability, no moves. This
	//                                                        is what the same-name pikalytics.com
	//                                                        page itself renders as its team
	//                                                        list/grid; a *lot* more real teams
	//                                                        than any one species' own /api/p/
	//                                                        `team` sample (confirmed live: 20
	//                                                        there vs. 200 here), since it isn't
	//                                                        filtered to teams containing one
	//                                                        specific species at all.
	//   GET /api/topteams/{slug}/team/{tournamentId}/{authorId} — full detail (ability + moves,
	//                                                        the same shape /api/p/'s own `team`
	//                                                        entries already carry) for one real
	//                                                        team from the list above, identified
	//                                                        by that entry's own tournamentId/
	//                                                        authorId fields. This is what
	//                                                        pikalytics.com's own "Details"
	//                                                        expand fetches lazily on click,
	//                                                        confirmed live via the network
	//                                                        request it fires.
	//
	// Confirmed live: battledataregmas2 (Reg M-A ranked ladder) 404s on the bulk endpoint
	// ("Unknown top teams format") while every other FORMAT_SLUG_MAP slug 200s — consistent
	// with Reg M-A being realistically dead already (see FORMAT_SLUG_MAP's own doc comment).
	// Treated as "no data" the same as any other unsupported format, not a special case.
	// ---------------------------------------------------------------------
	const TOP_TEAMS_CACHE_PREFIX = 'cf_pikalytics_topteams_';
	const TEAM_DETAIL_CACHE_PREFIX = 'cf_pikalytics_teamdetail_';

	function fetchTopTeams(slug) {
		return fetch(`https://www.pikalytics.com/api/topteams/${slug}`)
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null)
			.then((data) => (data && Array.isArray(data.teams)) ? data.teams : null);
	}

	/** Returns a Promise resolving to the format's up-to-200 real featured teams (light detail
	 *  — no ability/moves yet, see the module comment above), or null if the format has none
	 *  (unsupported by FORMAT_SLUG_MAP, or the 404 case). Falls back to a stale cached list
	 *  (rather than null) if a fresh fetch fails, same "don't throw away a good answer over a
	 *  transient hiccup" reasoning as getFormatMeta above. */
	function getTopTeams(formatId) {
		const slug = slugFor(formatId);
		if (!slug) return Promise.resolve(null);

		const cached = readEntry(TOP_TEAMS_CACHE_PREFIX, slug);
		if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return Promise.resolve(cached.data);

		return fetchTopTeams(slug).then((teams) => {
			if (!teams) return cached ? cached.data : null;
			writeEntry(TOP_TEAMS_CACHE_PREFIX, slug, { data: teams, fetchedAt: Date.now() });
			return teams;
		});
	}

	function fetchTeamDetail(slug, tournamentId, authorId) {
		return fetch(`https://www.pikalytics.com/api/topteams/${slug}/team/${encodeURIComponent(tournamentId)}/${encodeURIComponent(authorId)}`)
			.then((r) => (r.ok ? r.json() : null))
			.catch(() => null)
			.then((data) => (data && data.team && Array.isArray(data.team.pokemon)) ? data.team : null);
	}

	/** Returns a Promise resolving to the full detail (ability + moves per Pokémon) for one
	 *  team named by its own tournamentId/authorId fields from a getTopTeams() entry, or null.
	 *  Cached per {slug, tournamentId, authorId} triple — a real team's own build doesn't change
	 *  once played, so this could in principle cache forever, but reuses the same CACHE_TTL_MS
	 *  as everything else here rather than inventing a separate policy for one endpoint. */
	function getTopTeamDetail(formatId, tournamentId, authorId) {
		const slug = slugFor(formatId);
		if (!slug || !tournamentId || !authorId) return Promise.resolve(null);

		const key = slug + '|' + tournamentId + '|' + authorId;
		const cached = readEntry(TEAM_DETAIL_CACHE_PREFIX, key);
		if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return Promise.resolve(cached.data);

		return fetchTeamDetail(slug, tournamentId, authorId).then((team) => {
			if (!team) return cached ? cached.data : null;
			writeEntry(TEAM_DETAIL_CACHE_PREFIX, key, { data: team, fetchedAt: Date.now() });
			return team;
		});
	}

	window.CF_Pikalytics = {
		getSpeciesData, getTopUsageList, resolveQuerySpecies, slugFor, getTopTeams, getTopTeamDetail,
	};
})();
