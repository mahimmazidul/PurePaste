import { qs } from "../lib/dom";

/**
 * One toggle, two papers. The initial state comes from the pre-paint script in
 * theme.js (stored choice, else the system preference); this only flips it and
 * remembers the flip.
 */
export function initThemeControl(): void {
	const toggle = qs<HTMLButtonElement>("[data-theme-toggle]");
	if (!toggle) return;

	const sync = () => {
		const dark = document.documentElement.classList.contains("dark");
		toggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
		toggle.setAttribute("aria-pressed", String(dark));
	};
	sync();

	toggle.addEventListener("click", () => {
		const dark = !document.documentElement.classList.contains("dark");
		document.documentElement.classList.toggle("dark", dark);
		try {
			localStorage.setItem("slip-theme", dark ? "dark" : "light");
		} catch {
			/* private mode — the choice just won't survive a reload */
		}
		sync();
	});
}
