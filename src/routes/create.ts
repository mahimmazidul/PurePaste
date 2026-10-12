import type { Context } from "hono";
import { deferrer } from "../lib/ctx";
import type { Config } from "../config";
import type { AppBindings } from "../env";
import { fail, isAppError } from "../lib/errors";
import { negotiate } from "../lib/negotiate";
import { decodeBase64Url } from "../lib/ids";
import { createPaste } from "../services/paste-store";
import { verifyTurnstile } from "../services/turnstile";
import { clientAddress } from "../middleware/rate-limit";
import {
	assembleEncryptedInput,
	assembleFileInput,
	assembleRedirectInput,
	assembleTextInput,
	parseFlag,
	type RawCreateInput,
} from "../lib/validation";
import { renderCreated } from "../views/pages/created";
import { emptyFormValues, renderHome, type HomeFormValues } from "../views/pages/home";
import { renderErrorPage } from "../views/pages/error";
import type { CreatePasteInput } from "../types";

/** Slack for multipart boundaries and form field names on top of the file limit. */
const MULTIPART_SLACK_BYTES = 1024 * 1024;
/** Encrypted payloads may ride along in JSON as base64 when they are small. */
const JSON_PAYLOAD_MAX_BYTES = 512 * 1024;

interface ParsedRequest {
	raw: RawCreateInput;
	kindHint: "text" | "file" | "redirect" | "encrypted";
	text: string | null;
	bytes: Uint8Array | null;
	file: { size: number; filename: string } | null;
	turnstileToken: string | null;
	/** Values kept for re-rendering the form after a validation error. */
	formValues: HomeFormValues;
	encryptRequested: boolean;
}

export type CreateOutcome =
	{ ok: true; response: Response } | { ok: false; error: unknown; formValues: HomeFormValues; browserForm: boolean };

/**
 * Parses, validates, stores, and answers.
 *
 * Failures are returned rather than thrown so the caller can decide whether the
 * visitor gets JSON or the editor with their text still in it.
 */
export async function createFromRequest(c: Context<AppBindings>): Promise<CreateOutcome> {
	const config = c.get("config");
	const contentType = (c.req.header("content-type") ?? "").toLowerCase();
	const browserForm =
		contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded");

	// Filled in as soon as the body is parsed, so a rejected submission can be
	// re-rendered with what the visitor typed.
	const carrier: FormCarrier = { values: emptyFormValues };

	try {
		const response = await runCreate(c, config, contentType, browserForm, carrier);
		return { ok: true, response };
	} catch (error) {
		return { ok: false, error, formValues: carrier.values, browserForm };
	}
}

interface FormCarrier {
	values: HomeFormValues;
}

async function runCreate(
	c: Context<AppBindings>,
	config: Config,
	contentType: string,
	browserForm: boolean,
	carrier: FormCarrier,
): Promise<Response> {
	const declaredLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
	const ceiling = config.fileMaxBytes + MULTIPART_SLACK_BYTES;
	if (Number.isFinite(declaredLength) && declaredLength > ceiling) {
		throw fail.tooLarge(`${Math.floor(config.fileMaxBytes / 1024 / 1024)} MiB`);
	}

	const parsed = await parseRequest(c, contentType, browserForm);
	carrier.values = parsed.formValues;
	await verifyTurnstile(c.env, config, browserForm ? parsed.turnstileToken : null, clientAddress(c));

	const input = assemble(parsed, config);
	const created = await createPaste(c.env, config, input, { ctx: deferrer(c) });
	const origin = new URL(c.req.url).origin;

	// The form path always answers with a page. The API path follows the Accept header.
	if (browserForm && negotiate(c, "html") === "html") {
		return c.html(
			renderCreated({
				config,
				origin,
				id: created.record.id,
				manageToken: created.manageToken,
				expiresAt: created.record.expiresAt,
				kind: created.record.kind,
				burnAfterRead: created.record.burnAfterRead,
				title: created.record.title,
				redirectUrl: created.record.redirectUrl,
			}),
		);
	}

	const format = negotiate(c, "json");
	const url = `${origin}/${created.record.kind === "redirect" ? "l" : "p"}/${created.record.id}`;
	const manageUrl = `${origin}/manage/${created.record.id}#token=${created.manageToken}`;

	if (format === "text") {
		return c.text(`${url}\n`, 201);
	}

	return c.json(
		{
			id: created.record.id,
			url,
			raw_url: `${origin}/raw/${created.record.id}`,
			download_url: created.record.kind === "file" ? `${origin}/download/${created.record.id}` : null,
			manage_url: manageUrl,
			manage_token: created.manageToken,
			kind: created.record.kind,
			encrypted: created.record.encrypted,
			burn_after_reading: created.record.burnAfterRead,
			expires_at: created.record.expiresAt,
			expires_in_seconds: Math.round((created.record.expiresAt - created.record.createdAt) / 1000),
			size_bytes: created.record.sizeBytes,
		},
		201,
	);
}

