import type { Config } from "../config";
import type { AppEnv } from "../env";
import { fail } from "../lib/errors";
import { generateId, generateManageToken } from "../lib/ids";
import { hashManageToken, hashPasswordVerifier } from "../lib/crypto";
import { utf8Length } from "../lib/validation";
import type { CreatePasteInput, CreatedPaste, PasteRecord, ReadResult } from "../types";
import { MetadataStore } from "./metadata-store";
import type { BlobBody, ObjectKind } from "./object-store";
import type { BlobPool } from "./storage-provider";
import { resolveStorage } from "./storage-provider";
import { supabaseStore } from "./supabase-store";

/** Anything with `waitUntil`: the Worker execution context, in practice. */
export interface Deferrer {
	waitUntil(promise: Promise<unknown>): void;
}

export interface Stores {
	meta: MetadataStore;
	/** Every configured blob store, as one object: see ./storage-provider. */
	objects: BlobPool;
}

export function stores(env: AppEnv): Stores {
	return { meta: new MetadataStore(env.DB), objects: blobStore(env) };
}

/**
 * The blob layer for this request: one object in front of every configured store.
 * Metadata always lives in D1, so swapping what is behind it changes nothing about
 * how reads, burns, expiry and the cleanup sweep work. See ./storage-provider.
 */
function blobStore(env: AppEnv): BlobPool {
	return resolveStorage(env).objects;
}

export interface CreateOptions {
	/** Injected in tests to force a collision. */
	idFactory?: () => string;
	now?: number;
	/**
	 * The execution context, when the caller has one. A mirror write is handed to
	 * `waitUntil` instead of being awaited, so a visitor never pays for a round trip
	 * to another region. Without it (tests, cron) the write is simply awaited.
	 */
	ctx?: Deferrer;
}

/**
 * Creates a paste.
 *
 * Implicit expiration is always applied here: `expiresAt` is computed from the
 * server clock and already clamped by the validator, so a client can never ask
 * for a longer lifetime than the instance allows.
 */
export async function createPaste(
	env: AppEnv,
	config: Config,
	input: CreatePasteInput,
	options: CreateOptions = {},
): Promise<CreatedPaste> {
	if (input.kind === "redirect" && !config.redirectEnabled) {
		throw fail.featureDisabled("URL mode");
	}

	const now = options.now ?? Date.now();
	const expiresAt = Math.min(now + input.ttlSeconds * 1000, now + config.maxTtlSeconds * 1000);
	const storesOut = stores(env);
	const idFactory = options.idFactory ?? (() => generateId());
	const manageToken = generateManageToken();

	// A custom slug gets one attempt: collisions are the visitor's problem to solve,
	// not something to paper over with a different id. Generated ids are retried.
	const attempts = input.slug ? 1 : 5;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const id = input.slug ?? idFactory();
		const body = await writeBody(config, input, id, storesOut.objects);
		const objectKey = body.objectKey;

		const record: PasteRecord = {
			id,
			kind: input.kind,
			title: input.title,
			language: input.language,
			filename: input.kind === "file" || input.encrypted ? input.filename : null,
			contentType: input.kind === "file" || input.encrypted ? input.contentType : null,
			sizeBytes: body.sizeBytes,
			content: body.content,
			objectKey,
			blobStore: body.blobStore,
			passwordSalt: input.password?.salt ?? null,
			passwordVerifier: input.password
				? await hashPasswordVerifier(config.appSecret, id, input.password.salt, input.password.verifier)
				: null,
			passwordIterations: input.password?.iterations ?? null,
			passwordAlgo: input.password?.algo ?? null,
			manageHash: await hashManageToken(config.appSecret, id, manageToken),
			burnAfterRead: input.burnAfterRead,
			encrypted: input.encrypted,
			markdown: input.markdown,
			redirectUrl: input.redirectUrl,
			createdAt: now,
			expiresAt,
			consumedAt: null,
			views: 0,
		};

		let outcome: "created" | "collision";
		try {
			outcome = await storesOut.meta.insert(record);
		} catch (error) {
			if (objectKey) await safeDeleteObject(storesOut.objects, objectKey);
			throw error;
		}

		if (outcome === "created") {
			await mirrorRecord(env, record, options.ctx);
			return { record, manageToken };
		}

		// The id was taken. Remove the object written for this attempt so a retry can
		// never leave an unreferenced file behind, then either report the clash or
		// try again with a fresh id.
		if (objectKey) await safeDeleteObject(storesOut.objects, objectKey);
		if (input.slug) throw fail.slugTaken();
	}

	throw new Error("Could not allocate a unique paste id");
}

/**
 * Mirror one record to Supabase, if this instance has a Supabase mirror at all.
 *
 * The rule everywhere in this file: the mirror is allowed to be slow, wrong or
 * down, and must never make a visitor's request fail or wait. Errors land in the
 * store's status, which `GET /api/config` publishes.
 */
export async function mirrorRecord(env: AppEnv, record: PasteRecord, ctx?: Deferrer): Promise<void> {
	const mirror = supabaseStore(env);
	if (!mirror) return;
	const task = mirror.upsert(record).catch(() => false);
	if (ctx) ctx.waitUntil(task);
	else await task;
}

async function safeDeleteObject(objects: BlobPool, key: string): Promise<void> {
	try {
		await objects.delete([key]);
	} catch {
		// Best effort: the cleanup sweep removes anything unreferenced later.
	}
}

interface WrittenBody {
	content: string | null;
	objectKey: string | null;
	/** Which store in the pool took the body, so a read can start there. */
	blobStore: string | null;
	sizeBytes: number;
}

