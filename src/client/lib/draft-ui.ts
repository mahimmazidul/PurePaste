/**
 * Composer-side draft behaviour: take a snapshot of every panel, put it back
 * after a refresh, and offer the way out of it. Storage itself lives in
 * ./drafts — this file only talks to the DOM.
 */

import { clearDraft, loadDraft, saveDraft, type Draft } from "./drafts";
import { announce, qs, qsa } from "./dom";

/** Fields we never mirror: the file handle can't survive anyway. */
const IGNORED_NAMES = new Set([
	"file",
	"password_salt",
	"password_verifier",
	"password_iterations",
	"cf-turnstile-response",
]);

let timer: number | undefined;

function snapshot(form: HTMLFormElement): Draft["panels"][string] {
	const fields: Record<string, string> = {};
	const boxes: Record<string, 0 | 1> = {};
	for (const element of qsa<HTMLInputElement | HTMLSelectElement>("[name]", form)) {
		const name = element.getAttribute("name");
		if (!name || IGNORED_NAMES.has(name)) continue;
		if (element instanceof HTMLInputElement) {
			if (element.type === "checkbox") {
				boxes[name] = element.checked ? 1 : 0;
				continue;
			}
			if (element.type === "file" || element.type === "password") continue;
			fields[name] = element.value;
			continue;
		}
		if (element instanceof HTMLSelectElement) {
			fields[name] = element.value;
			continue;
		}
		fields[name] = (element as HTMLInputElement).value;
	}
	return { fields, boxes };
}

/**
 * Mirror the whole composer — all three panels, not only the visible one, since
 * the others are the same `<form>` siblings a refresh would also have eaten.
 */
function collect(): Draft {
	const panels: Draft["panels"] = {};
	for (const form of qsa<HTMLFormElement>("[data-create-form]")) {
		panels[form.dataset.mode ?? "slip"] = snapshot(form);
	}
	const active = qsa<HTMLInputElement>("[data-mode-radio]").find((radio) => radio.checked);
	return { panels, mode: active?.dataset.modeRadio };
}

/** Debounced, so a fast typist doesn't hammer localStorage. */
export function queueDraftSave(): void {
	window.clearTimeout(timer);
	timer = window.setTimeout(() => saveDraft(collect()), 350);
}

export function flushDraft(): void {
	window.clearTimeout(timer);
	saveDraft(collect());
}

export function discardDraft(): void {
	clearDraft();
}

/** Puts a stored draft back into the form. True when there was content to restore. */
export function applyDraft(): boolean {
	const draft = loadDraft();
	if (!draft) return false;

	for (const form of qsa<HTMLFormElement>("[data-create-form]")) {
		const panel = draft.panels[form.dataset.mode ?? "slip"];
		if (!panel) continue;
		for (const [name, value] of Object.entries(panel.fields ?? {})) {
			if (!value) continue;
			const field = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
				`[name="${CSS.escape(name)}"]`,
			);
			if (field && !field.matches("input[type='password'], input[type='file']")) field.value = value;
		}
		for (const [name, value] of Object.entries(panel.boxes ?? {})) {
			const box = form.querySelector<HTMLInputElement>(`input[type='checkbox'][name="${CSS.escape(name)}"]`);
			if (box) box.checked = value === 1;
		}
		// Programmatic assignment fires nothing, so the behaviours listening for it
		// (editor auto-grow, the character count, the "Lives for …" hint) are
		// nudged by hand — otherwise a restored sheet looks empty even when it is not.
		form.querySelector("[data-editor]")?.dispatchEvent(new Event("input", { bubbles: true }));
		form.querySelector('select[name="expire"]')?.dispatchEvent(new Event("change", { bubbles: true }));
	}

	const notice = qs<HTMLInputElement>(`[data-mode-radio="${draft.mode ?? ""}"]`);
	if (notice) {
		notice.checked = true;
		notice.dispatchEvent(new Event("change", { bubbles: true }));
	}

	const restored = Object.values(draft.panels).some((panel) => !isBlank(panel));
	const banner = qs<HTMLElement>("[data-draft-notice]");
	if (restored) {
		if (banner) banner.hidden = false;
		const text = qs<HTMLElement>("[data-draft-notice-text]");
		const age = draft.savedAt ? draftAge(draft.savedAt) : "";
		if (text && age) text.textContent = `This browser had something in progress (${age}), so it's back.`;
	}
	return restored;
}

function isBlank(panel: Draft["panels"][string] | undefined): boolean {
	if (!panel) return true;
	const text = Object.entries(panel.fields ?? {}).some(([, value]) => value.trim() !== "");
	const boxes = Object.values(panel.boxes ?? {}).some((value) => value === 1);
	return !text && !boxes;
}

function draftAge(savedAt: string): string {
	const saved = new Date(savedAt).getTime();
	if (!Number.isFinite(saved)) return "";
	const minutes = Math.max(1, Math.round((Date.now() - saved) / 60_000));
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

/** The "we kept it" banner: discard, or simply get on with writing. */
export function wireDraftNotice(): void {
	const banner = qs<HTMLElement>("[data-draft-notice]");
	const button = qs<HTMLButtonElement>("[data-draft-clear]");
	if (!banner || !button) return;
	button.addEventListener("click", () => {
		discardDraft();
		for (const form of qsa<HTMLFormElement>("[data-create-form]")) {
			for (const field of qsa<HTMLInputElement | HTMLTextAreaElement>("[name]", form)) {
				if (field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "file")) {
					if (field.type === "checkbox") field.checked = false;
					continue;
				}
				field.value = "";
			}
		}
		banner.hidden = true;
		announce("Draft discarded", "info");
	});
}
