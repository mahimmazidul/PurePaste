import { env, exports } from "cloudflare:workers";
import type { AppEnv } from "../src/env";
import type { Config } from "../src/config";
import { resolveConfig } from "../src/config";

export const testEnv = env as unknown as AppEnv;
export const testConfig: Config = resolveConfig(testEnv);

const ORIGIN = "http://purepaste.test";

/** Calls the Worker exactly as the platform would, bindings included. */
export function request(path: string, init: RequestInit = {}): Promise<Response> {
	const target = path.startsWith("http") ? path : `${ORIGIN}${path}`;
	return exports.default.fetch(new Request(target, init));
}

export function jsonRequest(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
	return request(path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json", Accept: "application/json", ...(init.headers ?? {}) },
		...init,
	});
}

export interface CreatedBody {
	id: string;
	url: string;
	manage_url: string;
	manage_token: string;
	raw_url: string;
	expires_at: number;
	kind: string;
	encrypted: boolean;
}

/** Creates a paste through the API and returns the parsed response. */
export async function createPaste(body: Record<string, unknown>): Promise<CreatedBody> {
	const response = await jsonRequest("/api/pastes", body);
	if (response.status !== 201) {
		throw new Error(`create failed: ${response.status} ${await response.text()}`);
	}
	return (await response.json()) as CreatedBody;
}

export async function readRow(id: string): Promise<Record<string, unknown> | null> {
	return testEnv.DB.prepare("SELECT * FROM pastes WHERE id = ?").bind(id).first<Record<string, unknown>>();
}

export async function objectCount(): Promise<number> {
	const listed = await testEnv.BLOBS!.list();
	return listed.keys.length;
}

export async function objectKeys(): Promise<string[]> {
	const listed = await testEnv.BLOBS!.list();
	return listed.keys.map((key) => key.name).sort();
}

/** Clears both stores so each test starts from a known state. */
export async function resetStorage(): Promise<void> {
	await testEnv.DB.prepare("DELETE FROM pastes").run();
	const listed = await testEnv.BLOBS!.list();
	for (const key of listed.keys) await testEnv.BLOBS!.delete(key.name);
}

/** A PBKDF2 verifier as a browser would compute it. */
export async function deriveVerifier(password: string, saltHex: string, iterations: number): Promise<string> {
	const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
	const bytes = new Uint8Array(bits);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function makePasswordMaterial(
	password: string,
): Promise<{ salt: string; verifier: string; iterations: number }> {
	const saltBytes = crypto.getRandomValues(new Uint8Array(16));
	const salt = [...saltBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const iterations = 100_000; // fast enough for tests, above the enforced floor
	return { salt, verifier: await deriveVerifier(password, salt, iterations), iterations };
}

/** Reads a JSON body with a type, since `Response.json()` is untyped here. */
export async function readJson<T = Record<string, unknown>>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

export { ORIGIN };
