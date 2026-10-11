import type { Config } from "../../config";
import { escapeHtml } from "../../lib/format";
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

export interface HomeOptions {
	config: Config;
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
	"7d": "7 days",
	"14d": "14 days",
	"30d": "30 days",
};

function expirationOptions(config: Config, selected: string): string {
	const defaultSeconds = config.defaultTtlSeconds;
	const fallback =
		config.ttlChoices.find((choice) => choice.seconds === defaultSeconds)?.value ?? config.ttlChoices[0]?.value;
	return config.ttlChoices
		.map((choice) => {
			const value = choice.value;
			const isSelected = selected ? selected === value : value === fallback;
			const defaultNote = value === fallback ? " (default)" : "";
			return `<option value="${escapeHtml(value)}"${isSelected ? " selected" : ""}>${escapeHtml(TTL_LABELS[value] ?? value)}${defaultNote}</option>`;
		})
		.join("");
}

function languageOptions(selected: string): string {
	return LANGUAGES.map(
		(language) =>
			`<option value="${escapeHtml(language.id)}"${language.id === selected ? " selected" : ""}>${escapeHtml(language.label)}</option>`,
	).join("");
}

export function renderHome(options: HomeOptions): string {
	const { config } = options;
	const values = options.values ?? emptyFormValues;
	const fileLimit = `${Math.floor(config.fileMaxBytes / 1024 / 1024)} MiB`;
	const textLimit = `${Math.floor(config.textMaxBytes / 1024 / 1024)} MiB`;

	const linkForm = config.redirectEnabled
		? `<section class="card card-quiet link-card" aria-labelledby="link-mode-title">
		<h2 class="h3" id="link-mode-title">Sharing a link?</h2>
		<p class="lede">Send a short address that opens it. We show the destination first, so nobody lands somewhere unexpected.</p>
		<form method="post" action="/" class="form-grid" data-link-form>
			<input type="hidden" name="kind" value="redirect">
			<div class="field">
				<label for="url">Destination</label>
				<input class="text-input" type="url" id="url" name="url" placeholder="https://example.com/something" inputmode="url" value="${escapeHtml(values.url)}" required>
				<p class="field-note">http and https only.</p>
			</div>
			<div class="field-row">
				<div class="field">
					<label for="url-expire">Expires</label>
					<select class="select-input" id="url-expire" name="expire">${expirationOptions(config, "")}</select>
				</div>
				<div class="field">
					<label for="url-slug">Custom name <span class="optional">optional</span></label>
					<input class="text-input mono" type="text" id="url-slug" name="slug" placeholder="my-link" value="${escapeHtml(values.slug)}" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]">
				</div>
			</div>
			<label class="check">
				<input type="checkbox" name="burn" value="1">
				<span>Burn after opening <span class="check-note">One visit only.</span></span>
			</label>
			<div class="form-actions">
				<button class="btn btn-secondary" type="submit">${icons.link}<span>Create link</span></button>
			</div>
		</form>
	</section>`
		: `<section class="card card-quiet link-card" aria-labelledby="link-mode-title">
		<h2 class="h3" id="link-mode-title">Sharing a link?</h2>
		<p class="lede">URL mode is turned off on this instance, so only pastes and files are available.</p>
	</section>`;

	const turnstile =
		config.turnstileEnabled && config.turnstileSiteKey
			? `<div class="field">
			<div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstileSiteKey)}" data-theme="auto"></div>
			<p class="field-note">A quick check that you're a person, not a script.</p>
		</div>`
			: "";

	const body = `
	<section class="hero">
		<h1 class="h1">Make a paste</h1>
		<p class="lede">Text, code or a file up to ${escapeHtml(fileLimit)}. Every paste expires, nothing is listed publicly, and the link is the only way in.</p>
	</section>

	${options.flash ? notice({ tone: options.flash.tone, body: options.flash.body }) : ""}
	${options.forkOf ? notice({ tone: "info", body: `Forking <span class="mono">${escapeHtml(options.forkOf)}</span>. The original stays where it is until you delete it.` }) : ""}
	${errorSummary(options.errors ?? [])}

	<section class="card editor-card" aria-labelledby="editor-title">
		<h2 class="sr-only" id="editor-title">New paste</h2>
		<form method="post" action="/" enctype="multipart/form-data" class="paste-form" data-create-form>
			<div class="field">
				<label for="title">Title <span class="optional">optional</span></label>
				<input class="text-input" type="text" id="title" name="title" maxlength="200" value="${escapeHtml(values.title)}" placeholder="Notes from standup">
			</div>

			<div class="field">
				<label for="content">Paste</label>
				<textarea class="text-input textarea mono" id="content" name="content" rows="14" spellcheck="false" placeholder="Paste or type anything…" data-editor>${escapeHtml(values.content)}</textarea>
				<div class="field-foot">
					<span class="field-note" data-editor-counter></span>
					<span class="field-note">Text up to ${escapeHtml(textLimit)}</span>
				</div>
			</div>

			<div class="field-row">
				<div class="field">
					<label for="language">Language</label>
					<select class="select-input" id="language" name="language">${languageOptions(values.language)}</select>
				</div>
				<div class="field">
					<label for="expire">Expires</label>
					<select class="select-input" id="expire" name="expire">${expirationOptions(config, values.expire)}</select>
				</div>
			</div>

			<div class="dropzone" data-dropzone>
				${icons.file}
				<div class="dropzone-text">
					<label class="dropzone-label" for="file">Drop a file here, or choose one</label>
					<p class="field-note">Up to ${escapeHtml(fileLimit)}. Files are stored on Cloudflare R2 and always download rather than open in the browser.</p>
				</div>
				<input class="file-input" type="file" id="file" name="file" data-file-input>
				<p class="dropzone-selected" data-file-name hidden></p>
			</div>

			${turnstile}

			<details class="advanced" ${options.errors?.length ? "open" : ""}>
				<summary>More options</summary>
				<div class="advanced-body">
					<div class="field">
						<label for="slug">Custom name <span class="optional">optional</span></label>
						<input class="text-input mono" type="text" id="slug" name="slug" value="${escapeHtml(values.slug)}" placeholder="release-notes" pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" aria-describedby="slug-note">
						<p class="field-note" id="slug-note">Three to sixty-four characters: lowercase letters, numbers and dashes. This becomes the end of the link.</p>
					</div>

					<div class="field js-only" data-js-only>
						<label for="password">Password <span class="optional">optional</span></label>
						<input class="text-input" type="password" id="password" data-password-input autocomplete="new-password" aria-describedby="password-note">
						<p class="field-note" id="password-note">Checked in your browser before anything is sent, so we never see your password. Readers enter it once, then get a short-lived session for that paste.</p>
						<input type="hidden" name="password_salt" data-password-salt>
						<input type="hidden" name="password_verifier" data-password-verifier>
						<input type="hidden" name="password_iterations" value="${config.passwordIterations}" data-password-iterations>
					</div>

					<label class="check js-only" data-js-only data-encrypt-toggle>
						<input type="checkbox" name="encrypt" value="1" data-encrypt-input>
						<span>Encrypt in my browser <span class="check-note">The key stays in the link. We only ever store scrambled bytes, so nobody here — including us — can read it.</span></span>
					</label>

					<label class="check">
						<input type="checkbox" name="burn" value="1"${values.burn ? " checked" : ""}>
						<span>Burn after opening <span class="check-note">Nothing is spent until someone presses the button on the reveal page, so link previews can't open it.</span></span>
					</label>

					<label class="check">
						<input type="checkbox" name="markdown" value="1"${values.markdown ? " checked" : ""}>
						<span>Render as Markdown <span class="check-note">Headings, lists, links and code. Unsafe HTML is stripped.</span></span>
					</label>

					<p class="field-note">Password protection and browser encryption are different things: a password keeps the link from being opened by whoever finds it, encryption keeps the content from being read on the server. You can use both.</p>
				</div>
			</details>

			<div class="form-actions">
				<button class="btn btn-primary" type="submit" data-submit-button>Create paste</button>
				<span class="form-hint" aria-hidden="true">Ctrl/⌘ + Enter</span>
			</div>
		</form>
	</section>

	<noscript>
		<div class="notice notice-info">
			<p class="notice-title">JavaScript is off</p>
			<div class="notice-body">Pastes and files work fine without it. Resetting a password or encrypting in the browser needs JavaScript, so those options are hidden.</div>
		</div>
	</noscript>

	${linkForm}
`;

	return renderLayout({
		config,
		page: "home",
		title: "PurePaste",
		body,
		description:
			"Make a paste or share a file. Accountless, private by obscurity, and everything expires within 30 days.",
	});
}
