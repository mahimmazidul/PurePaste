import { readFragment } from "../lib/crypto";
import { announce, formatBytes, qs, upgradeRelativeTimes } from "../lib/dom";
import { removeLocalItem, updateLocalItem } from "../lib/local-items";

interface Metadata {
	id: string;
	kind: string;
	locked: boolean;
	encrypted: boolean;
	markdown: boolean;
	burn_after_reading: boolean;
	awaits_reveal: boolean;
	title: string | null;
	language: string | null;
	filename: string | null;
	size_bytes: number;
	created_at: number;
	expires_at: number;
	views: number | null;
}

const REASONS: Record<number, string> = {
	404: "This slip is no longer here. It was either let go or it faded.",
	410: "This slip has faded, or it was a one-time link that has already been opened.",
};

/**
 * The management page reads the token out of the URL fragment. It never reaches
 * the server: not in a request line, not in a referrer, not in a log.
 */
export function initManagePage(): void {
	upgradeRelativeTimes();

	const id = document.body.dataset.pasteId;
	if (!id) return;

	const panel = qs<HTMLElement>("[data-manage-panel]");
	const loading = qs<HTMLElement>("[data-manage-loading]");
	const errorPanel = qs<HTMLElement>("[data-manage-error]");
	const errorText = qs<HTMLElement>("[data-manage-error-text]");
	const token = readFragment(location.hash).get("token");
	const key = readFragment(location.hash).get("k");

	const fail = (message: string): void => {
		loading?.setAttribute("hidden", "");
		errorPanel?.removeAttribute("hidden");
		if (errorText) errorText.textContent = message;
		// Nothing else on this page works without a token, so the delete button
		// stays disabled rather than failing later.
		for (const button of document.querySelectorAll<HTMLButtonElement>("[data-delete-open]")) button.disabled = true;
	};

	if (!token) {
		fail(
			"The part of the link after the #, which holds the management key, did not arrive. Copy the whole link — everything after the # matters.",
		);
		return;
	}

	// Narrowing is captured here rather than relied on inside the closure below.
	void load({ id, token });

	async function load(target: { id: string; token: string }): Promise<void> {
		const { id } = target;
		let meta: Metadata;
		try {
			const response = await fetch(`/api/pastes/${id}`, { headers: { Accept: "application/json" } });
			if (!response.ok) {
				fail(REASONS[response.status] ?? "This slip couldn't be found.");
				return;
			}
			meta = (await response.json()) as Metadata;
		} catch {
			fail("Couldn't reach the server. Check your connection and reload this page.");
			return;
		}

		loading?.setAttribute("hidden", "");
		panel?.removeAttribute("hidden");

		// The public link only carries a key for encrypted pastes, and only if the
		// management link was saved with one.
		const publicPath = meta.kind === "redirect" ? `/l/${id}` : `/p/${id}`;
		const publicUrl = key ? `${location.origin}${publicPath}#k=${key}` : `${location.origin}${publicPath}`;
		const publicField = qs<HTMLInputElement>("[data-manage-public]");
		if (publicField) publicField.value = publicUrl;
		const manageField = qs<HTMLInputElement>("[data-manage-link]");
		if (manageField) manageField.value = location.href;

		const status = qs<HTMLElement>("[data-manage-status]");
		if (status) {
			status.textContent = meta.awaits_reveal
				? "Still unopened. A one-time paste is only spent when somebody presses the button on the reveal page."
				: meta.encrypted
					? "Encrypted. We store scrambled bytes and cannot read them."
					: "Live until it expires.";
		}

		const list = qs<HTMLDListElement>("[data-manage-meta]");
		if (list) {
			const items: Array<[string, string]> = [
				[
					"Type",
					meta.encrypted
						? "Encrypted paste"
						: meta.kind === "file"
							? "File"
							: meta.kind === "redirect"
								? "Link"
								: "Text",
				],
				["Size", formatBytes(meta.size_bytes)],
				["Sealed", new Date(meta.created_at).toLocaleString()],
				["Fades", new Date(meta.expires_at).toLocaleString()],
			];
			if (meta.locked) items.push(["Protection", "Password required"]);
			if (typeof meta.views === "number") items.push(["Reads", `${meta.views} (approximate)`]);
			list.textContent = "";
			for (const [label, value] of items) {
				const wrapper = document.createElement("div");
				wrapper.className = "meta-item";
				const dt = document.createElement("dt");
				dt.textContent = label;
				const dd = document.createElement("dd");
				dd.textContent = value;
				wrapper.append(dt, dd);
				list.append(wrapper);
			}
		}

		// Keep the local list in step with what the server just told us.
		updateLocalItem(id, {
			expiresAt: new Date(meta.expires_at).toISOString(),
			...(meta.title ? { title: meta.title } : {}),
			...(key ? { key } : {}),
		});

		const openLink = qs<HTMLAnchorElement>("[data-manage-open]");
		if (openLink) openLink.href = publicUrl;

		const forkLink = qs<HTMLAnchorElement>("[data-manage-fork]");
		if (meta.encrypted && forkLink) {
			// A fork of ciphertext would be useless: it cannot be re-encrypted.
			forkLink.setAttribute("hidden", "");
		}

		wireDelete(target.id, target.token);
	}
}

function wireDelete(id: string, token: string): void {
	const opener = qs<HTMLButtonElement>("[data-delete-open]");
	const dialog = qs<HTMLDialogElement>("[data-confirm-dialog]");
	const confirmButton = qs<HTMLButtonElement>("[data-confirm-accept]");
	if (!opener) return;

	opener.disabled = false;

	opener.addEventListener("click", () => {
		if (dialog && typeof dialog.showModal === "function") {
			dialog.showModal();
			return;
		}
		// No dialog support: the browser's own confirmation carries the same warning.
		if (window.confirm("Delete this paste? This cannot be undone.")) void performDelete();
	});

	confirmButton?.addEventListener("click", () => {
		dialog?.close();
		void performDelete();
	});

	async function performDelete(): Promise<void> {
		opener!.disabled = true;
		try {
			const response = await fetch(`/api/pastes/${id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			});
			// 404 means somebody already deleted it, which is the outcome we wanted.
			if (!response.ok && response.status !== 404) throw new Error(String(response.status));
			removeLocalItem(id);
			announce("Let go, gently", "success");
			location.assign("/#drawer");
		} catch {
			opener!.disabled = false;
			announce("The slip couldn't be let go. Check your connection and try again.", "error");
		}
	}
}
