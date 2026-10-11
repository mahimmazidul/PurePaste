/**
 * Runs in the head, before the first paint, so the saved paper applies without
 * a flash. It also marks the document as script-enabled, which is what reveals
 * the controls that only work with JavaScript.
 *
 * Keep this file tiny and synchronous: it is the one blocking script on the page.
 */
try {
	const stored = localStorage.getItem("slip-theme");
	const dark = stored
		? stored === "dark"
		: window.matchMedia("(prefers-color-scheme: dark)").matches;
	if (dark) document.documentElement.classList.add("dark");
} catch {
	// A blocked localStorage means the device preference wins. Nothing else to do.
}
document.documentElement.classList.add("js");
