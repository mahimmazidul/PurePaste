import type { AppEnv } from "../env";
import type { BlobBody, BlobStore, ObjectKind, PutOptions } from "./object-store";
import type { Deferrer } from "./paste-store";
import { KV_MAX_VALUE_BYTES, KVObjectStore, ObjectStore } from "./object-store";
import { s3StoreFromEnv } from "./s3-store";

/**
 * One place decides where bytes live — and for the blob stores, that is a *pool*
 * rather than a winner.
 *
 * Rows (metadata, options, counters, expiry) always live in D1, with an optional
 * Supabase copy for reads when D1 is unavailable: see ./paste-store and
 * ./supabase-store. Only bodies are pooled here, so the burn claim, every read path
 * and the cleanup sweep keep working the same way whatever the pool is made of.
 */
export type StorageProvider = "r2" | "s3" | "kv";

/** What the namespace is for, once a bucket is in charge of the bytes. */
export type KvRole = "off" | "share" | "cache";

export interface PoolPolicy {
	/** Largest body KV will accept at all — a value over it is refused by KV itself. */
	kvMaxBytes: number;
	/**
	 * `share` puts small bodies in KV instead of the bucket; `cache` leaves every
	 * body in the bucket and copies the ones people actually read into KV, where the
	 * next read is served from an edge near them; `off` uses no namespace at all.
	 * `auto` is decided by what the instance has bound, in `resolveStorage`.
	 */
	kvRole: KvRole | "auto";
	/** `share`: largest body worth routing to KV at write time. */
	kvShareMaxBytes: number;
	/** `cache`: largest body worth copying into KV on a read, and how long it lives. */
	kvCacheMaxBytes: number;
	kvCacheTtlSeconds: number;
	/** KV writes in one UTC day before the bucket absorbs the rest. */
	kvWritesPerDay: number;
	/** Consecutive write failures that park a store… */
	failureThreshold: number;
	/** …and how long it stays parked before a write is tried there again. */
	parkMs: number;
}

export const DEFAULT_POLICY: PoolPolicy = {
	kvMaxBytes: KV_MAX_VALUE_BYTES,
	kvRole: "share",
	kvShareMaxBytes: 256 * 1024,
	kvCacheMaxBytes: 4 * 1024 * 1024,
	kvCacheTtlSeconds: 60 * 60 * 24 * 3,
	kvWritesPerDay: 600,
	failureThreshold: 3,
	parkMs: 10 * 60 * 1000,
};

/**
 * The policy, from `BLOB_*` variables.
 *
 * Clamped rather than trusted, the same way `src/config.ts` treats everything else:
 * `BLOB_KV_WRITES_PER_DAY=100000` would point an instance at the day KV starts
 * refusing writes, and a number that can only be wrong is not a setting.
 */
export function poolPolicyFromEnv(env: AppEnv): PoolPolicy {
	// The role's default depends on what is bound, which `resolveStorage` knows and
	// this function does not: `auto` means "cache" the moment a bucket takes over the
	// writing, and "share" while KV is the only store there is.
	const clamp = (value: string | undefined, fallback: number, min: number, max: number): number => {
		const parsed = Number.parseInt((value ?? "").trim(), 10);
		if (!Number.isFinite(parsed) || parsed < 0) return fallback;
		return Math.min(max, Math.max(min, parsed));
	};
	const share = clamp(env.BLOB_KV_SHARE_MAX_BYTES, DEFAULT_POLICY.kvShareMaxBytes, 0, KV_MAX_VALUE_BYTES);
	const role = (env.BLOB_KV?.trim().toLowerCase() || "auto") as string;
	return {
		kvMaxBytes: KV_MAX_VALUE_BYTES,
		kvRole: role === "off" || role === "share" || role === "cache" ? (role as KvRole) : "auto",
		kvShareMaxBytes: env.BLOBS ? share : 0,
		kvCacheMaxBytes: clamp(env.BLOB_KV_CACHE_MAX_BYTES, DEFAULT_POLICY.kvCacheMaxBytes, 0, KV_MAX_VALUE_BYTES),
		kvCacheTtlSeconds: clamp(env.BLOB_KV_CACHE_TTL_SECONDS, DEFAULT_POLICY.kvCacheTtlSeconds, 60, 60 * 60 * 24 * 30),
		kvWritesPerDay: clamp(env.BLOB_KV_WRITES_PER_DAY, DEFAULT_POLICY.kvWritesPerDay, 0, 1000),
		failureThreshold: DEFAULT_POLICY.failureThreshold,
		parkMs: DEFAULT_POLICY.parkMs,
	};
}

