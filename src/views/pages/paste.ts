import type { Config } from "../../config";
import { escapeHtml, formatBytes, formatDateTime, formatDisplayDateTime, formatExpiry } from "../../lib/format";
import { languageLabel } from "../../lib/languages";
import { button, icon, icons, metaRow, notice, renderLayout } from "../layout";
import type { PasteRecord } from "../../types";

export interface PastePageOptions {
	config: Config;
	record: PasteRecord;
	/** Inline body for small pastes; null when the body lives in R2. */
	inline: string | null;
	/** True when the visitor holds a valid unlock cookie or password header. */
	unlocked: boolean;
	now: number;
	/** Extra flash message, e.g. after a successful reveal. */
	flash?: { tone: "info" | "warn" | "success"; body: string } | null;
}

function pasteBadges(record: PasteRecord): string {
	const badges: string[] = [];
	if (record.encrypted) badges.push(`<span class="badge badge-pink">${icons.lock}Encrypted</span>`);
	if (record.passwordVerifier) badges.push(`<span class="badge badge-pink">${icons.key}Password</span>`);
	if (record.burnAfterRead) badges.push(`<span class="badge badge-pink">${icons.flame}Burn after opening</span>`);
	if (record.markdown) badges.push(`<span class="badge badge-mint">Markdown</span>`);
	if (record.kind === "redirect") badges.push(`<span class="badge badge-mint">${icons.link}Link</span>`);
	return badges.length ? `<div class="badge-row">${badges.join("")}</div>` : "";
}

function titleFor(record: PasteRecord): string {
	if (record.title) return record.title;
	if (record.kind === "file") return record.filename ?? "File";
	if (record.encrypted) return "Encrypted paste";
	return "Untitled paste";
}

function actionBar(record: PasteRecord, options: { showFork: boolean }): string {
	const actions: string[] = [];

	// Copying the plaintext only makes sense when a plaintext body exists on this page.
	actions.push(
		button({
			label: "Copy content",
			iconName: "copy",
			attributes: "data-copy-content data-js-only",
			variant: "secondary",
		}),
	);
	actions.push(
		button({ label: "Copy link", iconName: "link", attributes: "data-copy-link data-js-only", variant: "secondary" }),
	);
	actions.push(
		button({ label: "QR code", iconName: "qr", attributes: "data-qr-open data-js-only", variant: "secondary" }),
	);

	if (!record.encrypted) {
		if (record.kind !== "redirect") {
			actions.push(
				`<a class="btn btn-secondary" href="${escapeHtml(`/${record.id}/raw`)}">${icon("raw")}<span>Raw</span></a>`,
			);
		}
		if (record.kind === "file") {
			actions.push(
				`<a class="btn btn-secondary" href="${escapeHtml(`/${record.id}/download`)}">${icon("download")}<span>Download</span></a>`,
			);
		}
	}
	if (options.showFork) {
		actions.push(
			`<a class="btn btn-quiet" href="${escapeHtml(`/?fork=${record.id}`)}">${icon("fork")}<span>Fork</span></a>`,
		);
	}
	return `<div class="action-bar">${actions.join("")}</div>`;
}

function metaFor(record: PasteRecord, config: Config, now: number): string {
	const items: Array<{ label: string; value: string; iconName?: "eye" }> = [];
	if (record.kind === "text" && record.language) {
		items.push({ label: "Language", value: `<span class="mono">${escapeHtml(languageLabel(record.language))}</span>` });
	}
	if (record.kind === "file" && record.filename) {
		items.push({ label: "File", value: `<span class="mono">${escapeHtml(record.filename)}</span>` });
		items.push({ label: "Size", value: escapeHtml(formatBytes(record.sizeBytes)) });
	}
	if (record.kind !== "redirect") {
		items.push({ label: "Size", value: escapeHtml(formatBytes(record.sizeBytes)) });
	}
	items.push({
		label: "Created",
		value: `<time datetime="${escapeHtml(formatDateTime(record.createdAt))}" data-relative="${record.createdAt}">${escapeHtml(formatDisplayDateTime(record.createdAt))}</time>`,
	});
	items.push({
		label: "Expires",
		value: `<time datetime="${escapeHtml(formatDateTime(record.expiresAt))}" data-relative-expiry="${record.expiresAt}" data-relative-before="Expires">${escapeHtml(formatExpiry(record.expiresAt, now))}</time>`,
	});
	if (config.viewCounting) {
		items.push({
			label: "Reads",
			value: `${escapeHtml(String(record.views))} <span class="muted">(approximate)</span>`,
		});
	}
	return metaRow(items);
}

