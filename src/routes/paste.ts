import type { Context } from "hono";
import type { AppBindings } from "../env";
import { verifyPassword, verifyUnlockTicket } from "../lib/crypto";
import { escapeHtml } from "../lib/format";
import { negotiate } from "../lib/negotiate";
import { parseId } from "../lib/validation";
import { claimBurn, deletePaste, loadPaste, openBody } from "../services/paste-store";
import { recordView } from "../services/views";
import { renderPastePage } from "../views/pages/paste";
import { renderErrorPage } from "../views/pages/error";

/** Bodies larger than this are streamed to the browser instead of inlined into a page. */
const MAX_INLINE_RENDER_BYTES = 1024 * 1024;

export function cookieNameFor(id: string): string {
	return `pp_${id}`;
}

export interface UnlockState {
	unlocked: boolean;
}

/** A paste is unlocked by the short-lived cookie, or by a derived verifier header. */
export async function checkUnlocked(
	c: Context<AppBindings>,
	pasteId: string,
	storedVerifier: string | null,
	salt: string | null,
): Promise<UnlockState> {
	if (!storedVerifier || !salt) return { unlocked: true };

	const headerVerifier = c.req.header("x-paste-password");
	if (headerVerifier) {
		const ok = await verifyPassword(c.get("config").appSecret, pasteId, salt, headerVerifier.trim(), storedVerifier);
		return { unlocked: ok };
	}

	const cookie = readCookie(c.req.header("cookie"), cookieNameFor(pasteId));
	if (!cookie) return { unlocked: false };
	const ticket = await verifyUnlockTicket(c.get("config").appSecret, cookie, Date.now());
	return { unlocked: ticket !== null && ticket.pasteId === pasteId };
}

export function readCookie(header: string | undefined, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=") || null;
	}
	return null;
}

function htmlError(context: Context<AppBindings>, options: { status: number; title: string; message: string; hint?: string }): Response {
	return context.html(
		renderErrorPage({
			config: context.get("config"),
			status: options.status,
			title: options.title,
			message: options.message,
			hint: options.hint,
		}),
		options.status as 404 | 410 | 401 | 403 | 500,
	);
}

/** Renders the paste page (or the lock / reveal gate in front of it). */
export async function getPastePage(c: Context<AppBindings>): Promise<Response> {
	const config = c.get("config");
	const id = parseId(c.req.param("id"));
	const now = Date.now();
	const result = await loadPaste(c.env, id, { now });

	if (result.status === "missing") {
		return htmlError(c, {
			status: 404,
			title: "Nothing at this address",
			message: "This paste doesn't exist. It may have expired, been deleted, or the link may have a typo in it.",
		});
	}
	if (result.status === "expired") {
		return htmlError(c, {
			status: 410,
			title: "This paste has expired",
			message: "It was here, and now it's gone. Pastes delete themselves when their time is up.",
		});
	}
	if (result.status === "consumed") {
		return htmlError(c, {
			status: 410,
			title: "Already opened",
			message: "This was a one-time link, and it has been used.",
		});
	}

	const record = result.record;
	const unlock = await checkUnlocked(c, record.id, record.passwordVerifier, record.passwordSalt);

	if (result.status === "needs-reveal") {
		// The gate is rendered without ever reading the body.
		return c.html(renderPastePage({ config, record, inline: null, unlocked: true, now }));
	}
	if (!unlock.unlocked) {
		return c.html(renderPastePage({ config, record, inline: null, unlocked: false, now }));
	}

	if (record.kind === "redirect" && !config.redirectEnabled) {
		return htmlError(c, { status: 404, title: "URL mode is off", message: "This instance no longer serves link pastes." });
	}

	let inline: string | null = null;
	if (record.kind === "text" && !record.encrypted) {
		const body = await openBody(c.env, record);
		if (body.kind === "inline") inline = body.text;
		else if (body.kind === "missing") {
			// A row without a body means storage was lost mid-flight. Clean it up.
			c.executionCtx.waitUntil(deletePaste(c.env, record).then(() => undefined));
			return htmlError(c, { status: 404, title: "Nothing at this address", message: "This paste's contents are no longer available." });
		}
	}

	recordView(c.env, config, record.id, c.executionCtx);

	return c.html(renderPastePage({ config, record, inline, unlocked: true, now }));
}

