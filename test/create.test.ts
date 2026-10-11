import { beforeEach, describe, expect, it } from "vitest";
import { createPaste as apiCreate, jsonRequest, objectKeys, readJson, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";
import { createPaste as serviceCreate } from "../src/services/paste-store";
import { TTL_CHOICES } from "../src/config";

describe("paste creation", () => {
	beforeEach(resetStorage);

	it("creates a text paste and stores the body in D1", async () => {
		const created = await apiCreate({ content: "hello purepaste", title: "Greeting" });
		const row = await readRow(created.id);

		expect(created.id).toMatch(/^[0-9a-z]{10}$/);
		expect(row?.content).toBe("hello purepaste");
		expect(row?.object_key).toBeNull();
		expect(row?.title).toBe("Greeting");
		expect(await objectKeys()).toEqual([]);
		expect(created.manage_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("never stores the management token in plaintext", async () => {
		const created = await apiCreate({ content: "secret" });
		const row = await readRow(created.id);
		expect(JSON.stringify(row)).not.toContain(created.manage_token);
		expect(String(row?.manage_hash)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("defaults to seven days and honours each offered lifetime", async () => {
		const created = await apiCreate({ content: "default" });
		const row = await readRow(created.id);
		const lifetime = Number(row?.expires_at) - Number(row?.created_at);
		expect(lifetime).toBe(7 * 24 * 60 * 60 * 1000);

		for (const choice of TTL_CHOICES) {
			const body = await apiCreate({ content: `ttl ${choice.value}`, expire: choice.value });
			const scoped = await readRow(body.id);
			expect(Number(scoped?.expires_at) - Number(scoped?.created_at)).toBe(choice.seconds * 1000);
		}
	});

	it("clamps an over-long request to the thirty day server maximum", async () => {
		const created = await apiCreate({ content: "forever?", expire: "31536000" });
		const row = await readRow(created.id);
		const lifetime = Number(row?.expires_at) - Number(row?.created_at);
		expect(lifetime).toBe(30 * 24 * 60 * 60 * 1000);
		expect(row?.expires_at).toBeGreaterThan(0);
	});

	it("rejects an unknown expiration instead of guessing", async () => {
		const response = await jsonRequest("/api/pastes", { content: "x", expire: "never" });
		expect(response.status).toBe(400);
		expect((await readJson(response)).error).toBe("invalid_expiration");
	});

	it("rejects empty content", async () => {
		const response = await jsonRequest("/api/pastes", { content: "   " });
		expect(response.status).toBe(400);
		expect((await readJson(response)).error).toBe("invalid_request");
	});

	it("accepts a custom slug, normalises it, and reports collisions", async () => {
		const created = await apiCreate({ content: "slugged", slug: "Release Notes" });
		expect(created.id).toBe("release-notes");

		const duplicate = await jsonRequest("/api/pastes", { content: "again", slug: "release-notes" });
		expect(duplicate.status).toBe(409);
		expect((await readJson(duplicate)).error).toBe("slug_taken");
	});

	it("refuses reserved and unsafe slugs", async () => {
		for (const slug of ["api", "assets", "manage", "raw", "download", "about", "pastes"]) {
			const response = await jsonRequest("/api/pastes", { content: "x", slug });
			expect(response.status).toBe(400);
			expect((await readJson(response)).error).toBe("reserved_slug");
		}
		// A dotted name is refused by the character rules before the reserved list is reached.
		const dotted = await jsonRequest("/api/pastes", { content: "x", slug: "robots.txt" });
		expect(dotted.status).toBe(400);
		expect((await readJson(dotted)).error).toBe("invalid_slug");

		for (const slug of ["ab", "a".repeat(65), "has spaces!", "../escape", "UPPER..case", "-leading", "trailing-"]) {
			const response = await jsonRequest("/api/pastes", { content: "x", slug });
			expect([400, 409]).toContain(response.status);
		}

		// A slug that normalises onto a reserved route must still be refused.
		const disguised = await jsonRequest("/api/pastes", { content: "x", slug: "API" });
		expect(disguised.status).toBe(400);
		expect((await readJson(disguised)).error).toBe("reserved_slug");
	});

	it("ascends when the allowed slug length boundary is respected", async () => {
		const short = await apiCreate({ content: "x", slug: "abc" });
		expect(short.id).toBe("abc");
		const longSlug = "a".repeat(31) + "b".repeat(33);
		const long = await apiCreate({ content: "x", slug: longSlug });
		expect(long.id).toHaveLength(64);
		expect(long.id).toBe(longSlug);
	});

	it("retries after an id collision and cleans up the orphaned object", async () => {
		const first = await apiCreate({ content: "occupies the id" });

		const ids = [first.id, "retried001"];
		let index = 0;
		const created = await serviceCreate(
			testEnv,
			testConfig,
			{
				kind: "text",
				title: null,
				language: "plaintext",
				markdown: false,
				burnAfterRead: false,
				encrypted: false,
				ttlSeconds: 3600,
				slug: null,
				password: null,
				redirectUrl: null,
				// Large enough to be stored in R2, so the collision path has an object to clean up.
				body: { type: "text", text: "x".repeat(testConfig.inlineTextMaxBytes + 10) },
				filename: null,
				contentType: null,
			},
			{ idFactory: () => ids[index++] ?? "unused000" },
		);

		expect(created.record.id).toBe("retried001");
		const keys = await objectKeys();
		expect(keys).toEqual([`pp/v1/text/retried001`]);
	});

	it("gives up cleanly when every generated id collides", async () => {
		await apiCreate({ content: "occupies the id", slug: "collides01" });
		await expect(
			serviceCreate(testEnv, testConfig, {
				kind: "text",
				title: null,
				language: "plaintext",
				markdown: false,
				burnAfterRead: false,
				encrypted: false,
				ttlSeconds: 3600,
				slug: null,
				password: null,
				redirectUrl: null,
				body: { type: "text", text: "x" },
				filename: null,
				contentType: null,
			}, { idFactory: () => "collides01" }),
		).rejects.toThrow();
	});

	it("collects stdin as a raw body and answers with just the URL", async () => {
		const response = await request("/api/pastes?expire=1h&slug=stdin-paste", {
			method: "POST",
			body: "piped in",
			headers: { "Content-Type": "text/plain", Accept: "text/plain" },
		});
		expect(response.status).toBe(201);
		const text = (await response.text()).trim();
		expect(text).toBe("http://purepaste.test/stdin-paste");
	});

	it("answers JSON by default on the API", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: "curl default",
			headers: { "Content-Type": "text/plain" },
		});
		expect(response.status).toBe(201);
		const body = (await readJson(response)) as { id: string; url: string; raw_url: string; manage_url: string };
		expect(body.url).toContain(body.id);
		expect(body.raw_url).toBe(`http://purepaste.test/raw/${body.id}`);
		expect(body.manage_url).toContain("#token=");
	});

	it("creates a paste from the browser form and renders the result page", async () => {
		const form = new FormData();
		form.set("content", "posted from a form");
		form.set("title", "Form paste");
		form.set("expire", "1d");
		form.set("language", "javascript");

		const response = await request("/", { method: "POST", body: form, headers: { Accept: "text/html" } });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Paste created");
		expect(html).toContain("Keep this link somewhere safe");
		expect(html).toContain("#token=");
		expect(html).toContain('data-created=');
	});

	it("re-renders the form with the typed values when a form is rejected", async () => {
		const form = new FormData();
		form.set("content", "kept");
		form.set("slug", "api");

		const response = await request("/", { method: "POST", body: form, headers: { Accept: "text/html" } });
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).toContain("reserved by PurePaste");
		expect(html).toContain("kept");
	});
});
