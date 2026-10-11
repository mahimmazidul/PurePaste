import type { Config } from "../../config";
import { escapeHtml, formatDuration } from "../../lib/format";
import { copyField, icons, notice, renderLayout } from "../layout";
import type { PasteKind } from "../../types";

export interface CreatedPageOptions {
	config: Config;
	origin: string;
	id: string;
	manageToken: string;
	expiresAt: number;
	kind: PasteKind;
	burnAfterRead: boolean;
	title?: string | null;
	redirectUrl?: string | null;
	now?: number;
}

/** Server-rendered result of a form submission: works with JavaScript disabled. */
export function renderCreated(options: CreatedPageOptions): string {
	const isLink = options.kind === "redirect";
	const path = `/${isLink ? "l" : "p"}/${options.id}`;
	const publicUrl = `${options.origin}${path}`;
	const manageUrl = `${options.origin}/manage/${options.id}#token=${options.manageToken}`;
	const now = options.now ?? Date.now();

	// The shape the drawer on the front page keeps, so the page script can file
	// this slip away without another round trip.
	const localItem = JSON.stringify({
		kind: isLink ? "link" : "paste",
		id: options.id,
		title: (isLink ? options.redirectUrl : options.title) ?? null,
		url: publicUrl,
		manageToken: options.manageToken,
		expiresAt: new Date(options.expiresAt).toISOString(),
		createdAt: new Date(now).toISOString(),
	});

	const burnNote = options.burnAfterRead
		? `<p class="sealed-burn">${icons.flame}<span>${
				isLink
					? "It burns the moment someone continues — one visit, then it's gone."
					: "It burns the moment someone opens it — one read, then it's gone."
			}</span></p>`
		: "";

	const body = `
	<section class="card sealed-card rise-in">
		<div class="sealed-head">
			<span class="sealed-check">${icons.check}</span>
			<div>
				<h1 class="sealed-title font-display-it">Sealed.</h1>
				<p class="sealed-lede">Your ${isLink ? "link" : options.kind === "file" ? "file" : "slip"} lives for now — it fades in ${escapeHtml(formatDuration(Math.max(0, Math.round((options.expiresAt - now) / 1000))))}. Nothing lists it; the link below is the only way in.</p>
			</div>
		</div>

		<div class="sealed-url-row">
			<span class="sealed-url mono">${escapeHtml(publicUrl)}</span>
			<span class="sealed-actions">
				<button class="btn btn-secondary" type="button" data-copy-target="sealed-url-value">${icons.copy}<span>Copy link</span></button>
				<input type="hidden" id="sealed-url-value" value="${escapeHtml(publicUrl)}">
				<a class="btn btn-primary" href="${escapeHtml(path)}">${icons.external}<span>Open</span></a>
			</span>
		</div>
		${burnNote}

		<div class="sealed-manage hairline-t">
			${copyField({
				id: "manage-link",
				label: "The delete key",
				value: manageUrl,
				description:
					"A delete key was saved in this browser, under “Kept on this device”. This link is the spare copy — we store a fingerprint of the key, so we can't show it again.",
			})}
		</div>
		${notice({
			tone: "warn",
			title: "Keep the key somewhere safe",
			body: "Without it the slip can only be left to fade. The drawer on the front page of this browser already holds a copy.",
		})}
		<div class="form-actions">
			<a class="btn btn-quiet" href="/">Make another</a>
		</div>
	</section>
`;

	return renderLayout({
		config: options.config,
		page: "created",
		title: "Sealed",
		body,
		noindex: true,
		bodyAttributes: { "data-created": localItem },
	});
}