export interface PoolMember {
	provider: StorageProvider;
	label: string;
	store: BlobStore;
	/** Read-only members exist so old links keep working while their store drains. */
	readOnly: boolean;
	writes: number;
	writeFailures: number;
	/** Hits served by anyone other than the store the row points at. */
	fallbackReads: number;
	consecutive: number;
	parkedUntil: number;
	/** The last failure, for `/api/config`. Never a stack trace. */
	lastError: string | null;
}

interface Placement {
	member: PoolMember;
	key: string;
}

function writable(member: PoolMember): boolean {
	return !member.readOnly && member.parkedUntil <= Date.now();
}

/**
 * The blob layer as one object with several places behind it.
 *
 * Reads go to the store the row names, then to the others: a paste whose row predates
 * a store, or whose row was written while the placement was still unknown, is still
 * found. Writes pick one store — never all of them, because two copies of a body
 * means two things to delete and two things that can disagree. Deletes always hit
 * every store, which is what makes the hourly sweep the whole retention story:
 * nothing in this design needs someone to remember which bucket a file went into.
 */
export class BlobPool implements BlobStore {
	/** KV writes in the current UTC day. Per isolate, and deliberately approximate. */
	private kvDay = "";
	private kvWritesToday = 0;
	private cacheHits = 0;
	private cacheFills = 0;
	private cacheFailures = 0;
	private readonly members: PoolMember[];
	private readonly policy: PoolPolicy;

	/** The role as decided; `auto` is resolved by `resolveStorage`, never left here. */
	private readonly role: KvRole;

	constructor(members: PoolMember[], policy: PoolPolicy = DEFAULT_POLICY) {
		if (members.length === 0) throw new Error("BlobPool needs at least one store");
		this.members = members;
		this.policy = policy;
		this.role = policy.kvRole === "auto" ? "share" : policy.kvRole;
	}

	get providers(): StorageProvider[] {
		return this.members.map((member) => member.provider);
	}

	/** Everything the operator may want to know, and nothing sensitive. */
	status(): Array<{
		provider: StorageProvider;
		label: string;
		role: "write" | "read-only";
		writes: number;
		write_failures: number;
		fallback_reads: number;
		parked: boolean;
		last_error: string | null;
	}> {
		const now = Date.now();
		return this.members.map((member) => ({
			provider: member.provider,
			label: member.label,
			role: member.readOnly ? ("read-only" as const) : ("write" as const),
			writes: member.writes,
			write_failures: member.writeFailures,
			fallback_reads: member.fallbackReads,
			parked: !member.readOnly && member.parkedUntil > now,
			last_error: member.lastError,
		}));
	}

	/** Bodies this pool would put in KV, and how many are left in it today. */
	share(): {
		kv_role: string;
		kv_share_bytes: number;
		kv_cache_bytes: number;
		kv_writes_today: number;
		kv_writes_left: number;
		cache_hits: number;
		cache_fills: number;
		cache_failures: number;
	} {
		return {
			kv_role: this.role,
			kv_share_bytes: this.role === "share" ? this.policy.kvShareMaxBytes : 0,
			kv_cache_bytes: this.role === "cache" ? this.policy.kvCacheMaxBytes : 0,
			kv_writes_today: this.kvWritesToday,
			kv_writes_left: Math.max(0, this.policy.kvWritesPerDay - this.kvWritesToday),
			cache_hits: this.cacheHits,
			cache_fills: this.cacheFills,
			cache_failures: this.cacheFailures,
		};
	}

