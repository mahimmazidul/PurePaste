import type { Context, MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";
import { fail } from "../lib/errors";

/**
 * Edge rate limiting through Cloudflare's Rate Limiting binding.
 *
 * Counters live in Cloudflare's edge infrastructure — PurePaste performs no D1
 * writes for rate limiting and stores no addresses. The binding is optional:
 * when it is absent (local development, tests, or an operator who removed it)
 * the check is skipped and the service keeps working.
 *
 * The key is the calling address plus the purpose. That is the pragmatic choice
 * for anonymous abuse control; the trade-off (shared addresses share a limit) is
 * documented in the README.
 */
export function rateLimit(purpose: "create" | "unlock"): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const limiter = purpose === "create" ? c.env.CREATE_LIMITER : c.env.UNLOCK_LIMITER;
		const address = clientAddress(c);
		if (!limiter || !address) return next();

		try {
			const { success } = await limiter.limit({ key: `${purpose}:${address}` });
			if (!success) throw fail.rateLimited();
		} catch (error) {
			if (error instanceof Error && error.name === "AppError") throw error;
			// A limiter outage must not take the whole service down.
			return next();
		}

		return next();
	};
}

export function clientAddress(c: Context<AppBindings>): string | null {
	return c.req.header("cf-connecting-ip") ?? null;
}

/** Per-paste limit for unlock attempts, so a single paste cannot be ground down. */
export async function limitPasteUnlock(c: Context<AppBindings>, pasteId: string): Promise<void> {
	const limiter = c.env.UNLOCK_LIMITER;
	if (!limiter) return;
	try {
		const { success } = await limiter.limit({ key: `unlock-paste:${pasteId}` });
		if (!success) throw fail.rateLimited();
	} catch (error) {
		if (error instanceof Error && error.name === "AppError") throw error;
	}
}
