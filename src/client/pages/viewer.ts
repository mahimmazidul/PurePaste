import { decryptEnvelope, readFragment } from "../lib/crypto";
import { announce, copyText, qs, qsa, upgradeRelativeTimes } from "../lib/dom";
import { findHistory } from "../lib/history";

/** Everything the paste page adds on top of the markup the server sent. */
export function initViewer(): void {
	const body = document.body;
	const pasteId = body.dataset.pasteId;
	if (!pasteId) return;

	upgradeRelativeTimes();
	wireQrDialog();
	wireCopyButtons();
	wireRevealForm();
	wireUnlockForm(pasteId);
	void showRemoteCode();
	void renderMarkdownIfRequested();
	void initEncryptedView(pasteId);
}

/** Copy buttons work on any page: they copy the value of the input they name. */
export function wireCopyButtons(root: ParentNode = document): void {
	for (const button of qsa<HTMLButtonElement>("[data-copy-target]", root)) {
		button.addEventListener("click", () => {
			const field = qs<HTMLInputElement>(`#${button.dataset.copyTarget}`, root);
			if (field) void copyText(field.value);
		});
	}

	// "Copy link" copies the current URL, fragment and all: for an encrypted paste
	// the fragment is the key, so dropping it would break the link.
	qs("[data-copy-link]", root)?.addEventListener("click", () => void copyText(location.href, "Link copied"));

	qs("[data-copy-content]", root)?.addEventListener("click", () => {
		const text = currentPlainText();
		if (text === null) announce("Nothing to copy yet", "error");
		else void copyText(text, "Copied");
	});
}

/** Text the visitor can copy, whether it came from the markup or was decrypted. */
let decryptedText: string | null = null;
function currentPlainText(): string | null {
	if (decryptedText !== null) return decryptedText;
	const code = qs("[data-code] code, [data-remote-code] code");
	const text = code?.textContent ?? null;
	return text && text.trim().length > 0 ? text : null;
}

function wireQrDialog(): void {
	const opener = qs("[data-qr-open]");
	const dialog = qs<HTMLDialogElement>("[data-qr-dialog]");
	if (!opener || !dialog) return;

	opener.addEventListener("click", async () => {
		const holder = qs("[data-qr-holder]", dialog);
		const label = qs("[data-qr-url]", dialog);
		if (label) label.textContent = location.href;

		if (holder && holder.childElementCount === 0) {
			holder.textContent = "Building the code…";
			try {
				// The QR code is a separate chunk: only people who ask for one pay for it.
				const { renderQrSvg } = await import("../lib/qr");
				holder.innerHTML = renderQrSvg(location.href);
			} catch {
				holder.textContent = "Couldn't build a QR code in this browser.";
			}
		}

		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
	});
}

/** A one-time link is a real form post, so it survives without JavaScript. */
function wireRevealForm(): void {
	const form = qs<HTMLFormElement>("[data-reveal-form]");
	if (!form) return;
	form.addEventListener("submit", () => {
		const button = qs<HTMLButtonElement>('button[type="submit"]', form);
		if (button) {
			button.disabled = true;
			const span = button.querySelector("span");
			if (span) span.textContent = "Opening";
		}
	});
}

/** Large pastes arrive through the raw route rather than inside the markup. */
async function showRemoteCode(): Promise<void> {
	const block = qs<HTMLElement>("[data-remote-code]");
	if (!block) return;
	const code = block.querySelector("code");
	const source = block.dataset.src;
	if (!code || !source) return;

	try {
		const response = await fetch(source, { headers: { Accept: "text/plain" } });
		if (!response.ok) throw new Error(String(response.status));
		code.textContent = await response.text();
		await highlight(block);
	} catch {
		code.textContent = "";
		block.classList.add("is-error");
		const fallback = document.createElement("p");
		fallback.className = "field-note";
		fallback.append("This paste couldn't be loaded here. ");
		const link = document.createElement("a");
		link.href = source;
		link.textContent = "Open the raw text instead";
		fallback.append(link, ".");
		block.after(fallback);
	}
}

async function highlight(block: HTMLElement): Promise<void> {
	const language = block.dataset.language;
	if (!language || language === "plaintext" || language === "text") return;
	const { highlightBlock } = await import("../lib/highlight");
	await highlightBlock(block, language);
}

/** Markdown is rendered here, from the escaped source already on the page. */
async function renderMarkdownIfRequested(): Promise<void> {
	if (document.body.dataset.markdown !== "1") return;
	const source = qs<HTMLElement>("[data-markdown-source] code");
	const output = qs<HTMLElement>("[data-markdown-output]");
	if (!source || !output) return;

	try {
		const { renderMarkdown } = await import("../lib/markdown");
		output.innerHTML = renderMarkdown(source.textContent ?? "");
		output.hidden = false;
		const sourceBlock = qs<HTMLElement>("[data-markdown-source]");
		if (sourceBlock) sourceBlock.hidden = true;
	} catch {
		// Leave the plain source in view: it is always readable.
	}
}

/**
 * Password gate. The server has already sent the salt and the iteration count;
 * the password is turned into a verifier here and only the verifier travels.
 */