	/**
	 * Keys are the same string in every store (`pp/v1/<kind>/<id>`), which is what
	 * lets a row hold one `object_key` and a read still find the body when the store
	 * it names is not the one that has it. `keyFor` answers from the first writable
	 * member; `place` is what actually decides, and it returns the store it used.
	 */
	keyFor(id: string, kind: ObjectKind): string {
		const member = this.members.find(writable) ?? this.members[0];
		return member?.store.keyFor(id, kind) ?? "";
	}

	/**
	 * Order the stores are tried in, for a body of this size.
	 *
	 * The KV share exists because a namespace's free tier is a bucket of operations
	 * rather than bytes: small bodies are the ones read most and the cheapest to keep
	 * there, while the 1k-write day is what bounds it — so the share has a size limit
	 * and a daily count, and everything else goes to the bucket without being asked.
	 */
	private order(size: number, prefer?: StorageProvider | null): PoolMember[] {
		const ranked = [...this.members].sort((a, b) => {
			const score = (member: PoolMember): number => {
				if (prefer && member.provider === prefer) return 0;
				if (!writable(member)) return member.readOnly ? 3 : 4;
				return member.provider === "kv" ? (this.prefersKv(size) ? 1 : 3) : 2;
			};
			return score(a) - score(b);
		});
		return ranked;
	}

	private prefersKv(size: number): boolean {
		// In `cache` mode the namespace never takes a body at write time: the bucket is
		// the origin, so an upload is available the instant its row exists, and a copy
		// in KV only ever appears once somebody reads it.
		if (this.role !== "share") return false;
		if (this.policy.kvShareMaxBytes <= 0) return false;
		if (size < 0 || size > Math.min(this.policy.kvMaxBytes, this.policy.kvShareMaxBytes)) return false;
		return this.kvBudgetLeft() > 0;
	}

	private kvBudgetLeft(): number {
		this.rollDay();
		return this.policy.kvWritesPerDay - this.kvWritesToday;
	}

	private rollDay(now = Date.now()): void {
		const day = new Date(now).toISOString().slice(0, 10);
		if (day !== this.kvDay) {
			this.kvDay = day;
			this.kvWritesToday = 0;
		}
	}

