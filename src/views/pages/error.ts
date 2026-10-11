import type { Config } from "../../config";
import { escapeHtml } from "../../lib/format";
import { renderLayout } from "../layout";

export interface ErrorPageOptions {
	config: Config;
	status: number;
	title: string;
	message: string;
	hint?: string | undefined;
	detail?: string | undefined;
}

export function renderErrorPage(options: ErrorPageOptions): string {
	const hint = options.hint
		? `<p class="lede">${escapeHtml(options.hint)}</p>`
		: "";
	const detail = options.detail
		? `<details class="advanced"><summary>More detail</summary><div class="advanced-body"><p class="field-note mono">${escapeHtml(options.detail)}</p></div></details>`
		: "";

	const body = `
	<section class="card error-card">
		<p class="error-code mono">${escapeHtml(String(options.status))}</p>
		<h1 class="h1">${escapeHtml(options.title)}</h1>
		${hint}
		<p class="lede">${escapeHtml(options.message)}</p>
		${detail}
		<div class="form-actions">
			<a class="btn btn-primary" href="/">Make a paste instead</a>
		</div>
	</section>
`;

	return renderLayout({
		config: options.config,
		page: "error",
		title: options.title,
		body,
		noindex: true,
	});
}
