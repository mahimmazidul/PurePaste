import { newEncryptionKey, passwordFieldData } from "../lib/crypto";
import { announce, formatBytes, qs, qsa } from "../lib/dom";
import { saveLocalItem } from "../lib/local-items";

/**
 * The composer: three tabs, one sheet of paper each.
 *
 * Everything works without this file — the tabs are radios, the forms are
 * ordinary POSTs, and the server answers with the "Sealed." page. What lives
 * here is convenience (auto-grow, counts, ⌘+Enter, drag and drop) plus the two
 * things that genuinely cannot work without client-side code: deriving a
 * password verifier and encrypting a payload before it leaves the browser.
 */
export function initCreatePage(): void {
	const forms = qsa<HTMLFormElement>("[data-create-form]");
	for (const form of forms) wireForm(form);
	wireTabs();
	void prefillFork();
}

const CAPTIONS: Record<string, string> = {
	slip: "code · notes · prose",
	link: "short, honest links",
	file: "anything, up to the size limit",
};

function wireTabs(): void {
	const caption = qs<HTMLElement>("[data-mode-caption]");
	const radios = qsa<HTMLInputElement>("[data-mode-radio]");
	const sync = () => {
		const active = radios.find((radio) => radio.checked);
		if (caption && active) caption.textContent = CAPTIONS[active.dataset.modeRadio ?? ""] ?? "";
	};
	for (const radio of radios) radio.addEventListener("change", sync);
	sync();

	// More-options disclosure, per panel.
	for (const toggle of qsa<HTMLButtonElement>("[data-more-toggle]")) {
		toggle.addEventListener("click", () => {
			const body = qs<HTMLElement>("[data-more-body]", toggle.closest(".composer-panel") ?? undefined);
			const open = toggle.getAttribute("aria-expanded") === "true";
			toggle.setAttribute("aria-expanded", String(!open));
			const span = toggle.querySelector("span");
			if (span) span.textContent = open ? "More options" : "Fewer options";
			if (body) body.hidden = open;
		});
	}
}

/** ?fork=<id> pulls the old slip's text into the new one. */
async function prefillFork(): Promise<void> {
	const fork = new URLSearchParams(location.search).get("fork");
	if (!fork || !/^[a-z0-9-]{3,64}$/i.test(fork)) return;
	const radio = qs<HTMLInputElement>('[data-mode-radio="slip"]');
	if (radio) radio.checked = true;
	const editor = qs<HTMLTextAreaElement>('[data-mode="slip"] [data-editor]');
	if (!editor) return;
	try {
		const response = await fetch(`/raw/${encodeURIComponent(fork)}`, { headers: { Accept: "text/plain" } });
		if (!response.ok) return;
		editor.value = await response.text();
		updateCount(editor);
		grow(editor);
	} catch {
		/* the fork notice on the page already explains what was meant to happen */
	}
}

function grow(editor: HTMLTextAreaElement): void {
	editor.style.height = "0px";
	editor.style.height = `${Math.max(320, editor.scrollHeight)}px`;
}

function updateCount(editor: HTMLTextAreaElement): void {
	const form = editor.closest("[data-create-form]");
	const counter = form ? qs<HTMLElement>("[data-composer-count]", form) : null;
	if (!counter) return;
	const chars = editor.value.length;
	counter.textContent = chars > 0 ? `${chars.toLocaleString("en-US")} characters · ${formatBytes(new TextEncoder().encode(editor.value).byteLength)}` : "";
}