async function parseRequest(
	c: Context<AppBindings>,
	contentType: string,
	isBrowserForm: boolean,
): Promise<ParsedRequest> {
	const query = c.req.query();

	if (isBrowserForm) {
		const form = await c.req.formData().catch(() => null);
		if (!form) throw fail.invalidRequest("That form couldn't be read.");

		const get = (name: string): string | null => {
			const value = form.get(name);
			return typeof value === "string" ? value : null;
		};

		// A posted field always wins; the query string only fills gaps. That keeps the
		// documented "form fields or query string" true for multipart too, which is
		// how a script reaches it (`curl -F file=@x "?expire=1h"`).
		const raw: RawCreateInput = {
			title: get("title") ?? query.title,
			language: get("language") ?? query.language,
			content: get("content"),
			url: get("url") ?? query.url,
			slug: get("slug") ?? query.slug,
			expire: get("expire") ?? query.expire,
			burn: get("burn") ?? query.burn,
			markdown: get("markdown") ?? query.markdown,
			passwordSalt: get("password_salt"),
			passwordVerifier: get("password_verifier"),
			passwordIterations: get("password_iterations"),
		};

		const fileValue = form.get("file");
		const file = fileValue && typeof fileValue === "object" && "arrayBuffer" in fileValue ? (fileValue as File) : null;

		const formValues: HomeFormValues = {
			title: get("title") ?? "",
			content: get("content") ?? "",
			language: get("language") ?? "plaintext",
			expire: get("expire") ?? "",
			slug: get("slug") ?? "",
			burn: parseFlag(get("burn")),
			markdown: parseFlag(get("markdown")),
			url: get("url") ?? "",
		};

		const turnstileToken = get("cf-turnstile-response");

		// The browser encrypts the payload itself and posts the envelope as a part,
		// so the form needs no query string and works with the plain editor form.
		// A form that asks for encryption without sending an envelope falls through
		// to the ordinary path, which explains that encryption needs JavaScript.
		const payloadPart = form.get("payload");
		const payloadFile =
			payloadPart && typeof payloadPart === "object" && "arrayBuffer" in payloadPart ? (payloadPart as File) : null;
		if ((parseFlag(get("encrypted")) || parseFlag(get("encrypt"))) && payloadFile && payloadFile.size > 0) {
			if (payloadFile.size > c.get("config").fileMaxBytes) {
				throw fail.tooLarge(`${Math.floor(c.get("config").fileMaxBytes / 1024 / 1024)} MiB`);
			}
			return {
				raw,
				kindHint: "encrypted",
				text: null,
				bytes: new Uint8Array(await payloadFile.arrayBuffer()),
				file: null,
				turnstileToken,
				formValues,
				encryptRequested: true,
			};
		}

		if (get("kind") === "redirect") {
			return {
				raw,
				kindHint: "redirect",
				text: null,
				bytes: null,
				file: null,
				turnstileToken,
				formValues,
				encryptRequested: false,
			};
		}
		if (file && file.size > 0) {
			if (file.size > c.get("config").fileMaxBytes) {
				throw fail.tooLarge(`${Math.floor(c.get("config").fileMaxBytes / 1024 / 1024)} MiB`);
			}
			return {
				raw,
				kindHint: "file",
				text: null,
				bytes: new Uint8Array(await file.arrayBuffer()),
				file: { size: file.size, filename: file.name || "upload" },
				turnstileToken,
				formValues,
				encryptRequested: false,
			};
		}
		return {
			raw,
			kindHint: "text",
			text: get("content") ?? "",
			bytes: null,
			file: null,
			turnstileToken,
			formValues,
			encryptRequested: parseFlag(get("encrypt")),
		};
	}

	if (contentType.includes("application/json")) {
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== "object") throw fail.invalidRequest("That JSON couldn't be read.");

		const asString = (key: string): string | null => (typeof body[key] === "string" ? (body[key] as string) : null);
		const raw: RawCreateInput = {
			title: body.title,
			language: body.language,
			url: body.url,
			slug: body.slug ?? query.slug,
			expire: body.expire ?? body.ttl ?? query.expire,
			burn: body.burn ?? body.burn_after_reading ?? query.burn,
			markdown: body.markdown ?? query.markdown,
			passwordSalt: body.password_salt ?? body.passwordSalt,
			passwordVerifier: body.password_verifier ?? body.passwordVerifier,
			passwordIterations: body.password_iterations ?? body.passwordIterations,
		};

		if (body.encrypted === true || query.encrypted === "1") {
			const payload = asString("payload") ?? asString("data");
			if (!payload) {
				throw fail.unsupportedMediaType(
					"Send encrypted payloads as raw bytes: POST /api/pastes?encrypted=1 with Content-Type: application/octet-stream.",
				);
			}
			const bytes = decodeBase64Url(payload);
			if (!bytes) throw fail.invalidRequest("The encrypted payload was not valid base64url.");
			if (bytes.byteLength > JSON_PAYLOAD_MAX_BYTES) {
				throw fail.tooLarge(`${Math.floor(JSON_PAYLOAD_MAX_BYTES / 1024)} KiB for JSON payloads`);
			}
			return {
				raw,
				kindHint: "encrypted",
				text: null,
				bytes,
				file: null,
				turnstileToken: null,
				formValues: emptyFormValues,
				encryptRequested: true,
			};
		}

		const text = asString("content") ?? asString("text") ?? "";
		return {
			raw,
			kindHint: raw.url ? "redirect" : "text",
			text,
			bytes: null,
			file: null,
			turnstileToken: null,
			formValues: {
				...emptyFormValues,
				content: text,
				title: asString("title") ?? "",
				slug: asString("slug") ?? "",
				expire: asString("expire") ?? "",
			},
			encryptRequested: false,
		};
	}

	// Anything else is treated as a raw body: `cat file | curl --data-binary @-`.
	const encrypted = query.encrypted === "1";
	const raw: RawCreateInput = {
		title: query.title,
		language: query.language,
		url: query.url,
		slug: query.slug,
		expire: query.expire,
		burn: query.burn,
		markdown: query.markdown,
		filename: query.filename,
	};
	const queryValues: HomeFormValues = {
		...emptyFormValues,
		expire: query.expire ?? "",
		slug: query.slug ?? "",
		title: query.title ?? "",
	};

	if (encrypted || contentType.includes("application/octet-stream")) {
		const buffer = await c.req.arrayBuffer();
		if (buffer.byteLength > c.get("config").fileMaxBytes) {
			throw fail.tooLarge(`${Math.floor(c.get("config").fileMaxBytes / 1024 / 1024)} MiB`);
		}
		if (encrypted) {
			return {
				raw,
				kindHint: "encrypted",
				text: null,
				bytes: new Uint8Array(buffer),
				file: null,
				turnstileToken: null,
				formValues: queryValues,
				encryptRequested: true,
			};
		}
		const filename = query.filename ?? "upload";
		return {
			raw,
			kindHint: "file",
			text: null,
			bytes: new Uint8Array(buffer),
			file: { size: buffer.byteLength, filename },
			turnstileToken: null,
			formValues: queryValues,
			encryptRequested: false,
		};
	}

	// Nothing else is guessed at. A body that arrives labelled as something this
	// service does not handle is refused rather than stored as mangled text.
	if (!isTextualContentType(contentType)) {
		throw fail.unsupportedMediaType("Send JSON, plain text, a form, or a file.");
	}

	const text = await c.req.text();
	if (!encrypted && new TextEncoder().encode(text).byteLength > c.get("config").textMaxBytes) {
		throw fail.tooLarge(`${Math.floor(c.get("config").textMaxBytes / 1024 / 1024)} MiB`);
	}
	return {
		raw,
		kindHint: "text",
		text,
		bytes: null,
		file: null,
		turnstileToken: null,
		formValues: { ...queryValues, content: text },
		encryptRequested: false,
	};
}

