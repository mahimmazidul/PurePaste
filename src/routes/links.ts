import type { Context } from "hono";
import type { AppBindings } from "../env";
import { fail } from "../lib/errors";
import { assembleRedirectInput, parseId } from "../lib/validation";
import { claimBurn, createPaste, loadPaste, stores } from "../services/paste-store";
import { renderLinkInterstitial } from "../views/pages/link";
import { renderGonePage } from "../views/pages/error";

/**
 * Links: the "short hop" side of Slip.
 *
 * A link is stored exactly like any other paste — kind `redirect` — but it is
 * never an invisible 302. Visitors land on an interstitial that shows the
 * destination first; continuing is a deliberate POST that counts the visit and,
 * for burn-after-reading links, spends it atomically.
 */

function asLinkPayload(record: { id: string; redirectUrl: string | null; burnAfterRead: boolean; views: number; createdAt: number; expiresAt: number }) {
	return {
		id: record.id,
		url: record.redirectUrl,
		burn: record.burnAfterRead,
		visits: record.views,
		created_at: record.createdAt,
		expires_at: record.expiresAt,
	};
}

/** GET /l/:id — the interstitial page. */
export async function getLinkPage(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const now = Date.now();
	const result = await loadPaste(c.env, id, { now });

	if (result.status === "missing") {
		return c.html(renderGonePage({ config: c.get("config"), reason: "missing", kind: "link" }), 404);
	}
	if (result.status === "expired") {
		return c.html(renderGonePage({ config: c.get("config"), reason: "expired", kind: "link" }), 410);
	}
	if (result.status === "consumed") {
		return c.html(renderGonePage({ config: c.get("config"), reason: "burned", kind: "link" }), 410);
	}

	const record = result.record;
	if (record.kind !== "redirect" || !record.redirectUrl) {
		// Not a link. Slips live at /p/:id; send strays there rather than 404ing.
		return c.redirect(`/p/${id}`, 302);
	}

	// A burn link keeps its destination secret until it is spent.
	const showUrl = record.burnAfterRead && record.consumedAt === null ? null : record.redirectUrl;
	return c.html(renderLinkInterstitial({ config: c.get("config"), record, url: showUrl, now }));
}

/** POST /l/:id/go — the deliberate continuation. Counts the visit, burns if flagged, then 302s. */
export async function goLink(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const now = Date.now();
	const result = await loadPaste(c.env, id, { now });

	if (result.status !== "ok" && result.status !== "needs-reveal") {
		if (result.status === "expired") return c.redirect(`/l/${id}`, 303);
		return c.html(renderGonePage({ config: c.get("config"), reason: result.status === "consumed" ? "burned" : "missing", kind: "link" }), result.status === "consumed" ? 410 : 404);
	}

	const record = result.record;
	if (record.kind !== "redirect" || !record.redirectUrl) throw fail.notFound();

	let url = record.redirectUrl;
	if (record.burnAfterRead) {
		// One atomic claim: two simultaneous visitors cannot both be let through.
		const claimed = await claimBurn(c.env, id, now);
		if (!claimed || !claimed.redirectUrl) {
			return c.html(renderGonePage({ config: c.get("config"), reason: "burned", kind: "link" }), 410);
		}
		url = claimed.redirectUrl;
	} else {
		// Visits on links are always counted — the number is the point of a link.
		await stores(c.env).meta.addViews([{ id, count: 1 }]);
	}

	c.header("Cache-Control", "no-store");
	return c.redirect(url, 302);
}

/** POST /api/links — seal a short hop (Slip-shaped request and answer). */
export async function createLink(c: Context<AppBindings>): Promise<Response> {
	const config = c.get("config");
	const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object") throw fail.invalidRequest("Send JSON, please.");

	const input = assembleRedirectInput(
		{
			title: typeof body.title === "string" ? body.title : null,
			url: typeof body.url === "string" ? body.url : null,
			slug: typeof body.slug === "string" ? body.slug : null,
			expire: (body.expiry ?? body.expire ?? body.ttl) as string | undefined,
			burn: body.burn ?? body.burn_after_reading,
		},
		config,
	);

	const created = await createPaste(c.env, config, input);
	const origin = new URL(c.req.url).origin;
	const id = created.record.id;

	return c.json(
		{
			id,
			url: `${origin}/l/${id}`,
			manage_url: `${origin}/manage/${id}#token=${created.manageToken}`,
			manageToken: created.manageToken,
			manage_token: created.manageToken,
			expiresAt: new Date(created.record.expiresAt).toISOString(),
			expires_at: created.record.expiresAt,
			burn: created.record.burnAfterRead,
		},
		201,
	);
}

/** POST /api/links/:id/reveal — count the visit and hand back the destination as JSON. */
export async function revealLink(c: Context<AppBindings>): Promise<Response> {
	const id = parseId(c.req.param("id"));
	const now = Date.now();
	const result = await loadPaste(c.env, id, { now });

	if (result.status === "missing") throw fail.notFound();
	if (result.status === "expired") throw fail.expired();
	if (result.status === "consumed") throw fail.consumed();

	const record = result.record;
	if (record.kind !== "redirect" || !record.redirectUrl) throw fail.notFound();

	if (record.burnAfterRead) {
		const claimed = await claimBurn(c.env, id, now);
		if (!claimed || !claimed.redirectUrl) throw fail.consumed();
		return c.json({ link: asLinkPayload({ ...claimed, views: claimed.views + 1 }) });
	}

	await stores(c.env).meta.addViews([{ id, count: 1 }]);
	return c.json({ link: asLinkPayload({ ...record, views: record.views + 1 }) });
}
