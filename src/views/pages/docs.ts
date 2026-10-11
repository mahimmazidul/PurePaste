import { escapeHtml, formatBytes } from "../../lib/format";
import type { Config } from "../../config";
import { button, renderLayout } from "../layout";

/**
 * The API reference, served by the instance it documents.
 *
 * Every example is stamped with the origin of the incoming request, so the
 * same build reads correctly on workers.dev, a custom domain, or localhost —
 * nothing here hard-codes a hostname, exactly like the rest of the app.
 */
export interface ApiDocsOptions {
	config: Config;
	origin: string;
}

let snippets = 0;

/** A copyable command block: the hidden input feeds the existing copy wiring. */
function snippet(code: string, label: string): string {
	snippets += 1;
	const id = `snippet-${snippets}`;
	return `<div class="code-head">
<span class="destination-label">${escapeHtml(label)}</span>
${button({ label: "Copy", iconName: "copy", variant: "quiet", extraClass: "btn-small", attributes: `data-copy-target="${id}"` })}
</div>
<input type="hidden" id="${id}" value="${escapeHtml(code)}">
<pre class="code-block">${escapeHtml(code)}</pre>`;
}

function endpoint(method: "get" | "post" | "delete", path: string, summary: string): string {
	return `<p class="endpoint"><span class="method method-${method}">${method}</span><span class="path">${escapeHtml(path)}</span><span class="muted">${escapeHtml(summary)}</span></p>`;
}

function table(head: string[], rows: string[][]): string {
	return `<div class="table-scroll"><table class="api-table">
<thead><tr>${head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>
<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
</table></div>`;
}

const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;

export function renderApiDocs(options: ApiDocsOptions): string {
	const { config, origin } = options;
	snippets = 0;

	const body = `
<section class="hero">
	<h1 class="h1">The API</h1>
	<p class="lede">Everything the editor can do, a terminal can do. The format of every answer is decided by your request — an explicit ${code("?format=")} wins, then the ${code("Accept")} header, then the default for the path: ${code("/api/…")} answers JSON, pages answer HTML.</p>
	<div class="notice notice-info">
		<p class="notice-title">This instance</p>
		<div class="notice-body">Every example below is stamped with the address you are reading this on — <span class="mono">${escapeHtml(origin)}</span> — so it works for workers.dev subdomains, custom domains and local development alike. There is no API key: the management token each paste returns at creation is the only credential, and it travels in headers, never in query strings.</div>
	</div>
</section>

<section class="card">
	<h2 class="h2">Create</h2>
	${endpoint("post", "/api/pastes", "— or POST / for the browser form")}
	<p>One endpoint, four bodies. Small unencrypted text is kept in the database row; everything larger, every file and every encrypted payload goes to object storage.</p>
	${table(
		["Body", "Content-Type", "Notes"],
		[
			["Raw text", code("text/plain"), "The body is the paste. Friendliest from a pipe."],
			["JSON", code("application/json"), `${code("content")} or ${code("url")} (redirect), plus the options below.`, ],
			["File or bytes", code("multipart/form-data"), `A ${code("file")} part; other parts become options.`, ],
			["Opaque bytes", code("application/octet-stream"), `With ${code("?encrypted=1")} the bytes are stored untouched, or as the ${code("payload")} part of a form.`],
		],
	)}
	<p class="field-note">Options, in the JSON body, form fields or query string: ${code("title")}, ${code("language")}, ${code("expire")} (or ${code("ttl")}), ${code("slug")}, ${code("burn")}, ${code("markdown")}, ${code("password_salt")}, ${code("password_verifier")}, ${code("password_iterations")}. Expiry accepts ${config.ttlChoices.map((choice) => code(choice.value)).join(", ")} or bare seconds, clamped to ${code(`${config.maxTtlSeconds}`)}.</p>
	${snippet(
		`# A bare URL back — the friendliest thing for a shell script\necho "hello from a pipe" | curl -s -X POST --data-binary @- \\\n  -H "Content-Type: text/plain" -H "Accept: text/plain" \\\n  ${origin}/api/pastes`,
		"text from a pipe",
	)}
	${snippet(
		`# JSON in, the full object out\ncurl -s -X POST ${origin}/api/pastes \\\n  -H "Content-Type: application/json" \\\n  -d '{"content":"SELECT 1;","title":"Check","language":"sql","expire":"1d"}'`,
		"json",
	)}
	${snippet(`# A file\ncurl -s -X POST ${origin}/api/pastes \\\n  -H "Accept: application/json" -F "file=@./screenshot.png"`, "file upload")}
	${snippet(
		`# Burn after reading: exactly one reveal, then it is gone\ncurl -s -X POST ${origin}/api/pastes \\\n  -H "Content-Type: application/json" -H "Accept: text/plain" \\\n  -d '{"content":"one time only","burn":true,"expire":"1h"}'`,
		"burn after reading",
	)}
	<p>A successful create answers ${code("201")}: the bare URL when you asked for text, otherwise the full object.</p>
	<pre class="code-block">{
  "id": "k3m9x2qp7a",
  "url": "${escapeHtml(origin)}/k3m9x2qp7a",
  "raw_url": "${escapeHtml(origin)}/raw/k3m9x2qp7a",
  "download_url": null,
  "manage_url": "${escapeHtml(origin)}/manage/k3m9x2qp7a#token=…",
  "manage_token": "…",
  "kind": "text",
  "encrypted": false,
  "burn_after_reading": false,
  "expires_at": 1790000000000,
  "expires_in_seconds": 86400,
  "size_bytes": 42
}</pre>
	<p class="field-note">${code("manage_token")} is shown exactly once and stored only as a peppered hash. Lose it, and the paste can only be left to expire.</p>
</section>

