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

/**
 * CSP for the copyable media URL, which is the same body but meant to be *drawn*.
 *
 * A direct media link is opened as a top-level page, and a browser paints that
 * page with its own image, player or document element. `default-src 'none'` on its
 * own stops exactly that, and `sandbox` would disable the native viewers too, so
 * this policy names the one source they need — this URL — and nothing else.
 * `getMedia` only ever answers with a type the media allowlist accepted (an
 * image, audio, video or PDF, never markup), so no script or page can ride along.
 * `object-src` is listed for the PDF viewer; `frame-ancestors` still keeps the
 * bytes out of somebody else's frame, which is what `sandbox` was buying here.
 */
export const CSP_FOR_MEDIA =
	"default-src 'none'; img-src 'self'; media-src 'self'; object-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const CONTENT_TAIL = /\/(raw|download|media)$/;

/** The inline media URL: our own bytes, for the browser to render. */
export function isMediaRoute(path: string): boolean {
	return /\/media$/.test(path);
}

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
		// The inline media URL gets the one policy that lets a browser draw it, and
		// only when the bytes really are a renderable type — a 415 or a refusal is
		// still an HTML page and stays under the strict policy.
		const servedType = response.headers.get("Content-Type") ?? "";
		const mediaRoute =
			isMediaRoute(path) && /^(image|audio|video)\/|^application\/pdf\b/.test(servedType.replace(/;.*$/, ""));
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
			mediaRoute
				? CSP_FOR_MEDIA
				: contentRoute
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
