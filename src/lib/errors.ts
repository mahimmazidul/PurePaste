export type ErrorCode =
	| "invalid_request"
	| "invalid_expiration"
	| "invalid_slug"
	| "slug_taken"
	| "reserved_slug"
	| "invalid_url"
	| "invalid_credentials"
	| "password_required"
	| "unauthorized"
	| "not_found"
	| "expired"
	| "consumed"
	| "payload_too_large"
	| "unsupported_media_type"
	| "rate_limited"
	| "feature_disabled"
	| "turnstile_failed"
	| "internal_error";

/**
 * An error that is safe to show a visitor. Anything that is not an AppError is
 * treated as a bug and never rendered to the client.
 */
export class AppError extends Error {
	readonly code: ErrorCode;
	readonly status: number;
	readonly hint: string | undefined;

	constructor(code: ErrorCode, status: number, message: string, hint?: string) {
		super(message);
		this.name = "AppError";
		this.code = code;
		this.status = status;
		this.hint = hint;
	}
}

export const fail = {
	invalidRequest: (message = "Something in that request didn't look right.", hint?: string) =>
		new AppError("invalid_request", 400, message, hint),
	invalidExpiration: () =>
		new AppError("invalid_expiration", 400, "That expiration isn't one of the options.", "Choose 1h, 1d, 7d, 14d or 30d."),
	invalidSlug: (message = "That custom name can't be used.") => new AppError("invalid_slug", 400, message),
	slugTaken: () => new AppError("slug_taken", 409, "That custom name is already taken."),
	reservedSlug: () => new AppError("reserved_slug", 400, "That name is reserved by PurePaste."),
	invalidUrl: () => new AppError("invalid_url", 400, "That doesn't look like a web address.", "Only http and https links are accepted."),
	passwordRequired: () => new AppError("password_required", 401, "This paste needs a password."),
	invalidCredentials: () => new AppError("invalid_credentials", 401, "That password didn't match."),
	unauthorized: () => new AppError("unauthorized", 401, "That management link isn't valid."),
	notFound: () => new AppError("not_found", 404, "Nothing here."),
	expired: () => new AppError("expired", 410, "This paste has expired."),
	consumed: () => new AppError("consumed", 410, "This paste has already been opened."),
	tooLarge: (limit: string) =>
		new AppError("payload_too_large", 413, `That's bigger than this instance accepts (${limit}).`),
	unsupportedMediaType: (message = "That content type isn't supported.") =>
		new AppError("unsupported_media_type", 415, message),
	rateLimited: () => new AppError("rate_limited", 429, "Too many requests just now. Try again in a minute."),
	featureDisabled: (feature: string) => new AppError("feature_disabled", 404, `${feature} is turned off on this instance.`),
	turnstileFailed: () =>
		new AppError("turnstile_failed", 403, "We couldn't verify that you're a person. Reload and try again."),
	internal: () => new AppError("internal_error", 500, "Something went wrong on our end."),
};

export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}
