/**
 * Better Teambuilder for Showdown! — settings bridge.
 *
 * Runs in the default ISOLATED world (unlike move-data.js/content.js, which run in MAIN —
 * see manifest.json) so it can call chrome.storage, an extension API the page's own MAIN-
 * world JS environment has no access to. ISOLATED and MAIN worlds don't share a `window`,
 * so the only way to hand the read setting to content.js is through something both worlds
 * do share: the DOM. This writes it as a JSON attribute on <html>; content.js's own
 * waitForSideRoomSettings() polls for that attribute the same bounded-retry way it already
 * polls for Showdown's own globals. CF_DEFAULT_SETTINGS comes from defaults.js, loaded first
 * in this same content script (see manifest.json) — shared with options.js rather than a
 * second hand-typed copy.
 */
(function () {
	chrome.storage.sync.get(CF_DEFAULT_SETTINGS, (items) => {
		document.documentElement.setAttribute('data-cf-settings', JSON.stringify(items));
	});
})();
