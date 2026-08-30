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
 *  that never persists anything. */
class MemoryStorage {
	constructor() { this._data = new Map(); }
	getItem(key) { return this._data.has(key) ? this._data.get(key) : null; }
	setItem(key, value) { this._data.set(key, String(value)); }
	removeItem(key) { this._data.delete(key); }
	clear() { this._data.clear(); }
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
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmbbo3')).toBe('championstournaments');
	});

	it('returns undefined for a format outside the deliberate allowlist', () => {
		expect(CF_Pikalytics.slugFor('gen9ou')).toBeUndefined();
		expect(CF_Pikalytics.slugFor('gen9championsvgc2026regmb'.toUpperCase())).toBeUndefined();
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

	it('treats a response missing a real `teams` array as no data (e.g. the confirmed-live battledataregmas2 404)', async () => {
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
