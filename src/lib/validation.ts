import { fail } from "./errors";
import { checkSlug, decodeBase64Url, isSafeId, normalizeSlug } from "./ids";
import { PASSWORD_ALGO, decodeVerifier } from "./crypto";
import { resolveLanguage } from "./languages";
import { TTL_EXTRA_CHOICES } from "../config";
import type { Config } from "../config";
import type { CreatePasteInput, PasswordMaterial } from "../types";

const encoder = new TextEncoder();

export const TITLE_MAX_LENGTH = 200;
export const SLUG_ATTEMPTS = 5;
/** Upper bound for a redirect destination. Long enough for real links, short enough to store cheaply. */
export const REDIRECT_MAX_LENGTH = 2048;

export function utf8Length(text: string): number {
	return encoder.encode(text).byteLength;
}

/**
 * Cheap rejection first: UTF-8 is never shorter than the code unit count, so a
 * string longer than the byte budget can be refused without encoding it.
 */
export function utf8LengthAtMost(text: string, maxBytes: number): boolean {
	if (text.length > maxBytes) return false;
	return utf8Length(text) <= maxBytes;
}

export function parseTitle(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	// Control characters are stripped; they break layout and terminal output.
	// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
	const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
	if (!cleaned) return null;
	return cleaned.slice(0, TITLE_MAX_LENGTH);
}

export function parseSlug(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "string") throw fail.invalidSlug();
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const check = checkSlug(trimmed);
	if (!check.ok) {
		if (check.reason === "reserved") throw fail.reservedSlug();
		if (check.reason === "too-short") throw fail.invalidSlug("Custom names need at least 3 characters.");
		if (check.reason === "too-long") throw fail.invalidSlug("Custom names can be at most 64 characters.");
		if (check.reason === "ambiguous") throw fail.invalidSlug("That name looks too repetitive to be useful.");
		throw fail.invalidSlug("Use lowercase letters, numbers and dashes only.");
	}
	return check.slug;
}

/** Only absolute http(s) destinations are accepted, and credentials are refused. */
export function parseRedirectUrl(raw: unknown): string {
	if (typeof raw !== "string") throw fail.invalidUrl();
	const trimmed = raw.trim();
	if (!trimmed || trimmed.length > REDIRECT_MAX_LENGTH) throw fail.invalidUrl();
	// Control characters are refused rather than cleaned up. The URL parser drops
	// some of them silently, which would hide an attempt to smuggle a value into a
	// header or into a line of terminal output.
	// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw fail.invalidUrl();

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw fail.invalidUrl();
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw fail.invalidUrl();
	if (!url.hostname || url.hostname.includes(" ")) throw fail.invalidUrl();
	if (url.username || url.password) throw fail.invalidUrl();

	// The stored value is the parser's normalized form, so scheme and host case are
	// settled here and nothing downstream has to guess.
	const normalized = url.toString();
	if (normalized.length > REDIRECT_MAX_LENGTH) throw fail.invalidUrl();
	return normalized;
}

export function parseExpiration(raw: unknown, config: Config): number {
	if (raw === null || raw === undefined || raw === "") return config.defaultTtlSeconds;
	let value = String(raw).trim().toLowerCase();

	// Slip-style lifetime keys are accepted as aliases of the canonical menu.
	const aliases: Record<string, string> = { "1w": "7d", "1week": "7d", "1mo": "30d", "1month": "30d" };
	const alias = aliases[value];
	if (alias) value = alias;

	const choice =
		config.ttlChoices.find((option) => option.value === value) ??
		TTL_EXTRA_CHOICES.find((option) => option.value === value);
	// A lifetime nobody offered is still refused: the extra choices exist so the
	// file tab's shorter default round-trips, not as an open-ended grammar.
	if (choice) return Math.min(choice.seconds, config.maxTtlSeconds);

	// Bare seconds are accepted from the API, but the ceiling is the server's, not the client's.
	if (/^\d+$/.test(value)) {
		const seconds = Number.parseInt(value, 10);
		if (seconds <= 0) throw fail.invalidExpiration();
		return Math.min(seconds, config.maxTtlSeconds);
	}

	throw fail.invalidExpiration();
}

