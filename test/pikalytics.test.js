/**
 * Unit tests for src/pikalytics.js's public API (window.CF_Pikalytics). Tested as a black box
 * through getSpeciesData/getTopUsageList/resolveQuerySpecies/slugFor — the same surface content.js
 * itself calls — rather than reaching into private helpers, so these tests keep working across an
 * internal refactor as long as the documented contract (see the file's own module doc comment)
 * doesn't change. Network (fetch) and window.Dex are mocked; localStorage is jsdom's real
 * implementation, cleared between tests so the two-tier cache starts cold every time.
 */
require('../src/pikalytics.js');
const CF_Pikalytics = window.CF_Pikalytics;

/** Node's own built-in `localStorage` global (stable since Node 22) shadows jsdom's and, with
 *  no `--localstorage-file` configured, isn't actually backed by anything — every method call
 *  is a no-op. Swapping in a plain in-memory Storage stand-in keeps pikalytics.js's real
 *  readEntry/writeEntry cache logic under test instead of silently testing against a storage
 *  that never persists anything. `length`/`key(i)` (real Storage's own enumeration surface, not
 *  just get/set/remove/clear) round this out — pikalytics.js's own evictOldestIfOverCap/
 *  pruneStaleAndCollectSurvivors need to walk every real cached key under a given prefix, the
 *  same way real localStorage supports in a browser. */
class MemoryStorage {
	constructor() { this._data = new Map(); }
	getItem(key) { return this._data.has(key) ? this._data.get(key) : null; }
	setItem(key, value) { this._data.set(key, String(value)); }
	removeItem(key) { this._data.delete(key); }
	clear() { this._data.clear(); }
	key(index) { return Array.from(this._data.keys())[index] ?? null; }
	get length() { return this._data.size; }
}
window.localStorage = new MemoryStorage();

const SLUG = 'battledataregmbs3';
const FORMAT_ID = 'gen9championsvgc2026regmb'; // maps to SLUG — see pikalytics.js's FORMAT_SLUG_MAP.
const UNKNOWN_FORMAT_ID = 'gen9ou'; // deliberately not in the allowlist.

function discoveryResponse(species, month, cutoff) {
	return `**Data Date**: ${month}\n\n## FAQ for ${species} in ${SLUG}-${cutoff}\n`;
}

function mon(name, overrides) {
	return Object.assign({
		name,
		moves: [{ move: 'Fake Out', type: 'Normal', percent: '80.0' }],
		items: [{ item: 'Choice Scarf', percent: '20.0' }],
		abilities: [{ ability: 'Intimidate', percent: '100.0' }],
		natures: [{ nature: 'Jolly', percent: '60.0' }],
		spreads: [{ nature: 'Jolly', ev: '4/236/0/0/76/188', percent: '15.0' }],
		team: [{ pokemon: 'Rillaboom', percent: '25.0' }],
	}, overrides);
}

/** Routes a fetch mock by matching against the real Pikalytics endpoint shapes (see
 *  pikalytics.js's own module doc comment) rather than exact URLs, so tests read as "what does
 *  this endpoint return" without repeating the full URL-building logic. Top Teams' two
 *  endpoints (`topteams`/`teamDetail`) return real JSON objects via `.json()`, unlike the
 *  other four (`.text()`, hand-parsed by pikalytics.js itself) — routes.topteams/teamDetail
 *  handlers should return a plain object/array, not a JSON string. */
function installFetchMock(routes) {
	global.fetch = vi.fn((url) => {
		const u = String(url);
		let handler;
		let isJson = false;
		if (u.includes('/ai/pokedex/')) handler = routes.discover;
		else if (u.includes('/api/l/')) handler = routes.list;
		else if (u.includes('/api/p/')) handler = routes.species;
		else if (u.includes('/api/topteams/') && u.includes('/team/')) { handler = routes.teamDetail; isJson = true; }
		else if (u.includes('/api/topteams/')) { handler = routes.topteams; isJson = true; }
		if (!handler) return Promise.resolve({ ok: false, text: () => Promise.resolve(''), json: () => Promise.reject(new Error('not ok')) });
		const result = handler(u);
		return Promise.resolve({
			ok: true,
			text: () => Promise.resolve(isJson ? JSON.stringify(result) : result),
			json: () => Promise.resolve(isJson ? result : JSON.parse(result)),
		});
	});
	return global.fetch;
}

