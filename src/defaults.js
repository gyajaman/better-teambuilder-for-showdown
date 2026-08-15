/**
 * Better Teambuilder for Showdown! — shared settings defaults.
 *
 * Loaded before options.js (options.html's own <script> tag) and before settings-bridge.js
 * (manifest.json's isolated-world content_scripts entry lists this file first) so both read
 * the exact same object instead of two hand-typed copies that could drift apart. content.js
 * keeps its own separate copy (DEFAULT_SETTINGS) rather than sharing this one — it runs in
 * the page's MAIN world (see manifest.json), a different JS realm from these two ordinary
 * extension-context files that this plain global can't reach.
 */
/* exported CF_DEFAULT_SETTINGS */
const CF_DEFAULT_SETTINGS = { closeSideRoomsOnLoad: true };
