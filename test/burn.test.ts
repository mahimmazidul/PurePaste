import { beforeEach, describe, expect, it } from "vitest";
import { CONSUMED_GRACE_MS, sweep } from "../src/services/cleanup";
import { stores } from "../src/services/paste-store";
import { createPaste, objectKeys, readJson, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";

async function createBurnPaste(content: string, extra: Record<string, unknown> = {}) {
	return createPaste({ content, burn: "1", ...extra });
}

async function reveal(id: string, headers: Record<string, string> = {}) {
	return request(`/api/pastes/${id}/reveal`, { method: "POST", headers: { Accept: "text/html", ...headers } });
}

describe("burn after reading", () => {
	beforeEach(resetStorage);

	it("shows a reveal page that never contains the content", async () => {
		const created = await createBurnPaste("the one-time secret");
		const response = await request(`/${created.id}`);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("Read it, and let it go");
		expect(html).not.toContain("the one-time secret");

		// A crawler or preview bot following the link repeatedly changes nothing.
		await request(`/${created.id}`);
		await request(`/${created.id}`);
		const row = await readRow(created.id);
		expect(row?.consumed_at).toBeNull();
		expect(row?.content).toBe("the one-time secret");
	});

	it("refuses the raw route until the reveal happens", async () => {
		const created = await createBurnPaste("the one-time secret");
		const raw = await request(`/raw/${created.id}`, { headers: { Accept: "application/json" } });
		expect(raw.status).toBe(403);
		expect((await readJson(raw)).error).toBe("confirmation_required");
	});

	it("releases the content once, then closes every route", async () => {
		const created = await createBurnPaste("the one-time secret");
		const revealed = await reveal(created.id);
		const html = await revealed.text();

		expect(revealed.status).toBe(200);
		expect(html).toContain("the one-time secret");
		expect(html).toContain("gone forever");

		const row = await readRow(created.id);
		expect(row?.consumed_at).toBeGreaterThan(0);

		expect((await request(`/${created.id}`)).status).toBe(410);
		expect((await request(`/raw/${created.id}`)).status).toBe(410);
		expect((await request(`/download/${created.id}`)).status).toBe(410);
		expect((await request(`/api/pastes/${created.id}`)).status).toBe(410);
		expect((await reveal(created.id)).status).toBe(410);
	});

	it("answers a JSON client with the content once", async () => {
		const created = await createBurnPaste("json secret");
		const response = await reveal(created.id, { Accept: "application/json" });
		const body = (await readJson(response)) as { content: string; burned: boolean };

		expect(body.content).toBe("json secret");
		expect(body.burned).toBe(true);
		expect((await reveal(created.id, { Accept: "application/json" })).status).toBe(410);
	});

	it("lets exactly one of several simultaneous reveals win", async () => {
		const created = await createBurnPaste("concurrency");
		const responses = await Promise.all(
			Array.from({ length: 5 }, () => reveal(created.id, { Accept: "application/json" })),
		);
		const winners = responses.filter((response) => response.status === 200);
		const losers = responses.filter((response) => response.status === 410);

		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(4);
	});

	it("hands a one-time file back as a download", async () => {
		const form = new FormData();
		form.set("file", new File(["top secret bytes"], "keys.txt", { type: "text/plain" }));
		form.set("burn", "1");
		const created = (await (
			await request("/api/pastes", { method: "POST", body: form, headers: { Accept: "application/json" } })
		).json()) as { id: string };

		const revealed = await request(`/api/pastes/${created.id}/reveal`, { method: "POST" });
		expect(revealed.status).toBe(200);
		expect(revealed.headers.get("Content-Disposition")).toContain("attachment");
		expect(await revealed.text()).toBe("top secret bytes");
		expect((await request(`/${created.id}`)).status).toBe(410);
	});

	it("combines with a password without leaking the body", async () => {
		const { makePasswordMaterial } = await import("./helpers");
		const material = await makePasswordMaterial("open sesame");
		const created = await createPaste({
			content: "double locked",
			burn: "1",
			password_salt: material.salt,
			password_verifier: material.verifier,
			password_iterations: material.iterations,
		});

		const page = await request(`/${created.id}`);
		expect(await page.text()).not.toContain("double locked");

		const unauthed = await reveal(created.id);
		expect(unauthed.status).toBe(401);

		const unlocked = await reveal(created.id, { "X-Paste-Password": material.verifier });
		expect(unlocked.status).toBe(200);
		expect(await unlocked.text()).toContain("double locked");
	});

	it("removes the claimed row and its object on the next sweep", async () => {
		const created = await createBurnPaste("x".repeat(testConfig.inlineTextMaxBytes + 100));
		expect(await objectKeys()).toHaveLength(1);

		await reveal(created.id);
		const now = Date.now();
		const report = await sweep(stores(testEnv), testConfig, now + CONSUMED_GRACE_MS + 1000);

		expect(report.consumedRows).toBe(1);
		expect(report.consumedObjects).toBe(1);
		expect(await objectKeys()).toHaveLength(0);
		expect(await readRow(created.id)).toBeNull();
	});

	it("leaves an unopened one-time paste alone until it expires", async () => {
		const created = await createBurnPaste("never opened");
		const report = await sweep(stores(testEnv), testConfig, Date.now());
		expect(report.expiredRows).toBe(0);
		expect(report.consumedRows).toBe(0);
		expect(await readRow(created.id)).not.toBeNull();
	});
});