beforeEach(() => {
	localStorage.clear();
	delete window.Dex;
});

describe('slugFor', () => {
	it('returns the mapped slug for an allowlisted format', () => {
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmb')).toBe('battledataregmbs3');
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmbbo3')).toBe('championstournamentsregmb');
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmc')).toBe('gen9championsvgc2026regmc');
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmcbo3')).toBe('championstournaments');
	});

	it('returns undefined for a format outside the deliberate allowlist', () => {
		expect(CF_Pikalytics.slugFor('gen9ou')).toBeUndefined();
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmb'.toUpperCase())).toBeUndefined();
	});

	it('returns undefined for Reg M-A — removed from Showdown, deleted from the allowlist', () => {
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regma')).toBeUndefined();
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmabo3')).toBeUndefined();
	});
});

describe('resolveQuerySpecies', () => {
	it('returns the name unchanged when window.Dex is unavailable', () => {
		expect(CF_Pikalytics.resolveQuerySpecies('Blastoise-Mega')).toBe('Blastoise-Mega');
	});

	it('returns the name unchanged when the species does not exist in the Dex', () => {
		window.Dex = { species: { get: () => ({ exists: false }) } };
		expect(CF_Pikalytics.resolveQuerySpecies('Not A Real Mon')).toBe('Not A Real Mon');
	});

	it('collapses a battle-only forme (Mega/Primal) to its base species', () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: true, baseSpecies: 'Blastoise', name: 'Blastoise-Mega' }),
			},
		};
		expect(CF_Pikalytics.resolveQuerySpecies('Blastoise-Mega')).toBe('Blastoise');
	});

	it('leaves an independently-viable forme (e.g. a regional form) alone', () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: false, baseSpecies: 'Ninetales', name: 'Ninetales-Alola' }),
			},
		};
		expect(CF_Pikalytics.resolveQuerySpecies('Ninetales-Alola')).toBe('Ninetales-Alola');
	});

	it('collapses a known-cosmetic forme (confirmed empirically to 404 on Pikalytics) to its base species', () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: false, baseSpecies: 'Sinistcha', name: 'Sinistcha-Masterpiece' }),
			},
		};
		expect(CF_Pikalytics.resolveQuerySpecies('Sinistcha-Masterpiece')).toBe('Sinistcha');
	});

	it('leaves a forme that 404s but is NOT a cosmetic duplicate alone (e.g. Qwilfish-Hisui, Tauros-Paldea-Combat — genuinely distinct Pokémon, just unused this month)', () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: false, baseSpecies: 'Qwilfish', name: 'Qwilfish-Hisui' }),
			},
		};
		expect(CF_Pikalytics.resolveQuerySpecies('Qwilfish-Hisui')).toBe('Qwilfish-Hisui');
	});

	it('leaves formes that are illegal in Pokemon Champions alone, even though they 404 on Pikalytics too (e.g. Pikachu-Original — event-exclusive, Illegal in BattleTeambuilderTable) — no point folding data for something nobody can field', () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: false, baseSpecies: 'Pikachu', name: 'Pikachu-Original' }),
			},
		};
		expect(CF_Pikalytics.resolveQuerySpecies('Pikachu-Original')).toBe('Pikachu-Original');
	});
});

