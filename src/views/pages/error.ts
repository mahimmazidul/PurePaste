import type { Config } from "../../config";
import { escapeHtml } from "../../lib/format";
import { icons, renderLayout } from "../layout";

export interface ErrorPageOptions {
	config: Config;
	status: number;
	title: string;
	message: string;
	hint?: string | undefined;
	detail?: string | undefined;
}

export function renderErrorPage(options: ErrorPageOptions): string {
	const hint = options.hint ? `<p class="gone-hint">${escapeHtml(options.hint)}</p>` : "";
	const detail = options.detail
		? `<details class="advanced"><summary>More detail</summary><div class="advanced-body"><p class="field-note mono">${escapeHtml(options.detail)}</p></div></details>`
		: "";

	const body = `
	<div class="gone-wrap">
		<div class="gone rise-in">
			<span class="gone-icon">${icons.leaf}</span>
			<p class="error-code mono">${escapeHtml(String(options.status))}</p>
			<h1 class="gone-head font-display-it">${escapeHtml(options.title)}</h1>
			<p class="gone-body">${escapeHtml(options.message)}</p>
			${hint}
			${detail}
			<a class="btn btn-primary gone-cta" href="/">${options.status === 404 || options.status === 410 ? "Write a new slip" : "Back to the desk"}</a>
		</div>
	</div>
`;

	return renderLayout({
		config: options.config,
		page: "error",
		title: options.title,
		body,
		noindex: true,
		compactHeader: true,
	});
}

export interface GonePageOptions {
	config: Config;
	reason: "expired" | "missing" | "burned";
	kind?: "slip" | "link";
	status?: number;
}

/** The three quiet ways a Slip address stops working. */
export function renderGonePage(options: GonePageOptions): string {
	const kind = options.kind ?? "slip";
	const lines: Record<GonePageOptions["reason"], { head: string; body: string }> = {
		expired: {
			head: "This one has faded.",
			body: `Every ${kind} on Slip expires, and this one's time ran out. Ask the sender to seal a new one.`,
		},
		missing: {
			head: "Nothing by that name.",
			body: `No ${kind} ever lived here — or it's already gone. Check the link for typos.`,
		},
		burned: {
			head: "It kept its promise.",
			body: `This ${kind} was marked burn-after-reading, and it's already been read once.`,
		},
	};
	const { head, body } = lines[options.reason];
	const status = options.status ?? (options.reason === "missing" ? 404 : 410);

	const pageBody = `
	<div class="gone-wrap">
		<div class="gone rise-in">
			<span class="gone-icon">${icons.leaf}</span>
			<h1 class="gone-head font-display-it">${escapeHtml(head)}</h1>
			<p class="gone-body">${escapeHtml(body)}</p>
			<a class="btn btn-primary gone-cta" href="/">${kind === "slip" ? "Write a new slip" : "Make a new link"}</a>
		</div>
	</div>
`;

	return renderLayout({
		config: options.config,
		page: "error",
		title: head,
		body: pageBody,
		noindex: true,
		compactHeader: true,
		bodyAttributes: { "data-status": String(status) },
	});
}
