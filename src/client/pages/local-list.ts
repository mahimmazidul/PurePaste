import { announce, qs } from "../lib/dom";
import { getLocalItems, removeLocalItem, saveLocalItem, type LocalItem } from "../lib/local-items";

/* The drawer and the "Sealed." page both live off the same small store. */

const rowIcons = {
	paste: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.6 3.2H6.8a2 2 0 0 0-2 2v9.6a2 2 0 0 0 2 2h6.4a2 2 0 0 0 2-2V7z"/><path d="M11.6 3.2V7h3.6"/></svg>`,
	link: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.4 11.6 11.6 8.4"/><path d="M9.4 6.6 11 5a3.5 3.5 0 0 1 5 5l-1.6 1.6"/><path d="M10.6 13.4 9 15a3.5 3.5 0 0 1-5-5l1.6-1.6"/></svg>`,
	trash: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 6.2h11.6"/><path d="M8 3.4h4l.6 2.8H7.4z"/><path d="M6.1 6.4l.7 9.1a1.6 1.6 0 0 0 1.6 1.5h3.2a1.6 1.6 0 0 0 1.6-1.5l.7-9.1"/></svg>`,
	copy: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7.25" y="7.25" width="9.5" height="9.5" rx="2.5"/><path d="M12.75 4.6a2.5 2.5 0 0 0-2.5-2.35H5.5A2.5 2.5 0 0 0 3 4.75v4.75a2.5 2.5 0 0 0 2.35 2.5"/></svg>`,
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "in 5 days", "in 3 hours", "any moment now" */
export function timeUntil(date: Date | string | number): string {
	const ms = new Date(date).getTime() - Date.now();
	if (ms <= 0) return "expired";
	if (ms < HOUR) {
		const mins = Math.round(ms / MIN);
		if (mins < 2) return "any moment now";
		return `in ${mins} minutes`;
	}
	if (ms < DAY) {
		const hrs = Math.round(ms / HOUR);
		return hrs === 1 ? "in 1 hour" : `in ${hrs} hours`;
	}
	const days = Math.round(ms / DAY);
	if (days < 31) return days === 1 ? "in 1 day" : `in ${days} days`;
	const months = Math.round(days / 30);
	return months === 1 ? "in about a month" : `in ${months} months`;
}

/** The created page files the new slip away as soon as it loads. */
export function initCreatedPage(): void {
	const raw = document.body.dataset.created;
	if (!raw) return;
	try {
		const item = JSON.parse(raw) as LocalItem;
		if (item && item.id && item.manageToken) {
			saveLocalItem(item);
		}
	} catch {
		/* a malformed attribute just means no drawer entry */
	}
}

/** The drawer under the composer on the front page. */
export function initLocalList(): void {
	const list = qs<HTMLElement>("[data-drawer-list]");
	if (!list) return;

	const items = getLocalItems();
	list.textContent = "";

	if (items.length === 0) {
		const empty = document.createElement("p");
		empty.className = "drawer-empty";
		empty.textContent = "The drawer is empty. Everything you seal will rest here until it fades.";
		list.append(empty);
		return;
	}

	const ul = document.createElement("ul");
	ul.className = "local-list";

	for (const item of items) {
		ul.append(rowFor(item, ul));
	}
	list.append(ul);
}

function rowFor(item: LocalItem, ul: HTMLUListElement): HTMLLIElement {
	const li = document.createElement("li");
	li.className = "local-row";

	const icon = document.createElement("span");
	icon.className = "local-icon";
	icon.innerHTML = item.kind === "link" ? rowIcons.link : rowIcons.paste;

	const title = document.createElement("a");
	title.className = "local-title";
	title.href = item.url;
	if (item.title) title.textContent = item.title;
	else {
		const path = document.createElement("span");
		path.className = "mono";
		path.textContent = `/${item.kind === "link" ? "l" : "p"}/${item.id}`;
		title.append(path);
	}

	const fades = document.createElement("span");
	fades.className = "local-fades";
	fades.textContent = `fades ${timeUntil(item.expiresAt)}`;

	const copy = document.createElement("button");
	copy.type = "button";
	copy.className = "local-copy";
	copy.innerHTML = `${rowIcons.copy}<span>Copy</span>`;
	copy.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(item.url);
			announce("Link copied", "success");
		} catch {
			announce("Couldn't copy — select the link and copy it manually", "error");
		}
	});

	const letGo = document.createElement("button");
	letGo.type = "button";
	letGo.className = "local-letgo";
	letGo.innerHTML = rowIcons.trash;
	letGo.setAttribute("aria-label", "Let it go");
	letGo.title = "Let it go now";

	letGo.addEventListener("click", () => {
		const sure = document.createElement("button");
		sure.type = "button";
		sure.className = "local-sure";
		sure.textContent = "Sure?";
		sure.addEventListener("click", () => void release());
		letGo.replaceWith(sure);
		// Clicking anywhere else puts the small trash can back.
		const restore = (event: MouseEvent) => {
			if (!li.contains(event.target as Node)) {
				sure.replaceWith(letGo);
				document.removeEventListener("click", restore);
			}
		};
		window.setTimeout(() => document.addEventListener("click", restore), 0);
	});

	async function release(): Promise<void> {
		try {
			await fetch(`/api/pastes/${item.id}`, {
				method: "DELETE",
				headers: { "X-Manage-Token": item.manageToken },
			});
		} catch {
			/* even on failure, drop it from the device */
		}
		removeLocalItem(item.id);
		li.remove();
		if (ul.childElementCount === 0) location.reload();
		else announce("Let go, gently", "success");
	}

	li.append(icon, title, fades, copy, letGo);
	return li;
}