export function parseFlag(raw: unknown): boolean {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "number") return raw === 1;
	if (typeof raw !== "string") return false;
	return ["1", "on", "true", "yes"].includes(raw.trim().toLowerCase());
}

export function parsePasswordMaterial(raw: {
	verifier?: unknown;
	salt?: unknown;
	iterations?: unknown;
}): PasswordMaterial | null {
	const verifierRaw = typeof raw.verifier === "string" ? raw.verifier.trim() : "";
	const saltRaw = typeof raw.salt === "string" ? raw.salt.trim().toLowerCase() : "";
	if (!verifierRaw && !saltRaw) return null;

	if (!/^[0-9a-f]{32}$/.test(saltRaw)) {
		throw fail.invalidRequest(
			"Password derivation parameters were missing.",
			"Send password_salt as 16 random bytes in hex.",
		);
	}
	if (!decodeVerifier(verifierRaw) || !decodeBase64Url(verifierRaw)) {
		throw fail.invalidRequest(
			"Password verifier was malformed.",
			"Send password_verifier as the base64url PBKDF2 output (32 bytes).",
		);
	}
	const iterations = Number.parseInt(String(raw.iterations ?? ""), 10);
	if (!Number.isFinite(iterations) || iterations < 100_000 || iterations > 1_000_000) {
		throw fail.invalidRequest("Password iteration count was out of range.", "Use between 100000 and 1000000.");
	}
	return { salt: saltRaw, verifier: verifierRaw, iterations, algo: PASSWORD_ALGO };
}

/* ------------------------------------------------------------------ *
 * File names
 * ------------------------------------------------------------------ */

