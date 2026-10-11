import type { Config } from "../../config";
import { notice, renderLayout } from "../layout";

/**
 * "My pastes" is a local list, not an account: it is read from and written to
 * localStorage by the client script. The server has no list endpoint and never
 * learns what this browser has made.
 */
export function renderHistoryPage(config: Config): string {
	const body = `
	<section class="hero">
		<h1 class="h1">My pastes</h1>
		<p class="lede">Links you created in this browser. They are stored here, on your device, and nowhere else — which also means clearing site data erases the list.</p>
	</section>

	<div class="action-bar">
		<button class="btn btn-secondary" type="button" data-history-check data-js-only>Check for expired pastes</button>
		<button class="btn btn-quiet" type="button" data-history-forget data-js-only>Forget old entries</button>
	</div>

	<section class="card" data-history-list aria-live="polite">
		<p class="empty-state" data-history-empty>Nothing saved in this browser yet. <a href="/">Make a paste</a> and it will show up here.</p>
	</section>

	<noscript>
		${notice({ tone: "info", title: "JavaScript is off", body: "This list is kept in your browser's local storage, which needs JavaScript to read. Pastes themselves work fine without it — you just need your own copy of the links." })}
	</noscript>
`;

	return renderLayout({
		config,
		page: "history",
		title: "My pastes",
		body,
		noindex: true,
	});
}
