import { fail } from "../lib/errors";

/** Workers KV refuses values above 25 MiB; the buffered put enforces it up front. */
export const KV_MAX_VALUE_BYTES = 25 * 1024 * 1024;

export type ObjectKind = "text" | "file" | "blob";

export interface PutOptions {
	size?: number;
	contentType?: string;
	filename?: string;
}

/**
 * The normalised view of a stored body returned by either backend.
 *
 * Callers need the stream, the byte size and a stable etag; the display
 * metadata rides along, but the D1 row stays the authoritative source for
 * content type and filename.
 */
export interface BlobBody {
	body: ReadableStream;
	size: number;
	httpEtag: string;
	contentType?: string;
	filename?: string;
}

/**
 * The blob-storage contract shared by both backends:
 *
 *  - `ObjectStore`    — R2, the upstream default. Strongly consistent reads.
 *  - `KVObjectStore`  — Workers KV, for accounts that cannot enable R2
 *                       (R2 activation requires a payment method even for
 *                       free-tier usage; KV needs none).
 *
 * `./storage-provider` decides which of these is live (R2, an S3-compatible
 * bucket, Firebase Storage, KV), so switching is configuration, not a code edit.
 * The R2 and KV shapes below stay the ones every other backend is modelled on.
 */
export interface BlobStore {
	keyFor(id: string, kind: ObjectKind): string;
	put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: PutOptions): Promise<void>;
	putFromRequest(key: string, request: Request, options?: PutOptions): Promise<void>;
	putBytes(key: string, bytes: Uint8Array, options?: PutOptions): Promise<void>;
	get(key: string): Promise<BlobBody | null>;
	delete(keys: string[]): Promise<{ deleted: number; failed: string[] }>;
	/**
	 * An optional link the visitor's browser can fetch by itself, bypassing this
	 * Worker. Present on the S3-compatible and Firebase stores when the operator
	 * configures a public bucket base (or, for S3, when presigned links are the
	 * only option). R2 and KV return null: their reads already cost nothing extra.
	 */
	publicUrlFor?(key: string): Promise<string | null>;
}

/**
 * Thin wrapper around R2.
 *
 * Object keys are derived only from the validated paste id and a storage kind —
 * never from a visitor-supplied filename or media type. The original display name
 * is kept as object metadata and in D1 instead.
 */
export class ObjectStore implements BlobStore {
	constructor(
		private readonly bucket: R2Bucket,
		private readonly prefix = "pp/v1",
	) {}

	keyFor(id: string, kind: ObjectKind): string {
		return `${this.prefix}/${kind}/${id}`;
	}

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<void> {
		const httpMetadata: R2HTTPMetadata = {};
		if (options.contentType) httpMetadata.contentType = options.contentType;
		if (options.filename)
			httpMetadata.contentDisposition = `attachment; filename="${encodeURIComponent(options.filename)}"`;

		await this.bucket.put(key, value, {
			httpMetadata,
			customMetadata: options.filename ? { filename: options.filename } : undefined,
		});
	}

	/** Streams a request body straight into R2 without buffering it in the isolate. */
	async putFromRequest(key: string, request: Request, options: PutOptions = {}): Promise<void> {
		if (!request.body) throw new Error("Request body is unavailable");
		if (!options.size || options.size < 0) throw new Error("A known size is required to stream an upload");

		const { readable, writable } = new FixedLengthStream(options.size);
		// Start the upload and the pipe together so neither side blocks the other.
		const upload = this.bucket.put(key, readable, {
			httpMetadata: options.contentType ? { contentType: options.contentType } : undefined,
			customMetadata: options.filename ? { filename: options.filename } : undefined,
		});
		await request.body.pipeTo(writable);
		await upload;
	}

	async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
		await this.put(key, bytes, options);
	}

	async get(key: string): Promise<BlobBody | null> {
		const object = await this.bucket.get(key);
		if (!object || !("body" in object) || !object.body) return null;
		return {
			body: object.body,
			size: object.size,
			httpEtag: object.httpEtag,
			contentType: object.httpMetadata?.contentType ?? undefined,
			filename: object.customMetadata?.filename,
		};
	}

	async head(key: string): Promise<R2Object | null> {
		return this.bucket.head(key);
	}

	/** Idempotent: deleting a key that is already gone is not an error. */
	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const failed: string[] = [];
		let deleted = 0;
		// R2 accepts up to 1000 keys per call.
		for (let index = 0; index < keys.length; index += 1000) {
			const slice = keys.slice(index, index + 1000);
			if (slice.length === 0) continue;
			try {
				await this.bucket.delete(slice);
				deleted += slice.length;
			} catch {
				for (const key of slice) {
					try {
						await this.bucket.delete(key);
						deleted += 1;
					} catch {
						failed.push(key);
					}
				}
			}
		}
		return { deleted, failed };
	}
}

