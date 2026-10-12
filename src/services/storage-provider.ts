import type { AppEnv } from "../env";
import type { BlobBody, BlobStore, ObjectKind, PutOptions } from "./object-store";
import { KVObjectStore, ObjectStore } from "./object-store";
import { s3StoreFromEnv } from "./s3-store";

/**
 * One place decides where bytes live.
 *
 * Metadata stays in D1 (with an optional live Supabase mirror: see
 * ./supabase-store); only blobs are pluggable here, so the cleanup job, the burn
 * claim and every read path keep working the same way under any provider below.
 */
export type StorageProvider = "r2" | "s3" | "kv";

export interface ResolvedStorage {
	provider: StorageProvider;
	objects: BlobStore;
	/** Human-readable reason, surfaced by `GET /api/config` and the deploy notes. */
	reason: string;
	/** The chosen store before any read-through wrapper: the one that can list a bucket. */
	primary: BlobStore;
	/**
	 * The read-through store, when one is in play: blobs written before this backend
	 * existed still live there, and old links have to keep working.
	 */
	fallback?: StorageProvider;
}

/**
 * Wraps the chosen store with a second one that is only ever read.
 *
 * Moving blobs from KV to a bucket is a config change, and the day you make it every
 * file already stored is in the wrong place. Rather than declare those links dead,
 * the old binding stays in the read path until the sweep has deleted each row's
 * object from both. Deletes go to both on purpose: that is what drains it.
 */
export class ReadThroughStore implements BlobStore {
	readonly hits = { count: 0 };

	constructor(
		private readonly primary: BlobStore,
		private readonly legacy: BlobStore,
	) {}

	keyFor(id: string, kind: ObjectKind): string {
		return this.primary.keyFor(id, kind);
	}

	put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string, options?: PutOptions): Promise<void> {
		return this.primary.put(key, value, options);
	}

	putFromRequest(key: string, request: Request, options?: PutOptions): Promise<void> {
		return this.primary.putFromRequest(key, request, options);
	}

	putBytes(key: string, bytes: Uint8Array, options?: PutOptions): Promise<void> {
		return this.primary.putBytes(key, bytes, options);
	}

	async get(key: string): Promise<BlobBody | null> {
		const found = await this.primary.get(key);
		if (found) return found;
		const legacyBody = await this.legacy.get(key);
		if (legacyBody) this.hits.count += 1;
		return legacyBody;
	}

	/** Both, so a key cannot survive in the retired store. */
	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const [primary, legacy] = await Promise.all([this.primary.delete(keys), this.legacy.delete(keys)]);
		const failed = new Set([...primary.failed, ...legacy.failed]);
		return { deleted: Math.max(primary.deleted, legacy.deleted), failed: [...failed] };
	}

	publicUrlFor(key: string): Promise<string | null> {
		// A link the visitor can fetch on their own only exists for bytes the current
		// store holds; a read-through object is on its way out and stays proxied.
		return this.primary.publicUrlFor?.(key) ?? Promise.resolve(null);
	}
}

const fallbacks: Record<StorageProvider, (env: AppEnv) => { provider: StorageProvider; store: BlobStore } | null> = {
	r2: (env) => (env.BLOBS ? { provider: "kv", store: new KVObjectStore(env.BLOBS) } : null),
	kv: (env) => (env.BUCKET ? { provider: "r2", store: new ObjectStore(env.BUCKET) } : null),
	s3: (env) => (env.BLOBS ? { provider: "kv", store: new KVObjectStore(env.BLOBS) } : null),
};

interface Candidate {
	provider: StorageProvider;
	label: string;
	bind(env: AppEnv): BlobStore | null;
}

/** Ordered by what an existing deployment is most likely to already have. */
const candidates: Candidate[] = [
	{
		provider: "r2",
		label: "R2 bucket bound as BUCKET",
		bind: (env) => (env.BUCKET ? new ObjectStore(env.BUCKET) : null),
	},
	{
		provider: "s3",
		label: "S3-compatible endpoint (S3_ENDPOINT + S3_BUCKET + keys)",
		bind: (env) => s3StoreFromEnv(env),
	},
	{
		provider: "kv",
		label: "KV namespace bound as BLOBS",
		bind: (env) => (env.BLOBS ? new KVObjectStore(env.BLOBS) : null),
	},
];

export function resolveStorage(env: AppEnv): ResolvedStorage {
	const wanted = env.STORAGE_PROVIDER?.trim().toLowerCase();

	if (wanted && wanted !== "auto") {
		const match = candidates.find((entry) => entry.provider === wanted);
		if (!match) {
			const names = candidates.map((entry) => entry.provider).join(", ");
			throw new Error(`STORAGE_PROVIDER="${wanted}" is not a storage backend. Expected one of: ${names}, or "auto".`);
		}
		const objects = match.bind(env);
		if (!objects) {
			throw new Error(`STORAGE_PROVIDER="${match.provider}" is pinned but not configured: it needs ${match.label}.`);
		}
		return withFallback(env, {
			provider: match.provider,
			objects,
			primary: objects,
			reason: `pinned by STORAGE_PROVIDER (${match.label})`,
		});
	}

	for (const entry of candidates) {
		const objects = entry.bind(env);
		if (objects) return withFallback(env, { provider: entry.provider, objects, primary: objects, reason: entry.label });
	}

	throw new Error(
		"No blob storage is configured. Bind an R2 bucket (BUCKET) or a KV namespace (BLOBS), or set the S3_* variables.",
	);
}

/**
 * `STORAGE_FALLBACK` chooses the retired store: `kv`, `r2` or `off`. Default `auto`,
 * which means "whatever other binding is still there" — the safe reading during a
 * migration, and a no-op once the old store has drained.
 *
 * Exported because the interesting part of it — read the old place, delete both —
 * deserves a test with two fakes in it rather than a live KV namespace.
 */
function withFallback(env: AppEnv, resolved: ResolvedStorage): ResolvedStorage {
	const wanted = env.STORAGE_FALLBACK?.trim().toLowerCase() || "auto";
	if (wanted === "off") return resolved;
	const candidate = fallbacks[resolved.provider]?.(env);
	if (!candidate) return resolved;
	if (wanted !== "auto" && wanted !== candidate.provider) return resolved;
	return {
		...resolved,
		objects: new ReadThroughStore(resolved.objects, candidate.store),
		primary: resolved.objects,
		fallback: candidate.provider,
		reason: `${resolved.reason}, reading through ${candidate.provider} for objects written before it`,
	};
}
