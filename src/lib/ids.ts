/**
 * Identifier and slug rules.
 *
 * Paste ids are generated with the platform CSPRNG. The alphabet is Crockford-style
 * base32 (no i, l, o, u) so ids survive being read aloud or typed by hand.
 */

export const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ID_LENGTH = 10;

export const MANAGED_TOKEN_BYTES = 32;

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 64;

/** Reserved so that a paste can never shadow an application route. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
	"api",
	"assets",
	"raw",
	"download",
	"manage",
	"pastes",
	"about",
	"privacy",
	"robots.txt",
	"robots",
	"favicon.ico",
	"favicon",
	"sitemap.xml",
	"sitemap",
	"health",
	"healthz",
	"index",
	"home",
	"admin",
	"administrator",
	"login",
	"logout",
	"signup",
	"register",
	"account",
	"settings",
	"new",
	"create",
	"edit",
	"delete",
	"cdn-cgi",
	"well-known",
	"_headers",
	"_redirects",
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/;

export function encodeBase32(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += ID_ALPHABET[byte & 31];
	return out;
}

/** Uniform over the 32 character alphabet: 5 bits map exactly onto the alphabet. */
export function generateId(randomBytes: (length: number) => Uint8Array = defaultRandomBytes, length = ID_LENGTH): string {
	return encodeBase32(randomBytes(length)).slice(0, length);
}

export function defaultRandomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

export function generateManageToken(randomBytes: (length: number) => Uint8Array = defaultRandomBytes): string {
	return encodeBase64Url(randomBytes(MANAGED_TOKEN_BYTES));
}

export function normalizeSlug(raw: string): string {
	return raw
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/-{2,}/g, "-");
}

export interface SlugCheck {
	ok: boolean;
	reason?: "empty" | "too-short" | "too-long" | "characters" | "reserved" | "ambiguous";
	slug: string;
}

export function checkSlug(raw: string): SlugCheck {
	const slug = normalizeSlug(raw);

	if (!slug) return { ok: false, reason: "empty", slug };
	if (slug.length < SLUG_MIN_LENGTH) return { ok: false, reason: "too-short", slug };
	if (slug.length > SLUG_MAX_LENGTH) return { ok: false, reason: "too-long", slug };
	// Dots are rejected outright: they make traversal and file-extension tricks possible
	// and they collide with well-known paths such as robots.txt.
	if (!SLUG_PATTERN.test(slug)) return { ok: false, reason: "characters", slug };
	if (RESERVED_SLUGS.has(slug)) return { ok: false, reason: "reserved", slug };
	if (slug.startsWith("pp-")) return { ok: false, reason: "reserved", slug };
	// Confusable with generated ids in the UI, and easy to abuse for phishing.
	if (/^([a-z0-9])\1{3,}$/.test(slug)) return { ok: false, reason: "ambiguous", slug };

	return { ok: true, slug };
}

/** Ids are matched by this before they ever touch storage. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export function isSafeId(id: string): boolean {
	return ID_PATTERN.test(id) && !id.includes("..") && !id.startsWith("-") && !id.endsWith("-");
}

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	try {
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}
