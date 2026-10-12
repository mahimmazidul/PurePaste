/**
 * S3-compatible object storage: Backblaze B2, Supabase Storage, Cloudflare R2,
 * MinIO — anything that speaks the S3 REST API with path-style keys.
 *
 * Why this exists next to KV: on a free account KV is the only cardless option,
 * and it is a tight one (1 GB shared, 1 000 writes and 100 000 reads a day). B2's
 * free allowance is 10 GB of storage with downloads free up to 3× the average
 * stored data, and its API transactions are free on pay-as-you-go — which is the
 * difference between a couple of hundred shared files and a couple of thousand.
 *
 * Signing is AWS Signature V4, done with WebCrypto, no SDK: four HMAC rounds
 * over a canonical request. Two deliberate simplifications, both documented:
 *  - the payload is `UNSIGNED-PAYLOAD`, so an upload streams straight through the
 *    Worker instead of being buffered to hash it (S3 and B2 both accept it over TLS);
 *  - deletes are one request per key, like the KV backend. The cleanup sweep is
 *    already batched, and a batch `DeleteObjects` call would need an MD5 of an XML
 *    body for no real saving at this scale.
 */

import type { AppEnv } from "../env";
import type { BlobBody, BlobStore, ObjectKind, PutOptions } from "./object-store";

export interface S3Settings {
	/** Scheme + host, and any fixed path prefix (Supabase needs one). No trailing slash. */
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	/**
	 * A public base — a bucket CDN domain, or a Cloudflare-proxied custom domain in
	 * front of the bucket. When set, links handed to visitors are built from it and
	 * carry no credentials at all, so the bytes never touch this Worker.
	 */
	publicBase?: string;
	/** Key prefix; bump it to move to a fresh layout in the same bucket. */
	prefix?: string;
	/**
	 * Address the bucket as `<bucket>.<endpoint host>` instead of `<endpoint>/<bucket>`.
	 * Required by Supabase Storage's S3-compatible API, which rejects path style.
	 */
	virtualHostStyle?: boolean;
	/**
	 * Delete hidden/previous versions too. On by default: a versioned bucket that
	 * only ever gets plain DELETEs never gives its storage back.
	 */
	purgeVersions?: boolean;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as unknown as ArrayBuffer,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data) as unknown as ArrayBuffer));
}

/** Code-point ordering, which is what the SigV4 spec asks for. */
function byteOrder(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** RFC 3986, which is what S3's canonical form uses (space → %20, not +). */
function uriEncode(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzStamps(now = new Date()): { date: string; datetime: string } {
	// Every character the ISO form carries that SigV4 does not want, including the
	// trailing Z: `datetime` gets its own, and leaving both makes an invalid stamp.
	const iso = now.toISOString().replace(/[:-]|\.\d{3}|Z/g, "");
	return { date: iso.slice(0, 8), datetime: `${iso.slice(0, 15)}Z` };
}

interface SignResult {
	headers: Record<string, string>;
	datetime: string;
	signature: string;
	signedHeaders: string;
	/** The exact query the signature covers, so a presigned URL can reuse it. */
	canonicalQuery: string;
	/** Returned for the same reason debug output is: canonicalisation is where signing breaks. */
	canonicalRequest: string;
	stringToSign: string;
}

interface SignInput {
	method: string;
	/** Path from the endpoint root, e.g. `/bucket/pp/v1/file/abc`. */
	path: string;
	query: [string, string][];
	headers: Record<string, string>;
	/** Hex hash, `UNSIGNED-PAYLOAD`, or `STREAMING-*`. */
	payloadHash: string;
	region: string;
	service: string;
	accessKeyId: string;
	secretAccessKey: string;
	host: string;
	now?: Date;
	/**
	 * `header` (default) signs the `x-amz-date` header; `query` is for presigned
	 * URLs, where the date and expiry live in the query string instead.
	 */
	mode?: "header" | "query";
}

async function signV4(input: SignInput): Promise<SignResult> {
	const { date, datetime } = amzStamps(input.now);
	const scope = `${date}/${input.region}/${input.service}/aws4_request`;
	const headerMode = (input.mode ?? "header") === "header";

	// Names are lowercased once and used in that form both for the canonical
	// request and for the wire: header names are case-insensitive in HTTP, but a
	// signature is not, so this map has to be the only source of truth.
	const canon = new Map<string, string>();
	for (const [name, value] of Object.entries(input.headers)) {
		canon.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "));
	}
	canon.set("host", input.host);
	// A presigned URL carries its own date in the query and signs only `host`, so
	// adding a date header there would sign something the request never sends.
	if (headerMode) canon.set("x-amz-date", datetime);
	const names = [...canon.keys()].sort(byteOrder);
	const canonHeaders = names.map((name) => `${name}:${canon.get(name)}\n`).join("");
	const signedHeaders = names.join(";");

	// Byte order, not locale order: the service sorts the encoded pairs by code
	// point, and `localeCompare` can disagree with it about case.
	const canonicalQuery = [...input.query]
		.map(([key, value]) => [uriEncode(key), uriEncode(value)] as [string, string])
		.sort((a, b) => (a[0] === b[0] ? byteOrder(a[1], b[1]) : byteOrder(a[0], b[0])))
		.map(([key, value]) => `${key}=${value}`)
		.join("&");

	const canonicalRequest = [
		input.method,
		// Already encoded by the caller; encoding it again would sign a path the
		// service never sees (%20 turning into %2520).
		input.path,
		canonicalQuery,
		canonHeaders,
		signedHeaders,
		input.payloadHash,
	].join("\n");

	const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, await sha256Hex(canonicalRequest)].join("\n");

	let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), date);
	key = await hmac(key, input.region);
	key = await hmac(key, input.service);
	key = await hmac(key, "aws4_request");
	const signature = hex(await hmac(key, stringToSign));

	const wire: Record<string, string> = {};
	for (const [name, value] of canon) wire[name] = value;
	wire.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	return { headers: wire, datetime, signature, signedHeaders, canonicalQuery, canonicalRequest, stringToSign };
}

