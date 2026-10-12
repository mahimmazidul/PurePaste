import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import { resolveConfig } from "../src/config";
import { buildCsp } from "../src/middleware/security";
import {
	BlobPool,
	DEFAULT_POLICY,
	poolMember,
	resolveStorage,
	type PoolPolicy,
	type StorageProvider,
} from "../src/services/storage-provider";
import { S3ObjectStore, s3SettingsFromEnv, testing } from "../src/services/s3-store";
import { createPaste, objectKeys, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";
import { sweep } from "../src/services/cleanup";
import { stores } from "../src/services/paste-store";
import type { BlobStore } from "../src/services/object-store";
import type { PasteRecord } from "../src/types";
import { SupabaseStore, supabaseSettingsFromEnv } from "../src/services/supabase-store";
import { isDeepPassHour, runMaintenance, sweepOrphans } from "../src/services/maintenance";
import { listingsOf, versionsOf } from "../src/services/s3-store";

/**
 * The blob backend is chosen by configuration, so the choosing is the part that
 * can silently wreck a deployment: pick the wrong store and uploads land somewhere
 * the cleanup sweep never looks. These tests pin the precedence, the pinning
 * override, and the two places a mistake would be invisible at runtime — the
 * signature (an S3 bucket would reject every request) and the CSP (a direct-link
 * origin has to be allowlisted, and only that origin).
 */

const fake = (values: Record<string, unknown>): AppEnv => values as unknown as AppEnv;

const S3_CONFIGURED = {
	S3_ENDPOINT: "https://s3.us-west-002.backblazeb2.com",
	S3_BUCKET: "my-bucket",
	S3_ACCESS_KEY_ID: "AKIAEXAMPLEIDEXAMPLE",
	S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
	S3_REGION: "us-west-002",
};

describe("storage backends", () => {
	it("prefers a bound R2 bucket over everything else", () => {
		const resolved = resolveStorage(fake({ BUCKET: {}, BLOBS: {}, ...S3_CONFIGURED }));
		expect(resolved.provider).toBe("r2");
		expect(resolved.reason).toContain("BUCKET");
	});

	it("takes an S3 endpoint over KV, and KV over nothing", () => {
		expect(resolveStorage(fake({ BLOBS: {}, ...S3_CONFIGURED })).provider).toBe("s3");
		expect(resolveStorage(fake({ BLOBS: {} })).provider).toBe("kv");
		// An S3 set with no bindings at all is still a real store.
		expect(resolveStorage(fake({ ...S3_CONFIGURED })).provider).toBe("s3");
	});

	it("refuses to invent a backend rather than write to nowhere", () => {
		expect(() => resolveStorage(fake({}))).toThrow(/No blob storage is configured/);
	});

	it("honours an explicit pin, even when it contradicts the bindings", () => {
		expect(resolveStorage(fake({ STORAGE_PROVIDER: "kv", BUCKET: {}, BLOBS: {} })).provider).toBe("kv");
		// A typo is a deploy-time mistake, so it is an error and not a fallback.
		expect(() => resolveStorage(fake({ STORAGE_PROVIDER: "grid", BLOBS: {} }))).toThrow(/not a storage backend/);
		expect(() => resolveStorage(fake({ STORAGE_PROVIDER: "s3", BLOBS: {} }))).toThrow(/pinned but not configured/);
	});

	it("needs the whole S3 set before it will use a bucket", () => {
		const { S3_SECRET_ACCESS_KEY: _missing, ...partial } = S3_CONFIGURED;
		expect(s3SettingsFromEnv(fake(partial))).toBeNull();
		const settings = s3SettingsFromEnv(fake(S3_CONFIGURED));
		expect(settings?.region).toBe("us-west-002");
		expect(s3SettingsFromEnv(fake({ ...S3_CONFIGURED, S3_REGION: undefined }))?.region).toBe("auto");
	});

	it("reports the live backend through the public config endpoint", async () => {
		const body = (await (await request("/api/config")).json()) as {
			storage: { provider: string; reason: string; direct_links: boolean; mode: string };
		};
		// The test Worker binds KV only, which is also the shape of the live deploy.
		expect(body.storage.provider).toBe("kv");
		// One store bound is a pool of one, and says so: the mode is about how many
		// stores take writes, not about which class is running.
		expect(body.storage.mode).toBe("single");
		expect(body.storage.direct_links).toBe(false);
		expect(body.storage.reason).toContain("BLOBS");
	});
});

/**
 * Reference values were produced by an independent implementation of the AWS
 * SigV4 algorithm (Python, hashlib/hmac) for a fixed date of 2026-10-12T06:00:00Z.
 * Pinning them is the only way to notice a canonicalisation drift: a wrong
 * signature does not degrade, it fails every single request.
 */
const VECTORS = {
	get: {
		canonicalRequest:
			"GET\n/my-bucket/pp/v1/file/abc123\n\nhost:s3.us-west-002.backblazeb2.com\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20261012T060000Z\n\nhost;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		stringToSign:
			"AWS4-HMAC-SHA256\n20261012T060000Z\n20261012/us-west-002/s3/aws4_request\nbbe83dc5e2cd237e52498483c9259afb10b529a4d948ef1ba22ea2072e578b9a",
		signature: "59f7e4a354a055f96ac16ff2add3036801aa178f0fd8ab9a8e6100470e9ea3bd",
	},
	put: {
		canonicalRequest:
			'PUT\n/my-bucket/pp/v1/file/abc123\n\ncontent-disposition:inline; filename="cat.png"\ncontent-length:1234\ncontent-type:image/png\nhost:s3.us-west-002.backblazeb2.com\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:20261012T060000Z\n\ncontent-disposition;content-length;content-type;host;x-amz-content-sha256;x-amz-date\nUNSIGNED-PAYLOAD',
		stringToSign:
			"AWS4-HMAC-SHA256\n20261012T060000Z\n20261012/us-west-002/s3/aws4_request\n6677939b49ceaf9524165a957f36932543c692fbde6b6b88c99fb6e3692c0be8",
		signature: "d06fcfe3a2b6032070b2d9a1e008c08c9de192102f445015501e1b0f498f9dfe",
	},
	presign: {
		canonicalQuery:
			"X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLEIDEXAMPLE%2F20261012%2Fus-west-002%2Fs3%2Faws4_request&X-Amz-Date=20261012T060000Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host",
		stringToSign:
			"AWS4-HMAC-SHA256\n20261012T060000Z\n20261012/us-west-002/s3/aws4_request\n785898b080ad8826ad1b5c8b0aff8c0dbc2539769d7421675ce64ffeb4744683",
		signature: "d023f6fe28a7b17675673c3221beeb9c1cb6bc988895f9a4c1d74bd3aa6baad5",
	},
} as const;

const KEY = "pp/v1/file/abc123";
const NOW = new Date("2026-10-12T06:00:00.000Z");

describe("S3 request signing", () => {
	const base = {
		path: "/my-bucket/pp/v1/file/abc123",
		region: "us-west-002",
		service: "s3",
		accessKeyId: "AKIAEXAMPLEIDEXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		host: "s3.us-west-002.backblazeb2.com",
		now: NOW,
	};

	it("matches an independent implementation for a plain GET", async () => {
		const signed = await testing.signV4({
			...base,
			method: "GET",
			query: [],
			headers: { "x-amz-content-sha256": testing.emptySha256 },
			payloadHash: testing.emptySha256,
		});
		expect(signed.canonicalRequest).toBe(VECTORS.get.canonicalRequest);
		expect(signed.stringToSign).toBe(VECTORS.get.stringToSign);
		expect(signed.signature).toBe(VECTORS.get.signature);
		expect(signed.headers.authorization).toContain(`Signature=${VECTORS.get.signature}`);
	});

	it("signs the object metadata it sends, and declares an unsigned payload", async () => {
		const signed = await testing.signV4({
			...base,
			method: "PUT",
			query: [],
			headers: {
				"x-amz-content-sha256": "UNSIGNED-PAYLOAD",
				"content-type": "image/png",
				"content-length": "1234",
				"content-disposition": 'inline; filename="cat.png"',
			},
			payloadHash: "UNSIGNED-PAYLOAD",
		});
		expect(signed.canonicalRequest).toBe(VECTORS.put.canonicalRequest);
		expect(signed.signature).toBe(VECTORS.put.signature);
	});

	it("signs only the host for a presigned URL, and puts the date in the query", async () => {
		const signed = await testing.signV4({
			...base,
			method: "GET",
			mode: "query",
			query: [
				["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
				["X-Amz-Credential", "AKIAEXAMPLEIDEXAMPLE/20261012/us-west-002/s3/aws4_request"],
				["X-Amz-Date", "20261012T060000Z"],
				["X-Amz-Expires", "900"],
				["X-Amz-SignedHeaders", "host"],
			],
			headers: {},
			payloadHash: "UNSIGNED-PAYLOAD",
		});
		expect(signed.canonicalQuery).toBe(VECTORS.presign.canonicalQuery);
		expect(signed.stringToSign).toBe(VECTORS.presign.stringToSign);
		expect(signed.signature).toBe(VECTORS.presign.signature);
		// The signature covers `host` alone: an x-amz-date header here would be a
		// header the browser never sends, and the bucket would reject the link.
		expect(signed.signedHeaders).toBe("host");
		expect(signed.canonicalRequest).not.toContain("x-amz-date:20261012T060000Z\n");
	});

	it("builds a presigned link whose query is exactly what was signed", async () => {
		const store = new S3ObjectStore({
			endpoint: "https://s3.us-west-002.backblazeb2.com",
			bucket: "my-bucket",
			accessKeyId: "AKIAEXAMPLEIDEXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			region: "us-west-002",
		});
		const url = new URL((await store.publicUrlFor(KEY, 900))!);
		expect(url.pathname).toBe("/my-bucket/pp/v1/file/abc123");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

		// Recomputing the signature from the link itself proves the two agree: a
		// re-encoded query on the way out is the classic way this breaks.
		const canonical = [...url.searchParams.entries()]
			.filter(([name]) => name !== "X-Amz-Signature")
			.map(
				([name, value]) =>
					`${encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}=${encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
			)
			.sort()
			.join("&");
		expect(url.search.slice(1).replace(/&X-Amz-Signature=[0-9a-f]+$/, "")).toBe(canonical);
	});

	it("addresses a bucket the way its endpoint expects", async () => {
		const pathStyle = new S3ObjectStore({
			endpoint: "https://s3.us-west-002.backblazeb2.com",
			bucket: "my-bucket",
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			region: "us-west-002",
		});
		const link = await pathStyle.publicUrlFor("pp/v1/file/abc 123");
		expect(link).toContain("/my-bucket/pp/v1/file/abc%20123");

		// Supabase's S3 endpoint refuses path-style addresses outright.
		const virtual = new S3ObjectStore({
			endpoint: "https://xyz.supabase.co/storage/v1/s3",
			bucket: "slips",
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
			region: "us-east-1",
			virtualHostStyle: true,
		});
		const vhost = new URL((await virtual.publicUrlFor("pp/v1/file/abc123"))!);
		expect(vhost.host).toBe("slips.xyz.supabase.co");
		expect(vhost.pathname).toBe("/storage/v1/s3/pp/v1/file/abc123");
	});

	it("hands out a credential-free link when the bucket is public", async () => {
		const store = new S3ObjectStore({
			endpoint: "https://s3.us-west-002.backblazeb2.com",
			bucket: "my-bucket",
			accessKeyId: "AKIAEXAMPLEIDEXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
			region: "us-west-002",
			publicBase: "https://cdn.example.com/purepaste/",
		});
		const link = await store.publicUrlFor("pp/v1/file/abc123");
		expect(link).toBe("https://cdn.example.com/purepaste/pp/v1/file/abc123");
		expect(link).not.toContain("Signature");
	});

	it("keys objects under the same layout whichever backend answers", () => {
		const settings = s3SettingsFromEnv(fake(S3_CONFIGURED))!;
		const store = new S3ObjectStore(settings);
		expect(store.keyFor("abc123", "file")).toBe("pp/v1/file/abc123");
		expect(store.keyFor("abc123", "text")).toBe("pp/v1/text/abc123");
	});
});

/**
 * The purge is what keeps a paid-tier bucket from quietly filling up, and it has to
 * work the same whatever is underneath. It is given a recording stand-in for the
 * object store: if `sweep` ever reaches past the `BlobStore` contract into R2 or KV
 * specifics, this is the test that says so.
 */
describe("cleanup against a plugged-in store", () => {
	beforeEach(resetStorage);

	it("asks the active store for exactly the keys the rows name", async () => {
		const created = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 32) });
		await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, created.id)
			.run();
		const row = await readRow(created.id);

		const asked: string[][] = [];
		const recorder = {
			...stores(testEnv).objects,
			async delete(keys: string[]) {
				asked.push(keys);
				return { deleted: keys.length, failed: [] };
			},
		} as unknown as BlobStore;

		const report = await sweep({ meta: stores(testEnv).meta, objects: recorder }, testConfig);

		expect(asked).toEqual([[row?.object_key]]);
		expect(report.expiredObjects).toBe(1);
		expect(await readRow(created.id)).toBeNull();
	});

	it("keeps the row when the store says no, so the object is never stranded", async () => {
		const created = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 32) });
		await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, created.id)
			.run();

		const refusing = {
			...stores(testEnv).objects,
			async delete(keys: string[]) {
				return { deleted: 0, failed: keys };
			},
		} as unknown as BlobStore;

		const report = await sweep({ meta: stores(testEnv).meta, objects: refusing }, testConfig);

		expect(report.deferred).toBe(1);
		expect(await readRow(created.id)).not.toBeNull();
		expect((await objectKeys()).length).toBeGreaterThan(0);
	});
});

describe("direct links and the policy that allows them", () => {
	it("accepts only an https origin, and only when the feature is on", () => {
		expect(
			resolveConfig({ STORAGE_DIRECT_LINKS: "on", S3_PUBLIC_BASE: "https://cdn.example.com/b/" }).storageDirectOrigin,
		).toBe("https://cdn.example.com");
		// http is not a typo to be fixed: a plain-HTTP origin in a CSP is a downgrade
		// waiting to happen, so it is simply not honoured.
		expect(
			resolveConfig({ STORAGE_DIRECT_LINKS: "on", S3_PUBLIC_BASE: "http://cdn.example.com" }).storageDirectOrigin,
		).toBeUndefined();
		expect(resolveConfig({ S3_PUBLIC_BASE: "https://cdn.example.com" }).storageDirectOrigin).toBeUndefined();
		expect(
			resolveConfig({ STORAGE_DIRECT_LINKS: "off", S3_PUBLIC_BASE: "https://cdn.example.com" }).storageDirectOrigin,
		).toBeUndefined();
	});

	it("names that origin in img-src and media-src, and nothing else", () => {
		const csp = buildCsp({ mediaOrigin: "https://cdn.example.com" });
		expect(csp).toContain("img-src 'self' data: https://cdn.example.com");
		expect(csp).toContain("media-src 'self' https://cdn.example.com");
		expect(csp).not.toContain("connect-src 'self' https://cdn.example.com");
		expect(csp).toContain("object-src 'none'");
		expect(buildCsp()).toContain("media-src 'self';");
	});
});

/**
 * One blob layer, several stores behind it.
 *
 * A body is written to exactly one store and the row records which, read tries that
 * store first and then the others, and a delete goes to every store there is. Fakes
 * are enough for all of it: what is under test is who is asked, in what order, and
 * what happens when one of them is having a bad day — not what is inside a bucket.
 */
describe("the blob pool", () => {
	class FakeStore {
		readonly reads: string[] = [];

		readonly deletes: string[][] = [];

		readonly puts: Array<{ key: string; options: { size?: number; ttlSeconds?: number } }> = [];

		readonly writes: Array<{ key: string; bytes: number }> = [];

		constructor(
			readonly name: string,
			readonly keys: string[] = [],
			/** Fails every write, the way a namespace over its daily budget does. */
			readonly broken = false,
			readonly url?: string,
		) {}

		objectPrefix(): string {
			return "pp/v1/";
		}

		keyFor(id: string, kind: string): string {
			return `pp/v1/${kind}/${id}`;
		}

		async get(key: string): Promise<{ body: ReadableStream; size: number; httpEtag: string } | null> {
			this.reads.push(key);
			if (!this.keys.includes(key)) return null;
			return { body: new Blob([this.name]).stream(), size: this.name.length, httpEtag: `"${this.name}"` };
		}

		async putBytes(
			key: string,
			bytes: Uint8Array,
			options: { size?: number; ttlSeconds?: number } = {},
		): Promise<void> {
			if (this.broken) throw new Error(`${this.name} is refusing writes today`);
			this.writes.push({ key, bytes: bytes.byteLength });
			this.puts.push({ key, options });
			if (!this.keys.includes(key)) this.keys.push(key);
		}

		async publicUrlFor(key: string): Promise<string | null> {
			return this.url ? `${this.url}/${key}` : null;
		}

		async delete(keys: string[]): Promise<{ deleted: number; failed: string[] }> {
			this.deletes.push(keys);
			return { deleted: keys.length, failed: [] };
		}

		/** What a cache fill does: a stream, a declared size, and a lifetime. */
		async put(
			key: string,
			value: ReadableStream | ArrayBuffer | Uint8Array | string,
			options: { size?: number; ttlSeconds?: number } = {},
		): Promise<void> {
			if (this.broken) throw new Error(`${this.name} is refusing writes today`);
			this.puts.push({ key, options });
			if (value instanceof ReadableStream && !this.keys.includes(key)) this.keys.push(key);
			if (value instanceof ReadableStream) {
				// Drained with a reader: workerd refuses `pipeTo(new WritableStream())`
				// between two unrelated streams, and a copy nobody reads would hang here.
				const reader = value.getReader();
				while (!(await reader.read()).done) {
					/* read to the end */
				}
			}
			if (!this.keys.includes(key)) this.keys.push(key);
		}
	}

	const member = (name: string, store: FakeStore, readOnly = false) =>
		poolMember(name as StorageProvider, `${name} binding`, store as unknown as BlobStore, readOnly);

	const policy = (over: Partial<PoolPolicy> = {}): PoolPolicy => ({ ...DEFAULT_POLICY, ...over });

	it("puts a small body in the namespace and a large one in the bucket", async () => {
		const bucket = new FakeStore("s3");
		const namespace = new FakeStore("kv");
		const pool = new BlobPool([member("s3", bucket), member("kv", namespace)], policy({ kvShareMaxBytes: 256 * 1024 }));

		const small = await pool.place("file", "a", new Uint8Array(1024), { size: 1024 });
		const large = await pool.place("file", "b", new Uint8Array(300 * 1024), { size: 300 * 1024 });

		expect(small.member.provider).toBe("kv");
		expect(large.member.provider).toBe("s3");
		// One copy each, in the store the row will name: this is not a mirror.
		expect(namespace.writes.map((w) => w.key)).toEqual(["pp/v1/file/a"]);
		expect(bucket.writes.map((w) => w.key)).toEqual(["pp/v1/file/b"]);
		expect(small.key).toBe("pp/v1/file/a");
	});

	it("stops feeding KV once its daily write budget is spent", async () => {
		const bucket = new FakeStore("s3");
		const namespace = new FakeStore("kv");
		const pool = new BlobPool([member("s3", bucket), member("kv", namespace)], policy({ kvWritesPerDay: 1 }));

		expect((await pool.place("file", "a", new Uint8Array(10), { size: 10 })).member.provider).toBe("kv");
		expect((await pool.place("file", "b", new Uint8Array(10), { size: 10 })).member.provider).toBe("s3");
		expect(namespace.writes).toHaveLength(1);
		// The share is reported, because "why is my file in the bucket" should be
		// answerable without reading this file.
		expect(pool.share().kv_writes_left).toBe(0);
	});

	it("moves the body to the other store when one refuses it, and parks the one that keeps refusing", async () => {
		const bucket = new FakeStore("s3");
		const namespace = new FakeStore("kv", [], true);
		const pool = new BlobPool([member("s3", bucket), member("kv", namespace)], policy({ kvWritesPerDay: 100 }));

		for (let index = 0; index < 4; index += 1) {
			const placed = await pool.place("file", `f${index}`, new Uint8Array(10), { size: 10 });
			// The upload never fails: the retry is invisible to the visitor.
			expect(placed.member.provider).toBe("s3");
			expect(bucket.writes).toHaveLength(index + 1);
		}

		const [kv] = pool.status().filter((entry) => entry.provider === "kv");
		expect(kv?.write_failures).toBe(3);
		expect(kv?.parked).toBe(true);
		expect(kv?.last_error).toContain("refusing writes");
		expect(namespace.writes).toHaveLength(0);
	});

	it("reads the store the row names, then every other one", async () => {
		const bucket = new FakeStore("s3", ["pp/v1/file/new"]);
		const namespace = new FakeStore("kv", ["pp/v1/file/old"]);
		const pool = new BlobPool([member("s3", bucket), member("kv", namespace)], policy({ kvShareMaxBytes: 0 }));

		expect((await pool.get("pp/v1/file/new", "s3"))?.httpEtag).toBe('"s3"');
		expect(bucket.reads).toEqual(["pp/v1/file/new"]);
		expect(namespace.reads).toEqual([]);

		// A row that does not know where its body is: ask until something answers.
		expect((await pool.get("pp/v1/file/old", null))?.httpEtag).toBe('"kv"');
		const [kv] = pool.status().filter((entry) => entry.provider === "kv");
		expect(kv?.fallback_reads).toBe(1);
		expect(await pool.get("pp/v1/file/gone", null)).toBeNull();
	});

	it("deletes from every store, including the one being retired", async () => {
		const bucket = new FakeStore("s3");
		const draining = new FakeStore("kv", [], true, undefined);
		const pool = new BlobPool([member("s3", bucket), member("kv", draining, true)], policy({ kvShareMaxBytes: 0 }));

		expect(await pool.delete(["k1", "k2"])).toEqual({ deleted: 2, failed: [] });
		expect(bucket.deletes).toEqual([["k1", "k2"]]);
		expect(draining.deletes).toEqual([["k1", "k2"]]);
	});

	it("only hands out a bucket link when the row says that bucket has the bytes", async () => {
		const bucket = new FakeStore("s3", [], false, "https://cdn.example/bucket");
		const namespace = new FakeStore("kv");
		const draining = new FakeStore("draining", [], true, "https://cdn.example/retired");
		const pool = new BlobPool(
			[member("s3", bucket), member("kv", namespace), member("r2", draining, true)],
			policy({ kvShareMaxBytes: 0 }),
		);

		// A row that does not know where its body is gets proxied, never redirected to a
		// guess: a presigned URL for the wrong store is a 404 with extra steps.
		expect(await pool.publicUrlFor("pp/v1/file/a", null)).toBeNull();
		// The store the row names answers, and only it.
		expect(await pool.publicUrlFor("pp/v1/file/a", "s3")).toBe("https://cdn.example/bucket/pp/v1/file/a");
		expect(await pool.publicUrlFor("pp/v1/file/a", "kv")).toBeNull();
		// A store being retired is not a link target even if it could produce one.
		expect(await pool.publicUrlFor("pp/v1/file/a", "r2")).toBeNull();
	});

	it("serves from the bucket, keeps an expiring copy in the namespace, and stamps the row", async () => {
		const bucket = new FakeStore("s3", ["pp/v1/file/a"]);
		const namespace = new FakeStore("kv");
		const pool = new BlobPool(
			[member("s3", bucket), member("kv", namespace)],
			policy({ kvRole: "cache", kvShareMaxBytes: 0, kvCacheMaxBytes: 1024 * 1024, kvWritesPerDay: 5 }),
		);
		const tasks: Promise<unknown>[] = [];
		const defer = { waitUntil: (task: Promise<unknown>) => void tasks.push(task) };
		const stamped: string[] = [];

		const first = await pool.read("pp/v1/file/a", null, {
			defer,
			stamp: async (provider) => void stamped.push(provider),
		});
		expect(first?.httpEtag).toBe('"s3"');
		await Promise.all(tasks);

		expect(namespace.puts.map((entry) => entry.key)).toEqual(["pp/v1/file/a"]);
		// The copy expires on its own, so a namespace nobody maintains cannot fill up.
		expect(namespace.puts[0]?.options.ttlSeconds).toBeGreaterThan(0);
		expect(stamped).toEqual(["kv"]);

		// Next time, the row names the namespace and the bucket is not asked at all.
		const second = await pool.read("pp/v1/file/a", "kv", { defer });
		expect(second?.httpEtag).toBe('"kv"');
		expect(bucket.reads).toHaveLength(1);
		expect(pool.share().cache_hits).toBe(1);
		expect(pool.share().cache_fills).toBe(1);
	});

	it("copies nothing when there is no context left to finish the copy in", async () => {
		const bucket = new FakeStore("s3", ["pp/v1/file/a"]);
		const namespace = new FakeStore("kv");
		const pool = new BlobPool(
			[member("s3", bucket), member("kv", namespace)],
			policy({ kvRole: "cache", kvShareMaxBytes: 0 }),
		);

		const body = await pool.read("pp/v1/file/a", null);
		expect(body?.httpEtag).toBe('"s3"');
		expect(namespace.puts).toHaveLength(0);
	});

	it("leaves a body too large to cache, or one the day has no room for, in the bucket", async () => {
		const bucket = new FakeStore("s3", ["pp/v1/file/a"]);
		const oversized = new FakeStore("kv");
		const pool = new BlobPool(
			[member("s3", bucket), member("kv", oversized)],
			policy({ kvRole: "cache", kvShareMaxBytes: 0, kvCacheMaxBytes: 1 }),
		);
		const tasks: Promise<unknown>[] = [];
		await pool.read("pp/v1/file/a", null, { defer: { waitUntil: (t) => void tasks.push(t) } });
		await Promise.all(tasks);
		expect(oversized.puts).toHaveLength(0);

		const spent = new FakeStore("kv");
		const exhausted = new BlobPool(
			[member("s3", bucket), member("kv", spent)],
			policy({ kvRole: "cache", kvShareMaxBytes: 0, kvCacheMaxBytes: 1024 * 1024, kvWritesPerDay: 0 }),
		);
		await exhausted.read("pp/v1/file/a", null, { defer: { waitUntil: (t) => void tasks.push(t) } });
		expect(spent.puts).toHaveLength(0);
		// Free-tier KV allows 1,000 writes a day; the pool is aimed well under it and
		// stops early rather than discovering the ceiling through failed uploads.
		expect(exhausted.share().kv_writes_left).toBe(0);
	});

	it("pools every configured store, and writes to one when asked to", () => {
		const both = resolveStorage(fake({ ...S3_CONFIGURED, BLOBS: {} }));
		expect(both.providers).toEqual(["s3", "kv"]);
		expect(both.mode).toBe("pool");
		expect(both.reason).toContain("pooled");
		expect(both.reason).toContain("KV namespace bound as BLOBS");
		// A bucket and a namespace together means the bucket is the origin, so the
		// namespace's job is serving reads rather than holding the only copy.
		expect(both.objects.share().kv_role).toBe("cache");
		expect(both.reason).toContain("cached in the namespace");

		// `off` is the old shape: one writer, and the retired binding kept readable so
		// links made before the switch still open while it drains.
		const one = resolveStorage(fake({ ...S3_CONFIGURED, BLOBS: {}, BLOB_POOL: "off" }));
		expect(one.mode).toBe("single");
		expect(one.provider).toBe("s3");
		expect(one.objects.status().map((entry) => entry.role)).toEqual(["write", "read-only"]);

		// Closing the retired store entirely takes the second writer with it: one knob
		// has to mean one thing.
		const alone = resolveStorage(fake({ ...S3_CONFIGURED, BLOBS: {}, STORAGE_FALLBACK: "off" }));
		expect(alone.providers).toEqual(["s3"]);
		expect(alone.objects.share().kv_share_bytes).toBe(0);
		// A store that is not bound is not offered, and not a mistake worth failing for.
		expect(resolveStorage(fake({ ...S3_CONFIGURED, STORAGE_FALLBACK: "r2" })).providers).toEqual(["s3"]);
		// A plain KV deployment runs through the same pool machinery with one store in it:
		// nothing is placed in a read-only binding, and a lone writer is reported as one.
		const onlyKv = resolveStorage(fake({ BLOBS: {} }));
		expect(onlyKv.provider).toBe("kv");
		expect(onlyKv.mode).toBe("single");
		expect(onlyKv.objects).toBeInstanceOf(BlobPool);
		// A read-only KV binding never gets a share: nothing may be placed in it.
		expect(resolveStorage(fake({ ...S3_CONFIGURED, BLOBS: {}, BLOB_POOL: "off" })).objects.share().kv_share_bytes).toBe(
			0,
		);
	});

	it("refuses to invent a backend rather than write to nowhere", () => {
		expect(() => resolveStorage(fake({ STORAGE_PROVIDER: "s3", BLOBS: {}, BLOB_POOL: "off" }))).toThrow(
			/pinned but not configured/,
		);
	});

	it("records in the row which store took the body", async () => {
		const big = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 64) });
		expect((await readRow(big.id))?.blob_store).toBe("kv");

		// An inline paste has no body to place, and says so rather than naming a store
		// that holds nothing.
		const small = await createPaste({ content: "short" });
		expect((await readRow(small.id))?.blob_store).toBeNull();
	});

	it("opens a paste whose row does not know where its bytes are", async () => {
		const created = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 64) });
		await testEnv.DB.prepare("UPDATE pastes SET blob_store = NULL WHERE id = ?").bind(created.id).run();

		// The body is text, so the raw route is the honest one to ask; the point is that
		// an unknown placement still resolves.
		const response = await request(`/raw/${created.id}`);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("yyyy");
	});

	it("walks every store for orphans, and never deletes what it cannot date", async () => {
		const now = Date.now();
		const live = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 64) });
		const deleted: string[] = [];
		const namespace = {
			list: async () => ({
				keys: [
					// Still pointed at by a row: the listing sees it, the sweep leaves it.
					{ name: `pp/v1/text/${live.id}`, metadata: { createdAt: now - 6 * 3_600_000 } },
					// Nobody's, and old enough that no request can still be holding it.
					{ name: "pp/v1/file/gone", metadata: { createdAt: now - 3 * 3_600_000 } },
					// An upload from a minute ago.
					{ name: "pp/v1/file/fresh", metadata: { createdAt: now - 60_000 } },
					// Stored before the stamp existed, so its age is unknowable.
					{ name: "pp/v1/file/undated", metadata: null },
				],
				list_complete: true,
			}),
			get: async () => null,
			getWithMetadata: async () => ({ value: null, metadata: null }),
			put: async () => undefined,
			delete: async (key: string) => void deleted.push(key),
		};

		const report = await sweepOrphans(fake({ DB: testEnv.DB, BLOBS: namespace }), testConfig, now, {
			graceMs: 2 * 3_600_000,
		});

		expect(deleted).toEqual(["pp/v1/file/gone"]);
		expect(report.removed).toBe(1);
		expect(report.scanned).toBe(4);
		expect(report.stores.kv).toEqual({ scanned: 4, removed: 1 });
		expect(report.skipped).toBe("");
		// And the live paste is untouched by all of it.
		expect((await readRow(live.id))?.blob_store).toBe("kv");
	});
});

const LIST_VERSIONS = `<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult>
  <Version><Key>pp/v1/file/a</Key><VersionId>v1</VersionId><IsLatest>true</IsLatest></Version>
  <Version><Key>pp/v1/file/a</Key><VersionId>v2</VersionId></Version>
  <DeleteMarker><Key>pp/v1/file/a</Key><VersionId>v3</VersionId></DeleteMarker>
  <Version><Key>pp/v1/file/other</Key><VersionId>x1</VersionId></Version>
</ListVersionsResult>`;

describe("bucket listing and version purging", () => {
	it("collects every version id of one key, markers included", () => {
		expect(versionsOf(LIST_VERSIONS, "pp/v1/file/a")).toEqual(["v1", "v2", "v3"]);
		expect(versionsOf(LIST_VERSIONS, "pp/v1/file/gone")).toEqual([]);
	});

	it("reads keys and timestamps out of a ListObjectsV2 body", () => {
		const body = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents><Key>pp/v1/file/a</Key><LastModified>2026-10-11T04:00:00.000Z</LastModified></Contents>
  <Contents><Key>pp/v1/file/b%20c</Key><LastModified>not-a-date</LastModified></Contents>
  <NextContinuationToken>page2</NextContinuationToken>
</ListBucketResult>`;
		const parsed = listingsOf(body);
		expect(parsed[0]?.key).toBe("pp/v1/file/a");
		expect(Date.parse(parsed[0]!.lastModified ? new Date(parsed[0]!.lastModified).toISOString() : "")).toBeGreaterThan(
			0,
		);
		expect(parsed[1]?.lastModified).toBe(0);
	});

	it("deletes versions after the plain delete, and survives a bucket that says no", async () => {
		const seen: string[] = [];
		const store = new S3ObjectStore(
			{
				endpoint: "https://s3.us-east-002.backblazeb2.com",
				bucket: "my-bucket",
				accessKeyId: "AKIA",
				secretAccessKey: "secret",
				region: "us-west-002",
				purgeVersions: true,
			},
			undefined,
			(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = new URL(String(input));
				seen.push(`${init?.method} ${url.pathname}${url.search}`);
				if (url.searchParams.has("versions"))
					return new Response(LIST_VERSIONS, { headers: { "Content-Type": "application/xml" } });
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		);

		const result = await store.delete(["pp/v1/file/a"]);
		expect(result).toEqual({ deleted: 1, failed: [] });
		expect(seen).toEqual([
			"DELETE /my-bucket/pp/v1/file/a",
			"GET /my-bucket/?versions=&prefix=pp%2Fv1%2Ffile%2Fa&max-keys=1000",
			"DELETE /my-bucket/pp/v1/file/a?versionId=v1",
			"DELETE /my-bucket/pp/v1/file/a?versionId=v2",
			"DELETE /my-bucket/pp/v1/file/a?versionId=v3",
		]);
	});

	it("leaves versions alone when the operator says the bucket is unversioned", async () => {
		const seen: string[] = [];
		const store = new S3ObjectStore(
			{
				endpoint: "https://s3.us-west-002.backblazeb2.com",
				bucket: "my-bucket",
				accessKeyId: "AKIA",
				secretAccessKey: "secret",
				region: "us-west-002",
				purgeVersions: false,
			},
			undefined,
			(async (input: RequestInfo | URL) => {
				seen.push(new URL(String(input)).search);
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		);
		await store.delete(["pp/v1/file/a"]);
		expect(seen).toEqual([""]);
	});
});

/** A transport that records calls and answers from a queue of canned responses. */
function recorder(responses: Array<{ status?: number; body?: string; headers?: Record<string, string> }> = []) {
	const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = responses.shift() ?? { status: 200, body: "[]" };
		calls.push({
			url: String(input),
			method: init?.method ?? "GET",
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: typeof init?.body === "string" ? init.body : "",
		});
		return new Response(response.body || null, { status: response.status ?? 200, headers: response.headers });
	}) as typeof fetch;
	return { calls, fetchImpl };
}

/** A paste row with every field a mirror has to carry. */
function sampleRecord(): PasteRecord {
	return {
		id: "abc123",
		kind: "text",
		title: null,
		language: null,
		filename: null,
		contentType: null,
		sizeBytes: 12,
		content: "hello there",
		objectKey: null,
		passwordSalt: null,
		passwordVerifier: null,
		passwordIterations: null,
		passwordAlgo: null,
		manageHash: "hash",
		burnAfterRead: false,
		encrypted: false,
		markdown: true,
		redirectUrl: null,
		createdAt: 1000,
		expiresAt: 2000,
		consumedAt: null,
		views: 0,
	};
}

function sampleRow(): Record<string, unknown> {
	return {
		id: "abc123",
		kind: "text",
		title: null,
		language: null,
		filename: null,
		content_type: null,
		size_bytes: 12,
		content: "hello there",
		object_key: null,
		password_salt: null,
		password_verifier: null,
		password_iterations: null,
		password_algo: null,
		manage_hash: "hash",
		burn_after_read: false,
		encrypted: false,
		markdown: true,
		redirect_url: null,
		created_at: 1000,
		expires_at: 2000,
		consumed_at: null,
		views: 0,
	};
}

const SUPABASE_SETTINGS = {
	url: "https://demo.supabase.co",
	key: "service-key",
	credential: "service" as const,
	table: "pastes",
	timeoutMs: 2500,
};

describe("Supabase runtime mirror", () => {
	it("enables the mirror only when a key can actually write", () => {
		const anon = supabaseSettingsFromEnv(
			fake({ SUPABASE_URL: "https://demo.supabase.co", SUPABASE_ANON_KEY: "a-b-c" }),
		);
		expect(anon.settings?.credential).toBe("anon");
		expect(anon.mirror).toBe(false);
		expect(anon.keepAlive).toBe(true);

		const service = supabaseSettingsFromEnv(
			fake({ SUPABASE_URL: "https://demo.supabase.co/", SUPABASE_SECRET_KEY: "s-e-c" }),
		);
		expect(service.settings?.credential).toBe("service");
		expect(service.settings?.url).toBe("https://demo.supabase.co");
		expect(service.mirror).toBe(true);

		expect(supabaseSettingsFromEnv(fake({ SUPABASE_ANON_KEY: "a" })).settings).toBeNull();
		expect(supabaseSettingsFromEnv(fake({ SUPABASE_URL: "https://demo.supabase.co" })).settings).toBeNull();
		// Asked for explicitly with a key that cannot do it: refuse, do not half-work.
		expect(() =>
			supabaseSettingsFromEnv(
				fake({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_MIRROR: "on" }),
			),
		).toThrow(/needs SUPABASE_SECRET_KEY/);
		// Keep-alive is the one thing that is useful even with no data access.
		expect(
			supabaseSettingsFromEnv(
				fake({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_KEEPALIVE: "off" }),
			).keepAlive,
		).toBe(false);
	});

	it("upserts the whole row with the service key on both headers", async () => {
		const { calls, fetchImpl } = recorder();
		const store = new SupabaseStore(SUPABASE_SETTINGS, true, fetchImpl);
		await store.upsert({ ...sampleRecord(), passwordVerifier: "hashed" } as PasteRecord);

		const call = calls[0]!;
		expect(call.method).toBe("POST");
		expect(call.url).toBe("https://demo.supabase.co/rest/v1/pastes");
		expect(call.headers.apikey).toBe("service-key");
		expect(call.headers.authorization).toBe("Bearer service-key");
		expect(call.headers.prefer).toContain("resolution=merge-duplicates");
		const row = JSON.parse(call.body) as Record<string, unknown>;
		expect(row.id).toBe("abc123");
		expect(row.burn_after_read).toBe(false);
		expect(row.expires_at).toBe(2000);
		expect(store.status.writes).toBe(1);
		expect(store.status.lastError).toBeNull();
	});

	it("claims a burn only where the row is still unclaimed", async () => {
		const { calls, fetchImpl } = recorder();
		const store = new SupabaseStore(SUPABASE_SETTINGS, true, fetchImpl);
		await store.markConsumed("abc123", 1500);
		expect(calls[0]!.method).toBe("PATCH");
		expect(calls[0]!.url).toContain("/rest/v1/pastes?id=eq.abc123&consumed_at=is.null");
		expect(JSON.parse(calls[0]!.body)).toEqual({ consumed_at: 1500 });
	});

	it("batches view counts through the function that can add them", async () => {
		const { calls, fetchImpl } = recorder();
		const store = new SupabaseStore(SUPABASE_SETTINGS, true, fetchImpl);
		await store.addViews([
			{ id: "a", count: 2 },
			{ id: "b", count: 5 },
		]);
		expect(calls[0]!.url).toBe("https://demo.supabase.co/rest/v1/rpc/apply_views");
		expect(JSON.parse(calls[0]!.body)).toEqual({
			deltas: [
				{ paste_id: "a", delta: 2 },
				{ paste_id: "b", delta: 5 },
			],
		});
		await store.addViews([]);
		expect(calls).toHaveLength(1);
	});

	it("purges expired and consumed rows and reads the count PostgREST reports", async () => {
		const { calls, fetchImpl } = recorder([{ status: 204, body: "", headers: { "content-range": "*/7" } }]);
		const store = new SupabaseStore(SUPABASE_SETTINGS, true, fetchImpl);
		const removed = await store.purgeExpired(1000, 100);
		expect(removed).toBe(7);
		expect(calls[0]!.method).toBe("DELETE");
		// The same five-minute grace the D1 sweep uses, so a reader mid-download keeps
		// their copy in both stores.
		expect(calls[0]!.url).toContain("or=(expires_at.lte.1000,consumed_at.lte.-299000)");
		// A grace period of zero would delete rows the sweep has not reached yet.
		const zero = recorder([{ status: 204, body: "" }]);
		await new SupabaseStore(SUPABASE_SETTINGS, true, zero.fetchImpl).purgeExpired(1000, 100, 0);
		expect(zero.calls[0]!.url).toContain("consumed_at.lte.1000");
	});

	it("reads a record back for the fallback path", async () => {
		const { fetchImpl } = recorder([
			{
				status: 200,
				body: JSON.stringify([{ ...sampleRow(), burn_after_read: 1, size_bytes: "42" }]),
			},
		]);
		const store = new SupabaseStore(SUPABASE_SETTINGS, true, fetchImpl);
		const record = await store.findById("abc123");
		expect(record?.burnAfterRead).toBe(true);
		expect(record?.sizeBytes).toBe(42);
		expect(store.status.fallbackReads).toBe(1);
	});

	it("counts any answer from the API as awake, and only a 2xx as the keepalive running", async () => {
		const happy = new SupabaseStore(SUPABASE_SETTINGS, true, recorder([{ status: 200, body: "[1]" }]).fetchImpl);
		expect(await happy.ping()).toEqual({ reachable: true, keepaliveRan: true, detail: "rpc" });

		// The state a brand-new project is in: reachable, schema not applied yet.
		const noSchema = recorder([
			{ status: 404, body: '{"code":"PGRST202"}' },
			{ status: 200, body: "{}" },
		]);
		const missing = new SupabaseStore(SUPABASE_SETTINGS, true, noSchema.fetchImpl);
		expect(await missing.ping()).toEqual({ reachable: true, keepaliveRan: false, detail: "schema-missing (root 200)" });

		// A permission denial is Postgres refusing, which is still traffic, and is
		// exactly what an anon key with no grants produces.
		const denied = new SupabaseStore(SUPABASE_SETTINGS, true, recorder([{ status: 401, body: "{}" }]).fetchImpl);
		expect(await denied.ping()).toEqual({ reachable: true, keepaliveRan: false, detail: "rpc401" });

		const dead = new SupabaseStore(SUPABASE_SETTINGS, true, (async () => {
			throw new TypeError("fetch failed");
		}) as typeof fetch);
		expect((await dead.ping()).reachable).toBe(false);
	});

	it("does nothing at all when the mirror is off, and nothing that can fail a request", async () => {
		const { calls, fetchImpl } = recorder([{ status: 503, body: "upstream refused" }]);
		const keepalive = new SupabaseStore(SUPABASE_SETTINGS, false, fetchImpl);
		await keepalive.upsert(sampleRecord() as PasteRecord);
		await keepalive.deleteMany(["abc123"]);
		expect(calls).toHaveLength(0);
		expect(keepalive.status.mirror).toBe("keepalive-only");

		const broken = new SupabaseStore(SUPABASE_SETTINGS, true, fetchImpl);
		expect(await broken.upsert(sampleRecord() as PasteRecord)).toBe(false);
		expect(broken.status.writeFailures).toBe(1);
		expect(broken.status.lastError).toContain("503");
	});
});

describe("the hourly cron", () => {
	beforeEach(resetStorage);

	/**
	 * Plain objects on purpose. The pool's own `createScheduledController` /
	 * `createExecutionContext` hand workerd proxies across the boundary, and the
	 * Worker's `console.log(controller.cron)` then dies trying to serialise one —
	 * which looks exactly like a bug in the handler if you do not know where it comes
	 * from. `waitUntil` is collected and awaited by hand, so the assertions below run
	 * after the cron's work is genuinely finished.
	 */
	const tasks: Promise<unknown>[] = [];
	const ctx = { waitUntil: (task: Promise<unknown>) => void tasks.push(task), passThroughOnException: () => undefined };

	async function runCron(scheduledTime: number): Promise<void> {
		tasks.length = 0;
		await worker.scheduled?.({ type: "scheduled", cron: "17 * * * *", scheduledTime, noCache: false }, testEnv, ctx);
		await Promise.all(tasks);
	}

	it("removes an expired paste and its object, whichever store holds the bytes", async () => {
		const created = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 32) });
		const at = Date.now();
		await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
			.bind(at - 1000, created.id)
			.run();
		expect(await objectKeys()).toHaveLength(1);

		await runCron(at);

		expect(await readRow(created.id)).toBeNull();
		expect(await objectKeys()).toHaveLength(0);
	});

	it("leaves a live paste for its own expiry to handle", async () => {
		const created = await createPaste({ content: "still here" });
		await runCron(Date.now());
		expect(await readRow(created.id)).not.toBeNull();
	});

	it("keeps Supabase awake, and treats an unreachable project as a log line", async () => {
		// A transport that cannot connect: every failure mode of the mirror has to end
		// in a status, never in a thrown error that stops the rest of the run.
		const env = fake({ SUPABASE_URL: "https://demo.supabase.co", SUPABASE_ANON_KEY: "publishable" });
		const dead = (async () => {
			throw new TypeError("Network connection lost.");
		}) as typeof fetch;
		const report = await runMaintenance(env, testConfig, Date.UTC(2026, 9, 12, 5, 17), dead);

		expect(report.supabase).toBe("unreachable");
		expect(report.supabaseKeepaliveRan).toBe(false);
		expect(report.supabaseDetail).toBeTruthy();
		expect(report.mirrorRowsRemoved).toBe(0);
		expect(report.orphans).toBe(0);
	});

	it("does the bucket listing once a day, not every hour", async () => {
		const env = fake({ SUPABASE_URL: "https://demo.supabase.co", SUPABASE_ANON_KEY: "publishable" });
		const dead = (async () => {
			throw new TypeError("no");
		}) as typeof fetch;
		const quietHour = Date.UTC(2026, 9, 12, 4, 17);

		expect((await runMaintenance(env, testConfig, quietHour, dead)).deep).toBe(true);
		expect((await runMaintenance(env, testConfig, quietHour + 3_600_000, dead)).deep).toBe(false);
		// With no object store bound at all the deep pass reports why it skipped
		// instead of taking the cron run down with it.
		expect((await sweepOrphans(env, testConfig, quietHour)).skipped).toContain("No blob storage");
	});
});

describe("cron shape", () => {
	it("runs the deep pass once a day, in a quiet hour", () => {
		expect(isDeepPassHour(Date.UTC(2026, 9, 12, 4, 17, 0))).toBe(true);
		expect(isDeepPassHour(Date.UTC(2026, 9, 12, 4, 0, 0))).toBe(true);
		expect(isDeepPassHour(Date.UTC(2026, 9, 12, 17, 17, 0))).toBe(false);
		expect(isDeepPassHour(Date.UTC(2026, 9, 12, 3, 59, 0))).toBe(false);
	});

	it("reports the mirror through the public config, with no keys in it", async () => {
		const body = (await (await request("/api/config")).json()) as {
			supabase: { enabled: boolean; mirror: string; credential: string };
			storage: { provider: string; providers: string[]; mode: string; stores: Array<{ role: string }> };
		};
		// The test Worker has neither Supabase var: the honest answer is "off".
		expect(body.supabase.enabled).toBe(false);
		expect(body.supabase.mirror).toBe("off");
		expect(body.storage.providers).toEqual(["kv"]);
		expect(body.storage.stores.map((entry) => entry.role)).toEqual(["write"]);
		expect(JSON.stringify(body)).not.toMatch(/key|token|secret/i);
	});
});
