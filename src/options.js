/** Better Teambuilder for Showdown! — options page script. CF_DEFAULT_SETTINGS comes from
 *  defaults.js (loaded first, see options.html), shared with settings-bridge.js rather than
 *  a second hand-typed copy. */
(function () {
	const checkbox = document.getElementById('closeSideRoomsOnLoad');
	const savedNote = document.getElementById('saved');
	let savedNoteTimer = null;

	chrome.storage.sync.get(CF_DEFAULT_SETTINGS, (items) => {
		checkbox.checked = !!items.closeSideRoomsOnLoad;
	});

	checkbox.addEventListener('change', () => {
		chrome.storage.sync.set({ closeSideRoomsOnLoad: checkbox.checked }, () => {
			savedNote.style.visibility = 'visible';
			if (savedNoteTimer) clearTimeout(savedNoteTimer);
			savedNoteTimer = setTimeout(() => { savedNote.style.visibility = 'hidden'; }, 1500);
		});
	});
})();
