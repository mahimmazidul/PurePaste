import type { Config } from "./config";

/**
 * Bindings available to the Worker.
 *
 * `DB` and `ASSETS` are required, plus exactly one blob backend: `BUCKET`
 * (R2, the upstream default) or `BLOBS` (Workers KV, for accounts that
 * cannot enable R2 without a payment method). Everything else is optional so
 * the application runs locally, and in tests, without any optional production
 * binding being configured.
 */
export interface AppEnv {
	/** Required bindings. */
	DB: D1Database;
	BUCKET?: R2Bucket;
	BLOBS?: KVNamespace;
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
	MEDIA_CACHE_SECONDS?: string;

	/**
	 * Blob backend. Absent means `auto`: R2 if a bucket is bound, then a
	 * configured S3 endpoint, then Firebase, then the KV namespace. Set it
	 * explicitly to `kv | r2 | s3 | firebase` to pin one.
	 */
	STORAGE_PROVIDER?: string;
	/** Any S3-compatible endpoint: Backblaze B2, Supabase Storage, R2, MinIO. */
	S3_ENDPOINT?: string;
	S3_REGION?: string;
	S3_BUCKET?: string;
	S3_ACCESS_KEY_ID?: string;
	S3_SECRET_ACCESS_KEY?: string;
	/** Public base for direct links, so bytes can skip the Worker entirely. */
	S3_PUBLIC_BASE?: string;
	S3_PREFIX?: string;
	/** `on` for endpoints that only accept `<bucket>.<host>` addressing (Supabase). */
	S3_VIRTUAL_HOST_STYLE?: string;
	/**
	 * `on` hands media GETs a 302 straight to the bucket instead of streaming them
	 * through this Worker. Only honoured when a public base is configured, and only
	 * for images, video and audio.
	 */
	STORAGE_DIRECT_LINKS?: string;
	/** Firebase Storage: service-account JSON fields, pasted as secrets. */
	FIREBASE_PROJECT_ID?: string;
	FIREBASE_BUCKET?: string;
	FIREBASE_CLIENT_EMAIL?: string;
	FIREBASE_PRIVATE_KEY?: string;
	/** Only for a bucket whose objects are public; otherwise links stay proxied. */
	FIREBASE_PUBLIC_BASE?: string;

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