describe('getSpeciesData', () => {
	it('resolves null with no network request for a format outside the allowlist', async () => {
		const fetchMock = installFetchMock({});
		const result = await CF_Pikalytics.getSpeciesData(UNKNOWN_FORMAT_ID, 'Landorus-Therian');
		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fetches discovery + species data and returns the parsed payload', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian')),
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		expect(result.name).toBe('Landorus-Therian');
		expect(result.moves[0].move).toBe('Fake Out');
	});

	it('serves the second lookup of the same species from cache — no extra fetch', async () => {
		const fetchMock = installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian')),
		});
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		const callsAfterFirst = fetchMock.mock.calls.length;
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst); // no new requests
	});

	it('shares the warmed format-meta cache across two different species (only one discovery fetch)', async () => {
		const fetchMock = installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('whatever')),
		});
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		const discoverCallsAfterFirst = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/ai/pokedex/')).length;
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Rillaboom');
		const discoverCallsAfterSecond = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/ai/pokedex/')).length;
		expect(discoverCallsAfterSecond).toBe(discoverCallsAfterFirst); // format meta already warm
	});

	it('treats a truthy non-array value in an ARRAY_FIELDS slot as invalid data (null)', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian', { moves: 'not-an-array' })),
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		expect(result).toBeNull();
	});

	it('treats the literal "false" body (wrong cutoff) as no data rather than throwing', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => 'false',
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		expect(result).toBeNull();
	});

	it('resolves a Mega species to its base species before querying', async () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: true, baseSpecies: 'Blastoise', name: 'Blastoise-Mega' }),
			},
		};
		const requestedSpecies = [];
		installFetchMock({
			discover: (u) => {
				const species = decodeURIComponent(u.split('/').pop());
				requestedSpecies.push(species);
				return discoveryResponse(species, '2026-05', '1500');
			},
			species: (u) => {
				requestedSpecies.push(decodeURIComponent(u.split('/').pop()));
				return JSON.stringify(mon('Blastoise'));
			},
		});
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Blastoise-Mega');
		expect(requestedSpecies.every((s) => s === 'Blastoise')).toBe(true);
	});

	it('resolves a known-cosmetic forme to its base species before querying (e.g. Sinistcha-Masterpiece)', async () => {
		window.Dex = {
			species: {
				get: () => ({ exists: true, battleOnly: false, baseSpecies: 'Sinistcha', name: 'Sinistcha-Masterpiece' }),
			},
		};
		const requestedSpecies = [];
		installFetchMock({
			discover: (u) => {
				const species = decodeURIComponent(u.split('/').pop());
				requestedSpecies.push(species);
				return discoveryResponse(species, '2026-05', '1500');
			},
			species: (u) => {
				requestedSpecies.push(decodeURIComponent(u.split('/').pop()));
				return JSON.stringify(mon('Sinistcha'));
			},
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Sinistcha-Masterpiece');
		expect(result.name).toBe('Sinistcha');
		expect(requestedSpecies.every((s) => s === 'Sinistcha')).toBe(true); // queried Sinistcha directly, no retry
	});

	it('drops an ability entry that is not actually obtainable on the species (e.g. bad/hacked ladder data)', async () => {
		window.Dex = {
			species: {
				get: () => ({
					exists: true, battleOnly: false, otherFormes: null,
					name: 'Incineroar', abilities: { '0': 'Blaze', H: 'Intimidate' },
				}),
			},
		};
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Incineroar', {
				abilities: [
					{ ability: 'Intimidate', percent: '98.584' },
					{ ability: 'Trace', percent: '0.283' }, // confirmed-live Reg M-C noise — not a real Incineroar ability
				],
			})),
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Incineroar');
		expect(result.abilities.map((a) => a.ability)).toEqual(['Intimidate']);
	});

	it('treats a Mega/Primal forme\'s ability as legal too, since Pikalytics folds Mega usage into the base species page', async () => {
		window.Dex = {
			species: {
				get: (name) => (name === 'Charizard-Mega-Y'
					? { exists: true, battleOnly: 'Charizard', abilities: { '0': 'Drought' } }
					: {
						exists: true, battleOnly: false, name: 'Charizard',
						otherFormes: ['Charizard-Mega-Y'], abilities: { '0': 'Blaze', H: 'Solar Power' },
					}),
			},
		};
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Charizard', {
				abilities: [
					{ ability: 'Blaze', percent: '40.0' },
					{ ability: 'Drought', percent: '35.0' },
					{ ability: 'Levitate', percent: '1.0' }, // not legal on Charizard in any forme
				],
			})),
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Charizard');
		expect(result.abilities.map((a) => a.ability).sort()).toEqual(['Blaze', 'Drought']);
	});

	it('does not filter abilities when the Dex is unavailable — fails open, not closed', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian', {
				abilities: [
					{ ability: 'Intimidate', percent: '98.5' },
					{ ability: 'TotallyFakeAbility', percent: '0.1' },
				],
			})),
		});
		const result = await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		expect(result.abilities.length).toBe(2);
	});
});

