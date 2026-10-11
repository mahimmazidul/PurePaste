import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "./env";
import { resolveConfig } from "./config";
import { fail, isAppError, type AppError } from "./lib/errors";
import { negotiate } from "./lib/negotiate";
import { securityHeaders } from "./middleware/security";
import { rateLimit } from "./middleware/rate-limit";
import { bodyLimitBytes } from "./middleware/body-limit";
import { createFromRequest, renderHomeWithError } from "./routes/create";
import { getDownload, getPastePage, getRawPaste, revealPaste } from "./routes/paste";
import { deleteManagedPaste, getMetadata, unlockPaste } from "./routes/manage";
import { renderApiDocs } from "./views/pages/docs";
import { renderAboutPage } from "./views/pages/about";
import { renderErrorPage } from "./views/pages/error";
import { renderHistoryPage } from "./views/pages/history";
import { renderLicensesPage } from "./views/pages/licenses";
import { renderHome } from "./views/pages/home";
import { renderManagePage } from "./views/pages/manage";

/**
 * Route table.
 *
 * Fixed application routes are registered before the catch-all paste route, and
 * that route is a single path segment, so `/api/...`, `/raw/...`, `/download/...`
 * and `/manage/...` can never be shadowed by a paste.
 */
export function createApp(): Hono<AppBindings> {
	const app = new Hono<AppBindings>();

	// Configuration is resolved once per request. Everything downstream reads it
	// from the context rather than re-parsing the environment.
	app.use("*", async (c, next) => {
		c.set("config", resolveConfig(c.env));
		await next();
	});
	app.use("*", securityHeaders());

	app.onError((error, c) => renderError(error, c));
	app.notFound((c) => renderError(fail.notFound(), c));

	/* ------------------------- pages ------------------------- */

	app.get("/", (c) => c.html(renderHome({ config: c.get("config") })));
	app.get("/pastes", (c) => c.html(renderHistoryPage(c.get("config"))));
	app.get("/about", (c) => c.html(renderAboutPage(c.get("config"))));
	app.get("/licenses", (c) => c.html(renderLicensesPage(c.get("config"))));
	app.get("/docs", (c) =>
		c.html(renderApiDocs({ config: c.get("config"), origin: new URL(c.req.url).origin })),
	);
	app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n"));

	app.post("/", rateLimit("create"), async (c) => {
		const outcome = await createFromRequest(c);
		if (outcome.ok) return outcome.response;
		// A rejected form comes back as the form itself, with what was typed still in it.
		if (isAppError(outcome.error) && outcome.error.status < 500) {
			return renderHomeWithError(c, outcome.error, outcome.formValues);
		}
		throw outcome.error;
	});

	/* ------------------------- api ------------------------- */

	const api = new Hono<AppBindings>();

	api.post("/pastes", rateLimit("create"), async (c) => {
		const outcome = await createFromRequest(c);
		if (!outcome.ok) throw outcome.error;
		return outcome.response;
	});
	api.get("/pastes/:id", (c) => getMetadata(c));
	api.get("/pastes/:id/raw", (c) => getRawPaste(c));
	api.post("/pastes/:id/unlock", bodyLimitBytes(8 * 1024), rateLimit("unlock"), (c) => unlockPaste(c));
	api.post("/pastes/:id/reveal", bodyLimitBytes(4 * 1024), (c) => revealPaste(c));
	api.delete("/pastes/:id", bodyLimitBytes(2 * 1024), (c) => deleteManagedPaste(c));
	api.get("/config", (c) => {
		const config = c.get("config");
		return c.json({
			ttl_choices: config.ttlChoices.map((choice) => ({ value: choice.value, seconds: choice.seconds })),
			max_ttl_seconds: config.maxTtlSeconds,
			text_max_bytes: config.textMaxBytes,
			file_max_bytes: config.fileMaxBytes,
			inline_text_max_bytes: config.inlineTextMaxBytes,
			password_iterations: config.passwordIterations,
			features: {
				redirect: config.redirectEnabled,
				view_counting: config.viewCounting,
				turnstile: config.turnstileEnabled,
			},
		});
	});

	// A path that exists but not for this method is answered plainly, with the
	// methods that do work. Without this, Hono would report 404 and send a client
	// looking for a bug that is not there.
	const allow = (methods: string[]) => (c: Context<AppBindings>) => {
		c.header("Allow", methods.join(", "));
		if (c.req.method === "OPTIONS") return c.body(null, 204);
		return c.json({ error: "method_not_allowed", message: `Use ${methods.join(" or ")} on this address.` }, 405);
	};

	api.all("/pastes", allow(["POST", "OPTIONS"]));
	api.all("/pastes/:id", allow(["GET", "DELETE", "OPTIONS"]));
	api.all("/pastes/:id/raw", allow(["GET", "OPTIONS"]));
	api.all("/pastes/:id/unlock", allow(["POST", "OPTIONS"]));
	api.all("/pastes/:id/reveal", allow(["POST", "OPTIONS"]));
	api.all("/config", allow(["GET", "OPTIONS"]));

	app.route("/api", api);

	/* --------------------- paste routes --------------------- */

	app.get("/manage/:id", (c) => c.html(renderManagePage({ config: c.get("config"), id: c.req.param("id") })));
	app.get("/raw/:id", (c) => getRawPaste(c));
	app.get("/download/:id", (c) => getDownload(c));

	// Friendly aliases for the same resources.
	app.get("/:id", (c) => getPastePage(c));
	app.get("/:id/raw", (c) => getRawPaste(c));
	app.get("/:id/download", (c) => getDownload(c));

	return app;
}

/* ------------------------- errors ------------------------- */

export function renderError(error: unknown, c: Context<AppBindings>): Response {
	const appError: AppError = isAppError(error) ? error : fail.internal();
	const config = c.get("config");

	// A client that is being throttled should be told when to come back rather than
	// left to guess. The window is a minute everywhere in this application.
	if (appError.status === 429) c.header("Retry-After", "60");
	const wantsJson = negotiate(c, c.req.path.startsWith("/api/") ? "json" : "html") === "json";

	if (!isAppError(error)) {
		// Log the cause for the operator; never return internals to the client.
		console.error("Unhandled error", {
			path: c.req.path,
			method: c.req.method,
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}

	if (wantsJson) {
		return c.json(
			{ error: appError.code, message: appError.message, ...(appError.hint ? { hint: appError.hint } : {}) },
			appError.status as 400,
		);
	}

	if (appError.status >= 500) {
		return c.html(
			renderErrorPage({
				config,
				status: 500,
				title: "Something went wrong",
				message: "That wasn't meant to happen. Nothing was saved, so it's safe to try again.",
			}),
			500,
		);
	}

	return c.html(
		renderErrorPage({
			config,
			status: appError.status,
			title: titleForError(appError),
			message: appError.message,
			hint: appError.hint,
		}),
		appError.status as 400,
	);
}

function titleForError(error: AppError): string {
	switch (error.code) {
		case "not_found":
			return "Nothing at this address";
		case "expired":
			return "This paste has expired";
		case "consumed":
			return "Already opened";
		case "rate_limited":
			return "Slow down a moment";
		case "payload_too_large":
			return "Too big";
		case "unsupported_media_type":
			return "Unsupported format";
		case "turnstile_failed":
			return "Couldn't verify that";
		case "slug_taken":
			return "That name is taken";
		case "invalid_credentials":
			return "That password didn't match";
		default:
			return "That didn't work";
	}
}