async function writeBody(config: Config, input: CreatePasteInput, id: string, objects: BlobPool): Promise<WrittenBody> {
	if (input.body.type === "none") {
		return { content: null, objectKey: null, blobStore: null, sizeBytes: 0 };
	}

	if (input.body.type === "text") {
		const bytes = utf8Length(input.body.text);
		if (!input.encrypted && bytes <= config.inlineTextMaxBytes) {
			return { content: input.body.text, objectKey: null, blobStore: null, sizeBytes: bytes };
		}
		const placed = await objects.place("text", id, input.body.text, {
			contentType: "text/plain; charset=utf-8",
			size: bytes,
		});
		return { content: null, objectKey: placed.key, blobStore: placed.member.provider, sizeBytes: bytes };
	}

	const kind: ObjectKind = input.encrypted ? "blob" : input.kind === "file" ? "file" : "text";
	const placed = await objects.place(kind, id, input.body.bytes, {
		contentType: input.encrypted ? "application/octet-stream" : (input.contentType ?? "application/octet-stream"),
		filename: input.filename ?? undefined,
		size: input.body.bytes.byteLength,
	});
	return {
		content: null,
		objectKey: placed.key,
		blobStore: placed.member.provider,
		sizeBytes: input.body.bytes.byteLength,
	};
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface LoadOptions {
	now?: number;
}

export async function loadPaste(env: AppEnv, id: string, options: LoadOptions = {}): Promise<ReadResult> {
	const now = options.now ?? Date.now();
	const { meta } = stores(env);
	let record: PasteRecord | null;
	try {
		record = await meta.findById(id);
	} catch (error) {
		// D1 had a bad minute. The mirror is a full copy of what is live, so a paste
		// does not have to go dark for it: read the other region instead.
		const mirror = supabaseStore(env);
		const fallback = mirror ? await mirror.findById(id).catch(() => null) : null;
		if (!fallback) throw error;
		record = fallback;
	}
	if (!record) return { status: "missing" };

	// Expiry is evaluated on every read; the scheduled sweep is what removes the row
	// and its object, so an expired paste answers consistently until then.
	if (record.expiresAt <= now) return { status: "expired" };
	if (record.consumedAt !== null) return { status: "consumed" };
	if (record.burnAfterRead) return { status: "needs-reveal", record };
	return { status: "ok", record };
}

export type BodyResult =
	| { kind: "inline"; text: string }
	| { kind: "object"; object: BlobBody; etag: string }
	| { kind: "redirect"; url: string }
	| { kind: "missing" };

/**
 * Open a body, and let the pool use every store it has.
 *
 * `defer` is the request's execution context. It is not decoration: a cached copy is
 * written behind the response, and a background write with nothing holding it open is
 * how you get half a file in the namespace. Without a context — tests, the burn path,
 * any caller that must answer immediately — the read is served and nothing is copied.
 */
export async function openBody(env: AppEnv, record: PasteRecord, defer?: Deferrer): Promise<BodyResult> {
	if (record.kind === "redirect") {
		return record.redirectUrl ? { kind: "redirect", url: record.redirectUrl } : { kind: "missing" };
	}
	if (record.content !== null) return { kind: "inline", text: record.content };
	if (record.objectKey) {
		const { meta, objects } = stores(env);
		const object = await objects.read(record.objectKey, record.blobStore as "r2" | "s3" | "kv" | null, {
			defer,
			stamp: (provider) => meta.setBlobStore(record.id, provider),
		});
		if (!object) return { kind: "missing" };
		return { kind: "object", object, etag: object.httpEtag };
	}
	return { kind: "missing" };
}

/**
 * Atomically claims a burn-after-reading paste. Returns null when the paste was
 * already opened by somebody else, or when it has expired.
 */
export async function claimBurn(
	env: AppEnv,
	id: string,
	now = Date.now(),
	ctx?: Deferrer,
): Promise<PasteRecord | null> {
	const record = await stores(env).meta.claimBurn(id, now);
	if (record) {
		const mirror = supabaseStore(env);
		if (mirror) {
			const task = mirror.markConsumed(id, now).catch(() => undefined);
			if (ctx) ctx.waitUntil(task);
			else await task;
		}
	}
	return record;
}

/* ------------------------------------------------------------------ *
 * Deletion
 * ------------------------------------------------------------------ */

export interface DeleteResult {
	id: string;
	objectRemoved: boolean;
	rowRemoved: boolean;
	/** True when the row was tombstoned for the sweep because R2 could not be reached. */
	deferred: boolean;
}

/**
 * Deletes a paste and its object.
 *
 * The object is removed first: a failure at that point leaves the row in place,
 * and the row is tombstoned so the paste stops being readable and the sweep
 * retries the deletion. Both steps are idempotent, so a retry is always safe.
 */
export async function deletePaste(env: AppEnv, record: PasteRecord): Promise<DeleteResult> {
	const { meta, objects } = stores(env);
	const mirror = supabaseStore(env);
	let objectRemoved = true;

	if (record.objectKey) {
		const result = await objects.delete([record.objectKey]);
		objectRemoved = result.failed.length === 0;
	}

	// The mirror follows the primary, whatever the object store said: a row that
	// stops being readable in D1 must stop being readable everywhere.
	await mirror?.deleteMany([record.id]).catch(() => undefined);

	if (!objectRemoved) {
		// Tombstone: content is unreachable, and the sweep owns the retry loop.
		await meta.claimBurn(record.id, Date.now());
		return { id: record.id, objectRemoved: false, rowRemoved: false, deferred: true };
	}

	const rowRemoved = await meta.deleteById(record.id);
	return { id: record.id, objectRemoved: true, rowRemoved, deferred: false };
}
