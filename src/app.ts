import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings, AppEnv } from "./env";
import { resolveConfig, type Config } from "./config";
import { fail, isAppError, type AppError } from "./lib/errors";
import { negotiate } from "./lib/negotiate";
import { securityHeaders } from "./middleware/security";
import { rateLimit } from "./middleware/rate-limit";
import { bodyLimitBytes } from "./middleware/body-limit";
import { createFromRequest, renderHomeWithError } from "./routes/create";
import { getDownload, getMedia, getPastePage, getRawPaste, revealPaste } from "./routes/paste";
import { deleteManagedPaste, getMetadata, unlockPaste } from "./routes/manage";
import { createLink, getLinkPage, goLink, revealLink } from "./routes/links";
import { stores } from "./services/paste-store";
import { resolveStorage } from "./services/storage-provider";
import { renderApiDocs } from "./views/pages/docs";
import { renderAboutPage } from "./views/pages/about";
import { renderErrorPage } from "./views/pages/error";
import { renderLicensesPage } from "./views/pages/licenses";
import { renderHome } from "./views/pages/home";
import { renderManagePage } from "./views/pages/manage";
import type { HomeStats } from "./views/pages/home";

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

	app.get("/", async (c) => {
		const stats: HomeStats = { slips: 0, links: 0, files: 0, bytes: 0 };
		try {
			const rows = await stores(c.env).meta.stats(Date.now());
			for (const row of rows) {
				if (row.kind === "redirect") stats.links += row.count;
				else if (row.kind === "file") stats.files += row.count;
				else stats.slips += row.count;
				stats.bytes += row.bytes;
			}
		} catch {
			// A stat bar must never take the front page down with it.
		}
		return c.html(renderHome({ config: c.get("config"), stats }));
	});
	// The drawer of device-kept slips now lives on the front page.
	app.get("/pastes", (c) => c.redirect("/#drawer", 302));
	app.get("/about", (c) => c.html(renderAboutPage(c.get("config"))));
	app.get("/licenses", (c) => c.html(renderLicensesPage(c.get("config"))));
	app.get("/docs", (c) => c.html(renderApiDocs({ config: c.get("config"), origin: new URL(c.req.url).origin })));
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
	api.post("/links", rateLimit("create"), (c) => createLink(c));
	api.get("/links/:id", (c) => getMetadata(c));
	api.delete("/links/:id", bodyLimitBytes(2 * 1024), (c) => deleteManagedPaste(c));
	api.post("/links/:id/reveal", bodyLimitBytes(2 * 1024), rateLimit("unlock"), (c) => revealLink(c));
	api.get("/stats", async (c) => {
		const rows = await stores(c.env).meta.stats(Date.now());
		let slips = 0;
		let links = 0;
		let files = 0;
		let bytes = 0;
		for (const row of rows) {
			if (row.kind === "redirect") links += row.count;
			else if (row.kind === "file") files += row.count;
			else slips += row.count;
			bytes += row.bytes;
		}
		return c.json({ slips, links, files, bytes });
	});
	/**
	 * Which object store is live and why — no secrets, no bucket contents. It exists
	 * because storage is chosen by configuration, and the fastest way to check a
	 * deploy is to ask it.
	 */
	api.get("/health", (c) => c.json({ ok: true, time: Date.now() }));
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
			storage: storageReport(c.env, config),
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
	api.all("/links", allow(["POST", "OPTIONS"]));
	api.all("/links/:id", allow(["GET", "DELETE", "OPTIONS"]));
	api.all("/links/:id/reveal", allow(["POST", "OPTIONS"]));
	api.all("/stats", allow(["GET", "OPTIONS"]));
	api.all("/health", allow(["GET", "OPTIONS"]));
	api.all("/config", allow(["GET", "OPTIONS"]));

	app.route("/api", api);

	/* --------------------- paste routes --------------------- */

	app.get("/manage/:id", (c) => c.html(renderManagePage({ config: c.get("config"), id: c.req.param("id") })));
	app.get("/raw/:id", (c) => getRawPaste(c));
	app.get("/download/:id", (c) => getDownload(c));

	// Canonical Slip paths: slips under /p/, links behind their interstitial at /l/.
	app.get("/p/:id", (c) => getPastePage(c));
	app.get("/p/:id/raw", (c) => getRawPaste(c));
	app.get("/p/:id/download", (c) => getDownload(c));
	app.get("/p/:id/media", (c) => getMedia(c));
	app.get("/l/:id", (c) => getLinkPage(c));
	app.post("/l/:id/go", (c) => goLink(c));

	// Friendly aliases for the same resources.
	app.get("/:id", (c) => getPastePage(c));
	app.get("/:id/raw", (c) => getRawPaste(c));
	app.get("/:id/download", (c) => getDownload(c));
	app.get("/:id/media", (c) => getMedia(c));

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

/** Non-sensitive storage diagnostics for `GET /api/config`. */
function storageReport(env: AppEnv, config: Config) {
	try {
		const resolved = resolveStorage(env);
		return {
			provider: resolved.provider,
			reason: resolved.reason,
			direct_links: Boolean(config.storageDirectOrigin),
		};
	} catch (error) {
		return { provider: "none", reason: (error as Error).message, direct_links: false };
	}
}
