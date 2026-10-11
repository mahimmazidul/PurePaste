import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, createPaste, objectKeys, readJson, readRow, request, resetStorage, testEnv } from "./helpers";
import { createApp } from "../src/app";

/**
 * The terminal-facing surface: create, read, list-free metadata, raw content and
 * delete, all through content negotiation rather than a User-Agent guess.
 */
describe("api", () => {
	beforeEach(resetStorage);

	it("answers plain curl with the URL and nothing else", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: "just the text",
			headers: { "Content-Type": "text/plain", Accept: "text/plain" },
		});

		expect(response.status).toBe(201);
		expect(response.headers.get("Content-Type")).toContain("text/plain");
		const body = await response.text();
		expect(body).toMatch(/^http:\/\/purepaste\.test\/p\/[a-z0-9]{10}\n$/);
	});

	it("honours ?format=url without any Accept header", async () => {
		const response = await request("/api/pastes?format=url", {
			method: "POST",
			body: "no accept header at all",
			headers: { "Content-Type": "text/plain" },
		});
		expect(response.status).toBe(201);
		expect((await response.text()).trim()).toMatch(/^http:\/\/purepaste\.test\/p\/[a-z0-9]{10}$/);
	});

	it("reports live totals and health", async () => {
		await request("/api/pastes", {
			method: "POST",
			body: "counted",
			headers: { "Content-Type": "text/plain", Accept: "application/json" },
		});
		const stats = await readJson<{ slips: number; links: number; files: number; bytes: number }>(
			await request("/api/stats"),
		);
		expect(stats.slips).toBeGreaterThanOrEqual(1);
		expect(stats.bytes).toBeGreaterThanOrEqual(7);

		const health = await readJson<{ ok: boolean }>(await request("/api/health"));
		expect(health.ok).toBe(true);
	});

	it("takes piped stdin and returns JSON when asked for it", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: "echo hello | curl --data-binary @-",
			headers: { "Content-Type": "text/plain", Accept: "application/json" },
		});
		const created = await readJson<{ id: string; url: string }>(response);

		expect(response.status).toBe(201);
		expect(created.url).toBe(`${ORIGIN}/p/${created.id}`);
		expect((await request(`/raw/${created.id}`)).status).toBe(200);
	});

	it("defaults to JSON when nothing is stated", async () => {
		const response = await request("/api/pastes", { method: "POST", body: "curl --data-binary @-" });
		expect(response.status).toBe(201);
		expect(response.headers.get("Content-Type")).toContain("application/json");
	});

	it("accepts a complete JSON body and echoes what it stored", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({
				content: "const answer = 42;\n",
				title: "Answer",
				language: "typescript",
				expire: "7d",
				slug: "answer-42",
			}),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		const created = await readJson<Record<string, unknown>>(response);

		expect(response.status).toBe(201);
		expect(created.id).toBe("answer-42");
		expect(created.kind).toBe("text");
		expect(created.encrypted).toBe(false);
		expect(created.burn_after_reading).toBe(false);
		expect(created.expires_in_seconds).toBe(604800);
		expect(created.raw_url).toBe(`${ORIGIN}/raw/answer-42`);
		expect(created.download_url).toBeNull();
		expect(typeof created.manage_token).toBe("string");
	});

	it("publishes metadata without ever leaking the management token", async () => {
		const created = await createPaste({ content: "metadata please" });
		const response = await request(`/api/pastes/${created.id}`, { headers: { Accept: "application/json" } });
		const text = await response.text();

		expect(response.status).toBe(200);
		expect(text).not.toContain(created.manage_token);
		const meta = JSON.parse(text) as Record<string, unknown>;
		expect(meta.id).toBe(created.id);
		expect(meta.locked).toBe(false);
		expect(meta.links).toMatchObject({ url: `${ORIGIN}/${created.id}`, raw_url: `${ORIGIN}/raw/${created.id}` });
		expect(meta.views).toBeNull(); // view counting is off by default
	});

	it("serves raw content to a terminal without a User-Agent telling it to", async () => {
		const created = await createPaste({ content: "plain and simple" });
		const response = await request(`/api/pastes/${created.id}/raw`, {
			headers: { Accept: "text/plain", "User-Agent": "Mozilla/5.0 (compatible; Fancy Browser)" },
		});

		// A browser user agent does not turn the API into a page.
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/plain");
		expect(await response.text()).toBe("plain and simple");
	});

	it("wraps raw content in JSON when that is what was asked for", async () => {
		const created = await createPaste({ content: "json wrapped" });
		const response = await request(`/api/pastes/${created.id}/raw?format=json`, {
			headers: { Accept: "application/json" },
		});
		const body = await readJson<{ id: string; content: string }>(response);

		expect(response.status).toBe(200);
		expect(body.id).toBe(created.id);
		expect(body.content).toBe("json wrapped");
	});

	it("deletes with a token in an authorization header", async () => {
		const created = await createPaste({ content: "delete me from a terminal" });
		const response = await request(`/api/pastes/${created.id}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${created.manage_token}`, Accept: "application/json" },
		});

		expect(response.status).toBe(200);
		expect((await readJson<{ deleted: boolean }>(response)).deleted).toBe(true);
		expect(await readRow(created.id)).toBeNull();
		expect(await objectKeys()).toEqual([]);
	});

	it("refuses a token passed in the query string", async () => {
		const created = await createPaste({ content: "not this way" });
		const response = await request(`/api/pastes/${created.id}?token=${created.manage_token}`, {
			method: "DELETE",
			headers: { Accept: "application/json" },
		});

		expect(response.status).toBe(401);
		expect((await readJson<{ error: string }>(response)).error).toBe("unauthorized");
		expect(await readRow(created.id)).not.toBeNull();
	});

	it("reports errors as structured JSON with usable status codes", async () => {
		const missing = await request(`/api/pastes/${"z".repeat(10)}`, { headers: { Accept: "application/json" } });
		expect(missing.status).toBe(404);
		expect(await readJson<{ error: string; message: string }>(missing)).toMatchObject({ error: "not_found" });

		const badId = await request("/api/pastes/NOT-AN-ID", { headers: { Accept: "application/json" } });
		expect(badId.status).toBe(404);

		const badType = await request("/api/pastes", {
			method: "POST",
			body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
			headers: { "Content-Type": "image/png", Accept: "application/json" },
		});
		expect(badType.status).toBe(415);
		expect((await readJson<{ error: string }>(badType)).error).toBe("unsupported_media_type");

		const notAllowed = await request("/api/pastes", { method: "PUT", headers: { Accept: "application/json" } });
		expect(notAllowed.status).toBe(405);
		expect(notAllowed.headers.get("Allow")).toContain("POST");

		const options = await request("/api/pastes", { method: "OPTIONS" });
		expect(options.status).toBe(204);
		expect(options.headers.get("Allow")).toContain("POST");
	});

	it("describes itself at /api/config without giving anything away", async () => {
		const response = await request("/api/config", { headers: { Accept: "application/json" } });
		const text = await response.text();
		const config = JSON.parse(text) as {
			ttl_choices: Array<{ value: string; seconds: number }>;
			max_ttl_seconds: number;
			features: Record<string, boolean>;
		};

		expect(response.status).toBe(200);
		expect(config.ttl_choices).toHaveLength(5);
		expect(config.ttl_choices.at(-1)?.seconds).toBe(2592000);
		expect(config.max_ttl_seconds).toBe(2592000);
		expect(config.features).toMatchObject({ redirect: true, view_counting: false, turnstile: false });
		// Limits and iteration counts are public; secrets and tokens are not.
		expect(text).not.toMatch(/app_secret|appsecret|secret_|manage_token|bearer/i);
		expect(text).not.toContain("purepaste-development-secret");
	});

	it("cannot be asked to list pastes", async () => {
		await createPaste({ content: "one" });
		await createPaste({ content: "two" });

		for (const path of ["/api/pastes", "/api/pastes/all", "/pastes.json"]) {
			const response = await request(path, { headers: { Accept: "application/json" } });
			expect([401, 404, 405]).toContain(response.status);
		}
	});

	it("keeps no addresses or user agents in storage", async () => {
		const created = await createPaste({ content: "nothing about the caller" });
		const row = await readRow(created.id);

		const serialized = JSON.stringify(row);
		expect(serialized).not.toMatch(/203\.0\.113\.|127\.0\.0\.1|Mozilla|User-Agent|ip_address/i);

		const columns = await testEnv.DB.prepare("PRAGMA table_info(pastes)").all<{ name: string }>();
		for (const column of columns.results) {
			expect(column.name).not.toMatch(/^(ip|ip_address|remote|address|user_agent|fingerprint)$/);
		}
	});

	it("returns a plain error page, never a stack trace, when something breaks", async () => {
		// A missing binding is the closest thing to a production failure available
		// here; whatever the cause, the response must stay boring.
		const broken = { ...testEnv, DB: undefined } as unknown as typeof testEnv;
		const response = await createApp().fetch(
			new Request(`${ORIGIN}/api/pastes`, {
				method: "POST",
				body: "text",
				headers: { "Content-Type": "text/plain", Accept: "application/json" },
			}),
			broken,
		);

		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).toContain("internal_error");
		expect(text).not.toMatch(/\bat \w+.*\(.*:\d+:\d+\)/);
		expect(text).not.toMatch(/stack|workerd|miniflare/i);
	});
});
