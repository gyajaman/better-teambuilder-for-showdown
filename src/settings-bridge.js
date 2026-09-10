/**
 * Better Teambuilder for Showdown! — settings bridge.
 *
 * Runs in the default ISOLATED world (unlike move-data.js/content.js, which run in MAIN —
 * see manifest.json) so it can call chrome.storage, an extension API the page's own MAIN-
 * world JS environment has no access to. ISOLATED and MAIN worlds don't share a `window`,
 * so the only way to hand the read setting to content.js is through something both worlds
 * do share: the DOM. This writes it as a JSON attribute on <html>; content.js's own
 * waitForSideRoomSettings() polls for that attribute the same bounded-retry way it already
 * polls for Showdown's own globals, and a live MutationObserver on that same attribute keeps
 * CF_SETTINGS current after that (see content.js's own doc comment on that observer for why).
 * CF_DEFAULT_SETTINGS comes from defaults.js, loaded first in this same content script (see
 * manifest.json) — shared with popup.js rather than a second hand-typed copy.
 *
 * Re-reads and re-writes that same attribute on every chrome.storage.onChanged fire too, not
 * just once at load — confirmed live: without this, saving a setting in the popup (e.g. the
 * Mega usage threshold) had zero effect on an already-open Showdown tab until a manual page
 * refresh, even though every place content.js reads CF_SETTINGS already re-reads it live on
 * each render and would have picked up the new value immediately on its own. Scoped to
 * chrome.storage.sync specifically (the `areaName` check) since that's the only area this
 * extension's own settings ever live in — a sync-storage change from a *different* extension
 * sharing the same profile is not something this should react to at all.
 */
(function () {
	function readAndWriteSettings() {
		chrome.storage.sync.get(CF_DEFAULT_SETTINGS, (items) => {
			document.documentElement.setAttribute('data-cf-settings', JSON.stringify(items));
		});
	}
	readAndWriteSettings();
	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== 'sync') return;
		readAndWriteSettings();
	});
})();
