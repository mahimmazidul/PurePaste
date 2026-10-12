import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { classifyMedia } from "../src/lib/media";
import { CSP_FOR_CONTENT } from "../src/middleware/security";
import { createPaste, readRow, request, resetStorage, deriveVerifier, testConfig } from "./helpers";

/**
 * The media preview is a second way to hand stored bytes to a browser, so it is
 * held to the same standard as `/raw`: the type on the wire must be ours, markup
 * must never be drawn, and nothing about the read may consume or unlock anything.
 */

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
	0x01, 0x00, 0x00, 0x01, 0x01, 0x08, 0x06,
]);

async function uploadFile(name: string, bytes: Uint8Array | string, type: string, extra: Record<string, string> = {}) {
	const form = new FormData();
	form.set("file", new File([bytes], name, { type }));
	for (const [key, value] of Object.entries(extra)) form.set(key, value);
	const response = await request("/api/pastes", {
		method: "POST",
		body: form,
		headers: { Accept: "application/json" },
	});
	if (response.status !== 201) throw new Error(`upload failed: ${response.status} ${await response.text()}`);
	return (await response.json()) as { id: string; kind: string };
}

describe("media classification", () => {
	it("draws what a browser can render inertly", () => {
		expect(classifyMedia("image/png", "cat.png")).toEqual({ kind: "image", contentType: "image/png", reason: null });
		expect(classifyMedia("application/octet-stream", "clip.mp4")).toEqual({
			kind: "video",
			contentType: "video/mp4",
			reason: null,
		});
		expect(classifyMedia("audio/mpeg", "track.mp3")).toEqual({
			kind: "audio",
			contentType: "audio/mpeg",
			reason: null,
		});
		expect(classifyMedia("application/pdf", "report.pdf")).toEqual({
			kind: "pdf",
			contentType: "application/pdf",
			reason: null,
		});
		expect(classifyMedia("text/markdown", "notes.md").kind).toBe("text");
	});

	it("answers with its own type, never the uploader's", () => {
		// Declared as HTML, named as a PNG: the browser would sniff an image, and so do we.
		expect(classifyMedia("text/html", "photo.png").contentType).toBe("image/png");
		// And the reverse, where the type is the only clue.
		expect(classifyMedia("image/webp", "no-extension").contentType).toBe("image/webp");
	});

	it("refuses markup and anything scriptable", () => {
		expect(classifyMedia("text/html", "page.html").kind).toBeNull();
		expect(classifyMedia("image/svg+xml", "icon.svg").kind).toBeNull();
		expect(classifyMedia("application/xhtml+xml", "page.xhtml").kind).toBeNull();
		expect(classifyMedia("application/octet-stream", "mystery.bin").kind).toBeNull();
		expect(classifyMedia(null, null)).toEqual({ kind: null, contentType: null, reason: "not a previewable type" });
	});

	it("explains why a refusal was a refusal", () => {
		expect(classifyMedia("image/svg+xml", "icon.svg").reason).toBe("markup or scriptable image");
		expect(classifyMedia("application/zip", "archive.zip").reason).toBe("not a previewable type");
	});
});

