import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";
import { fail } from "../lib/errors";

/**
 * Rejects oversized bodies before they are read.
 *
 * Only `Content-Length` can be checked up front; a chunked body without a length
 * is still bounded by the per-route checks that run once the payload is parsed,
 * so nothing unbounded is ever buffered.
 */
export function bodyLimitBytes(limit: number): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
		if (Number.isFinite(declared) && declared > limit) {
			throw fail.tooLarge(`${Math.floor(limit / 1024)} KiB`);
		}
		await next();
	};
}