/** Exported for the unit test that pins the canonical forms against an independent implementation. */
export const testing = { signV4, uriEncode, amzStamps, emptySha256: EMPTY_SHA256 };

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, digits: string) => String.fromCharCode(Number(digits)))
		.replace(/&amp;/g, "&");
}

function singleTag(xml: string, tag: string): string | null {
	const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
	return match?.[1] === undefined ? null : decodeXml(match[1]);
}

/** Every `<Key>` + `<LastModified>` pair from a ListObjectsV2 body. */
export function listingsOf(xml: string): Array<{ key: string; lastModified: number }> {
	const out: Array<{ key: string; lastModified: number }> = [];
	for (const block of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const body = block[1] ?? "";
		const key = singleTag(body, "Key");
		if (!key) continue;
		const stamp = singleTag(body, "LastModified");
		const parsed = stamp ? Date.parse(stamp) : Number.NaN;
		out.push({ key, lastModified: Number.isNaN(parsed) ? 0 : parsed });
	}
	return out;
}

/** Version ids for one exact key, from a ListObjectVersions body. */
export function versionsOf(xml: string, key: string): string[] {
	const ids: string[] = [];
	for (const block of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/(Version|DeleteMarker)>/g)) {
		const body = block[2] ?? "";
		if (singleTag(body, "Key") !== key) continue;
		const versionId = singleTag(body, "VersionId");
		// `null` is the id S3 gives the current object in an unversioned bucket:
		// deleting "null" deletes the object, which is what we want anyway.
		if (versionId) ids.push(versionId);
	}
	return ids;
}

export class S3ObjectStore implements BlobStore {
	readonly kind = "s3" as const;

	constructor(
		private readonly settings: S3Settings,
		private readonly prefix = settings.prefix ?? "pp/v1",
		/** The transport, injectable so the wire format can be tested without a network. */
		private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
	) {}

	/** Common prefix of every key this store owns; the orphan sweep lists under it. */
	objectPrefix(): string {
		return `${this.prefix}/`;
	}

	keyFor(id: string, kind: ObjectKind): string {
		return `${this.prefix}/${kind}/${id}`;
	}

	/**
	 * Where a key actually goes. Path style (`endpoint/bucket/key`) is what B2, R2
	 * and MinIO speak; virtual-host style (`bucket.endpoint/key`) is what Supabase's
	 * S3 endpoint requires, and the only difference anyone has to remember.
	 */
	private urlFor(key: string): { url: URL; path: string } {
		const base = new URL(this.settings.endpoint);
		const root = base.pathname.replace(/\/$/, "");
		const tail = `/${key
			.split("/")
			.map((part) => uriEncode(part))
			.join("/")}`;
		const host = this.settings.virtualHostStyle ? `${this.settings.bucket}.${base.host}` : base.host;
		const bucketPart = this.settings.virtualHostStyle ? "" : `/${this.settings.bucket}`;
		const path = `${root}${bucketPart}${tail}`;
		// The origin + encoded path form is what the request line carries, so the
		// signature and the URL can never disagree about escaping.
		return { url: new URL(`${base.protocol}//${host}${path}`), path };
	}