	/**
	 * Write a body and say where it went.
	 *
	 * A store that fails is tried once and then skipped for a while, so a namespace
	 * over its daily write budget or a bucket answering 5xx costs one retried write
	 * instead of one failed upload per visitor. Streams are the exception: a body can
	 * only be read once, so a streamed upload is committed to whichever store it
	 * started in and its failure is the visitor's to retry.
	 */
	async place(
		kind: ObjectKind,
		id: string,
		value: ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<Placement> {
		const size =
			options.size ?? (typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength);
		let lastError: unknown = null;
		let reservedKv = false;

		for (const member of this.order(size)) {
			if (!writable(member)) continue;
			const key = member.store.keyFor(id, kind);
			if (member.provider === "kv") {
				this.rollDay();
				this.kvWritesToday += 1;
				reservedKv = true;
			}
			try {
				await member.store.putBytes(key, toBytes(value), { ...options, size });
				member.writes += 1;
				member.consecutive = 0;
				member.parkedUntil = 0;
				return { member, key };
			} catch (error) {
				if (reservedKv) {
					this.kvWritesToday = Math.max(0, this.kvWritesToday - 1);
					reservedKv = false;
				}
				lastError = error;
				this.recordFailure(member, error);
			}
		}

		throw lastError ?? new Error("No writable blob store");
	}

	private recordFailure(member: PoolMember, error: unknown): void {
		member.writeFailures += 1;
		member.consecutive += 1;
		member.lastError = error instanceof Error ? error.message : String(error);
		if (member.consecutive >= this.policy.failureThreshold) {
			member.parkedUntil = Date.now() + this.policy.parkMs;
			console.warn(`blob store ${member.provider} parked for ${Math.round(this.policy.parkMs / 60000)} min`, {
				consecutive: member.consecutive,
				lastError: member.lastError,
			});
		}
	}

	/**
	 * Read, in the order the row makes sense.
	 *
	 * `preferred` is the store the row recorded. A miss there is not a 404 yet — the
	 * other stores are asked, because a body written before this pool existed, or
	 * restored from a bucket copy, has a row that may not know where it lives.
	 */
	async get(key: string, preferred?: StorageProvider | null): Promise<BlobBody | null> {
		return this.read(key, preferred);
	}

	/**
	 * Read, and copy the answer into the namespace when the policy says to cache.
	 *
	 * Three things this has to get right at once: a miss in the store the row names is
	 * not a 404, because the row may be older than the pool or its cached copy may have
	 * been evicted; the copy handed to the visitor is never the one written to KV, so a
	 * client that hangs up cannot leave half a file behind (`FixedLengthStream` is what
	 * makes a truncated fill fail rather than succeed badly); and the stamp on the row is
	 * the *last* step, so a fill that never happened can never be pointed at.
	 */
	async read(
		key: string,
		preferred?: StorageProvider | null,
		hooks: { defer?: Deferrer; stamp?: (provider: StorageProvider) => Promise<void> } = {},
	): Promise<BlobBody | null> {
		const order = this.order(-1, preferred);
		for (let index = 0; index < order.length; index += 1) {
			const member = order[index]!;
			const found = await member.store.get(key).catch(() => null);
			if (!found) continue;
			// Somebody other than the store the row names answered: worth counting,
			// because a rising number there means rows and bytes have drifted apart.
			if (index > 0) member.fallbackReads += 1;
			if (member.provider === "kv") {
				this.cacheHits += 1;
				return found;
			}
			const fill = this.cacheFill(key, found);
			if (!fill) return found;
			if (!hooks.defer) {
				// No execution context means no background work: a promise left running
				// after the response is a half-written cache entry, so skip the copy.
				return found;
			}
			const [served, copy] = found.body.tee();
			hooks.defer.waitUntil(
				fill(copy)
					.then(() => hooks.stamp?.("kv"))
					.catch(() => undefined),
			);
			return { ...found, body: served };
		}
		return null;
	}

	/**
	 * The write half of a cache fill, or null when this body should not be cached.
	 *
	 * It is a function of the copy stream rather than an immediate write because the
	 * caller has to decide whether there is anywhere to put the promise. The bytes are
	 * collected before anything is written, which costs a little memory and buys two
	 * things worth more: a visitor who hangs up mid-download leaves nothing behind (the
	 * copy ends short of the declared size, so the write is skipped), and a fill never
	 * depends on piping one stream into another.
	 */
	private cacheFill(key: string, body: BlobBody): ((copy: ReadableStream) => Promise<void>) | null {
		if (this.role !== "cache" || this.policy.kvCacheMaxBytes <= 0) return null;
		if (body.size <= 0 || body.size > Math.min(this.policy.kvMaxBytes, this.policy.kvCacheMaxBytes)) return null;
		this.rollDay();
		if (this.kvWritesToday >= this.policy.kvWritesPerDay) return null;
		if (this.activeFills >= BlobPool.MAX_CONCURRENT_FILLS) return null;
		const target = this.members.find((member) => member.provider === "kv" && !member.readOnly);
		if (!target || target.parkedUntil > Date.now()) return null;

		const expected = body.size;
		return async (copy: ReadableStream): Promise<void> => {
			this.activeFills += 1;
			try {
				const reader = copy.getReader();
				const chunks: Uint8Array[] = [];
				let total = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					if (!value) continue;
					chunks.push(value);
					total += value.byteLength;
					// More than the object claimed to be is a stream nobody should trust.
					if (total > expected) return;
				}
				if (total !== expected) return;

				// One identity, both places: the copy carries the etag the origin answered
				// with, so a visitor who revalidates gets a 304 instead of a second download.
				const bytes = new Uint8Array(expected);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				await target.store.putBytes(key, bytes, {
					size: expected,
					contentType: body.contentType,
					filename: body.filename,
					etag: body.httpEtag,
					ttlSeconds: this.policy.kvCacheTtlSeconds,
				});
				this.rollDay();
				this.kvWritesToday += 1;
				this.cacheFills += 1;
				target.writes += 1;
				target.consecutive = 0;
				target.parkedUntil = 0;
			} catch (error) {
				// A cache that cannot be written is a slower read, not a broken one.
				this.cacheFailures += 1;
				this.recordFailure(target, error);
			} finally {
				this.activeFills -= 1;
			}
		};
	}