export function sanitizeFilename(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? "";
	const cleaned = base
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[<>:"|?*]/g, "_")
		.trim()
		.replace(/^\.+/, "");
	const safe = cleaned || "download";
	return safe.slice(0, 128);
}

const CONTENT_TYPES: Record<string, string> = {
	"7z": "application/x-7z-compressed",
	csv: "text/csv",
	gz: "application/gzip",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	json: "application/json",
	log: "text/plain",
	md: "text/markdown",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	tar: "application/x-tar",
	toml: "text/plain",
	txt: "text/plain",
	webp: "image/webp",
	xz: "application/x-xz",
	yaml: "text/yaml",
	yml: "text/yaml",
	zip: "application/zip",
};

/**
 * The client's declared media type is ignored entirely. The type is derived from
 * the sanitized extension, and anything unknown becomes a generic download.
 */
export function resolveContentType(filename: string): string {
	const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
	return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/* ------------------------------------------------------------------ *
 * Assembling a creation request
 * ------------------------------------------------------------------ */

export interface RawCreateInput {
	kind?: unknown;
	title?: unknown;
	language?: unknown;
	content?: unknown;
	url?: unknown;
	slug?: unknown;
	expire?: unknown;
	ttl?: unknown;
	burn?: unknown;
	burnAfterRead?: unknown;
	markdown?: unknown;
	encrypted?: unknown;
	filename?: unknown;
	contentType?: unknown;
	passwordVerifier?: unknown;
	passwordSalt?: unknown;
	passwordIterations?: unknown;
}

export interface AssembledInput {
	input: CreatePasteInput;
	/** Raw text, kept in memory so the caller can measure before encoding. */
	text: string;
}

export function assembleTextInput(
	raw: RawCreateInput,
	text: string,
	config: Config,
	overrides: { burnAfterRead?: boolean } = {},
): AssembledInput {
	const title = parseTitle(raw.title);
	const markdownRequested = parseFlag(raw.markdown);
	const password =
		raw.passwordVerifier || raw.passwordSalt
			? parsePasswordMaterial({
					verifier: raw.passwordVerifier,
					salt: raw.passwordSalt,
					iterations: raw.passwordIterations,
				})
			: null;

	if (!utf8LengthAtMost(text, config.textMaxBytes)) {
		throw fail.tooLarge(`${Math.floor(config.textMaxBytes / 1024)} KiB`);
	}
	if (text.trim().length === 0) {
		throw fail.invalidRequest("There's nothing to save yet.", "Add some text, or choose a file.");
	}

	return {
		input: {
			kind: "text",
			title,
			language: resolveLanguage(typeof raw.language === "string" ? raw.language : null),
			markdown: markdownRequested,
			burnAfterRead: overrides.burnAfterRead ?? parseFlag(raw.burn ?? raw.burnAfterRead),
			encrypted: false,
			ttlSeconds: parseExpiration(raw.expire ?? raw.ttl, config),
			slug: parseSlug(raw.slug),
			password,
			redirectUrl: null,
			body: { type: "text", text },
			filename: null,
			contentType: null,
		},
		text,
	};
}

export function assembleFileInput(
	raw: RawCreateInput,
	file: { size: number; filename: string },
	body: CreatePasteInput["body"],
	config: Config,
): CreatePasteInput {
	if (file.size > config.fileMaxBytes) throw fail.tooLarge(`${Math.floor(config.fileMaxBytes / 1024 / 1024)} MiB`);
	if (file.size === 0) throw fail.invalidRequest("That file is empty.");

	const filename = sanitizeFilename(file.filename);
	const password =
		raw.passwordVerifier || raw.passwordSalt
			? parsePasswordMaterial({
					verifier: raw.passwordVerifier,
					salt: raw.passwordSalt,
					iterations: raw.passwordIterations,
				})
			: null;

	return {
		kind: "file",
		title: parseTitle(raw.title),
		language: null,
		markdown: false,
		burnAfterRead: parseFlag(raw.burn ?? raw.burnAfterRead),
		encrypted: false,
		ttlSeconds: parseExpiration(raw.expire ?? raw.ttl, config),
		slug: parseSlug(raw.slug),
		password,
		redirectUrl: null,
		body,
		filename,
		contentType: resolveContentType(filename),
	};
}

export function assembleRedirectInput(raw: RawCreateInput, config: Config): CreatePasteInput {
	const url = parseRedirectUrl(raw.url);
	return {
		kind: "redirect",
		title: parseTitle(raw.title),
		language: null,
		markdown: false,
		burnAfterRead: parseFlag(raw.burn ?? raw.burnAfterRead),
		encrypted: false,
		ttlSeconds: parseExpiration(raw.expire ?? raw.ttl, config),
		slug: parseSlug(raw.slug),
		password: null,
		redirectUrl: url,
		body: { type: "none" },
		filename: null,
		contentType: null,
	};
}

/** Encrypted pastes carry no readable metadata: the server stores only ciphertext. */
export function assembleEncryptedInput(
	raw: RawCreateInput,
	size: number,
	config: Config,
	body: CreatePasteInput["body"],
): CreatePasteInput {
	if (size > config.fileMaxBytes) throw fail.tooLarge(`${Math.floor(config.fileMaxBytes / 1024 / 1024)} MiB`);
	if (size < 32) throw fail.invalidRequest("That encrypted payload looks incomplete.");
	const password = {
		verifier: typeof raw.passwordVerifier === "string" ? raw.passwordVerifier : "",
		salt: typeof raw.passwordSalt === "string" ? raw.passwordSalt : "",
		iterations: raw.passwordIterations,
	};
	const parsedPassword = password.verifier || password.salt ? parsePasswordMaterial(password) : null;

	return {
		kind: "text",
		title: null,
		language: null,
		markdown: false,
		burnAfterRead: parseFlag(raw.burn ?? raw.burnAfterRead),
		encrypted: true,
		ttlSeconds: parseExpiration(raw.expire ?? raw.ttl, config),
		slug: parseSlug(raw.slug),
		password: parsedPassword,
		redirectUrl: null,
		body,
		filename: null,
		contentType: null,
	};
}

/** Path parameters are validated before they reach any query or object key. */
export function parseId(raw: string | undefined): string {
	if (!raw || !isSafeId(raw)) throw fail.notFound();
	if (normalizeSlug(raw) !== raw) throw fail.notFound();
	return raw;
}
