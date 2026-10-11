import { beforeEach, describe, expect, it } from "vitest";
import { ORIGIN, createPaste, readJson, readRow, request, resetStorage, testConfig, testEnv } from "./helpers";
import { createApp } from "../src/app";

/** A loopback address, kept out of the rows we assert on later. */
function create(ip: string, body = "rate limit probe") {
	return request("/api/pastes", {
		method: "POST",
		body,
		headers: { "Content-Type": "text/plain", Accept: "application/json", "cf-connecting-ip": ip },
	});
}

describe("rate limiting", () => {
	beforeEach(resetStorage);

	it("lets a normal burst through and then stops it", async () => {
		const statuses: number[] = [];
		for (let index = 0; index < 33; index += 1) {
			statuses.push((await create("203.0.113.10", `burst ${index}`)).status);
		}

		// The create limit is 30 per minute per address.
		expect(statuses.filter((status) => status === 201)).toHaveLength(30);
		expect(statuses.filter((status) => status === 429)).toHaveLength(3);
	});

	it("answers a throttled request with a readable error and a retry hint", async () => {
		for (let index = 0; index < 30; index += 1) await create("203.0.113.11", `fill ${index}`);

		const response = await request("/api/pastes", {
			method: "POST",
			body: "one too many",
			headers: { "Content-Type": "text/plain", Accept: "application/json", "cf-connecting-ip": "203.0.113.11" },
		});

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(await readJson<{ error: string }>(response)).toMatchObject({ error: "rate_limited" });
	});

	it("counts each address separately", async () => {
		for (let index = 0; index < 30; index += 1) await create("203.0.113.12", `neighbour ${index}`);

		expect((await create("203.0.113.12")).status).toBe(429);
		expect((await create("203.0.113.13")).status).toBe(201);
	});

	it("throttles unlock attempts on a paste", async () => {
		const created = await createPaste({
			content: "protected",
			password_salt: "a".repeat(32),
			password_verifier: "A".repeat(43),
			password_iterations: 100_000,
		});

		const statuses: number[] = [];
		for (let index = 0; index < 24; index += 1) {
			const response = await request(`/api/pastes/${created.id}/unlock`, {
				method: "POST",
				body: JSON.stringify({ verifier: "B".repeat(43) }),
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"cf-connecting-ip": "203.0.113.14",
				},
			});
			statuses.push(response.status);
		}

		// Wrong passwords are refused; past the limit they are refused faster.
		expect(statuses).toContain(401);
		expect(statuses.at(-1)).toBe(429);
	});

	it("keeps working when the optional bindings are absent", async () => {
		const optional = ["CREATE_LIMITER", "UNLOCK_LIMITER"] as const;
		const bare = { ...testEnv } as Record<string, unknown>;
		for (const name of optional) delete bare[name];

		const response = await createApp().fetch(
			new Request(`${ORIGIN}/api/pastes`, {
				method: "POST",
				body: "no bindings here",
				headers: { "Content-Type": "text/plain", Accept: "application/json", "cf-connecting-ip": "203.0.113.15" },
			}),
			bare as unknown as typeof testEnv,
		);

		expect(response.status).toBe(201);
		const created = (await response.json()) as { id: string };
		expect(await readRow(created.id)).not.toBeNull();
	});

	it("rate limits are configuration, not a promise about where they are counted", async () => {
		// The counters live at Cloudflare's edge, per location, so the documented
		// behaviour is "close enough", not a global guarantee. What matters here is
		// that no address is ever written to D1 by the limiter.
		const created = await createPaste({ content: "no address stored" });
		const serialized = JSON.stringify(await readRow(created.id));
		expect(serialized).not.toContain("203.0.113");
		expect(testConfig.fileMaxBytes).toBeGreaterThan(0);
	});
});
