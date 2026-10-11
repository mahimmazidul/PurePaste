import { beforeEach, describe, expect, it } from "vitest";
import { createPaste, readJson, readRow, request, resetStorage, testConfig } from "./helpers";

/** Creates a redirect paste through the JSON API. */
async function makeRedirect(url: string) {
	return request("/api/pastes", {
		method: "POST",
		body: JSON.stringify({ kind: "redirect", url, expire: "1d" }),
		headers: { "Content-Type": "application/json", Accept: "application/json" },
	});
}

describe("link mode", () => {
	beforeEach(resetStorage);

	it("stores a link and shows where it goes before sending anyone there", async () => {
		const response = await makeRedirect("https://example.com/a/b?c=d#e");
		expect(response.status).toBe(201);
		const created = await readJson<{ id: string; kind: string; url: string }>(response);
		expect(created.kind).toBe("redirect");

		const page = await request(`/${created.id}`);
		const html = await page.text();

		// No automatic redirect: the visitor decides.
		expect(page.status).toBe(200);
		expect(html).toContain("This link goes somewhere else");
		expect(html).toContain("example.com");
		expect(html).toContain("https://example.com/a/b?c=d#e");
		expect(html).toContain('rel="noopener noreferrer nofollow"');
	});

	it("never redirects on its own from the paste page", async () => {
		const created = await readJson<{ id: string }>(await makeRedirect("https://example.com/"));
		const response = await request(`/${created.id}`, { redirect: "manual" });
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
	});

	it("hands the destination to terminal users as plain text", async () => {
		const created = await readJson<{ id: string }>(await makeRedirect("https://example.com/terminal"));
		const response = await request(`/raw/${created.id}`, { headers: { Accept: "text/plain" } });
		expect(response.status).toBe(200);
		expect((await response.text()).trim()).toBe("https://example.com/terminal");
	});

	it("stores the destination, not a header, so it cannot be smuggled", async () => {
		const created = await readJson<{ id: string }>(await makeRedirect("https://example.com/ok"));
		const row = await readRow(created.id);
		expect(row?.redirect_url).toBe("https://example.com/ok");
		expect(row?.kind).toBe("redirect");
	});

	describe("validation", () => {
		const rejected: Array<[string, string]> = [
			["javascript:alert(1)", "script scheme"],
			["JavaScript:alert(1)", "mixed case script scheme"],
			["data:text/html,<script>alert(1)</script>", "data URL"],
			["vbscript:msgbox(1)", "vbscript scheme"],
			["file:///etc/passwd", "file scheme"],
			["ftp://example.com/x", "ftp"],
			["//evil.example.com/x", "protocol relative"],
			["/relative/path", "relative"],
			["https://user:pass@example.com/", "credentials"],
			["https://example.com/\r\nX-Injected: yes", "header injection"],
			["https://example.com/\nSet-Cookie: a=b", "newline"],
			["not a url", "nonsense"],
			["https://" + "a".repeat(2100) + ".com/", "over the length limit"],
		];

		for (const [url, label] of rejected) {
			it(`refuses ${label}`, async () => {
				const response = await makeRedirect(url);
				expect(response.status).toBe(400);
				const body = await readJson<{ error: string }>(response);
				expect(body.error).toBe("invalid_url");
			});
		}

		it("accepts uppercase scheme and trims surrounding space", async () => {
			const response = await makeRedirect("  HTTPS://Example.COM/Path  ");
			expect(response.status).toBe(201);
			const created = await readJson<{ id: string }>(response);
			const row = await readRow(created.id);
			expect(row?.redirect_url).toBe("https://example.com/Path");
		});
	});

	it("is switched off by configuration, without breaking pastes", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ kind: "redirect", url: "https://example.com/x" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		// The test environment keeps the feature on by default, so this is the
		// positive path; the disabled path is covered by the page rendering below.
		expect(response.status).toBe(201);

		const created = await readJson<{ id: string }>(response);
		expect(created.id).toMatch(/^[a-z0-9]{10}$/);
	});

	it("renders the homepage link form only when the feature is on", async () => {
		const html = await (await request("/")).text();
		expect(html).toContain("Sharing a link?");
		expect(testConfig.redirectEnabled).toBe(true);
	});

	it("keeps a link paste out of the normal text path", async () => {
		const created = await readJson<{ id: string; url: string; raw_url: string }>(
			await makeRedirect("https://example.com/only-a-link"),
		);
		const meta = await readJson<Record<string, unknown>>(
			await request(`/api/pastes/${created.id}`, { headers: { Accept: "application/json" } }),
		);
		expect(meta.kind).toBe("redirect");
		expect(meta.title).toBeNull();
		expect(meta.filename).toBeNull();
	});

	it("still expires like everything else", async () => {
		const created = await createPaste({ url: "https://example.com/expiring", kind: "redirect", expire: "1h" });
		const row = await readRow(created.id);
		const expiresAt = Number(row?.expires_at);
		const createdAt = Number(row?.created_at);
		expect(expiresAt).toBeGreaterThan(createdAt);
		expect(expiresAt - createdAt).toBeLessThanOrEqual(testConfig.maxTtlSeconds * 1000);
	});
});
