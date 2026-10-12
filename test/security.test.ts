import { beforeEach, describe, expect, it } from "vitest";
import { createPaste, readJson, request, resetStorage } from "./helpers";
import { buildCsp, CSP_FOR_CONTENT } from "../src/middleware/security";
import { REPO_URL } from "../src/views/layout";

/** Every response the Worker produces, whatever else changes, must carry these. */
describe("security headers", () => {
	beforeEach(resetStorage);

	it("applies a deny-by-default policy to pages", async () => {
		const response = await request("/");
		const csp = response.headers.get("Content-Security-Policy") ?? "";

		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("base-uri 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).not.toContain("unsafe-inline");
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).not.toContain("*");
	});

	it("names the Turnstile origin only when the feature is on", async () => {
		const off = await request("/");
		expect(off.headers.get("Content-Security-Policy")).not.toContain("challenges.cloudflare.com");
		expect(buildCsp({ turnstile: true })).toContain("frame-src https://challenges.cloudflare.com");
	});

	it("keeps other headers on every response", async () => {
		const created = await createPaste({ content: "headers" });
		for (const path of ["/", "/about", "/pastes", `/${created.id}`, `/raw/${created.id}`]) {
			const response = await request(path);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
			expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
		}
	});

	it("refuses to be framed, from a policy and from a header", async () => {
		const response = await request("/about");
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
	});

	it("serves paste content under a sandbox policy", async () => {
		const created = await createPaste({ content: "<b>not markup</b>" });
		const response = await request(`/raw/${created.id}`);
		expect(response.headers.get("Content-Security-Policy")).toBe(CSP_FOR_CONTENT);
		expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
	});

	it("never caches anything, including protected responses", async () => {
		const created = await createPaste({
			content: "protected",
			password_salt: "b".repeat(32),
			password_verifier: "A".repeat(43),
			password_iterations: 100_000,
		});

		for (const path of [`/${created.id}`, `/raw/${created.id}`, `/api/pastes/${created.id}`, `/api/config`]) {
			const response = await request(path, { headers: { Accept: "application/json" } });
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
	});

	it("asks search engines to stay away from pastes but leaves the shell alone", async () => {
		const created = await createPaste({ content: "not for crawlers" });
		const page = await request(`/${created.id}`);

		expect(page.headers.get("X-Robots-Tag")).toContain("noindex");
		expect(page.headers.get("X-Robots-Tag")).toContain("nofollow");
		expect(await page.text()).toContain('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">');

		for (const path of ["/", "/about", "/pastes"]) {
			expect((await request(path)).headers.get("X-Robots-Tag")).toBeNull();
		}
		expect((await request("/robots.txt")).headers.get("X-Robots-Tag")).toBeNull();
	});

	it("disallows crawlers in robots.txt", async () => {
		const response = await request("/robots.txt");
		expect(response.headers.get("Content-Type")).toContain("text/plain");
		expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
	});
});

describe("page markup", () => {
	beforeEach(resetStorage);

	it("has no inline scripts or styles anywhere", async () => {
		const created = await createPaste({ content: "markup review" });
		for (const path of ["/", "/about", "/pastes", `/${created.id}`, `/manage/${created.id}`]) {
			const html = await (await request(path)).text();
			expect(html).not.toMatch(/<script(?![^>]*src=)/i);
			expect(html).not.toMatch(/\son[a-z]+=/i);
			expect(html).not.toMatch(/style="/i);
		}
	});

	// What this is protecting is that a page load touches nobody else: no font, no
	// script, no pixel fetched from another site. A link the visitor may choose to
	// follow is a different thing — it sends nothing on its own, and the pages carry
	// `Referrer-Policy: no-referrer` — so the repository link is allowed, and it is
	// the only outbound address any page may name.
	it("loads nothing from another site and links out to exactly one place", async () => {
		for (const path of ["/", "/about", "/docs", "/licenses", "/pastes"]) {
			const html = await (await request(path)).text();

			// Strip the anchors: everything left is something the browser fetches.
			const fetched = html.replace(/<a\b[\s\S]*?<\/a>/g, "");
			const loads = Array.from(fetched.matchAll(/(?:src|href|action)="([^"]+)"/g)).map((match) => match[1]!);
			expect(loads.filter((url) => /^https?:/i.test(url))).toEqual([]); // Turnstile is off here
			expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
			expect(html).not.toMatch(/<link[^>]+rel=["']?(preload|prefetch|dns-preset|preconnect)/i);

			const anchors = Array.from(html.matchAll(/<a\b[^>]*href="([^"]+)"/g)).map((match) => match[1]!);
			const outbound = [...new Set(anchors.filter((url) => /^https?:/i.test(url)))];
			expect(outbound).toEqual([REPO_URL]);
			// And it hands the new tab nothing back, nor the address of the paste.
			for (const link of html.matchAll(/<a\b[^>]*href="https:[^"]*"[^>]*>/g)) {
				expect(link[0]).toContain('rel="noopener noreferrer"');
			}
		}

		const html = await (await request("/")).text();
		expect(html).toContain("/assets/styles/app.css");
		expect(html).toContain("/assets/fonts/fonts.css");
		expect(html).toContain("/assets/scripts/theme.js");
	});

	it("gives every page the landmarks and language a reader needs", async () => {
		const created = await createPaste({ content: "landmarks" });
		for (const path of ["/", "/about", "/docs", `/p/${created.id}`]) {
			const html = await (await request(path)).text();
			expect(html).toContain('<html lang="en"');
			expect(html).toContain('class="skip-link"');
			expect(html).toContain('<main id="main"');
			expect(html).toContain("<header");
			expect(html).toContain("<footer");
			expect(html).toContain('aria-label="Footer"');
			expect(html).toContain("viewport");
		}
	});

	it("labels the controls on the editor", async () => {
		const html = await (await request("/")).text();
		for (const id of ["title", "content", "language", "expire", "file", "slug"]) {
			expect(html).toContain(`id="${id}"`);
		}
		expect(html).toContain('aria-label="Title (optional)"');
		expect(html).toContain('aria-label="Slip content"');
		expect(html).toContain('for="file"');
		expect(html).toContain('aria-describedby="slug-note"');
		expect(html).toContain('spellcheck="false"');
	});

	it("announces errors in a summary that links to the field", async () => {
		const response = await request("/", {
			method: "POST",
			body: new URLSearchParams({ content: "", expire: "1h" }),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
		});
		const html = await response.text();

		expect(response.status).toBe(400);
		expect(html).toContain("data-error-summary");
		expect(html).toContain('role="alert"');
		expect(html).toContain("There's a problem with that submission");
	});

	it("credits the typefaces and scripts it serves itself", async () => {
		const response = await request("/licenses");
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Robots-Tag")).toBeNull();
		expect(html).toContain("Inter");
		expect(html).toContain("Instrument Serif");
		expect(html).toContain("JetBrains Mono");
		expect(html).toContain("SIL Open Font Licence");
		expect(html).toContain("/assets/licenses/highlight.js-BSD.txt");
		// The footer links every public page to it.
		expect(await (await request("/about")).text()).toContain('href="/licenses"');
	});

	it("keeps the reveal page free of the paste itself", async () => {
		const created = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ content: "secret one-time contents", burn: true, expire: "1d" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		const body = await readJson<{ id: string }>(created);
		const html = await (await request(`/${body.id}`)).text();

		expect(html).toContain("Read it, and let it go");
		expect(html).not.toContain("secret one-time contents");
	});
});