describe('getTopUsageList', () => {
	it('returns the top N entries in rank order, each with its own species payload attached', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			list: () => JSON.stringify([
				{ name: 'Rillaboom', rank: 2 },
				{ name: 'Landorus-Therian', rank: 1 },
				{ name: 'Flutter Mane', rank: 3 },
			]),
			species: (u) => JSON.stringify(mon(decodeURIComponent(u.split('/').pop()))),
		});
		const list = await CF_Pikalytics.getTopUsageList(FORMAT_ID, 'Landorus-Therian', 2);
		expect(list.map((e) => e.name)).toEqual(['Landorus-Therian', 'Rillaboom']); // sorted by rank, capped to 2
		expect(list[0].rank).toBe(1);
		expect(list[0].mon.name).toBe('Landorus-Therian');
	});

	it('keeps an entry (with mon: null) when that one species\' own lookup fails, rather than dropping the row', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			list: () => JSON.stringify([{ name: 'Landorus-Therian', rank: 1 }, { name: 'Rillaboom', rank: 2 }]),
			species: (u) => {
				const species = decodeURIComponent(u.split('/').pop());
				return species === 'Rillaboom' ? '' : JSON.stringify(mon(species));
			},
		});
		const list = await CF_Pikalytics.getTopUsageList(FORMAT_ID, 'Landorus-Therian', 2);
		expect(list.length).toBe(2);
		expect(list.find((e) => e.name === 'Rillaboom').mon).toBeNull();
	});

	it('resolves to an empty array (never rejects) for a format outside the allowlist', async () => {
		installFetchMock({});
		const list = await CF_Pikalytics.getTopUsageList(UNKNOWN_FORMAT_ID, 'Landorus-Therian', 20);
		expect(list).toEqual([]);
	});

	it('never has more than a handful of real species lookups in flight at once, even for a full top-20 list (a genuine burst of 20 simultaneous requests risks Cloudflare-fronted rate-limiting)', async () => {
		vi.useFakeTimers();
		try {
			let inFlight = 0;
			let maxInFlight = 0;
			global.fetch = vi.fn((url) => {
				const u = String(url);
				if (u.includes('/ai/pokedex/')) {
					return Promise.resolve({ ok: true, text: () => Promise.resolve(discoveryResponse('X', '2026-05', '1500')) });
				}
				if (u.includes('/api/l/')) {
					const list = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ name: 'Mon' + i, rank: i + 1 })));
					return Promise.resolve({ ok: true, text: () => Promise.resolve(list) });
				}
				if (u.includes('/api/p/')) {
					// Real per-species fetches only — deliberately deferred via a real timer
					// (not resolved synchronously) so genuine overlap between them is actually
					// observable, not just theoretical.
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					return new Promise((resolve) => {
						setTimeout(() => {
							inFlight--;
							resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(mon('X'))) });
						}, 10);
					});
				}
				return Promise.resolve({ ok: false, text: () => Promise.resolve('') });
			});

			const resultPromise = CF_Pikalytics.getTopUsageList(FORMAT_ID, 'Landorus-Therian', 20);
			for (let step = 0; step < 20; step++) {
				await vi.advanceTimersByTimeAsync(10);
			}
			const list = await resultPromise;

			expect(list.length).toBe(20); // every real lookup still completed
			expect(maxInFlight).toBeGreaterThan(1); // genuine concurrency actually happened...
			expect(maxInFlight).toBeLessThanOrEqual(6); // ...but never unbounded
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('getTopTeams', () => {
	it('fetches the bulk team list directly, with no discovery step (unlike every other endpoint here)', async () => {
		const fetchMock = installFetchMock({
			topteams: () => ({ format: SLUG, teams: [{ author: 'Ash', pokemon: [{ name: 'Incineroar' }] }] }),
		});
		const teams = await CF_Pikalytics.getTopTeams(FORMAT_ID);
		expect(teams).toEqual([{ author: 'Ash', pokemon: [{ name: 'Incineroar' }] }]);
		expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes('/ai/pokedex/'))).toBe(true);
	});

	it('resolves null with no network request for a format outside the allowlist', async () => {
		const fetchMock = installFetchMock({});
		const teams = await CF_Pikalytics.getTopTeams(UNKNOWN_FORMAT_ID);
		expect(teams).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('treats a response missing a real `teams` array as no data (e.g. an "Unknown top teams format" error body)', async () => {
		installFetchMock({ topteams: () => ({ error: 'Unknown top teams format' }) });
		const teams = await CF_Pikalytics.getTopTeams(FORMAT_ID);
		expect(teams).toBeNull();
	});

	it('serves the second lookup from cache — no extra fetch', async () => {
		const fetchMock = installFetchMock({ topteams: () => ({ teams: [{ author: 'Ash', pokemon: [] }] }) });
		await CF_Pikalytics.getTopTeams(FORMAT_ID);
		const callsAfterFirst = fetchMock.mock.calls.length;
		await CF_Pikalytics.getTopTeams(FORMAT_ID);
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
	});
});