describe("GET /p/:id/media", () => {
	beforeEach(resetStorage);

	it("serves an image inline with its own headers", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png");

		const media = await request(`/p/${created.id}/media`);
		expect(media.status).toBe(200);
		// The caching policy follows the configuration, never the caller: an instance
		// that has not opted in must be no-store, and one that has must be public.
		expect(media.headers.get("Cache-Control")).toBe(
			testConfig.mediaCacheSeconds > 0 ? `public, max-age=${testConfig.mediaCacheSeconds}, immutable` : "no-store",
		);
		expect(media.headers.get("Content-Type")).toBe("image/png");
		expect(media.headers.get("Content-Disposition")).toContain('inline; filename="pixel.png"');
		expect(media.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(media.headers.get("Accept-Ranges")).toBeNull();
		expect(new Uint8Array(await media.arrayBuffer())).toEqual(PNG);
	});

	// The header on a subresource does not govern the embedding page, but it does
	// govern the person who opens the link in a tab. A browser paints such a page
	// with its own image, player or document element, and `default-src 'none'` alone
	// would stop that — so the media URL names one source, itself, and nothing else.
	it("lets a browser draw the media URL and keeps every other path inert", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png");
		const media = await request(`/p/${created.id}/media`);
		const csp = media.headers.get("Content-Security-Policy")!;
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("img-src 'self'");
		expect(csp).toContain("media-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		// `sandbox` is what would blank the native viewers, so it is off this one path.
		expect(csp).not.toContain("sandbox");

		// The same bytes as a download are not meant to be drawn, so they stay inert.
		const download = await request(`/download/${created.id}`);
		expect(download.headers.get("Content-Security-Policy")).toBe(CSP_FOR_CONTENT);
	});

	// The looser policy is decided by what the response actually is, not by the URL.
	it("keeps the strict policy when the media URL has nothing to draw", async () => {
		const created = await uploadFile("page.html", "<p>hi</p>", "text/html");
		const refused = await request(`/p/${created.id}/media`);
		expect(refused.status).toBe(415);
		expect(refused.headers.get("Content-Security-Policy")).toContain("sandbox");
	});

	it("answers a conditional request without re-reading the body twice", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png");
		const first = await request(`/p/${created.id}/media`);
		const etag = first.headers.get("ETag");
		expect(etag).toMatch(/^"[^"]+"$/);

		const again = await request(`/p/${created.id}/media`, { headers: { "if-none-match": etag! } });
		expect(again.status).toBe(304);
		// A cache hit has to carry the same policy as the miss, or a shared cache would
		// extend a lifetime nobody chose.
		expect(again.headers.get("Cache-Control")).toBe(first.headers.get("Cache-Control"));
	});

	it("never burns, never counts a view, and leaves the paste readable", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png", { burn: "1" });

		const refused = await request(`/p/${created.id}/media`);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("confirmation_required");

		// A preview attempt must not spend the one read, so the reveal still works.
		const row = await readRow(created.id);
		expect(row?.consumed_at).toBeNull();

		const reveal = await request(`/api/pastes/${created.id}/reveal`, {
			method: "POST",
			headers: { Accept: "application/json" },
		});
		expect(reveal.status).toBe(200);
	});

	it("refuses an encrypted paste without touching the ciphertext", async () => {
		const response = await request("/api/pastes?encrypted=1", {
			method: "POST",
			body: new TextEncoder().encode("PPv1-not-really-encrypted-but-opaque::ciphertext"),
			headers: { "Content-Type": "application/octet-stream", Accept: "application/json" },
		});
		const created = (await response.json()) as { id: string };
		const media = await request(`/p/${created.id}/media`);
		expect(media.status).toBe(403);
		expect(((await media.json()) as { error: string }).error).toBe("encrypted");
	});

	it("asks for the password before it will draw anything", async () => {
		const salt = crypto.getRandomValues(new Uint8Array(16));
		const saltHex = [...salt].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const verifier = await deriveVerifier("hunter2", saltHex, testConfig.passwordIterations);

		const form = new FormData();
		form.set("file", new File([PNG], "pixel.png", { type: "image/png" }));
		form.set("password_verifier", verifier);
		form.set("password_salt", saltHex);
		form.set("password_iterations", String(testConfig.passwordIterations));
		const created = (await (
			await request("/api/pastes", { method: "POST", body: form, headers: { Accept: "application/json" } })
		).json()) as { id: string };

		expect((await request(`/p/${created.id}/media`)).status).toBe(401);

		const unlock = await request(`/api/pastes/${created.id}/unlock`, {
			method: "POST",
			body: JSON.stringify({ verifier }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		const cookie = (unlock.headers.getSetCookie?.()[0] ?? unlock.headers.get("Set-Cookie") ?? "").split(";")[0];
		expect(cookie).toContain("pp_");

		const allowed = await request(`/p/${created.id}/media`, { headers: { cookie } });
		expect(allowed.status).toBe(200);
		// Locked, so nothing may be cached anywhere, whatever the instance prefers.
		expect(allowed.headers.get("Cache-Control")).toBe("no-store");
	});

	it("will not draw a page, whatever the upload claimed", async () => {
		const created = await uploadFile("page.html", "<h1>hi</h1>", "text/html");

		const media = await request(`/p/${created.id}/media`);
		expect(media.status).toBe(415);
		expect(((await media.json()) as { error: string }).error).toBe("not_media");

		// The download path is untouched, so the file is not lost — only unpreviewed.
		const download = await request(`/download/${created.id}`);
		expect(download.status).toBe(200);
		expect(download.headers.get("Content-Disposition")).toContain("attachment");
	});

	it("returns nothing for a link, and 404 shape like every other miss", async () => {
		const created = await createPaste({ url: "https://example.com/a-page" });
		const media = await request(`/p/${created.id}/media`);
		expect(media.status).toBe(404);
		expect((await request(`/p/nosuchid/media`)).status).toBe(404);
	});
});

describe("the viewer page", () => {
	beforeEach(resetStorage);

	it("frames a previewable file and links the PDF out", async () => {
		const image = await uploadFile("pixel.png", PNG, "image/png");
		const page = await (await request(`/p/${image.id}`, { headers: { Accept: "text/html" } })).text();
		expect(page).toContain('class="media-frame"');
		expect(page).toContain(`src="/p/${image.id}/media"`);
		expect(page).toContain('loading="lazy"');

		const pdf = await uploadFile("report.pdf", "%PDF-1.4\n", "application/pdf");
		const pdfPage = await (await request(`/p/${pdf.id}`, { headers: { Accept: "text/html" } })).text();
		expect(pdfPage).toContain(`href="/p/${pdf.id}/media"`);
		expect(pdfPage).not.toContain("<iframe");
	});

	it("offers a copyable direct link for bytes a browser can show on its own", async () => {
		const image = await uploadFile("pixel.png", PNG, "image/png");
		const page = await (await request(`/p/${image.id}`, { headers: { Accept: "text/html" } })).text();
		const direct = `http://purepaste.test/p/${image.id}/media`;

		expect(page).toContain(`value="${direct}"`);
		expect(page).toContain('id="media-direct-link"');
		expect(page).toContain('data-copy-target="media-direct-link"');
		// The preview is the link: one click on the image is the image, in its own tab.
		expect(page).toContain(`<a href="${direct}" target="_blank" rel="noopener"><img src="/p/${image.id}/media"`);
		// Built from the request, because a hardcoded host would be wrong on a
		// custom domain and on every preview URL.
		expect(page).not.toContain('value="/p/' + image.id + '/media"');

		// A text file is read here, not pointed at; the field would be a lie.
		const text = await uploadFile("notes.txt", "hello", "text/plain");
		const textPage = await (await request(`/p/${text.id}`, { headers: { Accept: "text/html" } })).text();
		expect(textPage).not.toContain("media-direct-link");
	});

	it("does not hand out an address the media route would refuse", async () => {
		const burned = await uploadFile("pixel.png", PNG, "image/png", { burn: "1" });
		const burnPage = await (await request(`/p/${burned.id}`, { headers: { Accept: "text/html" } })).text();
		expect(burnPage).not.toContain("media-direct-link");

		const salt = crypto.getRandomValues(new Uint8Array(16));
		const saltHex = [...salt].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const locked = await uploadFile("pixel.png", PNG, "image/png", {
			password_verifier: await deriveVerifier("hunter2", saltHex, testConfig.passwordIterations),
			password_salt: saltHex,
			password_iterations: String(testConfig.passwordIterations),
		});
		const lockedPage = await (await request(`/p/${locked.id}`, { headers: { Accept: "text/html" } })).text();
		// Not merely hidden behind the gate: the address is absent from the HTML, so a
		// saved page cannot outlive the password.
		expect(lockedPage).not.toContain("media-direct-link");
		expect(lockedPage).not.toContain(`/p/${locked.id}/media`);
	});

	it("keeps markup as a download and keeps the page unbroken", async () => {
		const created = await uploadFile("page.html", "<h1>hi</h1>", "text/html");
		const page = await (await request(`/p/${created.id}`, { headers: { Accept: "text/html" } })).text();
		expect(page).not.toContain('class="media-frame"');
		expect(page).toContain(`/download/${created.id}`);
	});

	it("does not offer a preview it cannot honour", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png", { burn: "1" });
		const page = await (await request(`/p/${created.id}`, { headers: { Accept: "text/html" } })).text();
		expect(page).not.toContain("<img");
		// What the visitor sees instead is the confirmation gate, not a half-preview.
		expect(page).toContain("data-reveal-form");
	});
});

describe("media caching configuration", () => {
	it("defaults to no-store and clamps whatever an operator asks for", () => {
		// Zero by default: a preview is opt-in caching, never a surprise.
		expect(resolveConfig({}).mediaCacheSeconds).toBe(0);
		expect(resolveConfig({ MEDIA_CACHE_SECONDS: "3600" }).mediaCacheSeconds).toBe(3600);
		expect(resolveConfig({ MEDIA_CACHE_SECONDS: "99999999999" }).mediaCacheSeconds).toBe(31_536_000);
		expect(resolveConfig({ MEDIA_CACHE_SECONDS: "-5" }).mediaCacheSeconds).toBe(0);
	});
});
