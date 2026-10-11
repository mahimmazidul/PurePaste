import { beforeEach, describe, expect, it } from "vitest";
import { createPaste, objectKeys, readJson, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";
import { assembleFileInput, assembleTextInput } from "../src/lib/validation";
import { resetViewBuffer, flushViewsNow, recordView } from "../src/services/views";
import { stores } from "../src/services/paste-store";

const SMALL_LIMITS = { ...testConfig, inlineTextMaxBytes: 256, textMaxBytes: 512, fileMaxBytes: 1024 };

describe("size limits", () => {
	beforeEach(resetStorage);

	it("rejects text over the configured maximum", () => {
		expect(() => assembleTextInput({}, "a".repeat(512), SMALL_LIMITS)).not.toThrow();
		try {
			assembleTextInput({}, "a".repeat(513), SMALL_LIMITS);
			throw new Error("should have thrown");
		} catch (error) {
			expect((error as { code: string }).code).toBe("payload_too_large");
			expect((error as { status: number }).status).toBe(413);
		}
	});

	it("measures the limit in bytes rather than characters", () => {
		// Three-byte characters must be counted as three bytes each.
		const text = "あ".repeat(200);
		expect(() => assembleTextInput({}, text, SMALL_LIMITS)).toThrow();
	});

	it("rejects a file over the configured maximum", () => {
		expect(() =>
			assembleFileInput(
				{},
				{ size: 1024, filename: "ok.bin" },
				{ type: "bytes", bytes: new Uint8Array(1024) },
				SMALL_LIMITS,
			),
		).not.toThrow();
		expect(() =>
			assembleFileInput(
				{},
				{ size: 1025, filename: "big.bin" },
				{ type: "bytes", bytes: new Uint8Array(1) },
				SMALL_LIMITS,
			),
		).toThrow();
	});

	it("refuses an empty upload", () => {
		expect(() => assembleFileInput({}, { size: 0, filename: "empty.txt" }, { type: "none" }, SMALL_LIMITS)).toThrow();
	});

	it("rejects an oversized body before reading it", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: "tiny",
			headers: {
				"Content-Type": "text/plain",
				"Content-Length": String(testConfig.fileMaxBytes + 5 * 1024 * 1024),
				Accept: "application/json",
			},
		});
		expect(response.status).toBe(413);
		expect((await readJson(response)).error).toBe("payload_too_large");
	});

	it("accepts a file that fits and stores it in R2", async () => {
		const bytes = new Uint8Array(64 * 1024).fill(7);
		const form = new FormData();
		form.set("file", new File([bytes], "blob.bin", { type: "application/octet-stream" }));

		const created = await readJson<{ id: string }>(
			await request("/api/pastes", { method: "POST", body: form, headers: { Accept: "application/json" } }),
		);
		const row = await readRow(created.id);
		expect(row?.object_key).toBe(`pp/v1/file/${created.id}`);
		expect(row?.size_bytes).toBe(bytes.byteLength);
		expect(await objectKeys()).toEqual([`pp/v1/file/${created.id}`]);

		const raw = await request(`/raw/${created.id}`);
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
	});
});

describe("view counting", () => {
	beforeEach(async () => {
		await resetStorage();
		resetViewBuffer();
	});

	it("writes nothing while the feature is off", async () => {
		const created = await createPaste({ content: "no counting here" });
		recordView(testEnv, { ...testConfig, viewCounting: false }, created.id);
		recordView(testEnv, { ...testConfig, viewCounting: false }, created.id);
		await flushViewsNow(testEnv);

		const row = await readRow(created.id);
		expect(row?.views).toBe(0);
	});

	it("batches reads into a single update when the feature is on", async () => {
		const created = await createPaste({ content: "counted" });
		const config = { ...testConfig, viewCounting: true };

		for (let index = 0; index < 7; index += 1) recordView(testEnv, config, created.id);
		// Nothing has been written yet: reads are buffered in the isolate.
		expect((await readRow(created.id))?.views).toBe(0);

		await flushViewsNow(testEnv);
		expect((await readRow(created.id))?.views).toBe(7);

		// A second flush with an empty buffer changes nothing.
		await flushViewsNow(testEnv);
		expect((await readRow(created.id))?.views).toBe(7);
	});

	it("keeps counting away from the paste rows when disabled at the HTTP layer", async () => {
		const created = await createPaste({ content: "still not counted" });
		await request(`/${created.id}`);
		await request(`/${created.id}`);
		await flushViewsNow(testEnv);
		expect((await readRow(created.id))?.views).toBe(0);
	});
});