	/** Two at a time, because each one holds a body in memory. */
	private static readonly MAX_CONCURRENT_FILLS = 2;

	private activeFills = 0;

	/** Everything, always. An object that survives in one store is an object nobody deletes. */
	async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
		const results = await Promise.all(
			this.members.map(async (member) => {
				try {
					return await member.store.delete(keys);
				} catch (error) {
					member.lastError = error instanceof Error ? error.message : String(error);
					return { deleted: 0, failed: [...keys] };
				}
			}),
		);
		const failed = new Set<string>();
		let best = 0;
		for (const result of results) {
			best = Math.max(best, result.deleted);
			for (const key of result.failed) failed.add(key);
		}
		return { deleted: best, failed: [...failed] };
	}

	/** Plain put, for callers that already hold a key and do not care where it lands. */
	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | Uint8Array | string,
		options: PutOptions = {},
	): Promise<void> {
		const [member] = this.order(options.size ?? -1);
		if (!member) throw new Error("No writable blob store");
		if (value instanceof ReadableStream) await member.store.put(key, value, options);
		else await member.store.putBytes(key, toBytes(value), options);
		member.writes += 1;
	}

	async putBytes(key: string, bytes: Uint8Array, options: PutOptions = {}): Promise<void> {
		await this.place(kindFromKey(key), idFromKey(key), bytes, options);
	}

	async putFromRequest(key: string, request: Request, options: PutOptions = {}): Promise<void> {
		const member = this.order(options.size ?? -1)[0];
		if (!member) throw new Error("No writable blob store");
		await member.store.putFromRequest(key, request, options);
		member.writes += 1;
	}

	/**
	 * A link a visitor can fetch themselves, and only for a body the row says which
	 * store holds.
	 *
	 * A presigned URL for a key that turns out to live in the other store is a link to
	 * a 404, which is worse than no link at all — so an unknown placement (every row
	 * written before this pool existed, and every inline paste) is proxied through the
	 * Worker instead. A read-only member never gets asked either: its objects are on
	 * their way out, and the bytes should keep coming from wherever the row says.
	 */
	async publicUrlFor(key: string, preferred?: StorageProvider | null): Promise<string | null> {
		if (!preferred) return null;
		const member = this.members.find((entry) => entry.provider === preferred);
		if (!member || member.readOnly || !member.store.publicUrlFor) return null;
		return (await member.store.publicUrlFor(key).catch(() => null)) ?? null;
	}

	/** The stores an orphan pass should walk, with the prefix each one lists. */
	listables(): Array<{ provider: StorageProvider; store: BlobStore; prefix: string }> {
		return this.members
			.filter((member) => typeof member.store.list === "function" && typeof member.store.objectPrefix === "function")
			.map((member) => ({ provider: member.provider, store: member.store, prefix: member.store.objectPrefix!() }));
	}
}

