import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";

/**
 * Security headers.
 *
 * The Content Security Policy is built from `default-src 'none'`: nothing is
 * allowed unless it is named. There are no inline scripts anywhere in the
 * application, so `script-src 'self'` needs no hashes or nonces.
 */
export function buildCsp(options: { turnstile?: boolean; mediaOrigin?: string } = {}): string {
	// Direct bucket links are the only third-party media source we allow, and only
	// the exact origin the operator configured — never a wildcard.
	const extra = options.mediaOrigin ? ` ${options.mediaOrigin}` : "";
	const directives = [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		`img-src 'self' data:${extra}`,
		// The viewer page can draw a stored image, clip or track. Same-origin only,
		// and `object-src 'none'` stays: a PDF is opened by the browser's own viewer
		// in its own tab, never framed inside our pages.
		`media-src 'self'${extra}`,
		"style-src 'self'",
		"font-src 'self'",
		"connect-src 'self'" + (options.turnstile ? " https://challenges.cloudflare.com" : ""),
		"script-src 'self'" + (options.turnstile ? " https://challenges.cloudflare.com" : ""),
		"object-src 'none'",
		"worker-src 'none'",
	];
	if (options.turnstile) directives.push("frame-src https://challenges.cloudflare.com");
	return directives.join("; ");
}

/** CSP for routes that hand back untrusted bytes: inert, and never embeddable. */
export const CSP_FOR_CONTENT = "default-src 'none'; sandbox; frame-ancestors 'none'";

const CONTENT_TAIL = /\/(raw|download|media)$/;

export function isContentRoute(path: string): boolean {
	if (path.startsWith("/raw/") || path.startsWith("/download/")) return true;
	// The same bytes are reachable as /p/:id/raw and /:id/media; the policy a
	// response carries has to follow the bytes, not the URL shape that got there.
	if (CONTENT_TAIL.test(path)) return true;
	return path === "/robots.txt" || path === "/favicon.ico";
}

/** Pages that are meant to be found by search engines, plus robots.txt itself. */
export function isPublicShellPath(path: string): boolean {
	return path === "/" || path === "/about" || path === "/licenses" || path === "/pastes" || path === "/robots.txt";
}

/**
 * Headers are applied to the finished response rather than to the context, so a
 * route that hands back a streamed body or a hand-built Response is covered just
 * as well as one that uses `c.html`.
 */
export function securityHeaders(): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		await next();

		const path = c.req.path;
		const contentRoute = isContentRoute(path);
		const response = c.res;
		const headers = new Headers(response.headers);

		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "no-referrer");
		headers.set(
			"Permissions-Policy",
			"accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
		);
		headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
		headers.set(
			"Content-Security-Policy",
			contentRoute
				? CSP_FOR_CONTENT
				: buildCsp({
						turnstile: c.get("config")?.turnstileEnabled === true,
						mediaOrigin: c.get("config")?.storageDirectOrigin,
					}),
		);
		headers.set("Cross-Origin-Resource-Policy", "same-origin");

		if (!contentRoute) {
			headers.set("X-Frame-Options", "DENY");
			headers.set("Cross-Origin-Opener-Policy", "same-origin");
		}

		// Nothing served by the Worker is cacheable unless the route said otherwise:
		// pastes expire, and protected responses must never be replayed from a cache.
		// `getMedia` is the one place that opts in, and only for an unlocked,
		// non-burning paste on an instance that set MEDIA_CACHE_SECONDS.
		if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
		if (!isPublicShellPath(path)) {
			headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
		}

		c.res = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
