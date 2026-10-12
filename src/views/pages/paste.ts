import type { Config } from "../../config";
import { escapeHtml, formatBytes, formatDateTime, formatDisplayDateTime, formatDuration } from "../../lib/format";
import { languageLabel } from "../../lib/languages";
import { classifyMedia } from "../../lib/media";
import { icons, notice, renderLayout } from "../layout";
import type { PasteRecord } from "../../types";

export interface PastePageOptions {
	config: Config;
	record: PasteRecord;
	/** Inline body for small pastes; null when the body lives in object storage. */
	inline: string | null;
	/** True when the visitor holds a valid unlock cookie or password header. */
	unlocked: boolean;
	now: number;
	/** Extra flash message, e.g. after a successful reveal. */
	flash?: { tone: "info" | "warn" | "success"; body: string } | null;
}

export function titleFor(record: PasteRecord): string {
	if (record.title) return record.title;
	if (record.kind === "file") return record.filename ?? "A file";
	if (record.encrypted) return "An encrypted slip";
	return "Untitled slip";
}

/** The quiet one-line ledger under the title: what · when · for how long · how big. */
function metaLine(record: PasteRecord, config: Config, now: number): string {
	const parts: string[] = [];

	if (record.kind === "file") {
		parts.push(`<span class="meta-chip">${icons.file}${escapeHtml(record.filename ?? "file")}</span>`);
	} else if (record.markdown) {
		parts.push(`<span class="meta-chip">${icons.file}Markdown</span>`);
	} else if (record.kind === "text" && record.language) {
		parts.push(`<span class="meta-chip">${icons.file}${escapeHtml(languageLabel(record.language))}</span>`);
	}

	parts.push(
		`<span>sealed <time datetime="${escapeHtml(formatDateTime(record.createdAt))}" data-relative="${record.createdAt}">${escapeHtml(formatDisplayDateTime(record.createdAt))}</time></span>`,
	);
	parts.push(
		`<span>fades <time datetime="${escapeHtml(formatDateTime(record.expiresAt))}" data-relative-expiry="${record.expiresAt}" data-relative-before="in">in ${escapeHtml(formatDuration(Math.max(0, Math.round((record.expiresAt - now) / 1000))))}</time></span>`,
	);
	if (config.viewCounting) {
		parts.push(
			`<span class="meta-chip">${icons.eye}${record.views === 1 ? "1 read" : `${escapeHtml(String(record.views))} reads`}</span>`,
		);
	}
	parts.push(`<span>${escapeHtml(formatBytes(record.sizeBytes))}</span>`);
	if (record.passwordVerifier) {
		parts.push(`<span class="meta-chip">${icons.key}password</span>`);
	}
	if (record.encrypted) {
		parts.push(`<span class="meta-chip">${icons.lock}encrypted in-browser</span>`);
	}
	if (record.burnAfterRead) {
		parts.push(`<span class="meta-chip meta-burn">${icons.flame}burns after reading</span>`);
	}

	return `<p class="paste-meta">${parts.join('<span class="meta-dot" aria-hidden="true">·</span>')}</p>`;
}

function actionBar(record: PasteRecord, options: { revealed: boolean }): string {
	const actions: string[] = [];
	const isText = record.kind === "text" && !record.encrypted;

	if (isText || record.markdown) {
		actions.push(
			`<button class="btn btn-secondary tool-btn" type="button" data-copy-content data-js-only>${icons.copy}<span>Copy</span></button>`,
		);
	}
	actions.push(
		`<button class="btn btn-secondary tool-btn" type="button" data-copy-link data-js-only>${icons.link}<span>Copy link</span></button>`,
	);
	if (isText && !record.markdown) {
		actions.push(
			`<button class="btn btn-secondary tool-btn" type="button" data-wrap-toggle data-js-only aria-pressed="false" title="Wrap long lines">${icons.wrap}<span>Wrap</span></button>`,
		);
	}
	if (!record.encrypted) {
		if (record.kind === "file") {
			actions.push(
				`<a class="btn btn-secondary tool-btn" href="${escapeHtml(`/download/${record.id}`)}">${icons.download}<span>Save</span></a>`,
			);
		} else if (isText) {
			actions.push(
				`<a class="btn btn-secondary tool-btn" href="${escapeHtml(`/p/${record.id}/download`)}">${icons.download}<span>Save</span></a>`,
			);
			if (!options.revealed) {
				actions.push(
					`<a class="btn btn-secondary tool-btn" href="${escapeHtml(`/p/${record.id}/raw`)}">${icons.raw}<span>Raw</span></a>`,
				);
			}
		}
	}
	if (!record.encrypted && record.passwordVerifier === null && record.kind === "text") {
		actions.push(
			`<a class="btn btn-quiet tool-btn" href="${escapeHtml(`/?fork=${record.id}`)}">${icons.fork}<span>Fork</span></a>`,
		);
	}
	// Shown by the page script when this device holds the delete key.
	actions.push(
		`<span class="letgo-slot" data-letgo-slot hidden>
			<button class="btn btn-secondary tool-btn letgo-btn" type="button" data-letgo>${icons.trash}<span>Let go</span></button>
			<button class="btn btn-danger tool-btn" type="button" data-letgo-confirm hidden>Sure?</button>
			<button class="btn btn-secondary tool-btn" type="button" data-letgo-cancel hidden>Keep it</button>
		</span>`,
	);
	return `<div class="action-bar">${actions.join("")}</div>`;
}

