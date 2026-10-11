import { newEncryptionKey, passwordFieldData } from "../lib/crypto";
import { announce, formatBytes, qs } from "../lib/dom";

/**
 * Editor enhancements.
 *
 * The form works without any of this: the plain path is an ordinary POST that the
 * server answers with a result page. What is added here is convenience
 * (keyboard shortcut, drag and drop, size readout) plus the two features that
 * genuinely cannot work without client-side code: deriving a password verifier
 * and encrypting a payload before it leaves the browser.
 */
export function initCreatePage(): void {
	const form = qs<HTMLFormElement>("[data-create-form]");
	if (!form) return;

	const editor = qs<HTMLTextAreaElement>("[data-editor]", form);
	const counter = qs("[data-editor-counter]", form);
	const submitButton = qs<HTMLButtonElement>("[data-submit-button]", form);
	const passwordInput = qs<HTMLInputElement>("[data-password-input]", form);
	const encryptToggle = qs<HTMLInputElement>("[data-encrypt-input]", form);
	const fileInput = qs<HTMLInputElement>("[data-file-input]", form);
	const fileNameLabel = qs("[data-file-name]", form);
	const dropzone = qs("[data-dropzone]", form);
	const iterationsField = qs<HTMLInputElement>("[data-password-iterations]", form);

	// The editor is focused on desktop, where a keyboard is waiting. On phones this
	// would open a soft keyboard and hide the form, so it is left alone.
	if (editor && window.matchMedia("(min-width: 860px) and (pointer: fine)").matches) {
		editor.focus();
	}

	if (editor && counter) {
		const updateCounter = () => {
			const bytes = new TextEncoder().encode(editor.value).byteLength;
			counter.textContent = editor.value ? `${formatBytes(bytes)}` : "";
		};
		editor.addEventListener("input", updateCounter);
		updateCounter();
	}

	// Ctrl/Cmd + Enter creates the paste from anywhere in the form.
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

	const setBusy = (busy: boolean, label = "Create paste") => {
		form.setAttribute("aria-busy", busy ? "true" : "false");
		if (!submitButton) return;
		submitButton.disabled = busy;
		submitButton.textContent = busy ? "Working…" : label;
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

		if (!password && !encrypting) return; // Ordinary POST: the server renders the result page.

		event.preventDefault();
		setBusy(true, encrypting ? "Encrypting" : "Create paste");

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
						? "The paste couldn't be created. Try again."
						: "Something went wrong preparing the paste. Try again.",
			);
		}
	});
}

/** The encrypted path: the payload never leaves as anything but ciphertext. */
async function submitEncrypted(form: HTMLFormElement): Promise<void> {
	const editor = qs<HTMLTextAreaElement>("[data-editor]", form);
	const fileInput = qs<HTMLInputElement>("[data-file-input]", form);
	const titleInput = qs<HTMLInputElement>("#title", form);
	const languageSelect = qs<HTMLSelectElement>("#language", form);
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
	data.set("expire", qs<HTMLSelectElement>("#expire", form)?.value ?? "");
	data.set("slug", qs<HTMLInputElement>("#slug", form)?.value ?? "");
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
		url: string;
		manage_url: string;
		manage_token: string;
		expires_at: number;
	};

	const { addHistory } = await import("../lib/history");
	const manageUrl = `${location.origin}/manage/${created.id}#token=${created.manage_token}&k=${key}`;
	addHistory({
		id: created.id,
		title: null,
		kind: metadata.kind,
		url: `${location.origin}/${created.id}#k=${key}`,
		manageUrl,
		token: created.manage_token,
		key,
		createdAt: Date.now(),
		expiresAt: created.expires_at,
		algorithm: "client-side-key",
	});

	announce("Encrypted and saved", "success");
	location.assign(manageUrl);
}
