import type { Context } from "hono";
import type { AppBindings } from "../env";
import { fail } from "../lib/errors";
import { parseId } from "../lib/validation";
import { signUnlockTicket, verifyManageToken, verifyPassword } from "../lib/crypto";
import { deletePaste, loadPaste, stores } from "../services/paste-store";
import { limitPasteUnlock } from "../middleware/rate-limit";
import { cookieNameFor } from "./paste";

/**
 * Metadata only. Protected pastes answer with the minimum needed to show a
 * password prompt: no title, no language, no file name.
 */
export async function getMetadata(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const result = await loadPaste(c.env, id, { now: Date.now() });

	if (result.status === "missing") return errorJson(c, 404, "not_found", "This paste doesn't exist.");
	if (result.status === "expired") return errorJson(c, 410, "expired", "This paste has expired.");
	if (result.status === "consumed")
		return errorJson(c, 410, "consumed", "This one-time paste has already been opened.");

	const record = result.record;
	const origin = new URL(c.req.url).origin;
	const links = {
		url: `${origin}/${record.id}`,
		raw_url: `${origin}/raw/${record.id}`,
		download_url: record.kind === "file" ? `${origin}/download/${record.id}` : null,
	};

	if (record.passwordVerifier && record.passwordSalt) {
		const headerVerifier = c.req.header("x-paste-password");
		const unlocked = headerVerifier
			? await verifyPassword(
					c.get("config").appSecret,
					record.id,
					record.passwordSalt,
					headerVerifier.trim(),
					record.passwordVerifier,
				)
			: false;
		if (!unlocked) {
			return c.json(
				{
					id: record.id,
					locked: true,
					encrypted: record.encrypted,
					burn_after_reading: record.burnAfterRead,
					awaits_reveal: result.status === "needs-reveal",
					created_at: record.createdAt,
					expires_at: record.expiresAt,
					size_bytes: record.sizeBytes,
					kdf: { algo: record.passwordAlgo, iterations: record.passwordIterations, salt: record.passwordSalt },
					links: { url: links.url, raw_url: links.raw_url, download_url: links.download_url },
				},
				200,
			);
		}
	}

	return c.json({
		id: record.id,
		kind: record.kind,
		locked: false,
		encrypted: record.encrypted,
		markdown: record.markdown,
		burn_after_reading: record.burnAfterRead,
		awaits_reveal: result.status === "needs-reveal",
		title: record.encrypted ? null : record.title,
		language: record.encrypted ? null : record.language,
		filename: record.encrypted ? null : record.filename,
		content_type: record.encrypted ? null : record.contentType,
		size_bytes: record.sizeBytes,
		created_at: record.createdAt,
		expires_at: record.expiresAt,
		views: c.get("config").viewCounting ? record.views : null,
		links,
	});
}

/**
 * Unlock with a verifier derived in the caller's browser (or terminal).
 *
 * The work done here is identical whether or not the verifier matches: one HMAC
 * and one constant-time comparison, so a wrong guess cannot be told apart from a
 * right one by timing or by the response body.
 */
export async function unlockPaste(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	await limitPasteUnlock(c, id);

	const result = await loadPaste(c.env, id, { now: Date.now() });
	if (result.status === "missing") return errorJson(c, 404, "not_found", "This paste doesn't exist.");
	if (result.status === "expired") return errorJson(c, 410, "expired", "This paste has expired.");
	if (result.status === "consumed") return errorJson(c, 410, "consumed", "This paste has already been opened.");

	const record = result.record;
	if (!record.passwordVerifier || !record.passwordSalt) {
		return c.json({ id: record.id, unlocked: true, message: "This paste isn't password protected." });
	}

	const verifier = await readVerifier(c);
	if (!verifier) throw fail.invalidCredentials();

	const ok = await verifyPassword(
		c.get("config").appSecret,
		record.id,
		record.passwordSalt,
		verifier,
		record.passwordVerifier,
	);
	if (!ok) throw fail.invalidCredentials();

	const expiresAt = Date.now() + c.get("config").unlockCookieTtlSeconds * 1000;
	const ticket = await signUnlockTicket(c.get("config").appSecret, { pasteId: record.id, expiresAt });
	const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";

	c.header(
		"Set-Cookie",
		`${cookieNameFor(record.id)}=${ticket}; Path=/; Max-Age=${c.get("config").unlockCookieTtlSeconds}; HttpOnly; SameSite=Lax${secure}`,
	);

	return c.json({ id: record.id, unlocked: true, expires_at: expiresAt });
}

async function readVerifier(c: Context<AppBindings>): Promise<string | null> {
	const headerVerifier = c.req.header("x-paste-password");
	if (headerVerifier) return headerVerifier.trim();

	const contentType = (c.req.header("content-type") ?? "").toLowerCase();
	try {
		if (contentType.includes("application/json")) {
			const body = (await c.req.json()) as { verifier?: unknown; password_verifier?: unknown };
			const value = typeof body.verifier === "string" ? body.verifier : body.password_verifier;
			return typeof value === "string" ? value.trim() : null;
		}
		const form = await c.req.formData();
		const value = form.get("verifier") ?? form.get("password_verifier");
		return typeof value === "string" ? value.trim() : null;
	} catch {
		return null;
	}
}

/** Delete with the management token. Token comes from a header, never a query string. */
export async function deleteManagedPaste(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const token = readManageToken(c);
	if (!token) {
		return errorJson(
			c,
			401,
			"unauthorized",
			"The management token is missing.",
			"Send it as: Authorization: Bearer <token>. Query strings are not accepted because they end up in logs and browser history.",
		);
	}

	const record = await stores(c.env).meta.findById(id);
	if (!record) return errorJson(c, 404, "not_found", "This paste doesn't exist. It may already have been deleted.");

	const valid = await verifyManageToken(c.get("config").appSecret, id, token, record.manageHash);
	if (!valid) return errorJson(c, 401, "unauthorized", "That management token doesn't match this paste.");

	const outcome = await deletePaste(c.env, record);

	return c.json({
		id,
		deleted: true,
		object_removed: outcome.objectRemoved,
		row_removed: outcome.rowRemoved,
		deferred: outcome.deferred,
		message: outcome.deferred
			? "The paste is no longer readable. Its stored file will be removed by the next cleanup run."
			: "Deleted. The link stops working immediately.",
	});
}

function readManageToken(c: Context<AppBindings>): string | null {
	const authorization = c.req.header("authorization");
	if (authorization?.toLowerCase().startsWith("bearer ")) {
		const value = authorization.slice(7).trim();
		if (value) return value;
	}
	const header = c.req.header("x-manage-token");
	if (header?.trim()) return header.trim();
	return null;
}

function errorJson(
	c: Context<AppBindings>,
	status: 400 | 401 | 404 | 410,
	code: string,
	message: string,
	hint?: string,
) {
	return c.json({ error: code, message, ...(hint ? { hint } : {}) }, status);
}
