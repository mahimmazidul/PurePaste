/**
 * Runtime configuration.
 *
 * Every limit is read from `vars` so an operator can tune the service, but the
 * hard security ceilings (30 day maximum lifetime) are enforced here rather than
 * trusted from configuration.
 */

/** Thirty days. Requirement: no paste may ever outlive this. */
export const ABSOLUTE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

/** The only expiration choices the UI and API accept. */
export const TTL_CHOICES = [
	{ value: "1h", seconds: 60 * 60 },
	{ value: "1d", seconds: 24 * 60 * 60 },
	{ value: "7d", seconds: 7 * 24 * 60 * 60 },
	{ value: "14d", seconds: 14 * 24 * 60 * 60 },
	{ value: "30d", seconds: 30 * 24 * 60 * 60 },
] as const;

export type TtlChoice = (typeof TTL_CHOICES)[number]["value"];

export interface Config {
	maxTtlSeconds: number;
	defaultTtlSeconds: number;
	inlineTextMaxBytes: number;
	textMaxBytes: number;
	fileMaxBytes: number;
	passwordIterations: number;
	unlockCookieTtlSeconds: number;
	redirectEnabled: boolean;
	viewCounting: boolean;
	turnstileEnabled: boolean;
	turnstileSiteKey: string | undefined;
	cleanupBatchSize: number;
	cleanupMaxBatches: number;
	appSecret: string;
	ttlChoices: readonly { value: TtlChoice; seconds: number }[];
}

/**
 * Fallback secret for local development. Production deployments should always set
 * APP_SECRET (see README); this only keeps `wrangler dev` working out of the box.
 */
const DEV_SECRET = "purepaste-development-secret-do-not-use-in-production";

/** Reads a configuration value without assuming a particular environment shape. */
function field(env: object, key: string): unknown {
	return (env as Record<string, unknown>)[key];
}

function readInt(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "string" ? Number.parseInt(value, 10) : typeof value === "number" ? value : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function readFlag(value: unknown, fallback: boolean): boolean {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["on", "true", "1", "yes", "enabled"].includes(normalized)) return true;
	if (["off", "false", "0", "no", "disabled"].includes(normalized)) return false;
	return fallback;
}

export function resolveConfig(env: object): Config {
	const maxTtlSeconds = readInt(field(env, "MAX_TTL_SECONDS"), ABSOLUTE_MAX_TTL_SECONDS, 60, ABSOLUTE_MAX_TTL_SECONDS);

	const ttlChoices = TTL_CHOICES.filter((choice) => choice.seconds <= maxTtlSeconds);

	const defaultTtlSeconds = Math.min(
		readInt(field(env, "DEFAULT_TTL_SECONDS"), 7 * 24 * 60 * 60, 60, maxTtlSeconds),
		maxTtlSeconds,
	);

	const inlineTextMaxBytes = readInt(field(env, "INLINE_TEXT_MAX_BYTES"), 64 * 1024, 1024, 1024 * 1024);
	const textMaxBytes = readInt(field(env, "TEXT_MAX_BYTES"), 10 * 1024 * 1024, inlineTextMaxBytes, 100 * 1024 * 1024);
	const appSecretValue = field(env, "APP_SECRET");
	const appSecretRaw = typeof appSecretValue === "string" ? appSecretValue.trim() : "";
	const turnstileSiteKeyValue = field(env, "TURNSTILE_SITE_KEY");

	return {
		maxTtlSeconds,
		defaultTtlSeconds,
		inlineTextMaxBytes,
		textMaxBytes,
		fileMaxBytes: readInt(field(env, "FILE_MAX_BYTES"), 25 * 1024 * 1024, 1024, 100 * 1024 * 1024),
		passwordIterations: readInt(field(env, "PASSWORD_ITERATIONS"), 210_000, 100_000, 1_000_000),
		unlockCookieTtlSeconds: readInt(field(env, "UNLOCK_COOKIE_TTL_SECONDS"), 1800, 60, 24 * 60 * 60),
		redirectEnabled: readFlag(field(env, "FEATURE_REDIRECT"), true),
		viewCounting: readFlag(field(env, "FEATURE_VIEW_COUNTING"), false),
		turnstileEnabled: readFlag(field(env, "FEATURE_TURNSTILE"), false),
		turnstileSiteKey:
			typeof turnstileSiteKeyValue === "string" && turnstileSiteKeyValue ? turnstileSiteKeyValue : undefined,
		cleanupBatchSize: readInt(field(env, "CLEANUP_BATCH_SIZE"), 100, 1, 1000),
		cleanupMaxBatches: readInt(field(env, "CLEANUP_MAX_BATCHES"), 5, 1, 20),
		appSecret: appSecretRaw.length >= 16 ? appSecretRaw : DEV_SECRET,
		ttlChoices,
	};
}

/** True when APP_SECRET was not supplied and the development fallback is in use. */
export function usingFallbackSecret(env: object): boolean {
	const value = field(env, "APP_SECRET");
	return !(typeof value === "string" && value.trim().length >= 16);
}