<section class="card">
	<h2 class="h2">Read</h2>
	${endpoint("get", "/api/pastes/<id>", "metadata as JSON")}
	${endpoint("get", "/raw/<id>", "the body itself (also at /<id>/raw)")}
	${endpoint("get", "/download/<id>", "as an attachment (also at /<id>/download)")}
	${endpoint("get", "/api/config", "this instance's limits, features and TTL menu")}
	${snippet(
		`curl -s ${origin}/api/pastes/<id>             # metadata\ncurl -s ${origin}/raw/<id>                       # the bytes\ncurl -s "${origin}/raw/<id>?format=json"         # {"id":…,"kind":"text","content":…}\ncurl -s -OJ ${origin}/download/<id>              # attachment, original filename\ncurl -s ${origin}/api/config                     # limits, features, TTL choices`,
		"reading",
	)}
	<p>A password-protected paste answers metadata with ${code("locked: true")} and the KDF parameters a client needs — and never the title, filename or content until it is unlocked. There is deliberately no endpoint that lists pastes.</p>
</section>

<section class="card">
	<h2 class="h2">Passwords</h2>
	<p>The password itself never travels. The client derives a verifier with PBKDF2-SHA-256 — ${code(`${config.passwordIterations}`)} iterations on this instance, a 16-byte hex salt, 32 derived bytes encoded base64url — and sends ${code("password_salt")}, ${code("password_verifier")} and ${code("password_iterations")} at creation. Readers then prove the password the same way:</p>
	${endpoint("post", "/api/pastes/<id>/unlock", "sets a short-lived session cookie")}
	${snippet(
		`# Once: exchange the verifier for a session cookie\ncurl -s -c jar -X POST ${origin}/api/pastes/<id>/unlock \\\n  -H "X-Paste-Password: <verifier>"\n\n# Or statelessly: send the verifier with each read\ncurl -s -b jar ${origin}/raw/<id>`,
		"unlock",
	)}
	<p class="field-note">Wrong guesses are indistinguishable from right ones by timing or body: the server does one HMAC and one constant-time comparison either way.</p>
</section>

<section class="card">
	<h2 class="h2">Burn after reading</h2>
	${endpoint("post", "/api/pastes/<id>/reveal", "the single call that releases a one-time paste")}
	${snippet(`curl -s -X POST ${origin}/api/pastes/<id>/reveal -H "Accept: application/json"`, "reveal once")}
	<p>Before the reveal, ${code("GET /raw/<id>")} answers ${code("403")}. After it, everything answers ${code("410")}: the claim is a single atomic statement, so two simultaneous reveals cannot both win.</p>
</section>

<section class="card">
	<h2 class="h2">Manage and delete</h2>
	${endpoint("delete", "/api/pastes/<id>", "with the management token in a header")}
	${snippet(
		`curl -s -X DELETE ${origin}/api/pastes/<id> \\\n  -H "Authorization: Bearer <manage_token>"\n\n# the same thing, spelled differently\ncurl -s -X DELETE ${origin}/api/pastes/<id> \\\n  -H "X-Manage-Token: <manage_token>"`,
		"delete",
	)}
	<p>A token in the query string is refused with ${code("401")} — query strings end up in logs, referrers and shell history. Deleting twice is safe: the second call answers ${code("404")}, which is the outcome you wanted.</p>
</section>

<section class="card">
	<h2 class="h2">Limits on this instance</h2>
	<dl class="spec-list">
		<div><dt>Text paste</dt><dd>up to ${escapeHtml(formatBytes(config.textMaxBytes))}</dd></div>
		<div><dt>File upload</dt><dd>up to ${escapeHtml(formatBytes(config.fileMaxBytes))}</dd></div>
		<div><dt>Kept in the row</dt><dd>unencrypted text up to ${escapeHtml(formatBytes(config.inlineTextMaxBytes))}</dd></div>
		<div><dt>Longest lifetime</dt><dd>${escapeHtml(String(Math.round(config.maxTtlSeconds / 86400)))} days, enforced server-side</dd></div>
		<div><dt>Password KDF</dt><dd>PBKDF2-SHA-256, ${escapeHtml(String(config.passwordIterations))} iterations</dd></div>
		<div><dt>Creation</dt><dd>30 requests / minute per address at the edge</dd></div>
		<div><dt>Unlocks</dt><dd>20 requests / minute per paste at the edge</dd></div>
	</dl>
	<p class="field-note">${code("GET /api/config")} returns these as JSON, so a client never has to guess. Edge rate limiting is configured here and degrades to no limit where the hosting plan does not provide it.</p>
</section>

<section class="card">
	<h2 class="h2">Errors</h2>
	<p>Every failure is a small JSON object and a status code that means something:</p>
	<pre class="code-block">{ "error": "expired", "message": "This paste has expired." }</pre>
	${table(
		["Status", "When"],
		[
			[code("400"), "Malformed request, invalid slug, invalid expiration, bad URL."],
			[code("401"), "Wrong or missing management token or password verifier."],
			[code("403"), "A burn-after-reading paste awaiting its reveal, or Turnstile said no."],
			[code("404"), "No such paste, or a feature that is turned off."],
			[code("405"), "A real address, wrong method — with an Allow header."],
			[code("410"), "Expired, or a one-time paste that has already been opened."],
			[code("413"), "Over the size limit."],
			[code("415"), "A content type this service does not read."],
			[code("429"), "Rate limited, with a Retry-After header."],
			[code("500"), "Something broke. No stack traces, ever."],
		],
	)}
</section>
`;

	return renderLayout({
		config: options.config,
		title: "API",
		page: "docs",
		body,
		description: "The PurePaste HTTP API: create, read, unlock, reveal and delete pastes from anything that can speak curl.",
	});
}
