import type { Config } from "../../config";
import { escapeHtml, formatDuration } from "../../lib/format";
import { icons, renderLayout } from "../layout";

export function renderAboutPage(config: Config): string {
	const fileLimit = `${Math.floor(config.fileMaxBytes / 1024 / 1024)} MiB`;
	const textLimit = `${Math.floor(config.textMaxBytes / 1024 / 1024)} MiB`;
	const inlineLimit = `${Math.floor(config.inlineTextMaxBytes / 1024)} KiB`;
	const maxDays = Math.round(config.maxTtlSeconds / 86400);

	const body = `
	<section class="hero">
		<h1 class="h1">How Slip works</h1>
		<p class="lede">A small place to hand someone a slip of text, a file, or a short honest link. No account, no dashboard, no list of pastes anywhere. This page is the honest version of what happens to what you paste.</p>
	</section>

	<section class="card">
		<h2 class="h2">The short version</h2>
		<ul class="plain-list">
			<li>Every paste has an expiry, chosen when you create it. Nothing is permanent. The maximum is ${String(maxDays)} days.</li>
			<li>There is no account and no admin view. Paste links are unguessable, which is the only privacy you get by default.</li>
			<li>You get a management key once, at creation, to delete or check on the paste. It is shown once because we only keep a fingerprint of it.</li>
			<li>No analytics, no advertising, no tracking pixels, no third-party requests from the pages themselves.</li>
			<li>The only cookie is a short-lived one that a password-protected paste sets after you unlock it.</li>
		</ul>
	</section>

	<section class="card">
		<h2 class="h2">Where things are stored</h2>
		<p>Metadata — sizes, expiry, a fingerprint of the delete key — lives in Cloudflare D1. Content lives in D1 only when it is a small, unencrypted slip (under ${escapeHtml(inlineLimit)}). Everything else, including every file and anything encrypted, goes to object storage (Cloudflare KV on this deployment).</p>
		<p>Object names are derived from the paste id, never from a file name, and files always download rather than open in a browser.</p>
		<dl class="spec-list">
			<div><dt>Text pastes</dt><dd>up to ${escapeHtml(textLimit)}</dd></div>
			<div><dt>Files</dt><dd>up to ${escapeHtml(fileLimit)}</dd></div>
			<div><dt>Longest lifetime</dt><dd>${String(maxDays)} days, enforced by the server</dd></div>
			<div><dt>Cleanup</dt><dd>hourly, plus an expiry check on every request</dd></div>
		</dl>
	</section>

	<section class="card">
		<h2 class="h2">Passwords and browser encryption are different</h2>
		<p>A <strong>password</strong> stops whoever finds the link from opening the paste. It is derived into a key in your browser, and only that key — never the password — reaches the server. It is a lock on the door: the content itself is still readable on the server.</p>
		<p><strong>Browser encryption</strong> is the stronger one. The content is scrambled with AES-GCM before it is uploaded, and the key travels in the part of the URL after the <span class="mono">#</span>. Browsers never send that part to a server, so the stored bytes cannot be read here at all. The trade-off is absolute: lose the full link and the content is gone, for everyone.</p>
		<p>You can use both. The password gate is checked first, then your browser decrypts what comes back.</p>
		<p class="field-note">Why passwords are derived in the browser: a deliberately slow password hash would take tens of milliseconds of processor time per attempt. That is fine on a big server, but Slip is built to run inside the free tier's CPU budget, where a slow hash would turn one unlock into ten requests' worth of work. Deriving in the browser keeps the work off the server while staying well above the iteration counts that make guessing expensive — and the server only ever holds a keyed fingerprint.</p>
	</section>

	<section class="card">
		<h2 class="h2">Burn after opening</h2>
		<p>One-time links open on a reveal page with a button. Nothing is spent by a link preview, a crawler, or a chat app fetching the URL — they do not press buttons. The claim itself is a single atomic update, so two people clicking at the same moment cannot both get the contents.</p>
	</section>

	<section class="card">
		<h2 class="h2">What we can and cannot see</h2>
		<ul class="plain-list">
			<li>We can technically read any paste that is not encrypted, and we keep the metadata for it.</li>
			<li>We cannot read anything encrypted in your browser, and we do not learn the title or file name that goes with it.</li>
			<li>We do not store IP addresses in the database, and we do not build visitor profiles. Cloudflare processes request data to serve and protect the site, as any host does.</li>
			<li>Deleting a paste removes the object and the row. Backups are outside our control: nothing here is promised to be unrecoverable forever, so treat a paste as temporary by design.</li>
		</ul>
	</section>

	<section class="card">
		<h2 class="h2">From a terminal</h2>
		<p class="lede">Paste standard input and get the link back:</p>
		<pre class="code-block mono"><code>cat notes.txt | curl -s -X POST --data-binary @- \\
  -H "Accept: text/plain" -H "Content-Type: text/plain" \\
  "/api/pastes?expire=1d"</code></pre>
		<p class="lede">Upload a file, delete a paste, fetch the raw text:</p>
		<pre class="code-block mono"><code>curl -s -X POST -F "file=@photo.png" -F "expire=7d" \\
  -H "Accept: application/json" /api/pastes

curl -s -X DELETE -H "Authorization: Bearer &lt;manage-token&gt;" \\
  /api/pastes/&lt;id&gt;

curl -s /raw/&lt;id&gt;</code></pre>
		<p class="field-note">The API answers with JSON by default, or with just the URL when you ask for <span class="mono">text/plain</span>. Errors are JSON with a stable <span class="mono">error</span> code and a plain-language message. The full contract — links, stats, passwords, burn — lives on the <a href="/docs">API page</a>, with every example stamped with this address.</p>
	</section>

	<section class="card">
		<h2 class="h2">Running your own</h2>
		<p>Slip is a single Cloudflare Worker with a D1 database, object storage and one hourly cron trigger. It has no accounts to manage and no admin panel to secure — which is exactly why there is nothing here to log into. ${icons.info} The README covers the exact commands.</p>
	</section>
`;

	return renderLayout({
		config,
		page: "about",
		title: "How it works",
		body,
		description:
			"What Slip stores, how expiration, passwords and browser encryption work, and what it cannot protect you from.",
	});
}

/** Used by the footer note on the home page. */
export const ABOUT_SUMMARY = "No accounts, no listing, everything expires.";

export function formatExpirySummary(seconds: number): string {
	return formatDuration(seconds);
}