/** Password gate. The derivation happens in the browser; the server only compares a verifier. */
function lockedBody(record: PasteRecord): string {
	return `
	<section class="card gate-card">
		<h1 class="h2">${icons.lock}This paste is protected</h1>
		<p class="lede">Enter the password to open it. Nothing is sent until your browser has turned it into a key.</p>
		<form class="form-grid" data-unlock-form data-paste-id="${escapeHtml(record.id)}">
			<div class="field">
				<label for="password">Password</label>
				<input class="text-input" type="password" id="password" name="password" autocomplete="current-password" required data-autofocus>
			</div>
			<div class="form-actions">
				<button class="btn btn-primary" type="submit">${icons.key}<span>Open</span></button>
			</div>
			<p class="field-note" data-unlock-error hidden role="alert"></p>
		</form>
		<noscript>
			<div class="notice notice-info">
				<p class="notice-title">JavaScript is off</p>
				<div class="notice-body">Password-protected pastes are opened with a key derived in your browser, which needs JavaScript. Terminal users can request the raw paste with a derived verifier — see the <a href="/about">API notes</a>.</div>
			</div>
		</noscript>
	</section>`;
}

/** Reveal page for burn-after-reading: a preview bot sees only a button. */
function revealBody(record: PasteRecord): string {
	return `
	<section class="card gate-card">
		<h1 class="h2">${icons.flame}This link opens once</h1>
		<p class="lede">Press the button and the paste appears. It's deleted straight afterwards, and this page won't work a second time.</p>
		<form method="post" action="/api/pastes/${escapeHtml(record.id)}/reveal" class="form-grid" data-reveal-form>
			<div class="form-actions">
				<button class="btn btn-primary" type="submit">${icons.eye}<span>Open it</span></button>
			</div>
		</form>
		<p class="field-note">Link previews and crawlers never press buttons, so this paste is safe from being opened for you.</p>
	</section>`;
}

function encryptedBody(record: PasteRecord): string {
	return `
	<section class="card" data-encrypted-view data-paste-id="${escapeHtml(record.id)}">
		<h1 class="h2">${icons.lock}Encrypted paste</h1>
		<p class="lede">This was encrypted in the sender's browser. The key lives in the part of the link after the <span class="mono">#</span>, which never reaches our servers — so your browser needs JavaScript, and we can't help if the whole link is lost.</p>
		<div class="encrypted-output" data-encrypted-output hidden>
			<h2 class="h3" data-encrypted-title></h2>
			<pre class="code-block" data-encrypted-text hidden><code></code></pre>
			<div class="file-card" data-encrypted-file hidden>
				${icons.file}
				<div class="file-meta">
					<p class="file-name mono" data-encrypted-filename></p>
					<p class="field-note" data-encrypted-filesize></p>
				</div>
				<button class="btn btn-primary" type="button" data-encrypted-download>${icons.download}<span>Save file</span></button>
			</div>
		</div>
		<p class="field-note" data-encrypted-error hidden role="alert"></p>
		<noscript>
			<div class="notice notice-info">
				<p class="notice-title">JavaScript is off</p>
				<div class="notice-body">This paste can only be decrypted in a browser. The bytes are stored, but without JavaScript there is nothing to unscramble them.</div>
			</div>
		</noscript>
	</section>`;
}

function redirectBody(record: PasteRecord): string {
	const destination = record.redirectUrl ?? "";
	let host = destination;
	try {
		host = new URL(destination).hostname;
	} catch {
		host = destination;
	}

	return `
	<section class="card gate-card">
		<h1 class="h2">${icons.link}This link goes somewhere else</h1>
		<p class="lede">PurePaste is passing you on to <strong>${escapeHtml(host)}</strong>. Check the destination before you continue — short links can hide anything.</p>
		<div class="destination">
			<span class="destination-label">Destination</span>
			<span class="destination-url mono">${escapeHtml(destination)}</span>
		</div>
		<div class="form-actions">
			<a class="btn btn-primary" href="${escapeHtml(destination)}" rel="noopener noreferrer nofollow" referrerpolicy="no-referrer" data-external>${icons.external}<span>Continue to ${escapeHtml(host)}</span></a>
			<a class="btn btn-secondary" href="/">Back to PurePaste</a>
		</div>
	</section>`;
}