function wireForm(form: HTMLFormElement): void {
	const mode = form.dataset.mode ?? "slip";
	const editor = qs<HTMLTextAreaElement>("[data-editor]", form);
	const submitButton = qs<HTMLButtonElement>("[data-submit-button]", form);
	const passwordInput = qs<HTMLInputElement>("[data-password-input]", form);
	const encryptToggle = qs<HTMLInputElement>("[data-encrypt-input]", form);
	const fileInput = qs<HTMLInputElement>("[data-file-input]", form);
	const fileNameLabel = qs("[data-file-name]", form);
	const dropzone = qs("[data-dropzone]", form);
	const iterationsField = qs<HTMLInputElement>("[data-password-iterations]", form);
	const expireSelect = qs<HTMLSelectElement>('select[name="expire"]', form);
	const counter = qs<HTMLElement>("[data-composer-count]", form);

	if (editor) {
		// The editor is focused on desktop, where a keyboard is waiting. On phones
		// this would open a soft keyboard and hide the form, so it is left alone.
		if (window.matchMedia("(min-width: 860px) and (pointer: fine)").matches) editor.focus();
		editor.addEventListener("input", () => {
			grow(editor);
			updateCount(editor);
		});
		grow(editor);
		updateCount(editor);
	}

	if (counter && expireSelect && mode !== "slip") {
		const sync = () => {
			const label = expireSelect.options[expireSelect.selectedIndex]?.textContent ?? "";
			counter.textContent = `Lives for ${label.toLowerCase()}`;
		};
		expireSelect.addEventListener("change", sync);
		sync();
	}

	// Ctrl/Cmd + Enter seals from anywhere in the form.
	form.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			form.requestSubmit();
		}
	});

	if (dropzone && fileInput) {
		const showFile = () => {
			const file = fileInput.files?.[0];
			if (fileNameLabel) {
				fileNameLabel.hidden = !file;
				fileNameLabel.textContent = file ? `${file.name} · ${formatBytes(file.size)}` : "";
			}
			dropzone.classList.toggle("has-file", Boolean(file));
		};

		fileInput.addEventListener("change", showFile);
		for (const type of ["dragenter", "dragover"]) {
			dropzone.addEventListener(type, (event) => {
				event.preventDefault();
				dropzone.classList.add("is-target");
			});
		}
		for (const type of ["dragleave", "drop"]) {
			dropzone.addEventListener(type, (event) => {
				event.preventDefault();
				dropzone.classList.remove("is-target");
			});
		}
		dropzone.addEventListener("drop", (event) => {
			const files = (event as DragEvent).dataTransfer?.files;
			if (!files || files.length === 0) return;
			fileInput.files = files;
			showFile();
		});
	}

	const setBusy = (busy: boolean) => {
		form.setAttribute("aria-busy", busy ? "true" : "false");
		if (!submitButton) return;
		submitButton.disabled = busy;
		const span = submitButton.querySelector("span");
		if (!span) return;
		if (busy) {
			submitButton.dataset.label = span.textContent ?? "";
			span.textContent = "Sealing…";
		} else if (submitButton.dataset.label) {
			span.textContent = submitButton.dataset.label;
		}
	};

	const showError = (message: string) => {
		let box = qs("[data-create-error]", form);
		if (!box) {
			box = document.createElement("p");
			box.className = "field-error";
			box.setAttribute("role", "alert");
			box.setAttribute("data-create-error", "");
			form.prepend(box);
		}
		box.textContent = message;
		setBusy(false);
	};

	form.addEventListener("submit", async (event) => {
		// Second pass through the submit event, after everything was derived.
		if (form.dataset.derived === "1") return;

		const password = passwordInput?.value ?? "";
		const encrypting = Boolean(encryptToggle?.checked);

		if (!password && !encrypting) {
			// Ordinary POST: the server answers with the "Sealed." page.
			if (mode === "slip" && !(editor?.value ?? "").trim()) {
				event.preventDefault();
				showError("Write something first — empty slips aren't kept.");
				editor?.focus();
				return;
			}
			if (mode === "file" && !(fileInput?.files?.[0])) {
				event.preventDefault();
				showError("Choose a file first.");
				return;
			}
			setBusy(true);
			return;
		}

		event.preventDefault();
		setBusy(true);

		try {
			if (password) {
				const requested = Number(iterationsField?.value ?? "") || 210_000;
				const data = await passwordFieldData(password, requested);
				const saltField = qs<HTMLInputElement>("[data-password-salt]", form);
				const verifierField = qs<HTMLInputElement>("[data-password-verifier]", form);
				if (saltField) saltField.value = data.salt;
				if (verifierField) verifierField.value = data.verifier;
				if (iterationsField) iterationsField.value = String(data.iterations);
				// The plaintext password is cleared so it cannot be submitted by mistake.
				if (passwordInput) passwordInput.value = "";
			}

			if (encrypting) {
				await submitEncrypted(form);
				return;
			}

			form.dataset.derived = "1";
			form.submit();
		} catch (error) {
			showError(
				error instanceof Error && error.message === "nothing_to_encrypt"
					? "There's nothing to encrypt yet. Type something or choose a file."
					: error instanceof Error && error.message === "create_failed"
						? "The slip couldn't be sealed. Try again."
						: error instanceof Error && error.message
							? error.message
							: "Something went wrong preparing the slip. Try again.",
			);
		}
	});
}

