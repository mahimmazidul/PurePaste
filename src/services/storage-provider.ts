import type { AppEnv } from "../env";
import type { BlobStore } from "./object-store";
import { KVObjectStore, ObjectStore } from "./object-store";
import { firebaseStoreFromEnv } from "./firebase-store";
import { s3StoreFromEnv } from "./s3-store";

/**
 * One place decides where bytes live.
 *
 * Metadata always stays in D1 — that is the database of record for text, options
 * and counters, whatever holds the file bodies. Only blobs are pluggable, so the
 * cleanup job, the burn claim and every read path keep working the same way under
 * any provider below.
 */
export type StorageProvider = "r2" | "s3" | "firebase" | "kv";

export interface ResolvedStorage {
	provider: StorageProvider;
	objects: BlobStore;
	/** Human-readable reason, surfaced by `GET /api/storage` and the deploy notes. */
	reason: string;
}

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
		provider: "firebase",
		label: "Firebase Storage service account (FIREBASE_*)",
		bind: (env) => firebaseStoreFromEnv(env),
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
		return { provider: match.provider, objects, reason: `pinned by STORAGE_PROVIDER (${match.label})` };
	}

	for (const entry of candidates) {
		const objects = entry.bind(env);
		if (objects) return { provider: entry.provider, objects, reason: entry.label };
	}

	throw new Error(
		"No blob storage is configured. Bind an R2 bucket (BUCKET) or a KV namespace (BLOBS), or set the S3_* variables.",
	);
}
