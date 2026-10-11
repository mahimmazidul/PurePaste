import { announce, copyText, qs, upgradeRelativeTimes } from "../lib/dom";
import { addHistory, loadHistory, removeHistory, updateHistoryBadges, type HistoryEntry } from "../lib/history";

/** Expiry is stored in seconds by the server; accept either that or milliseconds. */
function expiresInMs(entry: HistoryEntry): number {
	return entry.expiresAt > 1e12 ? entry.expiresAt : entry.expiresAt * 1000;
}

/**
 * The result page hands the paste that was just created to this browser, which
 * writes it to localStorage. The token came from the server as part of a plain
 * form post, and this is the only place it is kept.
 */
export function initCreatedPage(): void {
	const notice = qs<HTMLElement>("[data-created]");
	if (!notice) return;
	upgradeRelativeTimes();

	try {
		const raw = JSON.parse(notice.dataset.created ?? "{}") as Partial<HistoryEntry>;
		if (typeof raw.id === "string" && typeof raw.token === "string" && typeof raw.url === "string") {
			addHistory({
				id: raw.id,
				title: raw.title ?? null,
				kind: raw.kind ?? "text",
				url: raw.url,
				manageUrl: raw.manageUrl ?? `${location.origin}/manage/${raw.id}#token=${raw.token}`,
				token: raw.token,
				key: null,
				createdAt: raw.createdAt ?? Date.now(),
				expiresAt: raw.expiresAt ?? 0,
				algorithm: "none",
			});
		}
	} catch {
		// A malformed blob is not worth interrupting the page for.
	}
}

/**
 * "My pastes" renders whatever localStorage holds. The server is asked about a
 * paste only when the visitor presses the check button: there is no list
 * endpoint and no idle polling.
 */
export function initHistoryPage(): void {
	upgradeRelativeTimes();

	const container = qs<HTMLElement>("[data-history-list]");
	if (!container) return;
	const empty = qs<HTMLElement>("[data-history-empty]", container);

	let list = qs<HTMLUListElement>("ul.history-list", container);
	if (!list) {
		list = document.createElement("ul");
		list.className = "history-list";
		container.append(list);
	}

	const makeButton = (label: string, onClick: () => void, variant = "quiet"): HTMLButtonElement => {
		const element = document.createElement("button");
		element.type = "button";
		element.className = `btn btn-${variant} btn-small`;
		element.textContent = label;
		element.addEventListener("click", onClick);
		return element;
	};

	/** Deletion needs the management token, which is why it lives in this list. */
	const deleteEntry = async (entry: HistoryEntry, item: HTMLLIElement): Promise<void> => {
		if (!window.confirm("Delete this paste? This cannot be undone.")) return;
		try {
			const response = await fetch(`/api/pastes/${entry.id}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${entry.token}`, Accept: "application/json" },
			});
			if (!response.ok && response.status !== 404) throw new Error(String(response.status));
			removeHistory([entry.id]);
			item.remove();
			announce("Gone for good", "success");
			render();
		} catch {
			announce("Couldn't delete that paste", "error");
		}
	};

	const row = (entry: HistoryEntry): HTMLLIElement => {
		const item = document.createElement("li");
		item.className = "history-row";
		item.dataset.id = entry.id;

		const main = document.createElement("div");
		main.className = "history-main";

		const title = document.createElement("a");
		title.className = "history-title";
		title.href = entry.url;
		title.textContent = entry.title?.trim() || entry.id;
		main.append(title);

		const meta = document.createElement("p");
		meta.className = "history-meta";
		const tags: string[] = [entry.kind === "file" ? "File" : entry.kind === "redirect" ? "Link" : "Text"];
		if (entry.algorithm === "client-side-key") tags.push("encrypted");
		if (entry.key) tags.push("key saved here");
		meta.textContent = `${tags.join(" · ")} — expires ${new Date(expiresInMs(entry)).toLocaleDateString()}`;
		main.append(meta);

		const controls = document.createElement("div");
		controls.className = "history-controls";
		controls.append(
			makeButton("Open", () => {
				location.href = entry.url;
			}),
			makeButton("Copy link", () => void copyText(entry.url, "Link copied")),
			makeButton("Copy management link", () => void copyText(entry.manageUrl, "Management link copied")),
			makeButton("Delete", () => void deleteEntry(entry, item), "danger"),
		);

		item.append(main, controls);
		return item;
	};

	function render(): void {
		const entries = loadHistory();
		list!.textContent = "";
		if (empty) empty.hidden = entries.length > 0;
		for (const entry of entries) list!.append(row(entry));
		updateHistoryBadges();
	}

	render();

	// "Check for expired pastes" asks the server once per entry, one at a time, and
	// drops the ones that are gone. A failed request proves nothing, so nothing is
	// removed on error.
	qs("[data-history-check]")?.addEventListener("click", async (event) => {
		const button = event.currentTarget as HTMLButtonElement;
		const label = button.textContent ?? "Check for expired pastes";
		button.disabled = true;
		button.textContent = "Checking…";
		const stale: string[] = [];

		for (const entry of loadHistory()) {
			try {
				const response = await fetch(`/api/pastes/${entry.id}`, { headers: { Accept: "application/json" } });
				if (response.status === 404 || response.status === 410) stale.push(entry.id);
			} catch {
				// Offline, or the request was refused: keep the entry.
			}
		}

		if (stale.length > 0) removeHistory(stale);
		render();
		button.disabled = false;
		button.textContent = label;
		announce(
			stale.length === 0
				? "Everything in this list is still online"
				: `Removed ${stale.length} expired ${stale.length === 1 ? "entry" : "entries"}`,
			"success",
		);
	});

	// "Forget old entries" only touches the local list; the pastes themselves stay
	// online until they expire on their own.
	qs("[data-history-forget]")?.addEventListener("click", () => {
		const now = Date.now();
		const stale = loadHistory()
			.filter((entry) => expiresInMs(entry) <= now)
			.map((entry) => entry.id);
		if (stale.length === 0) {
			announce("Nothing in this list has expired yet");
			return;
		}
		removeHistory(stale);
		render();
		announce(`Forgot ${stale.length} expired ${stale.length === 1 ? "entry" : "entries"}`);
	});
}