describe("encrypted pastes", () => {
	beforeEach(resetStorage);

	/** A stand-in for the browser envelope: opaque bytes the server must not interpret. */
	function envelope(payload: string): Uint8Array {
		return new TextEncoder().encode(`PPv1-not-really-encrypted-but-opaque::${payload}`);
	}

	it("stores ciphertext without learning anything about it", async () => {
		const bytes = envelope("hello");
		const response = await request("/api/pastes?encrypted=1&expire=1d", {
			method: "POST",
			body: bytes,
			headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
		});
		const created = await readJson<{ id: string; encrypted: boolean }>(response);

		expect(response.status).toBe(201);
		expect(created.encrypted).toBe(true);

		const row = await readRow(created.id);
		expect(row?.encrypted).toBe(1);
		expect(row?.title).toBeNull();
		expect(row?.filename).toBeNull();
		expect(row?.content).toBeNull();
		expect(row?.object_key).toBe(`pp/v1/blob/${created.id}`);
		expect(row?.size_bytes).toBe(bytes.byteLength);

		// The bytes come back exactly as they were sent.
		const raw = await request(`/raw/${created.id}`);
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
		expect(raw.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(raw.headers.get("Content-Disposition")).toContain("attachment");
	});

	it("renders an encrypted paste as a lock, not as content", async () => {
		const response = await request("/api/pastes?encrypted=1", {
			method: "POST",
			body: envelope("topsecretvalue"),
			headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
		});
		const created = await readJson<{ id: string }>(response);

		const page = await request(`/${created.id}`);
		const html = await page.text();
		expect(html).toContain("Encrypted paste");
		expect(html).not.toContain("topsecretvalue");
		expect(html).toContain("data-encrypted-view");
	});

	it("publishes no readable metadata for an encrypted paste", async () => {
		const response = await request("/api/pastes?encrypted=1", {
			method: "POST",
			body: envelope("meta"),
			headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
		});
		const created = await readJson<{ id: string }>(response);
		const meta = await readJson<Record<string, unknown>>(
			await request(`/api/pastes/${created.id}`, { headers: { Accept: "application/json" } }),
		);

		expect(meta.encrypted).toBe(true);
		expect(meta.title).toBeNull();
		expect(meta.filename).toBeNull();
		expect(meta.content_type).toBeNull();
	});

	it("accepts a small payload as base64url JSON and rejects a malformed one", async () => {
		const bytes = envelope("json payload");
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		const payload = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

		const ok = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ encrypted: true, payload, expire: "1h" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect(ok.status).toBe(201);

		const invalid = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ encrypted: true, payload: "!!!not base64!!!" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect(invalid.status).toBe(400);

		const missing = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ encrypted: true }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect(missing.status).toBe(415);
	});

	it("refuses a payload that is too short to be an envelope", async () => {
		const response = await request("/api/pastes?encrypted=1", {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
			headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
		});
		expect(response.status).toBe(400);
	});

	it("accepts the envelope the browser posts as a form part", async () => {
		// This is the path the editor takes when somebody ticks "Encrypt in my
		// browser": a multipart form with the envelope as a `payload` part.
		const bytes = envelope("posted from the editor");
		const form = new FormData();
		form.set("encrypted", "1");
		form.set("expire", "1d");
		form.set("payload", new File([bytes], "payload.bin", { type: "application/octet-stream" }));

		const response = await request("/api/pastes", {
			method: "POST",
			body: form,
			headers: { Accept: "application/json" },
		});
		const created = await readJson<{ id: string; encrypted: boolean }>(response);

		expect(response.status).toBe(201);
		expect(created.encrypted).toBe(true);

		const row = await readRow(created.id);
		expect(row?.encrypted).toBe(1);
		expect(row?.kind).toBe("text");
		expect(row?.object_key).toBe(`pp/v1/blob/${created.id}`);
		expect(row?.size_bytes).toBe(bytes.byteLength);

		const raw = await request(`/raw/${created.id}`);
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
	});

	it("keeps the stored object opaque even when the paste is deleted", async () => {
		const created = await readJson<{ id: string; manage_token: string }>(
			await request("/api/pastes?encrypted=1", {
				method: "POST",
				body: envelope("gone"),
				headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
			}),
		);

		const before = await testEnv.BLOBS!.get(`pp/v1/blob/${created.id}`);
		expect(before).not.toBeNull();
		expect(await stores(testEnv).objects.delete([`pp/v1/blob/${created.id}`])).toEqual({ deleted: 1, failed: [] });
	});
});