describe('getTopTeamDetail', () => {
	it('fetches full per-Pokémon detail for one team by tournamentId/authorId', async () => {
		installFetchMock({
			teamDetail: () => ({
				team: { author: 'Ash', pokemon: [{ name: 'Incineroar', ability: 'Intimidate', moves: [{ name: 'Fake Out', type: 'normal' }] }] },
			}),
		});
		const team = await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, 'limitless-abc', 'ash');
		expect(team.pokemon[0].ability).toBe('Intimidate');
	});

	it('resolves null with no network request for a format outside the allowlist', async () => {
		const fetchMock = installFetchMock({});
		const team = await CF_Pikalytics.getTopTeamDetail(UNKNOWN_FORMAT_ID, 'limitless-abc', 'ash');
		expect(team).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('resolves null (without a network request) when tournamentId or authorId is missing', async () => {
		const fetchMock = installFetchMock({ teamDetail: () => ({ team: { pokemon: [] } }) });
		expect(await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, '', 'ash')).toBeNull();
		expect(await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, 'limitless-abc', '')).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('treats a team response missing a real `pokemon` array as no data', async () => {
		installFetchMock({ teamDetail: () => ({ team: { author: 'Ash' } }) });
		const team = await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, 'limitless-abc', 'ash');
		expect(team).toBeNull();
	});

	it('caches per {format, tournamentId, authorId} — a different team on the same format still fetches', async () => {
		const fetchMock = installFetchMock({
			teamDetail: (u) => ({ team: { author: u.includes('/ash/') ? 'Ash' : 'Misty', pokemon: [] } }),
		});
		await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, 'limitless-abc', 'ash');
		const callsAfterFirst = fetchMock.mock.calls.length;
		await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, 'limitless-abc', 'ash'); // same team -> cached
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
		await CF_Pikalytics.getTopTeamDetail(FORMAT_ID, 'limitless-xyz', 'misty'); // different team -> fetches
		expect(fetchMock.mock.calls.length).toBe(callsAfterFirst + 1);
	});
});

/** Real localStorage key prefix pikalytics.js writes species cache entries under, kept in sync
 *  with SPECIES_CACHE_PREFIX/the module doc comment's own documented "clearly namespaced key
 *  prefixes" contract rather than reaching into the module for the private constant — this
 *  file's own top comment already commits to testing against that documented shape (species
 *  cache keys are `SPECIES_CACHE_PREFIX + formatId + '|' + toID(querySpecies)`, per
 *  getSpeciesData's own source). */
