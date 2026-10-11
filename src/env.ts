import type { Config } from "./config";

/**
 * Bindings available to the Worker.
 *
 * `DB`, `BUCKET` and `ASSETS` are required. Everything else is optional so the
 * application runs locally, and in tests, without any optional production binding
 * being configured.
 */
export interface AppEnv {
	/** Required bindings. */
	DB: D1Database;
	BUCKET: R2Bucket;
	ASSETS: Fetcher;

	/** Vars. Optional so nothing here depends on how an operator configures the instance. */
	MAX_TTL_SECONDS?: string;
	DEFAULT_TTL_SECONDS?: string;
	INLINE_TEXT_MAX_BYTES?: string;
	TEXT_MAX_BYTES?: string;
	FILE_MAX_BYTES?: string;
	PASSWORD_ITERATIONS?: string;
	UNLOCK_COOKIE_TTL_SECONDS?: string;
	FEATURE_REDIRECT?: string;
	FEATURE_VIEW_COUNTING?: string;
	FEATURE_TURNSTILE?: string;
	CLEANUP_BATCH_SIZE?: string;
	CLEANUP_MAX_BATCHES?: string;

	/** Secrets. */
	APP_SECRET?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;

	/** Optional edge bindings: when absent, the corresponding check is skipped. */
	CREATE_LIMITER?: RateLimit;
	UNLOCK_LIMITER?: RateLimit;
}

export interface AppContext {
	env: AppEnv;
	ctx: ExecutionContext;
	config: Config;
}

export type AppBindings = {
	Bindings: AppEnv;
	Variables: {
		config: Config;
		/** Set by middleware once a request has been accepted for creation. */
		rateLimitKey?: string;
	};
};