/** The encrypted path: the payload never leaves as anything but ciphertext. */
async function submitEncrypted(form: HTMLFormElement): Promise<void> {
	const editor = qs<HTMLTextAreaElement>("[data-editor]", form);
	const fileInput = qs<HTMLInputElement>("[data-file-input]", form);
	const titleInput = qs<HTMLInputElement>('input[name="title"]', form);
	const languageSelect = qs<HTMLSelectElement>('select[name="language"]', form);
	const markdownInput = qs<HTMLInputElement>('input[name="markdown"]', form);

	const file = fileInput?.files?.[0] ?? null;
	const text = editor?.value ?? "";

	if (!file && text.trim().length === 0) {
		throw new Error("nothing_to_encrypt");
	}

	const metadata = {
		title: titleInput?.value.trim() || null,
		filename: file ? file.name : null,
		language: file ? "plaintext" : (languageSelect?.value ?? "plaintext"),
		markdown: Boolean(markdownInput?.checked),
		contentType: file ? file.type || "application/octet-stream" : null,
		kind: (file ? "file" : "text") as "file" | "text",
	};

	const key = newEncryptionKey();
	const payload = file ? new Uint8Array(await file.arrayBuffer()) : new TextEncoder().encode(text);
	const { encryptEnvelope } = await import("../lib/crypto");
	const envelope = await encryptEnvelope(metadata, payload, key);

	const data = new FormData();
	data.set("encrypted", "1");
	data.set("expire", qs<HTMLSelectElement>('select[name="expire"]', form)?.value ?? "");
	data.set("slug", qs<HTMLInputElement>('input[name="slug"]', form)?.value ?? "");
	const burn = qs<HTMLInputElement>('input[name="burn"]', form);
	if (burn?.checked) data.set("burn", "1");

	// Password material travels as fields; the password itself never does.
	const salt = qs<HTMLInputElement>("[data-password-salt]", form)?.value;
	const verifier = qs<HTMLInputElement>("[data-password-verifier]", form)?.value;
	const iterations = qs<HTMLInputElement>("[data-password-iterations]", form)?.value;
	if (salt && verifier && iterations) {
		data.set("password_salt", salt);
		data.set("password_verifier", verifier);
		data.set("password_iterations", iterations);
	}

	const turnstile = qs<HTMLInputElement>('input[name="cf-turnstile-response"]', form);
	if (turnstile?.value) data.set("cf-turnstile-response", turnstile.value);

	data.set("payload", new File([envelope], "payload.bin", { type: "application/octet-stream" }));

	const response = await fetch("/api/pastes", {
		method: "POST",
		body: data,
		headers: { Accept: "application/json" },
	});

	if (!response.ok) {
		const detail = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(detail?.message ?? "create_failed");
	}

	const created = (await response.json()) as {
		id: string;
		expires_at: number;
		manage_token: string;
	};

	saveLocalItem({
		kind: "paste",
		id: created.id,
		title: metadata.title ?? (file ? file.name : null),
		url: `${location.origin}/p/${created.id}#k=${key}`,
		manageToken: created.manage_token,
		expiresAt: new Date(created.expires_at).toISOString(),
		createdAt: new Date().toISOString(),
		key,
	});

	announce("Encrypted and sealed", "success");
	location.assign(`/p/${created.id}#k=${key}`);
}
