import { initCreatePage } from "./pages/create";
import { initCreatedPage, initLocalList } from "./pages/local-list";
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
			initLocalList();
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
		default:
			// link, docs, about, licenses, error: the markup is the whole feature.
			break;
	}
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
