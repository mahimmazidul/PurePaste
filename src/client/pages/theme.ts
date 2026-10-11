/**
 * The theme switch.
 *
 * The palette follows the device by default. Choosing light or dark stores that
 * choice for next time; choosing "system" hands control back to the device. The
 * stored value is applied before paint by the small script in the head, so this
 * module only has to keep the buttons in step.
 */
const STORAGE_KEY = "purepaste.theme";
type Theme = "auto" | "light" | "dark";

function stored(): Theme {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return value === "light" || value === "dark" ? value : "auto";
	} catch {
		return "auto";
	}
}

export function initThemeControl(): void {
	const group = document.querySelector<HTMLElement>("[data-theme-switch]");
	if (!group) return;

	const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>("[data-theme-value]"));

	const paint = (theme: Theme): void => {
		for (const button of buttons) {
			button.setAttribute("aria-pressed", button.dataset.themeValue === theme ? "true" : "false");
		}
	};

	const apply = (theme: Theme): void => {
		if (theme === "auto") {
			delete document.documentElement.dataset.theme;
		} else {
			document.documentElement.dataset.theme = theme;
		}
		try {
			if (theme === "auto") localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, theme);
		} catch {
			// Storage can be unavailable; the choice still applies to this visit.
		}
		paint(theme);
	};

	for (const button of buttons) {
		button.addEventListener("click", () => {
			const value = button.dataset.themeValue;
			if (value === "light" || value === "dark" || value === "auto") apply(value);
		});
	}

	paint(stored());
}
