/**
 * Better Teambuilder for Showdown! — shared settings defaults.
 *
 * Loaded before popup.js (popup.html's own <script> tag) and before settings-bridge.js
 * (manifest.json's isolated-world content_scripts entry lists this file first) so both read
 * the exact same object instead of two hand-typed copies that could drift apart. content.js
 * keeps its own separate copy (DEFAULT_SETTINGS) rather than sharing this one — it runs in
 * the page's MAIN world (see manifest.json), a different JS realm from these two ordinary
 * extension-context files that this plain global can't reach.
 */
/* exported CF_DEFAULT_SETTINGS */
const CF_DEFAULT_SETTINGS = {
	closeSideRoomsOnLoad: true,
	// Minimum Pikalytics usage percent before the Speed comparison hover popup's conditional
	// "what if it ran Scarf/Iron Ball/its Mega Stone" columns bother showing at all — see
	// content.js's own doc comment on that threshold check for why these are starting guesses
	// rather than researched numbers, and now user-adjustable instead of hardcoded for that
	// exact reason. Iron Ball's own default is expected to clear far less often than Scarf's in
	// practice (a Trick Room-oriented item, nowhere near as universal a pick) — same threshold
	// value as Scarf regardless, since there's no principled reason to pre-judge it stricter.
	scarfThresholdPercent: 5,
	ironballThresholdPercent: 5,
	megaThresholdPercent: 15,
};
