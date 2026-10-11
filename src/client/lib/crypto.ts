/**
 * Browser cryptography for PurePaste.
 *
 * This module never touches the network. It derives password verifiers and
 * performs end-to-end encryption, both of which are documented in the README
 * and in /about:
 *
 *  - A password is turned into a PBKDF2 key here. Only the derived verifier is
 *    sent, so the server never sees the password itself.
 *  - Encryption uses AES-GCM with a key generated in this browser. The key is
 *    placed in the URL fragment, which browsers do not send to servers.
 *
 * The module is written without DOM access so it can be tested directly inside
 * workerd alongside the server code.
 */

export const PASSWORD_ALGO = "PBKDF2-HMAC-SHA256";
export const DEFAULT_ITERATIONS = 210_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * TypeScript 5.7 and later track which buffer a typed array is backed by, and
 * Web Crypto only accepts the plain (non-shared) kind. Every byte array this
 * module builds is plain; this marks them as such in one place.
 */
type Bytes = Uint8Array & { buffer: ArrayBuffer };
function asBytes(value: Uint8Array): Bytes {
	return value as unknown as Bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
		const binary = atob(padded);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function randomBytes(length: number): Bytes {
	return crypto.getRandomValues(new Uint8Array(length));
}

export function randomHex(length: number): string {
	return toHex(randomBytes(length));
}

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

export async function derivePasswordKey(password: string, salt: Uint8Array, iterations: number): Promise<Bytes> {
	const key = await crypto.subtle.importKey("raw", asBytes(encoder.encode(password)), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: asBytes(salt), iterations, hash: "SHA-256" },
		key,
		256,
	);
	return new Uint8Array(bits);
}

export interface PasswordFieldData {
	salt: string;
	verifier: string;
	iterations: number;
}

/** Turns a typed password into the values the server is willing to accept. */
export async function passwordFieldData(password: string, iterations = DEFAULT_ITERATIONS): Promise<PasswordFieldData> {
	const salt = randomBytes(16);
	const derived = await derivePasswordKey(password, salt, iterations);
	return { salt: toHex(salt), verifier: toBase64Url(derived), iterations };
}

/* ------------------------------------------------------------------ *
 * Envelope encryption
 * ------------------------------------------------------------------ */

const MAGIC = [0x50, 0x50, 0x76, 0x31]; // "PPv1"
const META_AAD = encoder.encode("purepaste:v1:meta");
const CONTENT_AAD = encoder.encode("purepaste:v1:content");
const IV_LENGTH = 12;

export interface EncryptedMetadata {
	title: string | null;
	filename: string | null;
	language: string;
	markdown: boolean;
	contentType: string | null;
	kind: "text" | "file";
}

export function newEncryptionKey(): string {
	return toBase64Url(randomBytes(32));
}

async function importKey(keyB64: string): Promise<CryptoKey> {
	const raw = fromBase64Url(keyB64);
	if (!raw || raw.length !== 32) throw new Error("encryption_key_invalid");
	return crypto.subtle.importKey("raw", asBytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Layout: "PPv1" | kind | u32 meta length | iv | meta ciphertext | iv | content ciphertext
 * The server stores this blob as opaque bytes; it has no way to interpret it.
 */
export async function encryptEnvelope(
	metadata: EncryptedMetadata,
	content: Uint8Array,
	keyB64: string,
): Promise<Bytes> {
	const key = await importKey(keyB64);
	const metaBytes = encoder.encode(JSON.stringify(metadata));
	const metaIv = randomBytes(IV_LENGTH);
	const contentIv = randomBytes(IV_LENGTH);

	const metaCipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBytes(metaIv), additionalData: META_AAD }, key, asBytes(metaBytes)),
	);
	const contentCipher = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: asBytes(contentIv), additionalData: CONTENT_AAD }, key, asBytes(content)),
	);

	const total = MAGIC.length + 1 + 4 + IV_LENGTH + metaCipher.byteLength + IV_LENGTH + contentCipher.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	out.set(MAGIC, offset);
	offset += MAGIC.length;
	out[offset] = metadata.kind === "file" ? 1 : 0;
	offset += 1;
	new DataView(out.buffer).setUint32(offset, metaCipher.byteLength, false);
	offset += 4;
	out.set(metaIv, offset);
	offset += IV_LENGTH;
	out.set(metaCipher, offset);
	offset += metaCipher.byteLength;
	out.set(contentIv, offset);
	offset += IV_LENGTH;
	out.set(contentCipher, offset);
	return out;
}

export interface DecryptedPaste {
	metadata: EncryptedMetadata;
	content: Uint8Array;
}

export async function decryptEnvelope(bytes: Uint8Array, keyB64: string): Promise<DecryptedPaste> {
	if (bytes.byteLength < MAGIC.length + 1 + 4 + IV_LENGTH * 2) throw new Error("envelope_truncated");
	for (let index = 0; index < MAGIC.length; index += 1) {
		if (bytes[index] !== MAGIC[index]) throw new Error("envelope_unknown_format");
	}

	const key = await importKey(keyB64);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = MAGIC.length;
	const kind = bytes[offset] === 1 ? "file" : "text";
	offset += 1;
	const metaLength = view.getUint32(offset, false);
	offset += 4;

	if (offset + IV_LENGTH + metaLength + IV_LENGTH > bytes.byteLength) throw new Error("envelope_truncated");

	const metaIv = bytes.subarray(offset, offset + IV_LENGTH);
	offset += IV_LENGTH;
	const metaCipher = bytes.subarray(offset, offset + metaLength);
	offset += metaLength;
	const contentIv = bytes.subarray(offset, offset + IV_LENGTH);
	offset += IV_LENGTH;
	const contentCipher = bytes.subarray(offset);

	const metaPlain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: asBytes(metaIv), additionalData: META_AAD },
		key,
		asBytes(metaCipher),
	);
	const contentPlain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: asBytes(contentIv), additionalData: CONTENT_AAD },
		key,
		asBytes(contentCipher),
	);

	const metadata = JSON.parse(decoder.decode(metaPlain)) as EncryptedMetadata;
	return { metadata: { ...metadata, kind }, content: new Uint8Array(contentPlain) };
}

/* ------------------------------------------------------------------ *
 * URL fragments
 * ------------------------------------------------------------------ */

/** The fragment is read client side only; it is never part of a request. */
export function readFragment(hash: string): URLSearchParams {
	return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

export function pasteFragment(keyB64: string): string {
	return `#k=${keyB64}`;
}

export function manageFragment(token: string, keyB64?: string | null): string {
	return `#token=${token}${keyB64 ? `&k=${keyB64}` : ""}`;
}
