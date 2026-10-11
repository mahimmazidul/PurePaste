import type { Context } from "hono";

export type ResponseFormat = "html" | "json" | "text";

/**
 * Content negotiation for the API.
 *
 * Format is decided by the request, not by the User-Agent: an explicit `?format=`
 * wins, then the Accept header, then the route's default.
 */
export function negotiate(c: Context, fallback: ResponseFormat = "html"): ResponseFormat {
	const explicit = c.req.query("format")?.toLowerCase();
	if (explicit === "json" || explicit === "text" || explicit === "html") return explicit;

	const accept = c.req.header("accept") ?? "";
	if (accept.includes("application/json")) return "json";
	if (accept.includes("text/plain")) return "text";
	if (accept.includes("text/html")) return "html";

	// API paths default to JSON so `curl` without headers does the useful thing.
	if (c.req.path.startsWith("/api/")) return "json";
	return fallback;
}

export function wantsUrlOnly(c: Context): boolean {
	const explicit = c.req.query("format")?.toLowerCase();
	if (explicit === "text" || explicit === "url") return true;
	const accept = c.req.header("accept") ?? "";
	return accept.includes("text/plain") && !accept.includes("text/html");
}
