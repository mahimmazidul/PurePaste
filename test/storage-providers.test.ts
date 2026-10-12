import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { resolveConfig } from "../src/config";
import { buildCsp } from "../src/middleware/security";
import { resolveStorage } from "../src/services/storage-provider";
import { S3ObjectStore, s3SettingsFromEnv, testing } from "../src/services/s3-store";
import { createPaste, objectKeys, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";
import { sweep } from "../src/services/cleanup";
import { stores } from "../src/services/paste-store";
import type { BlobStore } from "../src/services/object-store";

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

const FIREBASE_CONFIGURED = {
	FIREBASE_PROJECT_ID: "p",
	FIREBASE_BUCKET: "p.appspot.com",
	FIREBASE_CLIENT_EMAIL: "svc@p.iam.gserviceaccount.com",
	FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nT0tA\n-----END PRIVATE KEY-----\n",
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
		expect(resolveStorage(fake({ ...S3_CONFIGURED, ...FIREBASE_CONFIGURED })).provider).toBe("s3");
		expect(resolveStorage(fake({ ...FIREBASE_CONFIGURED })).provider).toBe("firebase");
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
			storage: { provider: string; reason: string; direct_links: boolean };
		};
		// The test Worker binds KV only, which is also the shape of the live deploy.
		expect(body.storage.provider).toBe("kv");
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
		expect(
			resolveConfig({ STORAGE_DIRECT_LINKS: "on", FIREBASE_PUBLIC_BASE: "https://storage.googleapis.com/b" })
				.storageDirectOrigin,
		).toBe("https://storage.googleapis.com");
		expect(
			resolveConfig({ STORAGE_DIRECT_LINKS: "on", S3_PUBLIC_BASE: "http://cdn.example.com" }).storageDirectOrigin,
		).toBeUndefined();
		expect(resolveConfig({ S3_PUBLIC_BASE: "https://cdn.example.com" }).storageDirectOrigin).toBeUndefined();
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
