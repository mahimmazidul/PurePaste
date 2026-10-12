/**
 * Unfinished sheets, kept in this browser only.
 *
 * A refresh used to eat whatever was typed — which is the one way this page can
 * lose work. So every field on the composer is mirrored into localStorage and put
 * back on the next load. Files cannot be kept (the browser never lets a page hold
 * on to one), and a slip's text is only mirrored while it fits inside a budget, so
 * a ten-megabyte paste can never throw a quota error at the writer.
 *
 * Nothing here is uploaded. Clearing site data clears the draft, same as the drawer.
 */

export interface DraftPanel {
	fields: Record<string, string>;
	boxes: Record<string, 0 | 1>;
}

export interface Draft {
	panels: Record<string, DraftPanel>;
	/** Which tab was open, so a refresh lands where you left it. */
	mode?: string;
	savedAt?: string;
}

const KEY = "slip-draft-v1";
/** Above this, the text is a file job rather than a draft; we stop mirroring it. */
const MAX_DRAFT_BYTES = 200 * 1024;
/** A draft nobody came back for is stale after a week. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function read(): Draft | null {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Draft;
		if (!parsed || typeof parsed !== "object" || !parsed.panels) return null;
		if (typeof parsed.savedAt === "string") {
			const age = Date.now() - new Date(parsed.savedAt).getTime();
			if (Number.isFinite(age) && age > MAX_AGE_MS) {
				localStorage.removeItem(KEY);
				return null;
			}
		}
		return parsed;
	} catch {
		return null;
	}
}

function write(draft: Draft): void {
	try {
		localStorage.setItem(KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
	} catch {
		/* quota exceeded or storage disabled — the form simply keeps behaving as before */
	}
}

function isEmpty(panel: DraftPanel | undefined): boolean {
	if (!panel) return true;
	const text = Object.entries(panel.fields ?? {}).some(([, value]) => value.trim() !== "");
	const boxes = Object.values(panel.boxes ?? {}).some((value) => value === 1);
	return !text && !boxes;
}

/** True when the draft has anything a person would miss. */
function hasContent(draft: Draft | null): boolean {
	if (!draft) return false;
	return Object.values(draft.panels).some((panel) => !isEmpty(panel));
}

/** Only the slip editor is measured; every other field is short by design. */
function fitsBudget(draft: Draft): boolean {
	const content = draft.panels.slip?.fields.content ?? "";
	return new TextEncoder().encode(content).byteLength <= MAX_DRAFT_BYTES;
}

export function saveDraft(draft: Draft): void {
	if (!hasContent(draft) && !draft.mode) {
		clearDraft();
		return;
	}
	if (!fitsBudget(draft)) {
		// Keep the small fields, drop the giant body: better a partial draft than none.
		const slip = draft.panels.slip;
		write({
			...draft,
			panels: { ...draft.panels, slip: { fields: { ...slip?.fields, content: "" }, boxes: { ...slip?.boxes } } },
		});
		return;
	}
	write(draft);
}

/** What this browser was working on, if anything. */
export function loadDraft(): Draft | null {
	return read();
}

export function clearDraft(): void {
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* nothing to clear */
	}
}