/** Raw bytes. Never served for a paste that has not been revealed or unlocked. */
export async function getRawPaste(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const now = Date.now();
	const result = await loadPaste(c.env, id, { now });
	const wantsJson = negotiate(c, "text") === "json";

	if (result.status === "missing" || result.status === "expired" || result.status === "consumed") {
		return notAvailable(c, result.status, wantsJson);
	}
	if (result.status === "needs-reveal") {
		// Burn-after-reading content is only ever released through the reveal endpoint.
		return jsonOrText(c, wantsJson, 403, "This link opens once. Use the reveal page to claim it.", {
			error: "confirmation_required",
			hint: "POST /api/pastes/:id/reveal",
		});
	}

	const record = result.record;
	const unlock = await checkUnlocked(c, record.id, record.passwordVerifier, record.passwordSalt);
	if (!unlock.unlocked) {
		return jsonOrText(c, wantsJson, 401, "This paste needs a password.", {
			error: "password_required",
			hint: "Unlock first: POST /api/pastes/:id/unlock, or send X-Paste-Password: <verifier>.",
		});
	}

	const body = await openBody(c.env, record);
	if (body.kind === "missing") {
		c.executionCtx.waitUntil(deletePaste(c.env, record).then(() => undefined));
		return notAvailable(c, "missing", wantsJson);
	}
	if (body.kind === "redirect") {
		return wantsJson
			? c.json({ id: record.id, kind: "redirect", redirect_url: body.url })
			: new Response(`${body.url}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
	}
	if (body.kind === "inline") {
		recordView(c.env, c.get("config"), record.id, c.executionCtx);
		return wantsJson ? c.json({ id: record.id, kind: "text", content: body.text }) : textResponse(body.text);
	}

	// Encrypted payloads and files are handed over as opaque bytes.
	const headers = objectHeaders(record.encrypted ? "application/octet-stream" : (record.contentType ?? "application/octet-stream"));
	if (record.encrypted || record.kind === "file") {
		headers.set("Content-Disposition", contentDisposition(record.filename ?? `${record.id}.bin`, false));
	}
	return new Response(body.object.body, { headers });
}

/** Download: the same bytes, always as an attachment with a safe name. */
export async function getDownload(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const result = await loadPaste(c.env, id, { now: Date.now() });
	if (result.status === "needs-reveal") {
		return jsonOrText(c, false, 403, "This link opens once. Use the reveal page to claim it.", { error: "confirmation_required" });
	}
	if (result.status !== "ok") return notAvailable(c, result.status, false);

	const record = result.record;
	const unlock = await checkUnlocked(c, record.id, record.passwordVerifier, record.passwordSalt);
	if (!unlock.unlocked) {
		return htmlError(c, {
			status: 401,
			title: "Password needed",
			message: "Enter the password on the paste page, then download it from there.",
		});
	}
	if (record.kind === "redirect") {
		return htmlError(c, { status: 404, title: "Nothing to download", message: "This link points somewhere else." });
	}

	const body = await openBody(c.env, record);
	if (body.kind === "missing") return notAvailable(c, "missing", false);

	const filename = record.kind === "file" ? (record.filename ?? record.id) : `${record.id}.txt`;
	const headers = objectHeaders(record.kind === "file" ? (record.contentType ?? "application/octet-stream") : "text/plain; charset=utf-8");
	headers.set("Content-Disposition", contentDisposition(filename, false));

	if (body.kind === "inline") {
		headers.set("Content-Length", String(new TextEncoder().encode(body.text).byteLength));
		return new Response(body.text, { headers });
	}
	if (body.kind === "object") {
		if (body.object.size) headers.set("Content-Length", String(body.object.size));
		return new Response(body.object.body, { headers });
	}
	return notAvailable(c, "missing", false);
}

/** The only route that releases a burn-after-reading paste. */
export async function revealPaste(c: Context<AppBindings>): Promise<Response> {
	const config = c.get("config");
	const id = parseId(c.req.param("id"));
	const now = Date.now();
	const format = negotiate(c, "html");

	const existing = await loadPaste(c.env, id, { now });
	if (existing.status === "missing") return notAvailable(c, "missing", format === "json");
	if (existing.status === "expired") return notAvailable(c, "expired", format === "json");
	if (existing.status === "consumed") return notAvailable(c, "consumed", format === "json");

	if (existing.status === "ok") {
		// Not a burn paste: nothing to claim. Send the visitor to the normal page.
		return c.redirect(`/${id}`, 303);
	}

	const unlock = await checkUnlocked(c, existing.record.id, existing.record.passwordVerifier, existing.record.passwordSalt);
	if (!unlock.unlocked) {
		return jsonOrText(c, format === "json", 401, "This paste needs a password.", { error: "password_required" });
	}

	// Single atomic claim: the row is only returned to the statement that finds it unread.
	const claimed = await claimBurn(c.env, id, now);
	if (!claimed) return notAvailable(c, "consumed", format === "json");

	const body = await openBody(c.env, claimed);
	if (body.kind === "missing") return notAvailable(c, "missing", format === "json");
	if (body.kind === "redirect") {
		// A one-time link: the claim is what releases it, so send the visitor on.
		return format === "json" ? c.json({ id: claimed.id, kind: "redirect", redirect_url: body.url, burned: true }) : c.redirect(body.url, 303);
	}

	const goneNotice = "This paste has been burned. It is gone for good, so copy anything you still need.";

	if (body.kind === "object" && (claimed.kind === "file" || body.object.size > MAX_INLINE_RENDER_BYTES)) {
		// Too big to put inside a page, and the raw routes are closed now: hand back the bytes.
		const headers = objectHeaders(claimed.encrypted ? "application/octet-stream" : (claimed.contentType ?? "text/plain; charset=utf-8"));
		if (claimed.kind === "file" || claimed.encrypted) {
			headers.set("Content-Disposition", contentDisposition(claimed.filename ?? `${claimed.id}.bin`, false));
		}
		return new Response(body.object.body, { headers });
	}

	const text = body.kind === "inline" ? body.text : new TextDecoder().decode(await body.object.arrayBuffer());

	if (format === "json") {
		return c.json({ id: claimed.id, kind: claimed.kind, content: text, burned: true });
	}
	if (format === "text") {
		return textResponse(text);
	}

	return c.html(
		renderPastePage({
			config,
			record: claimed,
			inline: text,
			unlocked: true,
			now,
			flash: { tone: "warn", body: `<strong>${escapeHtml(goneNotice)}</strong>` },
		}),
	);
}

/* ------------------------------------------------------------------ *
 * Response helpers
 * ------------------------------------------------------------------ */

function textResponse(text: string): Response {
	return new Response(text, {
		headers: objectHeaders("text/plain; charset=utf-8"),
	});
}

function objectHeaders(contentType: string): Headers {
	const headers = new Headers();
	headers.set("Content-Type", contentType);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Cache-Control", "no-store");
	headers.set("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'none'");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
	return headers;
}

/** RFC 6266: an ASCII fallback plus a UTF-8 form, so odd names survive. */
function contentDisposition(filename: string, inline: boolean): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	const encoded = encodeURIComponent(filename);
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function notAvailable(c: Context<AppBindings>, status: string, wantsJson: boolean): Response {
	if (status === "expired") {
		return wantsJson
			? c.json({ error: "expired", message: "This paste has expired." }, 410)
			: htmlError(c, { status: 410, title: "This paste has expired", message: "It was here, and now it's gone." });
	}
	if (status === "consumed") {
		return wantsJson
			? c.json({ error: "consumed", message: "This one-time paste has already been opened." }, 410)
			: htmlError(c, { status: 410, title: "Already opened", message: "This was a one-time link, and it has been used." });
	}
	return wantsJson
		? c.json({ error: "not_found", message: "This paste doesn't exist." }, 404)
		: htmlError(c, { status: 404, title: "Nothing at this address", message: "This paste doesn't exist any more." });
}

function jsonOrText(
	c: Context<AppBindings>,
	wantsJson: boolean,
	status: 400 | 401 | 403 | 404,
	message: string,
	extra: Record<string, string>,
): Response {
	if (wantsJson) return c.json({ error: extra.error ?? "error", message, ...extra }, status);
	return new Response(message, { status, headers: objectHeaders("text/plain; charset=utf-8") });
}

