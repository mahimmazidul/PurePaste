import { beforeEach, describe, expect, it } from "vitest";
import { createPaste, objectKeys, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";

describe("reading pastes", () => {
	beforeEach(resetStorage);

	it("renders a small paste without any JavaScript and escapes it", async () => {
		const created = await createPaste({
			content: "<script>alert('xss')</script>\nplain tail",
			title: "Dangerous <title>",
		});

		const response = await request(`/${created.id}`);
		expect(response.status).toBe(200);
		const html = await response.text();

		expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("Dangerous &lt;title&gt;");
		// The content is present even though nothing ran.
		expect(html).toContain("plain tail");
	});

	it("sets the headers that keep a paste page private", async () => {
		const created = await createPaste({ content: "headers" });
		const response = await request(`/${created.id}`);

		expect(response.headers.get("X-Robots-Tag")).toContain("noindex");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
	});

	it("keeps the home page free of a noindex tag", async () => {
		const response = await request("/");
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Robots-Tag")).toBeNull();
	});

	it("returns raw text with a plain content type", async () => {
		const created = await createPaste({ content: "raw line\nsecond" });
		const response = await request(`/raw/${created.id}`);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await response.text()).toBe("raw line\nsecond");
	});

	it("stores oversized text in R2 and streams it back unchanged", async () => {
		const big = `${"x".repeat(testConfig.inlineTextMaxBytes + 2048)}END`;
		const created = await createPaste({ content: big, language: "text" });
		const row = await readRow(created.id);

		expect(row?.content).toBeNull();
		expect(row?.object_key).toBe(`pp/v1/text/${created.id}`);
		expect(await objectKeys()).toEqual([`pp/v1/text/${created.id}`]);

		const raw = await request(`/raw/${created.id}`);
		expect(await raw.text()).toBe(big);

		// The page hands the body to the browser rather than inlining 64 KiB of markup.
		const page = await request(`/${created.id}`);
		expect(await page.text()).toContain(`data-src="/p/${created.id}/raw"`);
	});

	it("accepts a file upload and serves it as a download", async () => {
		const form = new FormData();
		form.set("file", new File([new Uint8Array([1, 2, 3, 4, 5])], "notes.txt", { type: "text/plain" }));
		form.set("expire", "1d");
		const created = (await (
			await request("/api/pastes", {
				method: "POST",
				body: form,
				headers: { Accept: "application/json" },
			})
		).json()) as { id: string; kind: string };

		expect(created.kind).toBe("file");

		const download = await request(`/download/${created.id}`);
		expect(download.status).toBe(200);
		expect(download.headers.get("Content-Disposition")).toContain('attachment; filename="notes.txt"');
		expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(download.headers.get("Content-Type")).toBe("text/plain");
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
	});

	it("never serves an active file type for inline execution", async () => {
		const form = new FormData();
		form.set("file", new File(["<html><script>alert(1)</script>"], "page.html", { type: "text/html" }));
		const created = (await (
			await request("/api/pastes", { method: "POST", body: form, headers: { Accept: "application/json" } })
		).json()) as { id: string };

		const raw = await request(`/raw/${created.id}`);
		// The declared media type is ignored: an unknown extension becomes an opaque download.
		expect(raw.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(raw.headers.get("Content-Disposition")).toContain("attachment");
		expect(raw.headers.get("Content-Security-Policy")).toContain("sandbox");

		const download = await request(`/download/${created.id}`);
		expect(download.headers.get("Content-Disposition")).toContain("attachment");
	});

	it("keeps SVG downloads inert", async () => {
		const form = new FormData();
		form.set("file", new File(["<svg onload='alert(1)'></svg>"], "logo.svg", { type: "image/svg+xml" }));
		const created = (await (
			await request("/api/pastes", { method: "POST", body: form, headers: { Accept: "application/json" } })
		).json()) as { id: string };

		const download = await request(`/download/${created.id}`);
		expect(download.headers.get("Content-Disposition")).toContain("attachment");
		expect(download.headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(download.headers.get("Content-Type")).toBe("image/svg+xml");
	});

	it("refuses to serve an expired paste from any route", async () => {
		const created = await createPaste({ content: "gone soon", expire: "1h" });
		await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, created.id)
			.run();

		const page = await request(`/${created.id}`);
		expect(page.status).toBe(410);
		expect(await page.text()).toContain("expired");

		expect((await request(`/raw/${created.id}`)).status).toBe(410);
		expect((await request(`/download/${created.id}`)).status).toBe(410);
		expect((await request(`/api/pastes/${created.id}`)).status).toBe(410);

		const meta = (await (await request(`/api/pastes/${created.id}`)).json()) as { error: string };
		expect(meta.error).toBe("expired");
	});

	it("does not serve a body for an expired paste even if the row lingers", async () => {
		const created = await createPaste({ content: "still in R2", expire: "1h" });
		await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1, created.id)
			.run();

		const raw = await request(`/raw/${created.id}`);
		expect(raw.status).toBe(410);
		expect(await raw.text()).not.toContain("still in R2");
	});

	it("answers 404 for unknown and malformed ids", async () => {
		expect((await request("/doesnotexist")).status).toBe(404);
		expect((await request("/UPPERCASE1")).status).toBe(404);
		expect((await request("/has.dots")).status).toBe(404);
		expect((await request(`/${"a".repeat(70)}`)).status).toBe(404);
		expect((await request("/raw/../etc/passwd")).status).toBe(404);
		expect((await request("/api/pastes/nope")).status).toBe(404);
	});

	it("keeps the fixed application routes working", async () => {
		expect((await request("/about")).status).toBe(200);
		expect((await request("/pastes")).status).toBe(200);
		expect((await request("/robots.txt")).status).toBe(200);
		expect(await (await request("/robots.txt")).text()).toContain("Disallow: /");

		const config = (await (await request("/api/config")).json()) as { ttl_choices: unknown[]; features: object };
		expect(config.ttl_choices).toHaveLength(5);
		expect(config.features).toBeDefined();
	});

	it("counts views only when the feature is enabled", async () => {
		const created = await createPaste({ content: "counted" });
		// View counting is off by default (the shipped configuration), so reads must not write.
		await request(`/${created.id}`);
		await request(`/${created.id}`);
		const row = await readRow(created.id);
		expect(row?.views).toBe(0);
	});
});
