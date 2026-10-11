/**
 * Runs in the head, before the first paint, so the saved theme applies without a
 * flash of the wrong palette. It also marks the document as script-enabled, which
 * is what reveals the controls that only work with JavaScript.
 *
 * Keep this file tiny and synchronous: it is the one blocking script on the page.
 */
try {
	const stored = localStorage.getItem("purepaste.theme");
	if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch (error) {
	// A blocked localStorage means the device preference wins. Nothing else to do.
}
document.documentElement.classList.add("js");
