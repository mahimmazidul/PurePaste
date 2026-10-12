/**
 * Firebase Storage (Google Cloud Storage under the hood) through the JSON API.
 *
 * Worth stating plainly before anyone wires it up: as of today the no-cost Firebase
 * plan does **not** include Cloud Storage at all — the pricing page marks every
 * storage row "Not applicable" for Spark, and its 5 GB / 1 GB-a-day figures sit in
 * the Blaze column, which needs a payment method. This backend exists for the
 * person who is already on Blaze, or who wants Firebase's CDN in front of their
 * buckets. On a cardless account the choice is KV, or B2 through ./s3-store.
 *
 * Auth is a service-account JWT exchanged for an OAuth access token (RS256, signed
 * with WebCrypto — no SDK). The token is cached per Worker isolate until it is
 * nearly expired, so a burst of reads costs one token request, not one each.
 */

import type { AppEnv } from "../env";
import type { BlobBody, BlobStore, ObjectKind, PutOptions } from "./object-store";

export interface FirebaseSettings {
	projectId: string;
	bucket: string;
	clientEmail: string;
	/** The PKCS#8 private key from the service-account JSON, PEM included. */
	privateKey: string;
	/** Optional: a public bucket base for links that skip this Worker. */
	publicBase?: string;
}

const API = "https://storage.googleapis.com/storage/v1";
const UPLOAD_API = "https://storage.googleapis.com/upload/storage/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

const base64url = (bytes: Uint8Array | string): string => {
	const binary = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem: string): ArrayBuffer {
	// Secrets pasted into a dashboard often arrive with literal "\n" instead of
	// newlines, which makes the base64 body unparseable. Normalise both forms.
	const normalised = pem.includes("\\n") && !pem.includes("\n") ? pem.replace(/\\n/g, "\n") : pem;
	const body = normalised.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
	const raw = atob(body);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
	return bytes.buffer as ArrayBuffer;
}

interface TokenCache {
	value: string;
	until: number;
}

const tokens = new Map<string, TokenCache>();

/** Issued outside the class so a Worker isolate shares one token per service account. */
async function accessToken(settings: FirebaseSettings, now = Date.now()): Promise<string> {
	const cached = tokens.get(settings.clientEmail);
	if (cached && cached.until > now + 60_000) return cached.value;

	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToDer(settings.privateKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const issuedAt = Math.floor(now / 1000);
	const claims = {
		iss: settings.clientEmail,
		scope: SCOPE,
		aud: TOKEN_URL,
		iat: issuedAt,
		exp: issuedAt + 3600,
	};
	const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"RSASSA-PKCS1-v1_5",
			key,
			new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
		),
	);
	const assertion = `${signingInput}.${base64url(signature)}`;

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
	});
	if (!response.ok) throw new Error(`firebase_auth_failed: ${response.status}`);
	const payload = (await response.json()) as { access_token?: string; expires_in?: number };
	if (!payload.access_token) throw new Error("firebase_auth_failed: no access token");
	tokens.set(settings.clientEmail, {
		value: payload.access_token,
		until: now + Math.max(60, (payload.expires_in ?? 3600) - 300) * 1000,
	});
	return payload.access_token;
}

export class FirebaseObjectStore implements BlobStore {
	readonly kind = "firebase" as const;

	constructor(
		private readonly settings: FirebaseSettings,
		private readonly prefix = "pp/v1",
	) {}

	keyFor(id: string, kind: ObjectKind): string {
		return `${this.prefix}/${kind}/${id}`;
	}

	/** Object names are percent-encoded whole, so a key with a dot survives intact. */
	private objectPath(key: string): string {
		return `${API}/b/${encodeURIComponent(this.settings.bucket)}/o/${encodeURIComponent(key)}`;
	}

	private uploadPath(key: string): string {
		return `${UPLOAD_API}/b/${encodeURIComponent(this.settings.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
	}

	private async fetch(url: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${await accessToken(this.settings)}`);
		return fetch(url, { ...init, headers });
	}

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<void> {
		const headers: Record<string, string> = {};
		// A media upload takes the object's content type from the request itself.
		// Display metadata (filename) is not written here: D1 is the authoritative
		// record for it, which is also what makes the streaming path possible.
		if (options.contentType) headers["content-type"] = options.contentType;
		const response = await this.fetch(this.uploadPath(key), { method: "POST", body: value as BodyInit, headers });
		if (!response.ok) throw new Error(`firebase_put_failed: ${response.status}`);
	}

	async putFromRequest(key: string, request: Request, options: PutOptions = {}): Promise<void> {
		if (!request.body) throw new Error("Request body is unavailable");
		const headers: Record<string, string> = {};
		if (options.contentType) headers["content-type"] = options.contentType;
		const response = await this.fetch(this.uploadPath(key), {
			method: "POST",
			body: request.body as ReadableStream,
			headers,
			duplex: "half",
		} as RequestInit);
		if (!response.ok) throw new Error(`firebase_put_failed: ${response.status}`);
	}

	async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
		await this.put(key, bytes, options);
	}

	async get(key: string): Promise<BlobBody | null> {
		const response = await this.fetch(`${this.objectPath(key)}?alt=media`);
		if (response.status === 404 || response.status === 403) return null;
		if (!response.ok || !response.body) throw new Error(`firebase_get_failed: ${response.status}`);
		const length = response.headers.get("x-goog-stored-content-length") ?? response.headers.get("content-length");
		return {
			body: response.body,
			size: length ? Number.parseInt(length, 10) : -1,
			httpEtag: response.headers.get("etag") ?? `"${key}"`,
			contentType: response.headers.get("content-type") ?? undefined,
		};
	}

	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const failed: string[] = [];
		let deleted = 0;
		for (const key of keys) {
			try {
				const response = await this.fetch(this.objectPath(key), { method: "DELETE" });
				if (response.ok || response.status === 404) deleted += 1;
				else failed.push(key);
			} catch {
				failed.push(key);
			}
		}
		return { deleted, failed };
	}

	/** Only for a bucket whose objects are genuinely public; otherwise null. */
	async publicUrlFor(key: string): Promise<string | null> {
		const base = this.settings.publicBase;
		if (!base) return null;
		return `${base.replace(/\/$/, "")}/${encodeURIComponent(key)}`;
	}
}

export function firebaseSettingsFromEnv(env: AppEnv): FirebaseSettings | null {
	const projectId = env.FIREBASE_PROJECT_ID?.trim();
	const bucket = env.FIREBASE_BUCKET?.trim();
	const clientEmail = env.FIREBASE_CLIENT_EMAIL?.trim();
	const privateKey = env.FIREBASE_PRIVATE_KEY?.trim();
	if (!projectId || !bucket || !clientEmail || !privateKey) return null;
	return { projectId, bucket, clientEmail, privateKey, publicBase: env.FIREBASE_PUBLIC_BASE?.trim() || undefined };
}

export function firebaseStoreFromEnv(env: AppEnv): FirebaseObjectStore | null {
	const settings = firebaseSettingsFromEnv(env);
	return settings ? new FirebaseObjectStore(settings) : null;
}