/** Content types that can be read as text without losing the plot. */
const TEXTUAL_TYPES = [
	"application/json",
	"application/x-ndjson",
	"application/ld+json",
	"application/xml",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/javascript",
	"application/sql",
	"application/graphql",
	"application/x-sh",
	"application/x-httpd-php",
	"application/x-perl",
	"application/x-python",
	"application/x-ruby",
	"application/csv",
];

function isTextualContentType(contentType: string): boolean {
	const type = contentType.split(";")[0]?.trim() ?? "";
	if (!type) return true;
	if (type.startsWith("text/")) return true;
	if (type.endsWith("+json") || type.endsWith("+xml")) return true;
	return TEXTUAL_TYPES.includes(type);
}

function assemble(parsed: ParsedRequest, config: Config): CreatePasteInput {
	const body = parsed.bytes ? ({ type: "bytes", bytes: parsed.bytes } as const) : ({ type: "none" } as const);

	switch (parsed.kindHint) {
		case "redirect":
			return assembleRedirectInput(parsed.raw, config);
		case "file":
			return assembleFileInput(
				parsed.raw,
				{ size: parsed.file?.size ?? parsed.bytes?.byteLength ?? 0, filename: parsed.file?.filename ?? "upload" },
				body,
				config,
			);
		case "encrypted":
			return assembleEncryptedInput(parsed.raw, parsed.bytes?.byteLength ?? 0, config, body);
		default:
			return assembleTextInput(parsed.raw, parsed.text ?? "", config).input;
	}
}

/** Re-renders the editor with what the visitor typed, plus a readable error summary. */
export function renderHomeWithError(c: Context<AppBindings>, error: unknown, values: HomeFormValues): Response {
	const config = c.get("config");
	const status = isAppError(error) ? error.status : 500;
	const message = isAppError(error) ? error.message : "Something went wrong on our end.";
	const field = fieldForError(error);

	return c.html(
		renderHome({
			config,
			values,
			errors: [{ field, message }],
		}),
		status as 400 | 409 | 413 | 415 | 500,
	);
}

function fieldForError(error: unknown): string | undefined {
	if (!isAppError(error)) return undefined;
	switch (error.code) {
		case "slug_taken":
		case "invalid_slug":
		case "reserved_slug":
			return "slug";
		case "invalid_expiration":
			return "expire";
		case "invalid_url":
			return "url";
		case "invalid_credentials":
		case "password_required":
			return "password";
		case "payload_too_large":
			return "content";
		default:
			return undefined;
	}
}

export { renderErrorPage };