/** What is stored alongside each KV value. KV metadata is capped at 1 KiB. */
interface KVBlobMetadata {
	size: number;
	etag: string;
	contentType?: string;
	filename?: string;
}

/**
 * Workers KV backend — the same contract as the R2 store, for accounts that
 * cannot enable R2.
 *
 * Differences from R2, all absorbed here:
 *
 *  - KV is eventually consistent: a new value reaches every edge location
 *    within about a minute, so a large paste opened from a distant colo
 *    moments after creation can briefly report its body as missing. Small
 *    text pastes are unaffected — they live in the D1 row, not here.
 *  - KV has no HEAD and no native etag: the byte size and a per-object etag
 *    are stored as value metadata (filenames are truncated to stay inside
 *    the 1 KiB budget; D1 keeps the authoritative copy).
 *  - KV has no bulk delete: keys are removed one at a time. The sweep is
 *    already bounded to `CLEANUP_BATCH_SIZE` rows per pass, which keeps this
 *    inside the free tier's 1,000 deletes/day for personal-scale traffic.
 *
 * Free tier: 1 GB storage, 100k reads/day, 1k writes/deletes/lists per day,
 * 25 MiB maximum value size — which matches FILE_MAX_BYTES exactly.
 */
export class KVObjectStore implements BlobStore {
	constructor(
		private readonly kv: KVNamespace,
		private readonly prefix = "pp/v1",
	) {}

	keyFor(id: string, kind: ObjectKind): string {
		return `${this.prefix}/${kind}/${id}`;
	}

	private static byteSize(value: ArrayBuffer | Uint8Array | string): number {
		if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
		return value.byteLength;
	}

	private metadataFor(options: PutOptions, size: number): KVBlobMetadata {
		const metadata: KVBlobMetadata = { size, etag: `"${crypto.randomUUID()}"` };
		if (options.contentType) metadata.contentType = options.contentType;
		if (options.filename) metadata.filename = options.filename.slice(0, 200);
		return metadata;
	}

	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<void> {
		const size = options.size ?? (value instanceof ReadableStream ? -1 : KVObjectStore.byteSize(value));
		// The streaming path is bounded by FixedLengthStream; the buffered one needs
		// its own stop, or an oversized upload fails inside KV after the metadata row
		// is already written, leaving a row that points at nothing.
		if (size > KV_MAX_VALUE_BYTES) {
			throw fail.tooLarge(`${Math.floor(KV_MAX_VALUE_BYTES / 1024 / 1024)} MiB (the KV value limit)`);
		}
		await this.kv.put(key, value, { metadata: this.metadataFor(options, size) });
	}

	/** Streams a request body straight into KV without buffering it in the isolate. */
	async putFromRequest(key: string, request: Request, options: PutOptions = {}): Promise<void> {
		if (!request.body) throw new Error("Request body is unavailable");
		if (!options.size || options.size < 0) throw new Error("A known size is required to stream an upload");

		const { readable, writable } = new FixedLengthStream(options.size);
		const upload = this.kv.put(key, readable, { metadata: this.metadataFor(options, options.size) });
		await request.body.pipeTo(writable);
		await upload;
	}

	async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
		await this.put(key, bytes, { ...options, size: options.size ?? bytes.byteLength });
	}

	async get(key: string): Promise<BlobBody | null> {
		const result = await this.kv.getWithMetadata<KVBlobMetadata>(key, { type: "stream" });
		if (!result.value) return null;
		const meta = result.metadata;
		return {
			body: result.value,
			// -1 keeps the routes' `if (size)` guard from sending a bogus Content-Length.
			size: meta?.size ?? -1,
			httpEtag: meta?.etag ?? `"${key}"`,
			contentType: meta?.contentType,
			filename: meta?.filename,
		};
	}

	/** Idempotent: deleting a key that is already gone is not an error. */
	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const failed: string[] = [];
		let deleted = 0;
		// KV has no bulk delete; each key is its own operation.
		for (const key of keys) {
			try {
				await this.kv.delete(key);
				deleted += 1;
			} catch {
				failed.push(key);
			}
		}
		return { deleted, failed };
	}
}