function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof Uint8Array) return value;
	return new Uint8Array(value);
}

/** Keys are `<prefix>/<kind>/<id>`, so the last two segments name the body. */
function kindFromKey(key: string): ObjectKind {
	const kind = key.split("/").at(-2) ?? "";
	return kind === "file" || kind === "text" || kind === "blob" ? kind : "blob";
}

function idFromKey(key: string): string {
	return key.split("/").at(-1) ?? key;
}

export interface ResolvedStorage {
	/** The store new bodies go to when no share rule applies. */
	provider: StorageProvider;
	/** Every store in play, in the order they were bound. */
	providers: StorageProvider[];
	objects: BlobPool;
	reason: string;
	/** `pool` means more than one store takes writes. */
	mode: "pool" | "single";
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
		label: "S3-compatible bucket (S3_ENDPOINT + S3_BUCKET + keys)",
		bind: (env) => s3StoreFromEnv(env),
	},
	{
		provider: "kv",
		label: "KV namespace bound as BLOBS",
		bind: (env) => (env.BLOBS ? new KVObjectStore(env.BLOBS) : null),
	},
];

/** Whether a namespace is among the stores that take writes. */
function kvWrites(writers: Array<{ candidate: Candidate }>): boolean {
	return writers.some((entry) => entry.candidate.provider === "kv");
}

/** One store in the pool, counters at zero. Exported so tests build it the same way. */
export function poolMember(provider: StorageProvider, label: string, store: BlobStore, readOnly = false): PoolMember {
	return {
		provider,
		label,
		store,
		readOnly,
		writes: 0,
		writeFailures: 0,
		fallbackReads: 0,
		consecutive: 0,
		parkedUntil: 0,
		lastError: null,
	};
}

/**
 * Build the pool for this instance.
 *
 * `STORAGE_PROVIDER` pins one store: only it writes, and everything else that is
 * bound joins read-only so old objects stay reachable until they expire on their own.
 * Unset means every configured store writes, which is what makes the KV free tier
 * and a bucket work as one layer instead of one replacing the other.
 *
 * A pin that is not configured is an error rather than a quiet downgrade: a typo
 * should surface as one clear message on the next upload, not as bytes landing in a
 * namespace nobody meant to use.
 */
