import { decodeBase64Url } from "./ids";

/**
 * Server-side cryptography.
 *
 * Two things matter here:
 *  1. Password material is derived in the browser (see README: "Why password
 *     derivation happens in the browser"). The Worker only computes a cheap
 *     peppered hash of the verifier, which keeps every request inside the
 *     10 ms CPU budget of the free plan.
 *  2. All comparisons of secrets are constant time and always do the same work,
 *     so a wrong guess cannot be distinguished from a slow one.
 */

const encoder = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
	const bytes = typeof input === "string" ? encoder.encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
	return toHex(new Uint8Array(digest));
}

export async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(encoder.encode(secret)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(encoder.encode(message)));
	return new Uint8Array(signature);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
	return toHex(await hmacSha256(secret, message));
}

/** Fixed-time comparison of two strings. Length is not part of the comparison result. */
export function constantTimeEqual(a: string, b: string): boolean {
	const max = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < max; i += 1) {
		diff |= (i < a.length ? a.charCodeAt(i) : 0) ^ (i < b.length ? b.charCodeAt(i) : 0);
	}
	return diff === 0;
}

export async function randomHex(bytes: number): Promise<string> {
	return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

/* ------------------------------------------------------------------ *
 * Management tokens
 * ------------------------------------------------------------------ */

/**
 * Stored form of a management token: HMAC(secret, id + token). Binding the id
 * means a token lifted from one paste cannot be replayed against another.
 */
export async function hashManageToken(secret: string, pasteId: string, token: string): Promise<string> {
	return hmacSha256Hex(secret, `manage:v1:${pasteId}:${token}`);
}

export async function verifyManageToken(
	secret: string,
	pasteId: string,
	token: string,
	storedHash: string,
): Promise<boolean> {
	const computed = await hashManageToken(secret, pasteId, token);
	return constantTimeEqual(computed, storedHash);
}

/* ------------------------------------------------------------------ *
 * Password verifiers
 * ------------------------------------------------------------------ */

export const PASSWORD_ALGO = "PBKDF2-HMAC-SHA256";

/**
 * `verifier` is the base64url PBKDF2 output computed in the browser.
 * Storing HMAC(secret, id + salt + verifier) means a stolen database cannot be
 * attacked offline without also stealing the Worker secret.
 */
export async function hashPasswordVerifier(
	secret: string,
	pasteId: string,
	salt: string,
	verifier: string,
): Promise<string> {
	return hmacSha256Hex(secret, `pw:v1:${pasteId}:${salt.toLowerCase()}:${verifier}`);
}

export async function verifyPassword(
	secret: string,
	pasteId: string,
	salt: string,
	verifier: string,
	storedHash: string,
): Promise<boolean> {
	const computed = await hashPasswordVerifier(secret, pasteId, salt, verifier);
	return constantTimeEqual(computed, storedHash);
}

export function decodeVerifier(value: string): string | null {
	const bytes = decodeBase64Url(value);
	// A browser PBKDF2-SHA256 output is 32 bytes; longer inputs are rejected rather
	// than silently truncated.
	if (!bytes || bytes.length !== 32) return null;
	return value;
}

/* ------------------------------------------------------------------ *
 * Unlock cookies
 * ------------------------------------------------------------------ */

export interface UnlockTicket {
	pasteId: string;
	expiresAt: number;
}

export async function signUnlockTicket(secret: string, ticket: UnlockTicket): Promise<string> {
	const payload = `${ticket.pasteId}.${ticket.expiresAt}`;
	const signature = await hmacSha256Hex(secret, `unlock:v1:${payload}`);
	return `${payload}.${signature}`;
}

export async function verifyUnlockTicket(secret: string, value: string, now: number): Promise<UnlockTicket | null> {
	const parts = value.split(".");
	if (parts.length !== 3) return null;
	const [pasteId, expiresRaw, signature] = parts as [string, string, string];
	const expiresAt = Number.parseInt(expiresRaw, 10);
	if (!pasteId || !Number.isFinite(expiresAt) || expiresAt <= now) return null;
	const expected = await hmacSha256Hex(secret, `unlock:v1:${pasteId}.${expiresAt}`);
	return constantTimeEqual(expected, signature) ? { pasteId, expiresAt } : null;
}