/** Password gate. The derivation happens in the browser; the server only compares a verifier. */
function lockedBody(record: PasteRecord): string {
	return `
	<div class="gate-wrap">
		<section class="card gate-card rise-in">
			<span class="gate-icon">${icons.key}</span>
			<h1 class="h1 gate-title">A locked slip.</h1>
			<p class="lede">The sender set a password. Your browser turns it into a key before anything is sent — the password itself never travels.</p>
			<form class="gate-form" data-unlock-form data-paste-id="${escapeHtml(record.id)}">
				<input class="text-input gate-input" type="password" id="password" name="password" placeholder="The password, as you were told it" autocomplete="current-password" required data-autofocus aria-label="Password">
				<button class="btn btn-primary gate-submit" type="submit">${icons.lock}<span>Open the slip</span></button>
				<p class="field-error" data-unlock-error hidden role="alert"></p>
			</form>
			<noscript>
				<div class="notice notice-info">
					<p class="notice-title">JavaScript is off</p>
					<div class="notice-body">Locked slips are opened with a key derived in your browser, which needs JavaScript. Terminal users can send a derived verifier — see the <a href="/docs">API docs</a>.</div>
				</div>
			</noscript>
			<p class="gate-foot">Changed your mind? <a href="/">Leave it sealed</a></p>
		</section>
	</div>`;
}

/** Reveal page for burn-after-reading: a preview bot sees only a button. */
function revealBody(record: PasteRecord): string {
	return `
	<div class="gate-wrap">
		<section class="card gate-card rise-in">
			<span class="gate-icon">${icons.flame}</span>
			<h1 class="h1 gate-title">This slip <span class="font-display-it">burns</span> after it's read.</h1>
			<p class="lede">Once. That's all it has. The moment you open it, it's gone for everyone — link previews and refreshing can't coax it back.</p>
			<form method="post" action="/api/pastes/${escapeHtml(record.id)}/reveal" class="gate-form" data-reveal-form>
				<button class="btn btn-primary gate-submit" type="submit">${icons.eye}<span>Read it, and let it go</span></button>
			</form>
			<p class="gate-foot">Link previews and crawlers never press buttons, so this slip is safe from being opened for you.</p>
		</section>
	</div>`;
}

function encryptedBody(record: PasteRecord): string {
	return `
	<section class="card slip-body-card" data-encrypted-view data-paste-id="${escapeHtml(record.id)}">
		<h2 class="h2">${icons.lock}An encrypted slip</h2>
		<p class="lede">This was encrypted in the sender's browser. The key lives in the part of the link after the <span class="mono">#</span>, which never reaches our servers — so your browser needs JavaScript, and we can't help if the whole link is lost.</p>
		<div class="encrypted-output" data-encrypted-output hidden>
			<h3 class="h3" data-encrypted-title></h3>
			<pre class="code-block" data-encrypted-text hidden><code></code></pre>
			<div class="file-card" data-encrypted-file hidden>
				<span class="file-icon">${icons.file}</span>
				<div class="file-meta">
					<p class="file-name mono" data-encrypted-filename></p>
					<p class="field-note" data-encrypted-filesize></p>
				</div>
				<button class="btn btn-primary" type="button" data-encrypted-download>${icons.download}<span>Save file</span></button>
			</div>
		</div>
		<p class="field-error" data-encrypted-error hidden role="alert"></p>
		<noscript>
			<div class="notice notice-info">
				<p class="notice-title">JavaScript is off</p>
				<div class="notice-body">This slip can only be decrypted in a browser. The bytes are stored, but without JavaScript there is nothing to unscramble them.</div>
			</div>
		</noscript>
	</section>`;
}

/**
 * A stored file, with a frame only for what a browser may be handed safely.
 *
 * `classifyMedia` is the same gate the `/media` route applies, so the page can
 * never promise a preview the response would refuse. A burn is excluded because
 * a preview must not spend it; a password-locked file is excluded until the
 * visitor has unlocked, because the media route demands the same ticket.
 */