export function resolveStorage(env: AppEnv): ResolvedStorage {
	const wanted = env.STORAGE_PROVIDER?.trim().toLowerCase();
	const policy = poolPolicyFromEnv(env);

	const bound: Array<{ candidate: Candidate; store: BlobStore }> = [];
	for (const candidate of candidates) {
		const store = candidate.bind(env);
		if (store) bound.push({ candidate, store });
	}
	if (bound.length === 0) {
		throw new Error(
			"No blob storage is configured. Bind an R2 bucket (BUCKET) or a KV namespace (BLOBS), or set the S3_* variables.",
		);
	}

	if (wanted && wanted !== "auto") {
		const match = candidates.find((entry) => entry.provider === wanted);
		if (!match) {
			const names = candidates.map((entry) => entry.provider).join(", ");
			throw new Error(`STORAGE_PROVIDER="${wanted}" is not a storage backend. Expected one of: ${names}, or "auto".`);
		}
		const pinned = bound.find((entry) => entry.candidate.provider === wanted);
		if (!pinned) {
			throw new Error(`STORAGE_PROVIDER="${match.provider}" is pinned but not configured: it needs ${match.label}.`);
		}
		const members = [poolMember(match.provider, match.label, pinned.store)];
		const retired = bound.filter((entry) => entry !== pinned && keepsReads(env, entry.candidate.provider));
		for (const entry of retired)
			members.push(poolMember(entry.candidate.provider, entry.candidate.label, entry.store, true));
		const suffix =
			retired.length > 0
				? `, reading through ${retired.map((entry) => entry.candidate.provider).join(" and ")} for objects written before it`
				: "";
		return {
			provider: match.provider,
			providers: members.map((entry) => entry.provider),
			objects: new BlobPool(members, { ...policy, kvShareMaxBytes: 0, kvWritesPerDay: 0 }),
			reason: `pinned by STORAGE_PROVIDER (${match.label})${suffix}`,
			mode: "single",
		};
	}

	// `STORAGE_FALLBACK=off` means one store in play, full stop: no read-through of a
	// retired binding and no share for a second one. Otherwise the two knobs would
	// disagree about whether KV is being used at all.
	// `BLOB_POOL=off` is the single-writer shape: the first complete store takes every
	// body and any other binding is kept around read-only so objects written before it
	// keep opening until they expire on their own.
	const pooled = env.BLOB_POOL?.trim().toLowerCase() !== "off" && keepsAnyFallback(env);
	const writers = pooled ? bound : bound.slice(0, 1);
	const readers = pooled ? [] : bound.slice(1).filter((entry) => keepsReads(env, entry.candidate.provider));
	const members = [
		...writers.map((entry) => poolMember(entry.candidate.provider, entry.candidate.label, entry.store)),
		...readers.map((entry) => poolMember(entry.candidate.provider, entry.candidate.label, entry.store, true)),
	];

	const names = writers.map((entry) => `${entry.candidate.provider} (${entry.candidate.label})`).join(" + ");
	const hasBucket = writers.some((entry) => entry.candidate.provider === "r2" || entry.candidate.provider === "s3");
	const takesKv = kvWrites(writers);
	const role: KvRole =
		!takesKv || !pooled ? "off" : policy.kvRole === "auto" ? (hasBucket ? "cache" : "share") : policy.kvRole;
	// A share is meaningless for a store that never takes writes, and a cache is
	// meaningless for a namespace that is already the origin: say one thing.
	const effectivePolicy: PoolPolicy = {
		...policy,
		kvRole: role,
		kvShareMaxBytes: role === "share" ? policy.kvShareMaxBytes : 0,
		kvCacheMaxBytes: role === "cache" ? policy.kvCacheMaxBytes : 0,
		kvWritesPerDay: takesKv && pooled ? policy.kvWritesPerDay : 0,
	};
	const share =
		role === "share" && effectivePolicy.kvShareMaxBytes > 0
			? `, with bodies up to ${Math.round(effectivePolicy.kvShareMaxBytes / 1024)} KiB taking a KV share of ${effectivePolicy.kvWritesPerDay} writes a day`
			: role === "cache" && effectivePolicy.kvCacheMaxBytes > 0
				? `, with reads up to ${Math.round(effectivePolicy.kvCacheMaxBytes / 1024)} KiB cached in the namespace for ${Math.round(effectivePolicy.kvCacheTtlSeconds / 86400)} days (${effectivePolicy.kvWritesPerDay} writes a day)`
				: "";
	const drained =
		readers.length > 0
			? `, reading through ${readers.map((entry) => entry.candidate.provider).join(" and ")} for objects written before it`
			: "";

	return {
		provider: writers[0]!.candidate.provider,
		providers: members.map((entry) => entry.provider),
		objects: new BlobPool(members, effectivePolicy),
		reason: `${names}${pooled ? " pooled" : ` (${writers[0]!.candidate.label})`}${share}${drained}`,
		mode: writers.length > 1 ? "pool" : "single",
	};
}

/** Whether any store other than the writer is involved in this instance at all. */
function keepsAnyFallback(env: AppEnv): boolean {
	return (env.STORAGE_FALLBACK?.trim().toLowerCase() || "auto") !== "off";
}

/** `STORAGE_FALLBACK=off` closes the retired store; anything else keeps it readable. */
function keepsReads(env: AppEnv, provider: StorageProvider): boolean {
	const wanted = env.STORAGE_FALLBACK?.trim().toLowerCase() || "auto";
	if (wanted === "off") return false;
	return wanted === "auto" || wanted === provider;
}
