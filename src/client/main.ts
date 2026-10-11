import { initCreatePage } from "./pages/create";
import { initCreatedPage, initHistoryPage } from "./pages/history";
import { initManagePage } from "./pages/manage";
import { initThemeControl } from "./pages/theme";
import { initViewer, wireCopyButtons } from "./pages/viewer";

/**
 * One small bundle for the whole site. Pages opt in through body[data-page], so a
 * routing change can never silently disable behaviour.
 */
function boot(): void {
	initThemeControl();
	wireCopyButtons();

	switch (document.body.dataset.page) {
		case "home":
			initCreatePage();
			break;
		case "created":
			initCreatedPage();
			break;
		case "paste":
			initViewer();
			break;
		case "manage":
			initManagePage();
			break;
		case "history":
			initHistoryPage();
			break;
		default:
			break;
	}
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
