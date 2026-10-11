import type { Config } from "../config";
import { fail } from "../lib/errors";
import type { AppEnv } from "../env";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Optional Turnstile check for browser creation.
 *
 * Fails closed: if the widget is enabled but the token is missing or Cloudflare
 * cannot be reached, the paste is not created. API clients are not affected —
 * callers using the JSON API are expected to be rate limited at the edge.
 */
export async function verifyTurnstile(
	env: AppEnv,
	config: Config,
	token: string | null,
	ip: string | null,
): Promise<void> {
	if (!config.turnstileEnabled) return;

	const secret = env.TURNSTILE_SECRET_KEY;
	if (!secret) {
		throw new Error("FEATURE_TURNSTILE is on but TURNSTILE_SECRET_KEY is not configured");
	}
	if (!token) throw fail.turnstileFailed();

	const form = new FormData();
	form.set("secret", secret);
	form.set("response", token);
	if (ip) form.set("remoteip", ip);

	let outcome: { success?: boolean } = {};
	try {
		const response = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
		outcome = (await response.json()) as { success?: boolean };
	} catch {
		outcome = { success: false };
	}

	if (outcome.success !== true) throw fail.turnstileFailed();
}
