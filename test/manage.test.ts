import { beforeEach, describe, expect, it } from "vitest";
import { createPaste, objectKeys, readJson, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";

async function deletePasteRequest(id: string, token?: string): Promise<Response> {
	return request(`/api/pastes/${id}`, {
		method: "DELETE",
		headers: {
			Accept: "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
	});
}

describe("management and deletion", () => {
	beforeEach(resetStorage);

	it("renders the management page without ever receiving the key", async () => {
		const created = await createPaste({ content: "managed" });
		const response = await request(`/manage/${created.id}`);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain(`data-paste-id="${created.id}"`);
		// The key stays in the fragment, so it appears nowhere in the markup.
		expect(html).not.toContain(created.manage_token);
		expect(html).toContain("Management link");
		expect(html).toContain("Delete this paste?");
	});

	it("deletes the row and the object with a valid token, and is safe to retry", async () => {
		const created = await createPaste({
			content: "x".repeat(testConfig.inlineTextMaxBytes + 50),
		});
		expect(await objectKeys()).toHaveLength(1);

		const first = await deletePasteRequest(created.id, created.manage_token);
		expect(first.status).toBe(200);
		const body = await readJson<{ deleted: boolean; object_removed: boolean; row_removed: boolean }>(first);
		expect(body.deleted).toBe(true);
		expect(body.object_removed).toBe(true);
		expect(body.row_removed).toBe(true);

		expect(await readRow(created.id)).toBeNull();
		expect(await objectKeys()).toHaveLength(0);

		// Retrying a deletion reports that there is nothing left rather than failing.
		const again = await deletePasteRequest(created.id, created.manage_token);
		expect(again.status).toBe(404);
		expect((await readJson(again)).error).toBe("not_found");
	});

	it("rejects a missing, wrong, or borrowed token", async () => {
		const created = await createPaste({ content: "protected by a token" });
		const other = await createPaste({ content: "another paste" });

		expect((await deletePasteRequest(created.id)).status).toBe(401);
		expect((await deletePasteRequest(created.id, "not-the-token")).status).toBe(401);
		expect((await deletePasteRequest(created.id, other.manage_token)).status).toBe(401);

		// Nothing was removed by any of those attempts.
		expect(await readRow(created.id)).not.toBeNull();
	});

	it("refuses to take the token from a query string", async () => {
		const created = await createPaste({ content: "token in the wrong place" });
		const response = await request(`/api/pastes/${created.id}?token=${created.manage_token}`, {
			method: "DELETE",
			headers: { Accept: "application/json" },
		});
		expect(response.status).toBe(401);
		expect((await readJson(response)).error).toBe("unauthorized");
		expect(await readRow(created.id)).not.toBeNull();
	});

	it("deletes an expired paste with a valid token", async () => {
		const created = await createPaste({ content: "expiring", expire: "1h" });
		await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
			.bind(Date.now() - 1000, created.id)
			.run();

		const response = await deletePasteRequest(created.id, created.manage_token);
		expect(response.status).toBe(200);
		expect(await readRow(created.id)).toBeNull();
	});

	it("does not expose a listing endpoint", async () => {
		await createPaste({ content: "one" });
		await createPaste({ content: "two" });

		for (const path of ["/api/pastes", "/pastes.json", "/api/pastes/all", "/api"]) {
			const response = await request(path, { headers: { Accept: "application/json" } });
			expect([401, 404, 405]).toContain(response.status);
		}
	});

	it("reports metadata to the owner through the API", async () => {
		const created = await createPaste({ content: "metadata", title: "A title", language: "python" });
		const response = await request(`/api/pastes/${created.id}`, { headers: { Accept: "application/json" } });
		const body = await readJson<{
			id: string;
			title: string;
			language: string;
			kind: string;
			expires_at: number;
			links: { url: string; raw_url: string };
		}>(response);

		expect(body.title).toBe("A title");
		expect(body.language).toBe("python");
		expect(body.kind).toBe("text");
		expect(body.expires_at).toBeGreaterThan(Date.now());
		expect(body.links.raw_url).toContain(`/raw/${created.id}`);
	});
});
