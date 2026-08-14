import globals from "globals";

export default [
	{
		files: ["src/**/*.js"],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "script",
			globals: {
				...globals.browser,
				// Pokémon Showdown globals accessed by the extension at runtime.
				// These are defined by the site's own bundle and available because
				// the content script runs in the MAIN world (manifest.json).
				BattleMovedex: "readonly",
				BattlePokedex: "readonly",
				BattleSearch: "readonly",
				BattleTeambuilderTable: "readonly",
				Dex: "readonly",
				DexSearch: "readonly",
				toID: "readonly",
			},
		},
		rules: {
			// --- Possible errors ---
			"no-cond-assign": ["error", "except-parens"],
			"no-constant-condition": "error",
			"no-debugger": "error",
			"no-dupe-args": "error",
			"no-dupe-keys": "error",
			"no-duplicate-case": "error",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"no-ex-assign": "error",
			"no-extra-boolean-cast": "error",
			"no-func-assign": "error",
			"no-inner-declarations": "error",
			"no-irregular-whitespace": "error",
			"no-unreachable": "error",
			"no-unsafe-negation": "error",
			"use-isnan": "error",
			"valid-typeof": "error",

			// --- Best practices ---
			"eqeqeq": ["error", "always", { null: "ignore" }],
			"no-caller": "error",
			"no-eval": "error",
			"no-implied-eval": "error",
			"no-new-wrappers": "error",
			"no-throw-literal": "error",
			"no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
			"no-useless-call": "error",
			"no-useless-concat": "error",
			"no-useless-return": "error",

			// --- Variables ---
			"no-shadow-restricted-names": "error",
			"no-undef": "error",
			"no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
			"no-use-before-define": ["error", { functions: false, classes: false }],

			// --- Style (light touch — no formatting wars) ---
			"no-mixed-spaces-and-tabs": ["error", "smart-tabs"],
			"no-trailing-spaces": ["warn", { skipBlankLines: true }],
			"semi": ["warn", "always"],
		},
	},
];
