import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";

/**
 * Security headers.
 *
 * The Content Security Policy is built from `default-src 'none'`: nothing is
 * allowed unless it is named. There are no inline scripts anywhere in the
 * application, so `script-src 'self'` needs no hashes or nonces.
 */
export function buildCsp(options: { turnstile?: boolean } = {}): string {
	const directives = [
		"default-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"img-src 'self' data:",
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

export function isContentRoute(path: string): boolean {
	return path.startsWith("/raw/") || path.startsWith("/download/") || path === "/robots.txt" || path === "/favicon.ico";
}

export function isPublicShellPath(path: string): boolean {
	return path === "/" || path === "/about" || path === "/pastes";
}

export function securityHeaders(): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const path = c.req.path;
		const contentRoute = isContentRoute(path);

		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		c.header(
			"Permissions-Policy",
			"accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
		);
		c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
		c.header(
			"Content-Security-Policy",
			contentRoute ? CSP_FOR_CONTENT : buildCsp({ turnstile: c.get("config")?.turnstileEnabled === true }),
		);
		c.header("Cross-Origin-Resource-Policy", "same-origin");

		if (!contentRoute) {
			c.header("X-Frame-Options", "DENY");
			c.header("Cross-Origin-Opener-Policy", "same-origin");
		}

		// Nothing served by the Worker is cacheable: pastes expire, and protected
		// responses must never be replayed from a cache.
		c.header("Cache-Control", "no-store");
		if (!isPublicShellPath(path)) {
			c.header("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
		}

		await next();
	};
}
