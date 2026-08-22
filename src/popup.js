/** Better Teambuilder for Showdown! — toolbar popup script (manifest.json's
 *  action.default_popup — settings live directly in the popup rather than a separate options
 *  page/tab). CF_DEFAULT_SETTINGS comes from defaults.js (loaded first, see popup.html),
 *  shared with settings-bridge.js rather than a second hand-typed copy. */
(function () {
	const savedNote = document.getElementById('saved');
	let savedNoteTimer = null;

	/** Shared by every field below so they all show the same "Saved." pulse rather than each
	 *  wiring up its own timer. `display` (not `visibility`) so the note takes up no space at
	 *  all — and doesn't leave a permanent empty strip at the bottom of this already-compact
	 *  popup — until there's actually something to show. */
	function flashSaved() {
		savedNote.style.display = 'block';
		if (savedNoteTimer) clearTimeout(savedNoteTimer);
		savedNoteTimer = setTimeout(() => { savedNote.style.display = 'none'; }, 1500);
	}

	const closeSideRoomsCheckbox = document.getElementById('closeSideRoomsOnLoad');
	const scarfThresholdInput = document.getElementById('scarfThresholdPercent');
	const ironballThresholdInput = document.getElementById('ironballThresholdPercent');
	const megaThresholdInput = document.getElementById('megaThresholdPercent');

	chrome.storage.sync.get(CF_DEFAULT_SETTINGS, (items) => {
		closeSideRoomsCheckbox.checked = !!items.closeSideRoomsOnLoad;
		scarfThresholdInput.value = items.scarfThresholdPercent;
		ironballThresholdInput.value = items.ironballThresholdPercent;
		megaThresholdInput.value = items.megaThresholdPercent;
	});

	closeSideRoomsCheckbox.addEventListener('change', () => {
		chrome.storage.sync.set({ closeSideRoomsOnLoad: closeSideRoomsCheckbox.checked }, flashSaved);
	});

	/** Shared by all three percent inputs: clamps to 0-100 and falls back to the field's own
	 *  default on empty/non-numeric input, rather than ever writing NaN or an out-of-range value
	 *  into sync storage — content.js's CF_SETTINGS.scarfThresholdPercent/ironballThresholdPercent/
	 *  megaThresholdPercent (see its own doc comment) trusts these to already be sane numbers,
	 *  with no clamping of its own on the read side. */
	function bindPercentInput(input, key, defaultValue) {
		input.addEventListener('change', () => {
			let value = parseFloat(input.value);
			if (!Number.isFinite(value)) value = defaultValue;
			value = Math.min(Math.max(value, 0), 100);
			input.value = value;
			chrome.storage.sync.set({ [key]: value }, flashSaved);
		});
	}
	bindPercentInput(scarfThresholdInput, 'scarfThresholdPercent', CF_DEFAULT_SETTINGS.scarfThresholdPercent);
	bindPercentInput(ironballThresholdInput, 'ironballThresholdPercent', CF_DEFAULT_SETTINGS.ironballThresholdPercent);
	bindPercentInput(megaThresholdInput, 'megaThresholdPercent', CF_DEFAULT_SETTINGS.megaThresholdPercent);
})();