	private async request(
		key: string,
		method: string,
		options: {
			body?: BodyInit | null;
			headers?: Record<string, string>;
			payloadHash?: string;
			query?: [string, string][];
		} = {},
	): Promise<Response> {
		const { url, path } = this.urlFor(key);
		return this.send(url, path, method, options);
	}

	/** Bucket-level call: the path is the bucket root and the query does the work. */
	private async requestBucket(method: string, query: [string, string][]): Promise<Response> {
		const { url, path } = this.urlFor("");
		return this.send(url, path, method, { query });
	}

	private async send(
		url: URL,
		path: string,
		method: string,
		options: {
			body?: BodyInit | null;
			headers?: Record<string, string>;
			payloadHash?: string;
			query?: [string, string][];
		},
	): Promise<Response> {
		const query = options.query ?? [];
		const payloadHash = options.payloadHash ?? (options.body ? "UNSIGNED-PAYLOAD" : EMPTY_SHA256);
		const signed = await signV4({
			method,
			path,
			query,
			headers: { "x-amz-content-sha256": payloadHash, ...(options.headers ?? {}) },
			payloadHash,
			region: this.settings.region,
			service: "s3",
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
			host: url.host,
		});
		// The signed query is appended rather than rebuilt: whatever bytes went into
		// the signature are the bytes that must go on the wire.
		const target = new URL(url.toString());
		target.search = "";
		for (const [name, value] of query) target.searchParams.append(name, value);
		return this.fetchImpl(target, {
			method,
			headers: signed.headers,
			body: options.body,
			duplex: options.body ? "half" : undefined,
		} as RequestInit);
	}

	private headersFor(options: PutOptions): Record<string, string> {
		const headers: Record<string, string> = {};
		if (options.contentType) headers["Content-Type"] = options.contentType;
		if (options.filename) {
			const ascii = options.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
			headers["Content-Disposition"] =
				`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(options.filename)}`;
		}
		return headers;
	}

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<void> {
		const response = await this.request(key, "PUT", {
			body: value as BodyInit,
			headers: this.headersFor(options),
		});
		if (!response.ok) throw new Error(`s3_put_failed: ${response.status}`);
	}

	/** Streams a request body straight to the bucket; nothing is buffered here. */
	async putFromRequest(key: string, request: Request, options: PutOptions = {}): Promise<void> {
		if (!request.body) throw new Error("Request body is unavailable");
		const response = await this.request(key, "PUT", { body: request.body, headers: this.headersFor(options) });
		if (!response.ok) throw new Error(`s3_put_failed: ${response.status}`);
	}

