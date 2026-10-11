import type { Config } from "../../config";
import { escapeHtml } from "../../lib/format";
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
}

/** Server-rendered result of a form submission: works with JavaScript disabled. */
export function renderCreated(options: CreatedPageOptions): string {
	const publicUrl = `${options.origin}/${options.id}`;
	const manageUrl = `${options.origin}/manage/${options.id}#token=${options.manageToken}`;
	const history = JSON.stringify({
		id: options.id,
		token: options.manageToken,
		url: publicUrl,
		manageUrl,
		expiresAt: options.expiresAt,
		kind: options.kind,
		title: null,
		createdAt: Date.now(),
	});

	const burnNote = options.burnAfterRead
		? notice({
				tone: "info",
				title: "Burn after opening is on",
				body: "The first person to press Open on the reveal page gets it, and then it's gone for good. Link previews can't trigger it.",
			})
		: "";

	const body = `
	<section class="hero">
		<h1 class="h1">Paste created</h1>
		<p class="lede">${options.kind === "redirect" ? "Your link is ready." : "Your paste is live until it expires."} Copy the links below before you close this page.</p>
	</section>

	<section class="card">
		${copyField({ id: "public-link", label: "Share this link", value: publicUrl, description: "Anyone with this link can read it." })}
		${copyField({
			id: "manage-link",
			label: "Keep this link somewhere safe",
			value: manageUrl,
			description:
				"This is the only way to check on or delete the paste. We store a fingerprint of the key, not the key itself, so we can't send it again.",
		})}
		<div class="notice-row">
			${notice({
				tone: "warn",
				title: "Save the management link now",
				body: "It won't be shown again after you leave this page. Without it, the paste can only be left to expire.",
			})}
			${burnNote}
		</div>
		<div class="form-actions">
			<a class="btn btn-primary" href="/${escapeHtml(options.id)}">${icons.eye}<span>Open the paste</span></a>
			<a class="btn btn-secondary" href="/">${icons.copy}<span>Make another</span></a>
		</div>
	</section>
`;

	return renderLayout({
		config: options.config,
		page: "created",
		title: "Paste created",
		body,
		noindex: true,
		bodyAttributes: { "data-created": history },
	});
}
