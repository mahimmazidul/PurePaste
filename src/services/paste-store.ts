import type { Config } from "../config";
import type { AppEnv } from "../env";
import { fail } from "../lib/errors";
import { generateId, generateManageToken } from "../lib/ids";
import { hashManageToken, hashPasswordVerifier } from "../lib/crypto";
import { utf8Length } from "../lib/validation";
import type { CreatePasteInput, CreatedPaste, PasteRecord, ReadResult } from "../types";
import { MetadataStore } from "./metadata-store";
import { ObjectStore, type ObjectKind } from "./object-store";

export interface Stores {
	meta: MetadataStore;
	objects: ObjectStore;
}

export function stores(env: AppEnv): Stores {
	return { meta: new MetadataStore(env.DB), objects: new ObjectStore(env.BUCKET) };
}

export interface CreateOptions {
	/** Injected in tests to force a collision. */
	idFactory?: () => string;
	now?: number;
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

		if (outcome === "created") return { record, manageToken };

		// The id was taken. Remove the object written for this attempt so a retry can
		// never leave an unreferenced file behind, then either report the clash or
		// try again with a fresh id.
		if (objectKey) await safeDeleteObject(storesOut.objects, objectKey);
		if (input.slug) throw fail.slugTaken();
	}

	throw new Error("Could not allocate a unique paste id");
}

async function safeDeleteObject(objects: ObjectStore, key: string): Promise<void> {
	try {
		await objects.delete([key]);
	} catch {
		// Best effort: the cleanup sweep removes anything unreferenced later.
	}
}

interface WrittenBody {
	content: string | null;
	objectKey: string | null;
	sizeBytes: number;
}

async function writeBody(
	config: Config,
	input: CreatePasteInput,
	id: string,
	objects: ObjectStore,
): Promise<WrittenBody> {
	if (input.body.type === "none") {
		return { content: null, objectKey: null, sizeBytes: 0 };
	}

	if (input.body.type === "text") {
		const bytes = utf8Length(input.body.text);
		if (!input.encrypted && bytes <= config.inlineTextMaxBytes) {
			return { content: input.body.text, objectKey: null, sizeBytes: bytes };
		}
		const key = objects.keyFor(id, "text");
		await objects.putBytes(key, new TextEncoder().encode(input.body.text), {
			contentType: "text/plain; charset=utf-8",
			size: bytes,
		});
		return { content: null, objectKey: key, sizeBytes: bytes };
	}

	const kind: ObjectKind = input.encrypted ? "blob" : input.kind === "file" ? "file" : "text";
	const key = objects.keyFor(id, kind);
	await objects.putBytes(key, input.body.bytes, {
		contentType: input.encrypted ? "application/octet-stream" : (input.contentType ?? "application/octet-stream"),
		filename: input.filename ?? undefined,
		size: input.body.bytes.byteLength,
	});
	return { content: null, objectKey: key, sizeBytes: input.body.bytes.byteLength };
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
	const record = await meta.findById(id);
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
	| { kind: "object"; object: R2ObjectBody; etag: string }
	| { kind: "redirect"; url: string }
	| { kind: "missing" };

export async function openBody(env: AppEnv, record: PasteRecord): Promise<BodyResult> {
	if (record.kind === "redirect") {
		return record.redirectUrl ? { kind: "redirect", url: record.redirectUrl } : { kind: "missing" };
	}
	if (record.content !== null) return { kind: "inline", text: record.content };
	if (record.objectKey) {
		const object = await stores(env).objects.get(record.objectKey);
		if (!object) return { kind: "missing" };
		return { kind: "object", object, etag: object.httpEtag };
	}
	return { kind: "missing" };
}

/**
 * Atomically claims a burn-after-reading paste. Returns null when the paste was
 * already opened by somebody else, or when it has expired.
 */
export async function claimBurn(env: AppEnv, id: string, now = Date.now()): Promise<PasteRecord | null> {
	return stores(env).meta.claimBurn(id, now);
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
	let objectRemoved = true;

	if (record.objectKey) {
		const result = await objects.delete([record.objectKey]);
		objectRemoved = result.failed.length === 0;
	}

	if (!objectRemoved) {
		// Tombstone: content is unreachable, and the sweep owns the retry loop.
		await meta.claimBurn(record.id, Date.now());
		return { id: record.id, objectRemoved: false, rowRemoved: false, deferred: true };
	}

	const rowRemoved = await meta.deleteById(record.id);
	return { id: record.id, objectRemoved: true, rowRemoved, deferred: false };
}