	async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
		await this.put(key, bytes, { ...options, size: options.size ?? bytes.byteLength });
	}

	async get(key: string): Promise<BlobBody | null> {
		const response = await this.request(key, "GET");
		if (response.status === 404 || response.status === 403) return null;
		if (!response.ok || !response.body) throw new Error(`s3_get_failed: ${response.status}`);
		const length = response.headers.get("content-length");
		return {
			body: response.body,
			size: length ? Number.parseInt(length, 10) : -1,
			// B2 answers with a quoted ETag; R2 does too. Fall back to the key so the
			// conditional-request code always has something stable to compare.
			httpEtag: response.headers.get("etag") ?? `"${key}"`,
			contentType: response.headers.get("content-type") ?? undefined,
		};
	}

	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const failed: string[] = [];
		let deleted = 0;
		for (const key of keys) {
			try {
				// S3 answers 204 for a delete, and 404 for a key that is already gone;
				// both mean the object will not be there tomorrow.
				const response = await this.request(key, "DELETE");
				if (!response.ok && response.status !== 404) {
					failed.push(key);
					continue;
				}
				if (this.settings.purgeVersions) await this.deleteVersions(key);
				deleted += 1;
			} catch {
				failed.push(key);
			}
		}
		return { deleted, failed };
	}

	/**
	 * Delete every remaining version of one key.
	 *
	 * This is not paranoia, it is how a versioned bucket works: on Backblaze B2 a
	 * plain DELETE on a bucket set to "keep all versions" only *hides* the file, and
	 * the hidden version carries on costing storage forever. Expired pastes would
	 * therefore never actually leave the bucket, which is the opposite of what a
	 * self-destructing paste service promises. Delete markers go too — they are
	 * entries in the listing like any other.
	 */
	private async deleteVersions(key: string): Promise<number> {
		const listed = await this.requestBucket("GET", [
			["versions", ""],
			["prefix", key],
			["max-keys", "1000"],
		]);
		if (!listed.ok) return 0;
		const versions = versionsOf(await listed.text(), key);
		let removed = 0;
		for (const versionId of versions) {
			const response = await this.request(key, "DELETE", { query: [["versionId", versionId]] });
			if (response.ok || response.status === 404) removed += 1;
		}
		return removed;
	}

	/**
	 * One page of `key + last-modified`, for the orphan sweep. ListObjectsV2 is what
	 * every S3-compatible service here supports; the continuation token is handed
	 * straight back so the caller controls how deep a run goes.
	 */
	async list(
		prefix: string,
		token?: string,
	): Promise<{ keys: Array<{ key: string; lastModified: number }>; next: string | null }> {
		const query: [string, string][] = [
			["list-type", "2"],
			["prefix", prefix],
			["max-keys", "1000"],
		];
		if (token) query.push(["continuation-token", token]);
		const response = await this.requestBucket("GET", query);
		if (!response.ok) throw new Error(`s3_list_failed: ${response.status}`);
		const body = await response.text();
		return { keys: listingsOf(body), next: singleTag(body, "NextContinuationToken") };
	}

	/**
	 * A URL a visitor can fetch themselves. With a public base configured that is a
	 * plain link and the Worker is out of the data path entirely; without one it is a
	 * presigned GET, which keeps the bytes off this Worker but still spends the
	 * bucket's request budget. Callers must only use it for a paste that is safe to
	 * hand over: not burn-after-reading, not password-locked.
	 */
	async publicUrlFor(key: string, ttlSeconds = 3600): Promise<string | null> {
		const base = this.settings.publicBase;
		if (base)
			return `${base.replace(/\/$/, "")}/${key
				.split("/")
				.map((part) => uriEncode(part))
				.join("/")}`;

		const { url, path } = this.urlFor(key);
		const { date, datetime } = amzStamps();
		const scope = `${date}/${this.settings.region}/s3/aws4_request`;
		const query: [string, string][] = [
			["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
			["X-Amz-Credential", `${this.settings.accessKeyId}/${scope}`],
			["X-Amz-Date", datetime],
			["X-Amz-Expires", String(ttlSeconds)],
			["X-Amz-SignedHeaders", "host"],
		];
		const signed = await signV4({
			method: "GET",
			path,
			query,
			headers: {},
			payloadHash: "UNSIGNED-PAYLOAD",
			region: this.settings.region,
			service: "s3",
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
			host: url.host,
			mode: "query",
		});
		// Reusing the canonical query is not a shortcut, it is the requirement: the
		// signature covers those exact bytes, so the URL has to send them unchanged.
		return `${url.protocol}//${url.host}${path}?${signed.canonicalQuery}&X-Amz-Signature=${signed.signature}`;
	}
}

/**
 * Reads the `S3_*` variables. Returns null when the set is incomplete rather than
 * half-configuring a store: a missing secret at 03:00 during cleanup is a far worse
 * failure than a deploy that refuses to start with one clear message.
 */
/** Anything that reads as yes/on/1/true, because operators type all four. */
function readYes(value: string | undefined): boolean | undefined {
	const raw = value?.trim().toLowerCase();
	if (!raw) return undefined;
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function s3SettingsFromEnv(env: AppEnv): S3Settings | null {
	const endpoint = env.S3_ENDPOINT?.trim();
	const bucket = env.S3_BUCKET?.trim();
	const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
	return {
		endpoint,
		bucket,
		accessKeyId,
		secretAccessKey,
		region: env.S3_REGION?.trim() || "auto",
		publicBase: env.S3_PUBLIC_BASE?.trim() || undefined,
		prefix: env.S3_PREFIX?.trim() || "pp/v1",
		virtualHostStyle: readYes(env.S3_VIRTUAL_HOST_STYLE),
		purgeVersions: (env.S3_PURGE_VERSIONS?.trim().toLowerCase() ?? "on") !== "off",
	};
}

export function s3StoreFromEnv(env: AppEnv): S3ObjectStore | null {
	const settings = s3SettingsFromEnv(env);
	return settings ? new S3ObjectStore(settings) : null;
}
