/**
 * The drawer: what this device sealed, kept only in this browser.
 *
 * One record per slip or link, with its delete key. Nothing here ever reaches
 * the server — losing the browser loses the drawer, which is the point.
 */

export interface LocalItem {
	kind: "paste" | "link";
	id: string;
	title: string | null;
	url: string;
	manageToken: string;
	expiresAt: string;
	createdAt: string;
	/** Present for slips encrypted in the browser: the fragment key. */
	key?: string | null;
}

const KEY = "slip-items-v1";

function readAll(): LocalItem[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(x): x is LocalItem => Boolean(x) && typeof x.id === "string" && typeof x.manageToken === "string",
		);
	} catch {
		return [];
	}
}

function writeAll(items: LocalItem[]): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(items.slice(0, 60)));
	} catch {
		/* storage full or unavailable */
	}
}

/** All items with expired ones pruned away, newest first. */
export function getLocalItems(): LocalItem[] {
	const now = Date.now();
	const all = readAll();
	const live = all.filter((x) => new Date(x.expiresAt).getTime() > now);
	if (live.length !== all.length) writeAll(live);
	return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function saveLocalItem(item: LocalItem): void {
	const all = readAll().filter((x) => !(x.id === item.id));
	all.unshift(item);
	writeAll(all);
}

export function findItem(id: string): LocalItem | null {
	return readAll().find((x) => x.id === id) ?? null;
}

export function removeLocalItem(id: string): void {
	writeAll(readAll().filter((x) => x.id !== id));
}

/** Updates fields of a stored item if this device has it. */
export function updateLocalItem(id: string, patch: Partial<LocalItem>): void {
	const all = readAll();
	const item = all.find((x) => x.id === id);
	if (!item) return;
	writeAll(all.map((x) => (x.id === id ? { ...x, ...patch } : x)));
}