function fileBody(record: PasteRecord, unlocked: boolean): string {
	const name = record.filename ?? "download";
	const eligible = unlocked && !record.encrypted && !record.burnAfterRead && !record.passwordVerifier;
	const media = eligible
		? classifyMedia(record.contentType, record.filename)
		: { kind: null, contentType: null, reason: null };
	const src = `/p/${encodeURIComponent(record.id)}/media`;
	const caption = `${escapeHtml(formatBytes(record.sizeBytes))}${record.contentType ? ` · ${escapeHtml(record.contentType)}` : ""}`;

	let frame = "";
	let primary = `<a class="btn btn-primary" href="${escapeHtml(`/download/${record.id}`)}">${icons.download}<span>Save file</span></a>`;
	let note = "downloads rather than opens in the browser";

	if (media.kind === "image") {
		frame = `<figure class="media-frame"><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async"></figure>`;
		note = "shown here, at its own size · the original still downloads";
	} else if (media.kind === "video") {
		frame = `<figure class="media-frame"><video src="${escapeHtml(src)}" controls playsinline preload="metadata"></video></figure>`;
		note = "plays here · seeking needs the downloaded copy";
	} else if (media.kind === "audio") {
		frame = `<div class="media-frame media-audio"><audio src="${escapeHtml(src)}" controls preload="metadata"></audio></div>`;
		note = "plays here · the original still downloads";
	} else if (media.kind === "pdf") {
		note = "opens in your browser's own viewer, in a tab of its own";
		primary = `<a class="btn btn-primary" href="${escapeHtml(src)}" target="_blank" rel="noopener">${icons.eye}<span>Open the PDF</span></a>${primary}`;
	} else if (media.kind === "text") {
		note = "read it here, or take the file";
		frame = `<pre class="code-block media-text" data-file-text data-src="${escapeHtml(src)}" hidden><code>Loading…</code></pre>`;
		primary = `<button class="btn btn-secondary" type="button" data-file-text-toggle>${icons.raw}<span>Read it here</span></button>${primary}`;
	}

	return `
	${frame}
	<div class="file-card rise-in">
		<span class="file-icon">${icons.file}</span>
		<div class="file-meta">
			<p class="file-name mono">${escapeHtml(name)}</p>
			<p class="field-note">${caption} · ${escapeHtml(note)}</p>
		</div>
		<span class="file-actions">${primary}</span>
	</div>`;
}

export function renderPastePage(options: PastePageOptions): string {
	const { record, config, now } = options;

	if (record.passwordVerifier && !options.unlocked) {
		return renderLayout({
			config,
			page: "paste",
			title: "A locked slip",
			body: lockedBody(record),
			noindex: true,
			compactHeader: true,
			bodyAttributes: { "data-paste-id": record.id, "data-locked": "1" },
		});
	}

	if (record.burnAfterRead && record.consumedAt === null && !options.flash) {
		return renderLayout({
			config,
			page: "paste",
			title: "A one-time slip",
			body: revealBody(record),
			noindex: true,
			compactHeader: true,
			bodyAttributes: { "data-paste-id": record.id, "data-burn": "1" },
		});
	}

	let content: string;
	if (record.encrypted) {
		content = encryptedBody(record);
	} else if (record.kind === "file") {
		content = fileBody(record, options.unlocked);
	} else if (options.inline !== null) {
		content = `<pre class="code-block" data-code data-language="${escapeHtml(record.language ?? "plaintext")}"${record.markdown ? " data-markdown-source" : ""}><code>${escapeHtml(options.inline)}</code></pre>`;
	} else {
		content = `
		<pre class="code-block" data-remote-code data-src="${escapeHtml(`/p/${record.id}/raw`)}" data-language="${escapeHtml(record.language ?? "plaintext")}"><code>Loading the slip…</code></pre>
		<noscript>
			<div class="notice notice-info">
				<p class="notice-title">Large slip</p>
				<div class="notice-body">This one is too big to inline without JavaScript. <a href="${escapeHtml(`/p/${record.id}/raw`)}">Open the raw text</a> instead.</div>
			</div>
		</noscript>`;
	}

	// Markdown is rendered in the reader's browser from the same escaped source that is
	// on the page: without JavaScript the raw text is still readable, and the renderer
	// never sees HTML it did not produce itself.
	const markdownOutput = record.markdown ? `<div class="md-view" data-markdown-output hidden></div>` : "";

	const burned = Boolean(options.flash);
	const flash = options.flash
		? options.flash.tone === "warn"
			? `<p class="burn-note">${icons.flame}<span>Read once, gone forever — this slip was destroyed the moment it reached you. Copy anything you still need.</span></p>`
			: notice({ tone: options.flash.tone, body: options.flash.body })
		: "";

	const body = `
	<article class="paste-article rise-in">
		<header class="paste-header">
			<h1 class="paste-title">${record.title || record.kind === "file" ? escapeHtml(titleFor(record)) : `<span class="font-display-it untitled">${escapeHtml(titleFor(record))}</span>`}</h1>
			${metaLine(record, config, now)}
			${actionBar(record, { revealed: burned })}
		</header>
		${flash}
		<div class="paste-body">
			${content}
			${markdownOutput}
		</div>
		<p class="paste-foot">${icons.lock}<span>Unlisted and unindexed — whoever holds this link holds the slip.</span></p>
	</article>
`;

	return renderLayout({
		config,
		page: "paste",
		title: titleFor(record),
		body,
		noindex: true,
		compactHeader: true,
		bodyAttributes: {
			"data-paste-id": record.id,
			"data-paste-kind": record.kind,
			"data-encrypted": record.encrypted ? "1" : "0",
			"data-markdown": record.markdown ? "1" : "0",
			"data-views": String(record.views),
		},
	});
}

export { metaLine as pasteMetaLine };