const SPECIES_CACHE_PREFIX = 'cf_pikalytics_cache_';

describe('cache quota safety (localStorage eviction)', () => {
	it('deletes a real orphaned stale-version entry the next time its own prefix is written to', async () => {
		// A real cache entry, written the normal way, to learn the real current CACHE_VERSION
		// without hardcoding it — this test only cares that it changes, not its exact value.
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian')),
		});
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		const realKey = SPECIES_CACHE_PREFIX + FORMAT_ID + '|landorustherian';
		const realVersion = JSON.parse(localStorage.getItem(realKey)).version;

		// A real orphaned entry from a previous CACHE_VERSION, the kind a version bump leaves
		// behind — readEntry already treats this as a miss, but nothing has ever deleted it.
		const staleKey = SPECIES_CACHE_PREFIX + FORMAT_ID + '|staleleftover';
		localStorage.setItem(staleKey, JSON.stringify({ version: realVersion - 1, data: mon('Old'), fetchedAt: 1 }));
		expect(localStorage.getItem(staleKey)).not.toBeNull(); // sanity: actually seeded

		// Any other real cache-miss write under the SAME prefix should prune it as a side effect.
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Rillaboom');
		expect(localStorage.getItem(staleKey)).toBeNull();
	});

	it('leaves a real current-version entry alone even while pruning a stale one under the same prefix', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian')),
		});
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		const realKey = SPECIES_CACHE_PREFIX + FORMAT_ID + '|landorustherian';
		expect(localStorage.getItem(realKey)).not.toBeNull();
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Rillaboom'); // another write to the same prefix
		expect(localStorage.getItem(realKey)).not.toBeNull(); // untouched — it's current-version, not stale
	});

	it('evicts only the single oldest real entry once a prefix hits its cap, keeping every newer one', async () => {
		installFetchMock({
			discover: (u) => discoveryResponse(decodeURIComponent(u.split('/').pop()), '2026-05', '1500'),
			species: () => JSON.stringify(mon('Landorus-Therian')),
		});
		// One real write to learn the real current CACHE_VERSION, same reasoning as above.
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Landorus-Therian');
		const version = JSON.parse(localStorage.getItem(SPECIES_CACHE_PREFIX + FORMAT_ID + '|landorustherian')).version;
		localStorage.clear(); // start this test's own count from a clean prefix

		// A generous seed count, well past any reasonable real cap — oldest-first by fetchedAt,
		// distinct from insertion order (seeded newest-key-first on purpose, so a bug that
		// evicted by key/insertion order instead of real fetchedAt would still be caught).
		const SEED_COUNT = 500;
		for (let i = SEED_COUNT - 1; i >= 0; i--) {
			localStorage.setItem(SPECIES_CACHE_PREFIX + 'seed' + i, JSON.stringify({ version, data: mon('Seed' + i), fetchedAt: i }));
		}

		// One more real cache-miss write to a species not among the seeded keys — this is what
		// actually triggers evictOldestIfOverCap for this prefix.
		await CF_Pikalytics.getSpeciesData(FORMAT_ID, 'Rillaboom');

		let countAfter = 0;
		let survivedOldest = false;
		let survivedNewest = false;
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || key.indexOf(SPECIES_CACHE_PREFIX) !== 0) continue;
			countAfter++;
			if (key === SPECIES_CACHE_PREFIX + 'seed0') survivedOldest = true; // fetchedAt: 0, the real oldest
			if (key === SPECIES_CACHE_PREFIX + 'seed' + (SEED_COUNT - 1)) survivedNewest = true; // the real newest
		}
		expect(countAfter).toBeLessThanOrEqual(SEED_COUNT); // real eviction actually fired, not just grew
		expect(survivedOldest).toBe(false); // the genuinely oldest real entry is gone
		expect(survivedNewest).toBe(true); // a recently-fetched real entry is never evicted for space
	});
});
