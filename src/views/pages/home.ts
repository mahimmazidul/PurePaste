import { FILE_TTL_VALUE } from "../../config";
import type { Config } from "../../config";
import { escapeHtml, formatBytes } from "../../lib/format";
import { LANGUAGES } from "../../lib/languages";
import { errorSummary, icons, notice, renderLayout } from "../layout";

export interface HomeFormValues {
	title: string;
	content: string;
	language: string;
	expire: string;
	slug: string;
	burn: boolean;
	markdown: boolean;
	url: string;
}

export const emptyFormValues: HomeFormValues = {
	title: "",
	content: "",
	language: "plaintext",
	expire: "",
	slug: "",
	burn: false,
	markdown: false,
	url: "",
};

/** Live totals for the quiet stat bar under the composer. */
export interface HomeStats {
	slips: number;
	links: number;
	files: number;
	bytes: number;
}

export interface HomeOptions {
	config: Config;
	stats?: HomeStats;
	values?: HomeFormValues;
	errors?: Array<{ field?: string; message: string }>;
	/** Pre-filled status message, e.g. "That paste has expired". */
	flash?: { tone: "info" | "warn" | "success"; body: string } | null;
	/** Set when arriving from a fork action. */
	forkOf?: string | null;
}

const TTL_LABELS: Record<string, string> = {
	"1h": "1 hour",
	"1d": "1 day",
	"3d": "3 days",
	"7d": "1 week",
	"14d": "2 weeks",
	"30d": "30 days",
};

/**
 * Files sit in KV, the one budget on this instance with real pressure (1 GB of
 * storage on the free tier), so the file tab offers a shorter default than text.
 * `3d` is not in the shared menu on purpose — slips and links keep their week —
 * and the parser accepts it so the choice round-trips like any other.
 */
function ttlChoicesWithFiles(config: Config): Array<{ value: string; seconds: number }> {
	const choices = config.ttlChoices.map((choice) => ({ value: choice.value as string, seconds: choice.seconds }));
	const wanted = config.fileDefaultTtlSeconds;
	// The menu only grows when the server's upload default is not already offered,
	// so the option the tab selects is never a value the backend would ignore.
	if (!choices.some((choice) => choice.seconds === wanted)) {
		choices.push({ value: FILE_TTL_VALUE, seconds: wanted });
	}
	return choices.sort((a, b) => a.seconds - b.seconds);
}

/** The lifetime a file gets if nothing is changed, in words. */
function fileLifetimeLabel(config: Config): string {
	const choice = ttlChoicesWithFiles(config).find((option) => option.seconds === config.fileDefaultTtlSeconds);
	const labelled = choice ? TTL_LABELS[choice.value] : undefined;
	if (labelled) return labelled;
	const seconds = config.fileDefaultTtlSeconds;
	return seconds >= 86_400 ? `${Math.round(seconds / 86_400)} days` : `${Math.round(seconds / 3_600)} hours`;
}

function expirationOptions(config: Config, selected: string, fileMode = false): string {
	const choices = fileMode
		? ttlChoicesWithFiles(config)
		: config.ttlChoices.map((choice) => ({ value: choice.value as string, seconds: choice.seconds }));
	const defaultSeconds = fileMode ? config.fileDefaultTtlSeconds : config.defaultTtlSeconds;
	const fallback = choices.find((choice) => choice.seconds === defaultSeconds)?.value ?? choices[0]?.value;
	return choices
		.map((choice) => {
			const value = choice.value;
			const isSelected = selected ? selected === value : value === fallback;
			return `<option value="${escapeHtml(value)}"${isSelected ? " selected" : ""}>${escapeHtml(TTL_LABELS[value] ?? value)}</option>`;
		})
		.join("");
}

function languageOptions(selected: string): string {
	return LANGUAGES.map(
		(language) =>
			`<option value="${escapeHtml(language.id)}"${language.id === selected ? " selected" : ""}>${escapeHtml(language.label)}</option>`,
	).join("");
}

const group = (n: number): string => new Intl.NumberFormat("en-US").format(n);

function selectField(id: string, name: string, label: string, options: string): string {
	return `<label class="select-field">
		<span class="smallcaps select-label">${escapeHtml(label)}</span>
		<span class="select-wrap">
			<select class="select-input" id="${escapeHtml(id)}" name="${escapeHtml(name)}">${options}</select>
			<span class="select-chevron">${icons.chevronDown}</span>
		</span>
	</label>`;
}

