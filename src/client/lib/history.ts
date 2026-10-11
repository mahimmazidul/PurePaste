/**
 * The "My pastes" list, stored in this browser only.
 *
 * Nothing here is sent anywhere, and paste contents are never stored — only the
 * links, the management token, and enough metadata to show a useful list.
 */

const STORAGE_KEY = "purepaste.history.v1";
const MAX_ENTRIES = 200;

export interface HistoryEntry {
	id: string;
	title: string | null;
	kind: string;
	url: string;
	manageUrl: string;
	token: string;
	/** Present for encrypted pastes so the management link can rebuild the key. */
	key?: string | null;
	createdAt: number;
	expiresAt: number;
	algorithm?: "client-side-key" | "none";
}

function isEntry(value: unknown): value is HistoryEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<HistoryEntry>;
	return typeof entry.id === "string" && typeof entry.token === "string" && typeof entry.url === "string";
}

export function loadHistory(): HistoryEntry[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isEntry).sort((a, b) => b.createdAt - a.createdAt);
	} catch {
		return [];
	}
}

function persist(entries: HistoryEntry[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
	} catch {
		// Private browsing modes can refuse writes; the list simply will not persist.
	}
}

export function addHistory(entry: HistoryEntry): void {
	const entries = loadHistory().filter((existing) => existing.id !== entry.id);
	entries.unshift(entry);
	persist(entries);
	updateHistoryBadges();
}

export function updateHistory(id: string, patch: Partial<HistoryEntry>): void {
	const entries = loadHistory();
	const index = entries.findIndex((entry) => entry.id === id);
	if (index === -1) return;
	entries[index] = { ...entries[index]!, ...patch };
	persist(entries);
}

export function removeHistory(ids: string[]): void {
	const removing = new Set(ids);
	persist(loadHistory().filter((entry) => !removing.has(entry.id)));
	updateHistoryBadges();
}

export function findHistory(id: string): HistoryEntry | undefined {
	return loadHistory().find((entry) => entry.id === id);
}

export function updateHistoryBadges(): void {
	const count = loadHistory().length;
	for (const badge of document.querySelectorAll<HTMLElement>("[data-history-count]")) {
		if (count === 0) {
			badge.hidden = true;
			continue;
		}
		badge.hidden = false;
		badge.textContent = String(count);
	}
}
