import { beforeEach, describe, expect, it } from "vitest";
import { formatBytes } from "../src/lib/format";
import { createPaste, readJson, readRow, request, resetStorage, testConfig } from "./helpers";

/**
 * Two things live here that the shared expiry menu doesn't cover:
 *
 *  - the file tab's shorter default (3 days, because bytes are the budget on any of
 *    the providers) without touching slips or links;
 *  - the file panel's markup contract — a chosen file gets its own row with
 *    preview and remove buttons, and the composer keeps a draft banner.
 */
describe("file expiry and file panel", () => {
	beforeEach(resetStorage);

	const home = async (): Promise<string> => {
		const response = await request("/", { headers: { Accept: "text/html" } });
		expect(response.status).toBe(200);
		return response.text();
	};

	const selects = (html: string): Map<string, string> => {
		const found = new Map<string, string>();
		for (const match of html.matchAll(/<select[^>]*name="expire"[^>]*>([\s\S]*?)<\/select>/g)) {
			const id = /id="([^"]+)"/.exec(match[0])?.[1] ?? "";
			found.set(id, match[1] ?? "");
		}
		return found;
	};

	it("defaults only the file panel to three days", async () => {
		const html = await home();
		const options = selects(html);
		expect(options.size).toBeGreaterThanOrEqual(2);

		const filePanel = options.get("expire-file") ?? "";
		const slipPanel = options.get("expire") ?? "";

		expect(filePanel).toContain('<option value="3d" selected>');
		expect(filePanel).toContain("3 days");
		// Slips and links keep the week; the short option is the file tab's own.
		expect(slipPanel).not.toContain('value="3d"');
		expect(slipPanel).toContain('<option value="7d" selected>');
	});

	it("gives the API the same shorter default the file tab shows", async () => {
		const throughApi = new FormData();
		throughApi.set(
			"file",
			new File([new Uint8Array([1, 2, 3])], "no-choices.bin", { type: "application/octet-stream" }),
		);
		const upload = await request("/api/pastes", {
			method: "POST",
			body: throughApi,
			headers: { Accept: "application/json" },
		});
		expect(upload.status).toBe(201);
		const uploaded = await readJson<{ expires_in_seconds: number }>(upload);
		expect(uploaded.expires_in_seconds).toBe(3 * 24 * 60 * 60);

		// Text is untouched, and an explicit lifetime always wins over both.
		const plain = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ content: "no expiry given" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect((await readJson<{ expires_in_seconds: number }>(plain)).expires_in_seconds).toBe(7 * 24 * 60 * 60);

		const told = new FormData();
		told.set("file", new File([new Uint8Array([1, 2, 3])], "thirty-days.bin", { type: "application/octet-stream" }));
		told.set("expire", "30d");
		const overridden = await request("/api/pastes", {
			method: "POST",
			body: told,
			headers: { Accept: "application/json" },
		});
		expect((await readJson<{ expires_in_seconds: number }>(overridden)).expires_in_seconds).toBe(30 * 24 * 60 * 60);
	});

	it("lets a query string fill what the form left empty", async () => {
		const viaQuery = new FormData();
		viaQuery.set("file", new File([new Uint8Array([1, 2, 3])], "queried.bin", { type: "application/octet-stream" }));
		const queryOnly = await request("/api/pastes?expire=1h", {
			method: "POST",
			body: viaQuery,
			headers: { Accept: "application/json" },
		});
		expect((await readJson<{ expires_in_seconds: number }>(queryOnly)).expires_in_seconds).toBe(3600);

		// A posted field still outranks the URL.
		const both = new FormData();
		both.set("file", new File([new Uint8Array([1, 2, 3])], "both.bin", { type: "application/octet-stream" }));
		both.set("expire", "1h");
		const fieldWins = await request("/api/pastes?expire=30d", {
			method: "POST",
			body: both,
			headers: { Accept: "application/json" },
		});
		expect((await readJson<{ expires_in_seconds: number }>(fieldWins)).expires_in_seconds).toBe(3600);
	});

	it("keeps a chosen file in the shared menu honest", async () => {
		const html = await home();
		// The menu still offers the long tails, so nothing is taken away.
		expect(selects(html).get("expire-file")).toContain('value="30d"');
		expect(testConfig.defaultTtlSeconds).toBe(7 * 24 * 60 * 60);
		expect(testConfig.fileDefaultTtlSeconds).toBe(3 * 24 * 60 * 60);
	});

	it("gives the selected file its own row, with preview and remove", async () => {
		const html = await home();
		expect(html).toContain('class="file-block" data-file-block');
		// The client wires itself to these handles; a missing one disables the
		// whole file flow, silently.
		for (const hook of ["data-dropzone", "data-file-input", "data-file-name", "data-file-preview", "data-file-clear"]) {
			expect(html).toContain(hook);
		}
		expect(html).toContain('class="file-bar" data-file-bar hidden');
		expect(html).toContain("data-file-preview");
		expect(html).toContain("data-file-clear");
		expect(html).toContain("data-file-dialog");
		// The overlay input stays inside .dropzone (it swallows clicks), and the
		// chosen-file row is its sibling below — that is what stopped the overlap.
		const panel = html.slice(html.indexOf('data-mode="file"'), html.indexOf('id="title-file"'));
		expect(panel).toContain('class="dropzone" data-dropzone');
		const dropzoneEnd = panel.indexOf("</div>", panel.indexOf("data-file-input"));
		expect(panel.slice(0, dropzoneEnd)).toContain("data-file-input");
		expect(panel.slice(0, dropzoneEnd)).not.toContain("data-file-name");
		expect(panel.indexOf("data-file-bar")).toBeGreaterThan(dropzoneEnd);
	});

	it("promises the shorter lifetime in the file note", async () => {
		const html = await home();
		// Derived, not hardcoded: the note has to follow FILE_MAX_BYTES wherever it is
		// raised to, and the whole point of the line is that it is not a promise the
		// view can make on its own.
		expect(html).toContain(`Up to ${formatBytes(testConfig.fileMaxBytes)}, then it fades in 3 days`);
	});

	it("renders the draft banner the client fills in", async () => {
		const html = await home();
		expect(html).toContain("data-draft-notice hidden");
		expect(html).toContain("data-draft-clear");
	});

	it("accepts 3d on the API for any kind, and clamps nothing", async () => {
		const created = await createPaste({ content: "three day text", expire: "3d" });
		expect(created.expires_at).toBeGreaterThan(Date.now() + 2 * 24 * 60 * 60 * 1000);
		const row = await readRow(created.id);
		const lifetime = Number(row?.expires_at) - Number(row?.created_at);
		expect(lifetime).toBe(3 * 24 * 60 * 60 * 1000);
	});

	it("keeps the CSP the preview has to live inside", async () => {
		// The file preview draws images from a data: URL and never uses blob: or
		// <object>, because these two directives are what make that necessary.
		const response = await request("/", { headers: { Accept: "text/html" } });
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("img-src 'self' data:");
		expect(csp).toContain("object-src 'none'");
	});

	it("still refuses a lifetime the menu never offered", async () => {
		const response = await request("/api/pastes", {
			method: "POST",
			body: JSON.stringify({ content: "nope", expire: "2d" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect(response.status).toBe(400);
		const error = await readJson<{ message: string }>(response);
		expect(error.message).toMatch(/expiration/i);
	});
});