function toggle(
	id: string,
	name: string,
	label: string,
	hint: string | null,
	checked: boolean,
	iconName?: keyof typeof icons,
): string {
	return `<label class="toggle" for="${escapeHtml(id)}">
		<input type="checkbox" id="${escapeHtml(id)}" name="${escapeHtml(name)}" value="1"${checked ? " checked" : ""}>
		<span class="toggle-box" aria-hidden="true">${icons.check}</span>
		<span class="toggle-text">${iconName ? `<span class="toggle-icon">${icons[iconName]}</span>` : ""}${escapeHtml(label)}${hint ? `<span class="toggle-hint">${escapeHtml(hint)}</span>` : ""}</span>
	</label>`;
}

function composerFooter(counter: string, submitLabel: string, submitIcon: keyof typeof icons): string {
	return `<div class="composer-footer">
		<span class="composer-count" data-composer-count>${counter}</span>
		<span class="composer-keys" aria-hidden="true"><kbd>⌘</kbd><span>+</span><kbd>Enter</kbd><span class="muted">to seal</span></span>
		<button class="btn btn-primary seal-btn" type="submit" data-submit-button>${icons[submitIcon]}<span>${escapeHtml(submitLabel)}</span></button>
	</div>`;
}

export function renderHome(options: HomeOptions): string {
	const { config } = options;
	const values = options.values ?? emptyFormValues;
	const stats = options.stats ?? { slips: 0, links: 0, files: 0, bytes: 0 };
	const fileLimit = formatBytes(config.fileMaxBytes);
	const textLimit = formatBytes(config.textMaxBytes);
	const linkTabChecked = Boolean(values.url);

	const turnstile =
		config.turnstileEnabled && config.turnstileSiteKey
			? `<div class="field turnstile-field">
				<div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstileSiteKey)}" data-theme="auto"></div>
				<p class="field-note">A quick check that you're a person, not a script.</p>
			</div>`
			: "";

	/* ---- the three forms, one per tab ---- */

	const slipForm = `
	<form method="post" action="/" enctype="multipart/form-data" class="composer-panel panel-slip" data-create-form data-mode="slip">
		<div class="panel-head">
			<input class="title-input" type="text" id="title" name="title" maxlength="200" value="${escapeHtml(values.title)}" placeholder="Give it a name, if you like" aria-label="Title (optional)">
			<textarea class="editor" id="content" name="content" rows="12" spellcheck="false" placeholder="Write or paste — a stack trace, a poem, a letter…" aria-label="Slip content" data-editor>${escapeHtml(values.content)}</textarea>
		</div>
		<div class="panel-options hairline-t">
			<div class="options-row">
				${selectField("language", "language", "Language", languageOptions(values.language))}
				${selectField("expire", "expire", "Lives for", expirationOptions(config, values.expire))}
				${toggle("burn-slip", "burn", "Burn after reading", null, values.burn, "flame")}
				${toggle("markdown", "markdown", "Render Markdown", null, values.markdown)}
				<button type="button" class="more-toggle" data-more-toggle aria-expanded="false">${icons.plus}<span>More options</span></button>
			</div>
			<div class="more-body" data-more-body hidden>
				<label class="field">
					<span class="smallcaps select-label">Custom name · optional</span>
					<span class="slug-row"><span class="mono slug-prefix">/p/</span><input class="text-input mono" type="text" id="slug" name="slug" value="${escapeHtml(values.slug)}" placeholder="my-note" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" aria-describedby="slug-note"></span>
					<p class="field-note" id="slug-note">Lowercase letters, numbers and dashes. This becomes the end of the link.</p>
				</label>
				<label class="field js-only" data-js-only>
					<span class="smallcaps select-label">Password · optional</span>
					<input class="text-input" type="password" id="password" data-password-input autocomplete="new-password" placeholder="A word you'll share by voice" aria-describedby="password-note">
					<p class="field-note" id="password-note">Turned into a key in your browser before anything is sent — we never see the password itself.</p>
					<input type="hidden" name="password_salt" data-password-salt>
					<input type="hidden" name="password_verifier" data-password-verifier>
					<input type="hidden" name="password_iterations" value="${config.passwordIterations}" data-password-iterations>
				</label>
				<label class="toggle encrypt-toggle js-only" data-js-only data-encrypt-toggle for="encrypt">
					<input type="checkbox" id="encrypt" name="encrypt" value="1" data-encrypt-input>
					<span class="toggle-box" aria-hidden="true">${icons.check}</span>
					<span class="toggle-text">${`<span class="toggle-icon">${icons.lock}</span>`}Encrypt in my browser<span class="toggle-hint">The key stays in the link. We only ever store scrambled bytes.</span></span>
				</label>
			</div>
		</div>
		${turnstile}
		${composerFooter("", "Seal this slip", "check")}
	</form>`;

	const linkForm = config.redirectEnabled
		? `
	<form method="post" action="/" class="composer-panel panel-link" data-create-form data-mode="link">
		<input type="hidden" name="kind" value="redirect">
		<div class="panel-head panel-head-link">
			<label class="smallcaps select-label" for="url">Destination</label>
			<input class="dest-input mono" type="url" id="url" name="url" placeholder="https://somewhere.interesting/…" inputmode="url" spellcheck="false" value="${escapeHtml(values.url)}" required>
			<p class="field-note">Visitors see the destination first, then choose to continue — nobody lands somewhere unexpected.</p>
		</div>
		<div class="panel-options hairline-t">
			<div class="options-row">
				${selectField("expire-link", "expire", "Lives for", expirationOptions(config, ""))}
				${toggle("burn-link", "burn", "Burn after one visit", null, false, "flame")}
				<button type="button" class="more-toggle" data-more-toggle aria-expanded="false">${icons.plus}<span>More options</span></button>
			</div>
			<div class="more-body" data-more-body hidden>
				<label class="field">
					<span class="smallcaps select-label">Custom name · optional</span>
					<span class="slug-row"><span class="mono slug-prefix">/l/</span><input class="text-input mono" type="text" id="slug-link" name="slug" placeholder="my-link" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"></span>
				</label>
			</div>
		</div>
		${turnstile}
		${composerFooter("", "Seal this link", "check")}
	</form>`
		: `
	<div class="composer-panel panel-link">
		<div class="panel-head panel-head-link">
			<p class="lede">Link mode is turned off on this instance, so only slips and files are available.</p>
		</div>
	</div>`;

	const fileForm = `
	<form method="post" action="/" enctype="multipart/form-data" class="composer-panel panel-file" data-create-form data-mode="file">
		<div class="panel-head">
			<div class="file-block" data-file-block>
				<div class="dropzone" data-dropzone>
					<span class="dropzone-icon" aria-hidden="true">${icons.upload}</span>
					<div class="dropzone-text">
						<label class="dropzone-label" for="file">Drop a file here, or choose one</label>
						<p class="field-note">Up to ${escapeHtml(fileLimit)}, then it fades in ${escapeHtml(fileLifetimeLabel(config))}. Files always download rather than open in the browser.</p>
					</div>
					<input class="file-input" type="file" id="file" name="file" data-file-input>
				</div>
				<div class="file-bar" data-file-bar hidden>
					<p class="file-picked mono" data-file-name></p>
					<span class="file-bar-actions">
						<button type="button" class="btn btn-quiet btn-small" data-file-preview>${icons.eye}<span>Preview</span></button>
						<button type="button" class="btn btn-quiet btn-small" data-file-clear>${icons.close}<span>Remove</span></button>
					</span>
				</div>
			</div>
			<input class="title-input" type="text" id="title-file" name="title" maxlength="200" placeholder="A name for the file, if you like" aria-label="Title (optional)">
		</div>
		<div class="panel-options hairline-t">
			<div class="options-row">
				${selectField("expire-file", "expire", "Lives for", expirationOptions(config, values.expire, true))}
				${toggle("burn-file", "burn", "Burn after one download", null, false, "flame")}
				<button type="button" class="more-toggle" data-more-toggle aria-expanded="false">${icons.plus}<span>More options</span></button>
			</div>
			<div class="more-body" data-more-body hidden>
				<label class="field">
					<span class="smallcaps select-label">Custom name · optional</span>
					<span class="slug-row"><span class="mono slug-prefix">/p/</span><input class="text-input mono" type="text" id="slug-file" name="slug" placeholder="release-zip" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"></span>
				</label>
			</div>
		</div>
		${turnstile}
		${composerFooter("", "Seal this file", "check")}
		<dialog class="dialog dialog-preview" data-file-dialog>
			<div class="dialog-head">
				<p class="dialog-title" data-file-dialog-title>Preview</p>
				<button type="button" class="btn btn-quiet btn-small" data-file-dialog-close>${icons.close}<span>Close</span></button>
			</div>
			<div class="preview-body" data-file-preview-body></div>
			<p class="field-note">This is your own copy of the file, read in the browser. Nothing is sealed until you press the button below.</p>
		</dialog>
	</form>`;

	const body = `
	<section class="hero rise-in">
		<p class="smallcaps hero-kicker">A pastebin, softened</p>
		<h1 class="hero-title">A quiet place for <span class="font-display-it">text</span>.</h1>
		<p class="hero-lede">Paste code, notes or prose, share a file, or shorten a link that shows its destination first. Every slip expires, nothing is indexed, and no account stands between you and the paper. Text up to ${escapeHtml(textLimit)}.</p>
	</section>

	${options.flash ? notice({ tone: options.flash.tone, body: options.flash.body }) : ""}

	<div class="notice notice-info draft-notice" data-draft-notice hidden>
		<p class="notice-title">We kept your unfinished sheet</p>
		<div class="notice-body">
			<span data-draft-notice-text>This browser had something in progress, so it's back.</span>
			<button type="button" class="btn btn-quiet btn-small" data-draft-clear>${icons.trash}<span>Discard it</span></button>
		</div>
	</div>
	${options.forkOf ? notice({ tone: "info", body: `Forking <span class="mono">${escapeHtml(options.forkOf)}</span>. The original stays where it is until you delete it.` }) : ""}
	${errorSummary(options.errors ?? [])}

	<section class="composer rise-in rise-in-1" aria-label="Make a slip, a link or a file">
		<input type="radio" name="composer-mode" id="cmode-slip" class="mode-radio" data-mode-radio="slip"${linkTabChecked ? "" : " checked"}>
		<input type="radio" name="composer-mode" id="cmode-link" class="mode-radio" data-mode-radio="link"${linkTabChecked ? " checked" : ""}>
		<input type="radio" name="composer-mode" id="cmode-file" class="mode-radio" data-mode-radio="file">
		<div class="mode-tabs" role="tablist" aria-label="What are you sealing?">
			<label class="mode-tab tab-slip" for="cmode-slip" role="tab">${icons.file}<span>A slip</span></label>
			<label class="mode-tab tab-link" for="cmode-link" role="tab">${icons.link}<span>A link</span></label>
			<label class="mode-tab tab-file" for="cmode-file" role="tab">${icons.upload}<span>A file</span></label>
		</div>
		<span class="mode-caption smallcaps" data-mode-caption>code · notes · prose</span>
		${slipForm}
		${linkForm}
		${fileForm}
	</section>

	<section class="stat-bar rise-in rise-in-2" aria-label="This instance, right now">
		<div class="stat"><span class="stat-value">${group(stats.slips)}</span><span class="stat-label smallcaps">slips live</span></div>
		<div class="stat"><span class="stat-value">${group(stats.links)}</span><span class="stat-label smallcaps">links live</span></div>
		<div class="stat"><span class="stat-value">${group(stats.files)}</span><span class="stat-label smallcaps">files live</span></div>
		<div class="stat"><span class="stat-value">${escapeHtml(formatBytes(stats.bytes))}</span><span class="stat-label smallcaps">on the shelf</span></div>
	</section>

	<section class="drawer" id="drawer" data-local-list>
		<h2 class="smallcaps drawer-title">Kept on this device</h2>
		<p class="drawer-lede">Slips and links you sealed in this browser, with their delete keys. Nothing here is public — it's a drawer, not a feed.</p>
		<div data-drawer-list><p class="drawer-empty" data-drawer-empty>The drawer is empty. Everything you seal will rest here until it fades.</p></div>
	</section>

	<section class="principles hairline-t">
		<div class="principle rise-in">
			<span class="principle-icon">${icons.hourglass}</span>
			<h3 class="principle-title">Always expiring</h3>
			<p class="principle-body">Choose an hour or a month. Nothing lingers past its welcome, and the clearing is automatic.</p>
		</div>
		<div class="principle rise-in rise-in-1">
			<span class="principle-icon">${icons.eyeOff}</span>
			<h3 class="principle-title">Unlisted by design</h3>
			<p class="principle-body">There's no directory, no search, no recent list. The link is the only way in — share it like a secret.</p>
		</div>
		<div class="principle rise-in rise-in-2">
			<span class="principle-icon">${icons.key}</span>
			<h3 class="principle-title">You hold the key</h3>
			<p class="principle-body">Passwords when you need them, burn-after-reading when once is enough, and a delete key that stays on your device.</p>
		</div>
	</section>

	<noscript>
		<div class="notice notice-info">
			<p class="notice-title">JavaScript is off</p>
			<div class="notice-body">Slips, links and files all work fine without it. Passwords and in-browser encryption need JavaScript, so those options stay hidden — as do the file preview and keeping an unfinished sheet across a reload.</div>
		</div>
	</noscript>
`;

	return renderLayout({
		config,
		page: "home",
		title: "Slip",
		body,
		description:
			"Slip is a small, accountless place to share text, links and files. Everything expires, nothing is indexed, and the link is the only way in.",
	});
}
