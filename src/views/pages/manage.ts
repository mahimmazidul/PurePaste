import type { Config } from "../../config";
import { escapeHtml } from "../../lib/format";
import { icons, notice, renderLayout } from "../layout";

export interface ManagePageOptions {
	config: Config;
	id: string;
}

/**
 * The management page never receives the token: it lives in the URL fragment,
 * which browsers keep to themselves. Everything below is filled in by the
 * client script from that fragment, so the server cannot log or leak it.
 */
export function renderManagePage(options: ManagePageOptions): string {
	const body = `
	<section class="hero">
		<h1 class="h1">The delete key</h1>
		<p class="lede mono">${escapeHtml(options.id)}</p>
	</section>

	<div class="notice-row" data-manage-loading>
		${notice({ tone: "info", title: "Reading your key", body: 'The management key lives after the <span class="mono">#</span> in this link, so it stays in your browser. Checking the paste now.' })}
	</div>

	<section class="card" data-manage-panel hidden>
		<div data-manage-status></div>
		<div class="copy-field">
			<label class="copy-label smallcaps" for="public-link">Share this link</label>
			<div class="copy-row">
				<input class="text-input mono" id="public-link" type="text" readonly data-manage-public>
				<button class="btn btn-secondary" type="button" data-copy-target="public-link">${icons.copy}<span>Copy</span></button>
			</div>
		</div>
		<div class="copy-field">
			<label class="copy-label smallcaps" for="manage-link">The delete key link</label>
			<div class="copy-row">
				<input class="text-input mono" id="manage-link" type="text" readonly data-manage-link>
				<button class="btn btn-secondary" type="button" data-copy-target="manage-link">${icons.copy}<span>Copy</span></button>
			</div>
			<p class="field-note">Keep this private. Anyone who has it can let the slip go.</p>
		</div>
		<dl class="meta-row" data-manage-meta></dl>
		<div class="action-bar">
			<a class="btn btn-secondary" href="${escapeHtml(`/${options.id}`)}" data-manage-open>${icons.eye}<span>Open</span></a>
			<a class="btn btn-secondary" href="${escapeHtml(`/?fork=${options.id}`)}" data-manage-fork>${icons.fork}<span>Fork</span></a>
			<button class="btn btn-danger" type="button" data-delete-open>${icons.trash}<span>Let it go</span></button>
		</div>
	</section>

	<section class="card" data-manage-error hidden>
		<h2 class="h3">This delete key can't be used</h2>
		<p class="lede" data-manage-error-text></p>
		<p class="field-note">Management keys live in the part of the link after the <span class="mono">#</span>. If it went missing in a chat app or an email, open the original link you saved when the paste was created.</p>
	</section>

	<dialog class="dialog" data-confirm-dialog aria-labelledby="confirm-title">
		<h2 class="h3" id="confirm-title">Let this slip go?</h2>
		<p class="lede">This cannot be undone. The content is removed and the link stops working straight away.</p>
		<form method="dialog" class="form-actions">
			<button class="btn btn-secondary" type="submit" value="cancel" data-confirm-cancel>Keep it</button>
			<button class="btn btn-danger" type="submit" value="confirm" data-confirm-accept>${icons.trash}<span>Delete</span></button>
		</form>
	</dialog>

	<noscript>
		${notice({
			tone: "info",
			title: "JavaScript is off",
			body:
				'The management key is read from the URL fragment, which needs JavaScript. From a terminal you can delete a paste with <span class="mono">curl -X DELETE -H "Authorization: Bearer &lt;token&gt;" /api/pastes/' +
				escapeHtml(options.id) +
				"</span>.",
		})}
	</noscript>
`;

	return renderLayout({
		config: options.config,
		page: "manage",
		title: "The delete key",
		body,
		noindex: true,
		bodyAttributes: { "data-paste-id": options.id },
	});
}
