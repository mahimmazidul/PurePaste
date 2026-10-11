import type { Config } from "../../config";
import type { PasteRecord } from "../../types";
import { escapeHtml, formatDuration } from "../../lib/format";
import { icons, renderLayout } from "../layout";

export interface LinkInterstitialOptions {
	config: Config;
	record: PasteRecord;
	/** Null while a burn-after-reading link is still sealed. */
	url: string | null;
	now: number;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/**
 * The deliberate hop. A link on Slip is never an invisible 302: the visitor
 * sees the destination, and continuing is a POST that counts the visit — and,
 * for a burn link, spends it. Works entirely without JavaScript.
 */
export function renderLinkInterstitial(options: LinkInterstitialOptions): string {
	const { record, url, now } = options;
	const id = record.id;
	const burn = record.burnAfterRead;

	const destination = url
		? `<div class="destination">
			<span class="destination-label smallcaps">Destination</span>
			<span class="destination-url mono">${escapeHtml(url)}</span>
		</div>
		<div class="form-actions">
			<form method="post" action="/l/${escapeHtml(id)}/go" data-link-go>
				<button class="btn btn-primary" type="submit">${icons.arrowUpRight}<span>Continue to ${escapeHtml(hostOf(url))}</span></button>
			</form>
			<button class="btn btn-secondary" type="button" data-copy-target="link-dest-copy">${icons.copy}<span>Copy destination</span></button>
			<input type="hidden" id="link-dest-copy" value="${escapeHtml(url)}">
		</div>`
		: `<p class="gate-note">${icons.eyeOff}<span>The destination stays sealed until you continue — that is the whole point of a one-time link.</span></p>
		<div class="form-actions">
			<form method="post" action="/l/${escapeHtml(id)}/go" data-link-go>
				<button class="btn btn-primary" type="submit">${icons.flame}<span>Continue, and let it go</span></button>
			</form>
			<a class="btn btn-secondary" href="/">Leave it sealed</a>
		</div>`;

	const body = `
	<div class="gate-wrap">
		<section class="card gate-card rise-in">
			<span class="gate-icon">${icons.link}</span>
			<h1 class="h1 gate-title">${burn ? `This link <span class="font-display-it">burns</span> after one visit.` : "A short, honest hop."}</h1>
			<p class="lede">${
				burn
					? "Once. That's all it has. The moment you continue, it's gone for everyone — link previews and refreshing can't coax it back."
					: "Slip shows you where a short link actually goes before you land there. Nobody arrives somewhere unexpected."
			}</p>
			${destination}
			<p class="gate-meta">
				<span>${icons.eye}${escapeHtml(String(record.views))} ${record.views === 1 ? "visit" : "visits"}</span>
				<span aria-hidden="true">·</span>
				<span>fades in ${escapeHtml(formatDuration(Math.max(0, Math.round((record.expiresAt - now) / 1000))))}</span>
			</p>
		</section>
	</div>
`;

	return renderLayout({
		config: options.config,
		page: "link",
		title: "A short hop",
		body,
		noindex: true,
		compactHeader: true,
		bodyAttributes: { "data-link-id": id, "data-link-burn": burn ? "1" : "0" },
	});
}
