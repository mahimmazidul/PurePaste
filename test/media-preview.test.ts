import { beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { classifyMedia } from "../src/lib/media";
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
		expect(media.headers.get("Content-Type")).toBe("image/png");
		expect(media.headers.get("Content-Disposition")).toContain('inline; filename="pixel.png"');
		expect(media.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(media.headers.get("Accept-Ranges")).toBeNull();
		expect(new Uint8Array(await media.arrayBuffer())).toEqual(PNG);
	});

	// The header on a subresource does not govern the embedding page, but it does
	// govern somebody who opens the link in a tab: that copy must not be a script.
	it("keeps the content CSP on the response", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png");
		const media = await request(`/p/${created.id}/media`);
		expect(media.headers.get("Content-Security-Policy")).toContain("sandbox");
		expect(media.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
	});

	it("answers a conditional request without re-reading the body twice", async () => {
		const created = await uploadFile("pixel.png", PNG, "image/png");
		const first = await request(`/p/${created.id}/media`);
		const etag = first.headers.get("ETag");
		expect(etag).toMatch(/^"[^"]+"$/);

		const again = await request(`/p/${created.id}/media`, { headers: { "if-none-match": etag! } });
		expect(again.status).toBe(304);
		expect(again.headers.get("Cache-Control")).toBe("no-store");
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
