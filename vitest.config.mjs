import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'jsdom',
		include: ['test/**/*.test.js'],
		globals: true,
		// Single worker, not one per CPU core (vitest's default) — this suite is small enough
		// (3 files) that parallelizing it buys nothing, and one worker is a lighter footprint on
		// a memory-constrained dev machine. `maxWorkers: 1` is the Vitest 4 replacement for the
		// old `poolOptions.forks.singleFork` (removed, nesting it under `test` like that is now
		// deprecated) — deliberately not also setting `isolate: false` (the other half of what
		// the migration guide calls the literal singleFork-equivalent), since that changes test
		// isolation semantics (shared state across test files within the one process) rather
		// than just worker count, which isn't something this suite actually needs.
		pool: 'forks',
		maxWorkers: 1,
	},
});
