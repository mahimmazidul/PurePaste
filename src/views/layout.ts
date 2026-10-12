import { escapeHtml } from "../lib/format";
import type { Config } from "../config";

/**
 * The repository this deployment was built from. Every link to it on the site comes
 * from here, so a fork changes one line and the copy stays true.
 */
export const REPO_URL = "https://github.com/mahimmazidul/PurePaste";

/** `github.com/mahimmazidul/PurePaste`, for the places where a URL reads better than a word. */
export const REPO_LABEL = REPO_URL.replace(/^https?:\/\//, "");

/** The attributes every outbound link to the repository carries. */
export const REPO_LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';

/**
 * Icons drawn on a 20×20 grid, 1.6 strokes: quiet line work that matches the
 * paper design. One exception, at the bottom: the GitHub mark is their artwork
 * rather than ours, in the public domain (CC0, via Simple Icons), and it is used
 * for the one thing it means — a link to a repository. Its licence text ships at
 * /assets/licenses/github-CC0.txt and is listed on /licenses like everything else.
 */
export const icons = {
	copy: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7.25" y="7.25" width="9.5" height="9.5" rx="2.5"/><path d="M12.75 4.6a2.5 2.5 0 0 0-2.5-2.35H5.5A2.5 2.5 0 0 0 3 4.75v4.75a2.5 2.5 0 0 0 2.35 2.5"/></svg>`,
	download: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2v9.1"/><path d="M6.4 9.2 10 12.8l3.6-3.6"/><path d="M3.6 16.4h12.8"/></svg>`,
	upload: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 12.8V3.7"/><path d="M6.4 7.3 10 3.7l3.6 3.6"/><path d="M3.6 16.4h12.8"/></svg>`,
	trash: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.2h11.6"/><path d="M8 3.4h4l.6 2.8H7.4z"/><path d="M6.1 6.4l.7 9.1a1.6 1.6 0 0 0 1.6 1.5h3.2a1.6 1.6 0 0 0 1.6-1.5l.7-9.1"/></svg>`,
	fork: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.4 4.6v3.9a3.2 3.2 0 0 0 3.2 3.2h4"/><path d="M12.2 9.4l2.4 2.3-2.4 2.3"/><path d="M4.6 16.4h4.6"/></svg>`,
	raw: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 4.4 5 10l3.6 5.6"/><path d="M11.4 4.4 15 10l-3.6 5.6"/></svg>`,
	lock: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.4" y="8.6" width="11.2" height="8" rx="2.4"/><path d="M7.2 8.6V6.9a2.8 2.8 0 0 1 5.6 0v1.7"/></svg>`,
	key: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.4" cy="12.6" r="3.4"/><path d="M9.9 10.1 16 4m-2.2 1.8 1.8 1.8M11.4 8.6l1.8 1.8"/></svg>`,
	flame: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2c2.6 2.4 4.4 4.4 4.4 7.2a4.4 4.4 0 0 1-8.8 0c0-1.3.5-2.3 1.3-3.4.5 1 1.1 1.4 1.6 1.4.4-2 .7-3.6 1.5-5.2Z"/></svg>`,
	file: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.6 3.2H6.8a2 2 0 0 0-2 2v9.6a2 2 0 0 0 2 2h6.4a2 2 0 0 0 2-2V7z"/><path d="M11.6 3.2V7h3.6"/></svg>`,
	link: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.4 11.6 11.6 8.4"/><path d="M9.4 6.6 11 5a3.5 3.5 0 0 1 5 5l-1.6 1.6"/><path d="M10.6 13.4 9 15a3.5 3.5 0 0 1-5-5l1.6-1.6"/></svg>`,
	eye: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 10S5.4 5.4 10 5.4 17.4 10 17.4 10 14.6 14.6 10 14.6 2.6 10 2.6 10Z"/><circle cx="10" cy="10" r="2.2"/></svg>`,
	eyeOff: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.6C3 7.9 2.6 10 2.6 10s2.8 4.6 7.4 4.6c1.2 0 2.3-.3 3.2-.7M7.6 7.9A7.5 7.5 0 0 1 10 7.5c4.6 0 7.4 2.5 7.4 2.5s-.6 1-1.8 2.1"/><path d="M8.6 8.7a2.2 2.2 0 0 0 2.9 2.9"/><path d="M4 4l12 12"/></svg>`,
	check: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 10.6 8.2 14.2l7.2-8.4"/></svg>`,
	close: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2"/></svg>`,
	external: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.2 5.4H6.4a2.2 2.2 0 0 0-2.2 2.2v6a2.2 2.2 0 0 0 2.2 2.2h6a2.2 2.2 0 0 0 2.2-2.2V11.8"/><path d="M12 4.4h3.6V8"/><path d="M15.4 4.6 9.8 10.2"/></svg>`,
	arrowUpRight: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14 14 6"/><path d="M8 6h6v6"/></svg>`,
	info: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v4.2M10 6.6v.6"/></svg>`,
	alert: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6.4v4.4M10 13.2v.6"/></svg>`,
	sun: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 2.8v1.6M10 15.6v1.6M3.4 10H5M15 10h1.6M5.3 5.3l1.1 1.1M13.6 13.6l1.1 1.1M14.7 5.3l-1.1 1.1M6.4 13.6l-1.1 1.1"/></svg>`,
	moon: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.8 12.4A6.6 6.6 0 0 1 7.6 4.2a6.8 6.8 0 1 0 8.2 8.2Z"/></svg>`,
	leaf: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 15.4C3 11 5.6 5.8 11 4.2c1.8-.5 3.4-.5 4.4-.4.1 1 .1 2.6-.4 4.4-1.6 5.4-6.8 8-11.2 6.4"/><path d="M4.2 15.8C6 12.4 9 9.8 12.6 8.6"/></svg>`,
	hourglass: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.2h8M6 16.8h8"/><path d="M7 3.2c0 3 3 3.9 3 6.8 0-2.9 3-3.8 3-6.8"/><path d="M7 16.8c0-3 3-3.9 3-6.8 0 2.9 3 3.8 3 6.8"/></svg>`,
	plus: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 5v10M5 10h10"/></svg>`,
	chevronDown: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 8 10 12.5 14.5 8"/></svg>`,
	wrap: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 5.4h12.8M3.6 10h9.6a2.6 2.6 0 0 1 0 5.2h-2.4"/><path d="M12.4 13.4 10.6 15.2l1.8 1.8"/><path d="M3.6 14.6h3.2"/></svg>`,
	// Solid rather than stroked, because it is a mark and not a drawing: an 8×8
	// cat on a 20×20 grid would be a smudge of ink at the sizes we use it.
	github: `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`,
} as const;

export type IconName = keyof typeof icons;

export interface LayoutOptions {
	config: Config;
	/** Short page title; the brand name is appended. */
	title: string;
	page: string;
	body: string;
	description?: string;
	/** Loads the enhancement bundle. Pages that work entirely without it still get it for the small wins. */
	script?: boolean;
	noindex?: boolean;
	bodyAttributes?: Record<string, string>;
	/** True on reading pages, where the header keeps to itself. */
	compactHeader?: boolean;
}

export function renderLayout(options: LayoutOptions): string {
	const { config } = options;
	const title = options.title === "Slip" ? "Slip — a quiet place for text" : `${options.title} · Slip`;
	const description =
		options.description ??
		"Slip is a small, accountless place to share text, links and files. Everything expires, nothing is indexed.";

	const bodyAttributes = Object.entries({
		"data-page": options.page,
		...(options.bodyAttributes ?? {}),
	})
		.map(([key, value]) => `${key}="${escapeHtml(value)}"`)
		.join(" ");

	const turnstileScript =
		config.turnstileEnabled && config.turnstileSiteKey
			? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
	<meta name="turnstile-site-key" content="${escapeHtml(config.turnstileSiteKey)}">`
			: "";

	const tagline = options.compactHeader ? "" : `<span class="tagline smallcaps">text &amp; links that fade</span>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${options.noindex ? '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">' : '<meta name="robots" content="noindex, nofollow">'}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f4ed" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#171611" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/styles/app.css">
<script src="/assets/scripts/theme.js"></script>
${turnstileScript}
</head>
<body ${bodyAttributes}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header hairline-b">
	<div class="shell header-inner">
		<a class="wordmark" href="/" aria-label="Slip home">Slip<span class="wordmark-dot">.</span></a>
		<div class="header-side">
			${tagline}
			<a class="repo-link" href="${REPO_URL}" ${REPO_LINK_ATTRS} aria-label="Source code on GitHub" title="The code for this site, on GitHub">${icons.github}</a>
			<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch theme" title="Switch theme">
				<span class="theme-icon-dark">${icons.sun}</span>
				<span class="theme-icon-light">${icons.moon}</span>
			</button>
		</div>
	</div>
</header>
<main id="main" class="shell">
${options.body}
</main>
<footer class="site-footer hairline-t">
	<div class="shell footer-inner">
		<p>Everything on Slip expires. Nothing is listed or indexed — the link is the only way in.</p>
		<nav aria-label="Footer"><p class="footer-links"><a href="/about">How it works</a> · <a href="/docs">API</a> · <a href="/licenses">Licences</a> · <a href="${REPO_URL}" ${REPO_LINK_ATTRS}>Source</a></p></nav>
	</div>
</footer>
<div class="toast-stack" data-toasts aria-live="polite" aria-atomic="false"></div>
${options.script === false ? "" : '<script type="module" src="/assets/scripts/app.js"></script>'}
</body>
</html>`;
}

/** Small reusable pieces used by several pages. */

export function icon(name: IconName, className = "icon"): string {
	return `<span class="${className}">${icons[name]}</span>`;
}

export function button(options: {
	label: string;
	iconName?: IconName;
	href?: string;
	type?: "button" | "submit";
	variant?: "primary" | "secondary" | "quiet" | "danger";
	attributes?: string;
	extraClass?: string;
}): string {
	const variant = options.variant ?? "secondary";
	const className = `btn btn-${variant}${options.extraClass ? ` ${options.extraClass}` : ""}`;
	const inner = `${options.iconName ? icon(options.iconName) : ""}<span>${escapeHtml(options.label)}</span>`;
	const attributes = options.attributes ?? "";
	if (options.href) {
		return `<a class="${className}" href="${escapeHtml(options.href)}" ${attributes}>${inner}</a>`;
	}
	return `<button class="${className}" type="${options.type ?? "button"}" ${attributes}>${inner}</button>`;
}

export function copyField(options: { id: string; label: string; value: string; description?: string }): string {
	return `<div class="copy-field">
	<label class="copy-label smallcaps" for="${escapeHtml(options.id)}">${escapeHtml(options.label)}</label>
	<div class="copy-row">
		<input class="text-input mono" id="${escapeHtml(options.id)}" type="text" readonly value="${escapeHtml(options.value)}" spellcheck="false">
		<button class="btn btn-secondary" type="button" data-copy-target="${escapeHtml(options.id)}">
			${icons.copy}<span>Copy</span>
		</button>
	</div>
	${options.description ? `<p class="field-note">${options.description}</p>` : ""}
</div>`;
}

export function notice(options: { tone: "info" | "warn" | "success"; title?: string; body: string }): string {
	const title = options.title ? `<p class="notice-title">${escapeHtml(options.title)}</p>` : "";
	return `<div class="notice notice-${options.tone}" role="status">${title}<div class="notice-body">${options.body}</div></div>`;
}

export function errorSummary(errors: Array<{ field?: string; message: string }>): string {
	if (errors.length === 0) return "";
	const items = errors
		.map((error) =>
			error.field
				? `<li><a href="#${escapeHtml(error.field)}">${escapeHtml(error.message)}</a></li>`
				: `<li>${escapeHtml(error.message)}</li>`,
		)
		.join("");
	return `<div class="error-summary" role="alert" tabindex="-1" data-error-summary>
	<p class="error-summary-title">There's a problem with that submission</p>
	<ul>${items}</ul>
</div>`;
}

export function metaRow(items: Array<{ label: string; value: string; iconName?: IconName }>): string {
	return `<dl class="meta-row">${items
		.map(
			(item) =>
				`<div class="meta-item"><dt>${item.iconName ? icons[item.iconName] : ""}${escapeHtml(item.label)}</dt><dd>${item.value}</dd></div>`,
		)
		.join("")}</dl>`;
}
