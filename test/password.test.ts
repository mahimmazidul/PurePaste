import { beforeEach, describe, expect, it } from "vitest";
import { createPaste, makePasswordMaterial, readJson, readRow, request, resetStorage } from "./helpers";

async function lockedPaste(password: string, extra: Record<string, unknown> = {}) {
	const material = await makePasswordMaterial(password);
	const created = await createPaste({
		content: "classified contents",
		title: "Secret notes",
		password_salt: material.salt,
		password_verifier: material.verifier,
		password_iterations: material.iterations,
		...extra,
	});
	return { created, material };
}

function cookieFrom(response: Response): string {
	const header = response.headers.get("Set-Cookie") ?? "";
	return header.split(";")[0] ?? "";
}

describe("password protection", () => {
	beforeEach(resetStorage);

	it("stores a salted hash rather than anything that can be replayed", async () => {
		const { created, material } = await lockedPaste("correct horse battery staple");
		const row = await readRow(created.id);

		expect(row?.password_salt).toBe(material.salt);
		expect(row?.password_algo).toBe("PBKDF2-HMAC-SHA256");
		expect(row?.password_iterations).toBe(material.iterations);
		expect(String(row?.password_verifier)).toMatch(/^[0-9a-f]{64}$/);
		expect(String(row?.password_verifier)).not.toBe(material.verifier);
		expect(JSON.stringify(row)).not.toContain("correct horse battery staple");
	});

	it("shows a password prompt and no content, title, or metadata", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const response = await request(`/${created.id}`);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(html).toContain("A locked slip.");
		expect(html).not.toContain("classified contents");
		expect(html).not.toContain("Secret notes");
		expect(html).not.toContain(material.verifier);
		expect(html).not.toContain(material.salt);
	});

	it("withholds protected metadata from the API but shares what a prompt needs", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const response = await request(`/api/pastes/${created.id}`, { headers: { Accept: "application/json" } });
		const body = (await readJson(response)) as Record<string, unknown> & { locked: boolean; kdf: { salt: string } };

		expect(body.locked).toBe(true);
		expect(body.title).toBeUndefined();
		expect(body.kdf.salt).toBe(material.salt);
	});

	it("refuses raw access without a password", async () => {
		const { created } = await lockedPaste("hunter2");
		const response = await request(`/raw/${created.id}`, { headers: { Accept: "application/json" } });
		expect(response.status).toBe(401);
		expect((await readJson(response)).error).toBe("password_required");
	});

	it("rejects a wrong verifier with a single generic answer", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const wrong = await makePasswordMaterial("hunter3");

		const response = await request(`/api/pastes/${created.id}/unlock`, {
			method: "POST",
			body: JSON.stringify({ verifier: wrong.verifier }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect(response.status).toBe(401);
		const body = (await readJson(response)) as { error: string; message: string };
		expect(body.error).toBe("invalid_credentials");
		// The same wording a near miss would produce: nothing leaks about the guess.
		expect(body.message).toBe("That password didn't match.");
		expect(body.message).not.toContain(material.salt);

		// A plaintext password is not accepted at all: only a derived verifier is.
		const plaintext = await request(`/api/pastes/${created.id}/unlock`, {
			method: "POST",
			body: JSON.stringify({ password: "hunter2" }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		expect(plaintext.status).toBe(401);
	});

	it("issues a narrow, secure session cookie on a correct verifier", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const response = await request(`/api/pastes/${created.id}/unlock`, {
			method: "POST",
			body: JSON.stringify({ verifier: material.verifier }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});

		expect(response.status).toBe(200);
		const setCookie = response.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain(`pp_${created.id}=`);
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		expect(setCookie).toContain("Path=/");
		expect(setCookie).toContain("Max-Age=1800");

		const cookie = cookieFrom(response);
		const raw = await request(`/raw/${created.id}`, { headers: { cookie } });
		expect(raw.status).toBe(200);
		expect(await raw.text()).toBe("classified contents");

		const page = await request(`/${created.id}`, { headers: { cookie } });
		const html = await page.text();
		expect(html).toContain("classified contents");
		expect(html).not.toContain("This paste is protected");
	});

	it("accepts a derived verifier header so scripts never put a password in a URL", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const raw = await request(`/raw/${created.id}`, { headers: { "X-Paste-Password": material.verifier } });
		expect(raw.status).toBe(200);
		expect(await raw.text()).toBe("classified contents");
	});

	it("rejects a tampered or borrowed cookie", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const unlock = await request(`/api/pastes/${created.id}/unlock`, {
			method: "POST",
			body: JSON.stringify({ verifier: material.verifier }),
			headers: { "Content-Type": "application/json", Accept: "application/json" },
		});
		const cookie = cookieFrom(unlock);
		const tampered = `${cookie.split(".")[0]}.${cookie.split(".")[1]}.deadbeef`;
		expect((await request(`/raw/${created.id}`, { headers: { cookie: tampered } })).status).toBe(401);

		// The same ticket presented against another paste must not work.
		const other = await createPaste({ content: "other paste" });
		expect((await request(`/raw/${other.id}`, { headers: { cookie } })).status).toBe(200);
		expect(await (await request(`/raw/${other.id}`, { headers: { cookie } })).text()).toBe("other paste");
	});

	it("keeps a protected paste readable after unlocking and marks it as locked in metadata", async () => {
		const { created, material } = await lockedPaste("hunter2");
		const meta = (await (
			await request(`/api/pastes/${created.id}`, {
				headers: { Accept: "application/json", "X-Paste-Password": material.verifier },
			})
		).json()) as { locked: boolean; title: string | null };

		expect(meta.locked).toBe(false);
		expect(meta.title).toBe("Secret notes");
	});
});
