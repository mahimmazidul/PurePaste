import { escapeHtml } from "../lib/format";
import type { Config } from "../config";

/**
 * The brand mark: a sheet of paper with a bite taken out of the corner, so the
 * signal orange underneath shows through. No mascot, no gradient.
 */
export function brandMark(size = 24): string {
	const id = "pp-bite";
	return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
	<defs>
		<mask id="${id}">
			<rect width="24" height="24" fill="#fff" />
			<circle cx="21.4" cy="2.6" r="4.9" fill="#000" />
		</mask>
	</defs>
	<circle cx="21.4" cy="2.6" r="4.9" fill="var(--pink)" />
	<g mask="url(#${id})">
		<rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5.25" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="1.5" />
		<path d="M6.9 10.4h6.4M6.9 13.6h7.8M6.9 16.8h4.4" stroke="var(--mint-strong)" stroke-width="1.7" stroke-linecap="round" />
		<circle cx="10.4" cy="16.6" r="0" fill="none" />
	</g>
	<circle cx="17.4" cy="8.4" r="1.05" fill="var(--pink)" />
</svg>`;
}

export const icons = {
	copy: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7.25" y="7.25" width="9.5" height="9.5" rx="2.5"/><path d="M12.75 4.6a2.5 2.5 0 0 0-2.5-2.35H5.5A2.5 2.5 0 0 0 3 4.75v4.75a2.5 2.5 0 0 0 2.35 2.5"/></svg>`,
	download: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2v9.1"/><path d="M6.4 9.2 10 12.8l3.6-3.6"/><path d="M3.6 16.4h12.8"/></svg>`,
	trash: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.2h11.6"/><path d="M8 3.4h4l.6 2.8H7.4z"/><path d="M6.1 6.4l.7 9.1a1.6 1.6 0 0 0 1.6 1.5h3.2a1.6 1.6 0 0 0 1.6-1.5l.7-9.1"/></svg>`,
	qr: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.2" y="3.2" width="5.4" height="5.4" rx="1.6"/><rect x="11.4" y="3.2" width="5.4" height="5.4" rx="1.6"/><rect x="3.2" y="11.4" width="5.4" height="5.4" rx="1.6"/><path d="M11.6 11.6h2.2v2.2h-2.2zM15.4 15.4h1.4v1.4h-1.4z"/></svg>`,
	fork: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.4 4.6v3.9a3.2 3.2 0 0 0 3.2 3.2h4"/><path d="M12.2 9.4l2.4 2.3-2.4 2.3"/><path d="M4.6 16.4h4.6"/></svg>`,
	raw: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 4.4 5 10l3.6 5.6"/><path d="M11.4 4.4 15 10l-3.6 5.6"/></svg>`,
	lock: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.4" y="8.6" width="11.2" height="8" rx="2.4"/><path d="M7.2 8.6V6.9a2.8 2.8 0 0 1 5.6 0v1.7"/></svg>`,
	key: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.4" cy="12.6" r="3.4"/><path d="M9.9 10.1 16 4m-2.2 1.8 1.8 1.8M11.4 8.6l1.8 1.8"/></svg>`,
	flame: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2c2.6 2.4 4.4 4.4 4.4 7.2a4.4 4.4 0 0 1-8.8 0c0-1.3.5-2.3 1.3-3.4.5 1 1.1 1.4 1.6 1.4.4-2 .7-3.6 1.5-5.2Z"/></svg>`,
	file: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.6 3.2H6.8a2 2 0 0 0-2 2v9.6a2 2 0 0 0 2 2h6.4a2 2 0 0 0 2-2V7z"/><path d="M11.6 3.2V7h3.6"/></svg>`,
	link: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.4 11.6 11.6 8.4"/><path d="M9.4 6.6 11 5a3.5 3.5 0 0 1 5 5l-1.6 1.6"/><path d="M10.6 13.4 9 15a3.5 3.5 0 0 1-5-5l1.6-1.6"/></svg>`,
	eye: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 10S5.4 5.4 10 5.4 17.4 10 17.4 10 14.6 14.6 10 14.6 2.6 10 2.6 10Z"/><circle cx="10" cy="10" r="2.2"/></svg>`,
	check: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.6 10.6 8.2 14.2l7.2-8.4"/></svg>`,
	close: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.4 5.4l9.2 9.2M14.6 5.4l-9.2 9.2"/></svg>`,
	external: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.2 5.4H6.4a2.2 2.2 0 0 0-2.2 2.2v6a2.2 2.2 0 0 0 2.2 2.2h6a2.2 2.2 0 0 0 2.2-2.2V11.8"/><path d="M12 4.4h3.6V8"/><path d="M15.4 4.6 9.8 10.2"/></svg>`,
	info: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 9v4.2M10 6.6v.6"/></svg>`,
	theme: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 2.8v1.6M10 15.6v1.6M3.4 10H5M15 10h1.6M5.3 5.3l1.1 1.1M13.6 13.6l1.1 1.1M14.7 5.3l-1.1 1.1M6.4 13.6l-1.1 1.1"/></svg>`,
} as const;

export type IconName = keyof typeof icons;

export interface NavOptions {
	page: string;
	historyCount?: number;
}

function nav(options: NavOptions): string {
	const { page } = options;
	return `<nav class="site-nav" aria-label="Main">
	<a class="nav-link" href="/"${page === "home" ? ' aria-current="page"' : ""}>New paste</a>
	<a class="nav-link" href="/pastes"${page === "history" ? ' aria-current="page"' : ""}>My pastes<span class="nav-count" data-history-count hidden></span></a>
	<a class="nav-link" href="/about"${page === "about" ? ' aria-current="page"' : ""}>About</a>
<a class="nav-link" href="/docs"${page === "docs" ? ' aria-current="page"' : ""}>API</a>
	<div class="theme-switch" role="group" aria-label="Colour theme" data-theme-switch>
		<button type="button" class="theme-option" data-theme-value="auto" aria-pressed="true" title="Match system">${icons.theme}<span class="sr-only">System theme</span></button>
		<button type="button" class="theme-option" data-theme-value="light" aria-pressed="false" title="Light">Light</button>
		<button type="button" class="theme-option" data-theme-value="dark" aria-pressed="false" title="Dark">Dark</button>
	</div>
</nav>`;
}

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
}

export function renderLayout(options: LayoutOptions): string {
	const { config } = options;
	const title = options.title === "PurePaste" ? "PurePaste" : `${options.title} · PurePaste`;
	const description =
		options.description ??
		"PurePaste is a small, accountless place to share a snippet of text or a file. Everything expires.";

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

	return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
${options.noindex ? '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">' : '<meta name="robots" content="noindex, nofollow">'}
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fafaf9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#101012" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/styles/app.css">
<script src="/assets/scripts/theme.js"></script>
${turnstileScript}
</head>
<body ${bodyAttributes}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
	<div class="shell header-inner">
		<a class="brand" href="/" aria-label="PurePaste home">
			${brandMark(26)}
			<span class="brand-name">PurePaste</span>
		</a>
		${nav({ page: options.page })}
	</div>
</header>
<main id="main" class="shell">
${options.body}
</main>
<footer class="site-footer">
	<div class="shell footer-inner">
		<p>No accounts. No tracking. Everything here expires on its own.</p>
		<p class="footer-links"><a href="/about">How it works</a> · <a href="/docs">API</a> · <a href="/pastes">My pastes</a> · <a href="/licenses">Licences</a></p>
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
	<label class="copy-label" for="${escapeHtml(options.id)}">${escapeHtml(options.label)}</label>
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
	<p class="error-summary-title">There's a problem with that paste</p>
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