function wireUnlockForm(pasteId: string): void {
	const form = qs<HTMLFormElement>("[data-unlock-form]");
	if (!form) return;
	const error = qs<HTMLElement>("[data-unlock-error]", form);
	const input = qs<HTMLInputElement>('input[name="password"]', form);
	input?.focus();

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		const password = input?.value ?? "";
		const button = qs<HTMLButtonElement>('button[type="submit"]', form);
		if (button) button.disabled = true;
		if (error) {
			error.hidden = true;
			error.textContent = "";
		}

		try {
			const meta = await fetch(`/api/pastes/${pasteId}`, { headers: { Accept: "application/json" } }).then((response) =>
				response.json(),
			);
			const kdf = (meta as { kdf?: { salt?: string; iterations?: number } }).kdf;
			if (!kdf?.salt || !kdf.iterations) throw new Error("no kdf parameters");

			const { derivePasswordKey, toBase64Url } = await import("../lib/crypto");
			const saltBytes = kdf.salt.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16));
			if (!saltBytes || saltBytes.some((value) => Number.isNaN(value))) throw new Error("bad salt");
			const derived = await derivePasswordKey(password, new Uint8Array(saltBytes), kdf.iterations);

			const response = await fetch(`/api/pastes/${pasteId}/unlock`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ verifier: toBase64Url(derived) }),
			});

			if (response.ok) {
				location.reload();
				return;
			}

			// Every failure reads the same way, so nothing is learned from a wrong guess.
			show(error, "That password didn't match.");
		} catch {
			show(error, "Something went wrong. Try again.");
		} finally {
			if (button) button.disabled = false;
		}
	});
}

function show(box: HTMLElement | null, message: string): void {
	if (!box) return;
	box.textContent = message;
	box.hidden = false;
}

/** Encrypted pastes: fetch the bytes, unscramble them here, then show or save. */
async function initEncryptedView(pasteId: string): Promise<void> {
	const view = qs<HTMLElement>("[data-encrypted-view]");
	if (!view) return;

	const output = qs<HTMLElement>("[data-encrypted-output]", view);
	const errorBox = qs<HTMLElement>("[data-encrypted-error]", view);
	const titleNode = qs("[data-encrypted-title]", view);
	const textNode = qs<HTMLElement>("[data-encrypted-text]", view);
	const codeNode = textNode?.querySelector("code") ?? null;
	const fileNode = qs<HTMLElement>("[data-encrypted-file]", view);
	const fileNameNode = qs("[data-encrypted-filename]", view);
	const fileSizeNode = qs("[data-encrypted-filesize]", view);
	const downloadButton = qs<HTMLButtonElement>("[data-encrypted-download]", view);

	// The fragment is the preferred source; the local list is the fallback for
	// someone who opened the link from "My pastes".
	const key = readFragment(location.hash).get("k") ?? findHistory(pasteId)?.key ?? null;

	if (!key) {
		show(
			errorBox,
			"This link is missing the part after the #, which holds the key. Ask the sender for the whole link — without it, nobody can unscramble this.",
		);
		return;
	}

	try {
		const response = await fetch(`/raw/${pasteId}`, { headers: { Accept: "application/octet-stream" } });
		if (response.status === 401) {
			show(errorBox, "Enter the password above first, then reload this page.");
			return;
		}
		if (response.status === 410) {
			show(errorBox, "This paste has expired or has already been opened.");
			return;
		}
		if (!response.ok) {
			show(errorBox, "This paste isn't available any more.");
			return;
		}

		const bytes = new Uint8Array(await response.arrayBuffer());
		const { metadata, content } = await decryptEnvelope(bytes, key);

		output?.removeAttribute("hidden");
		if (metadata.title && titleNode) titleNode.textContent = metadata.title;
		document.title = `${metadata.title ?? "Encrypted paste"} · PurePaste`;

		if (metadata.kind === "file") {
			fileNode?.removeAttribute("hidden");
			if (fileNameNode) fileNameNode.textContent = metadata.filename ?? "download";
			if (fileSizeNode) {
				fileSizeNode.textContent = `${Math.round(content.byteLength / 1024)} KiB · unscrambled in your browser, not on the server`;
			}
			downloadButton?.addEventListener("click", () => {
				const blob = new Blob([content as unknown as BlobPart], {
					type: metadata.contentType ?? "application/octet-stream",
				});
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = metadata.filename ?? "download";
				link.click();
				URL.revokeObjectURL(url);
				announce("Saved to your downloads", "success");
			});
		} else {
			const text = new TextDecoder().decode(content);
			decryptedText = text;
			if (codeNode) codeNode.textContent = text;
			textNode?.removeAttribute("hidden");
			if (metadata.markdown) {
				const { renderMarkdown } = await import("../lib/markdown");
				const rendered = document.createElement("div");
				rendered.className = "markdown-body";
				rendered.innerHTML = renderMarkdown(text);
				textNode?.setAttribute("hidden", "");
				textNode?.after(rendered);
			}
		}
	} catch {
		show(
			errorBox,
			"These bytes couldn't be unscrambled with this link. Check that the whole link was copied, including everything after the #.",
		);
	}
}