export function renderPastePage(options: PastePageOptions): string {
	const { record, config, now } = options;

	if (record.passwordVerifier && !options.unlocked) {
		return renderLayout({
			config,
			page: "paste",
			title: "Protected paste",
			body: lockedBody(record),
			noindex: true,
			bodyAttributes: { "data-paste-id": record.id, "data-locked": "1" },
		});
	}

	if (record.burnAfterRead && record.consumedAt === null && !options.flash) {
		return renderLayout({
			config,
			page: "paste",
			title: "One-time link",
			body: revealBody(record),
			noindex: true,
			bodyAttributes: { "data-paste-id": record.id, "data-burn": "1" },
		});
	}

	let content: string;
	if (record.encrypted) {
		content = encryptedBody(record);
	} else if (record.kind === "redirect") {
		content = redirectBody(record);
	} else if (record.kind === "file") {
		content = `
		<div class="file-card">
			${icons.file}
			<div class="file-meta">
				<p class="file-name mono">${escapeHtml(record.filename ?? "download")}</p>
				<p class="field-note">${escapeHtml(formatBytes(record.sizeBytes))} · downloads rather than opens in the browser</p>
			</div>
			<a class="btn btn-primary" href="${escapeHtml(`/${record.id}/download`)}">${icons.download}<span>Download</span></a>
		</div>`;
	} else if (options.inline !== null) {
		content = `<pre class="code-block" data-code data-language="${escapeHtml(record.language ?? "plaintext")}"${record.markdown ? " data-markdown-source" : ""}><code>${escapeHtml(options.inline)}</code></pre>`;
	} else {
		content = `
		<pre class="code-block" data-remote-code data-src="${escapeHtml(`/${record.id}/raw`)}" data-language="${escapeHtml(record.language ?? "plaintext")}"><code>Loading the paste…</code></pre>
		<noscript>
			<div class="notice notice-info">
				<p class="notice-title">Large paste</p>
				<div class="notice-body">This one is too big to inline without JavaScript. <a href="${escapeHtml(`/${record.id}/raw`)}">Open the raw text</a> instead.</div>
			</div>
		</noscript>`;
	}

	// Markdown is rendered in the reader's browser from the same escaped source that is
	// on the page: without JavaScript the raw text is still readable, and the renderer
	// never sees HTML it did not produce itself.
	const markdownOutput = record.markdown ? `<div class="markdown-body" data-markdown-output hidden></div>` : "";

	const forkable = !record.encrypted && record.passwordVerifier === null;

	const body = `
	<article class="paste-article">
		<header class="paste-header">
			<h1 class="h1">${escapeHtml(titleFor(record))}</h1>
			${pasteBadges(record)}
			${metaFor(record, config, now)}
		</header>
		${options.flash ? notice({ tone: options.flash.tone, body: options.flash.body }) : ""}
		<div class="paste-body">
			${content}
			${markdownOutput}
		</div>
		${actionBar(record, { showFork: forkable })}
	</article>

	<dialog class="dialog" data-qr-dialog aria-labelledby="qr-title">
		<h2 class="h3" id="qr-title">Scan to open</h2>
		<div class="qr-holder" data-qr-holder></div>
		<p class="field-note" data-qr-url></p>
		<form method="dialog" class="form-actions">
			<button class="btn btn-secondary" type="submit">Close</button>
		</form>
	</dialog>
`;

	return renderLayout({
		config,
		page: "paste",
		title: titleFor(record),
		body,
		noindex: true,
		bodyAttributes: {
			"data-paste-id": record.id,
			"data-paste-kind": record.kind,
			"data-encrypted": record.encrypted ? "1" : "0",
			"data-markdown": record.markdown ? "1" : "0",
			"data-views": String(record.views),
		},
	});
}

export { pasteBadges, titleFor };
