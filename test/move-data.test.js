/**
 * Data-integrity tests for src/move-data.js — CF_MOVE_CATEGORIES is pure, hand-maintained data
 * (see the file's own module doc comment for the shape rules), so these are the kind of mistake
 * a human editing it by hand could plausibly make: a typo'd move id, a category added to the
 * data but forgotten in content.js's CATEGORY_ORDER, a description missing for a declared
 * searchType, etc. Nothing here touches the DOM or Showdown globals.
 */
require('../src/move-data.js');
const { CATEGORY_ORDER, DYNAMIC_CATEGORIES } = require('../src/content.js');

const categories = window.CF_MOVE_CATEGORIES;
const ID_RE = /^[a-z0-9]+$/; // Dex.toID form — see move-data.js's own doc comment.

describe('CF_MOVE_CATEGORIES basic shape', () => {
	it('is a non-empty object', () => {
		expect(categories).toBeTruthy();
		expect(Object.keys(categories).length).toBeGreaterThan(0);
	});

	for (const [key, cat] of Object.entries(categories || {})) {
		describe(`category "${key}"`, () => {
			it('has an id matching its object key', () => {
				expect(cat.id).toBe(key);
			});

			it('has a non-empty label', () => {
				expect(typeof cat.label).toBe('string');
				expect(cat.label.length).toBeGreaterThan(0);
			});

			it('declares a non-empty searchTypes array of only "pokemon"/"move", no duplicates', () => {
				expect(Array.isArray(cat.searchTypes)).toBe(true);
				expect(cat.searchTypes.length).toBeGreaterThan(0);
				for (const t of cat.searchTypes) expect(['pokemon', 'move']).toContain(t);
				expect(new Set(cat.searchTypes).size).toBe(cat.searchTypes.length);
			});

			it('has a description for every declared searchType, and no extra ones', () => {
				const descKeys = Object.keys(cat.description || {}).sort();
				const searchTypeKeys = [...cat.searchTypes].sort();
				expect(descKeys).toEqual(searchTypeKeys);
				for (const t of cat.searchTypes) {
					expect(typeof cat.description[t]).toBe('string');
					expect(cat.description[t].length).toBeGreaterThan(0);
				}
			});

			if (cat.kind === 'ability') {
				it('ability-kind categories carry an `abilities` list, not `moves`', () => {
					expect(Array.isArray(cat.abilities)).toBe(true);
					expect(cat.abilities.length).toBeGreaterThan(0);
					expect(cat.moves).toBeUndefined();
				});

				it('ability-kind categories are Pokémon-search only', () => {
					// There's no "ability" concept in Move search — see move-data.js's own
					// doc comment on `kind`.
					expect(cat.searchTypes).toEqual(['pokemon']);
				});
			} else {
				it('non-ability categories carry a `moves` array', () => {
					expect(Array.isArray(cat.moves)).toBe(true);
				});
			}

			const entries = cat.kind === 'ability' ? cat.abilities : cat.moves;
			it('every entry has a valid Dex.toID-form id, a non-empty name, and a boolean conditional', () => {
				for (const entry of entries || []) {
					expect(entry.id).toMatch(ID_RE);
					expect(typeof entry.name).toBe('string');
					expect(entry.name.length).toBeGreaterThan(0);
					expect(typeof entry.conditional).toBe('boolean');
					if (entry.conditional) {
						expect(typeof entry.reason).toBe('string');
						expect(entry.reason.length).toBeGreaterThan(0);
					}
				}
			});

			it('has no duplicate entry ids within the category', () => {
				const ids = (entries || []).map((e) => e.id);
				expect(new Set(ids).size).toBe(ids.length);
			});

			if (cat.negative) {
				it('a negative (exclusion) filter is move-search only, per its documented purpose', () => {
					expect(cat.searchTypes).toEqual(['move']);
				});
			}
		});
	}
});

describe('cross-file consistency with content.js', () => {
	it('every CF_MOVE_CATEGORIES key appears in CATEGORY_ORDER exactly once, and vice versa', () => {
		const dataKeys = Object.keys(categories).sort();
		const orderKeys = [...CATEGORY_ORDER].sort();
		expect(orderKeys).toEqual(dataKeys);
		expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
	});

	it('DYNAMIC_CATEGORIES matches exactly the categories flagged `dynamic: true` in move-data.js', () => {
		const flaggedDynamic = Object.entries(categories)
			.filter(([, cat]) => cat.dynamic)
			.map(([key]) => key)
			.sort();
		expect([...DYNAMIC_CATEGORIES].sort()).toEqual(flaggedDynamic);
	});
});
