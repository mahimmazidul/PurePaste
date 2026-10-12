import type { Config } from "../config";
import type { AppEnv } from "../env";
import type { BlobStore } from "./object-store";
import { CONSUMED_GRACE_MS } from "./cleanup";
import { resolveStorage } from "./storage-provider";
import { supabaseStore } from "./supabase-store";

/**
 * The other two things the hourly cron does, kept out of `sweep` because they are
 * aimed at services outside this Worker and must never hold it up.
 */

interface ListableStore {
	objectPrefix(): string;
	list(
		prefix: string,
		token?: string,
	): Promise<{ keys: Array<{ key: string; lastModified: number }>; next: string | null }>;
	delete(keys: string[]): Promise<{ deleted: number; failed: string[] }>;
}

export interface MaintenanceReport {
	supabase: "off" | "awake" | "unreachable" | "purged";
	supabaseDetail: string | null;
	/** True only when supabase/schema.sql is applied and the key may call it. */
	supabaseKeepaliveRan: boolean;
	mirrorRowsRemoved: number;
	orphans: number;
}

/**
 * Keeps the Supabase project awake and its copy of the table as tidy as D1's.
 *
 * The pause rule is the reason for the first half: a free project with no traffic for
 * a week goes to sleep, and a sleeping project answers the next visitor with a cold
 * start or a refusal. One authenticated query an hour means that never happens, and
 * it works with the publishable key alone — no mirror, no secrets, still awake.
 */
export async function tendSupabase(
	env: AppEnv,
	config: Config,
	now = Date.now(),
	transport?: typeof fetch,
): Promise<MaintenanceReport> {
	const store = supabaseStore(env, transport);
	const report: MaintenanceReport = {
		supabase: "off",
		supabaseDetail: null,
		supabaseKeepaliveRan: false,
		mirrorRowsRemoved: 0,
		orphans: 0,
	};
	if (!store) return report;

	const ping = await store.ping();
	report.supabase = ping.reachable ? "awake" : "unreachable";
	report.supabaseDetail = ping.detail;
	report.supabaseKeepaliveRan = ping.keepaliveRan;

	// Same grace as the D1 sweep, so a reader mid-download keeps their copy.
	if (store.status.mirror === "on") {
		try {
			report.mirrorRowsRemoved = await store.purgeExpired(now, config.cleanupBatchSize, CONSUMED_GRACE_MS);
			if (report.mirrorRowsRemoved > 0) report.supabase = "purged";
		} catch (error) {
			report.supabaseDetail = `${ping.detail}; purge: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	return report;
}

/**
 * Objects in an S3 bucket that no row points at.
 *
 * This should not happen — an upload that fails deletes its object, a collision
 * deletes its object, and the sweep deletes objects before rows. But "should not"
 * and "is not happening" are different claims when the only evidence is that nobody
 * has looked. Listing with `LastModified` is what makes looking safe: anything younger
 * than the grace window may belong to a request still in flight, so it is left alone
 * until a later run.
 *
 * KV is deliberately not swept this way: it reports no timestamps, and deleting
 * unreadable-age keys on a hunch is a worse trade than a few orphaned bytes.
 */
export async function sweepOrphans(
	env: AppEnv,
	config: Config,
	now = Date.now(),
	options: { graceMs?: number; maxPages?: number } = {},
): Promise<{ scanned: number; removed: number; skipped: string }> {
	// Resolve failure is a skip, not a crash: an instance whose storage is
	// misconfigured has bigger things to fix than an orphan sweep, and the cron has
	// already logged that one.
	let provider: string;
	let primary: BlobStore;
	try {
		({ provider, primary } = resolveStorage(env));
	} catch (error) {
		return { scanned: 0, removed: 0, skipped: error instanceof Error ? error.message : String(error) };
	}
	if (provider !== "s3") return { scanned: 0, removed: 0, skipped: `provider is ${provider}` };

	// Not every S3-shaped store can list, and the orphan pass needs listing: an
	// endpoint without ListObjectsV2 is a bucket you should sweep with a lifecycle
	// rule instead, so say which one that is rather than guessing.
	const candidate = primary as unknown as ListableStore;
	const store =
		typeof candidate?.list === "function" && typeof candidate.objectPrefix === "function" ? candidate : null;
	if (!store) return { scanned: 0, removed: 0, skipped: "store cannot list" };

	const graceMs = options.graceMs ?? 2 * 60 * 60 * 1000;
	const maxPages = options.maxPages ?? 5;
	const prefix = store.objectPrefix();
	const cutoff = now - graceMs;

	let token: string | undefined;
	let scanned = 0;
	let removed = 0;

	for (let page = 0; page < maxPages; page += 1) {
		const listing = await store.list(prefix, token);
		const stale = listing.keys.filter((entry) => entry.lastModified < cutoff).map((entry) => entry.key);
		scanned += listing.keys.length;

		if (stale.length > 0) {
			// One query, not one per key: the row set for these ids either exists or
			// does not, and D1 answers in a single round trip.
			const placeholders = stale.map(() => "?").join(", ");
			const rows = await env.DB.prepare(`SELECT object_key FROM pastes WHERE object_key IN (${placeholders})`)
				.bind(...stale)
				.all<{ object_key: string }>();
			const referenced = new Set((rows.results ?? []).map((row) => row.object_key));
			const orphans = stale.filter((key) => !referenced.has(key));
			if (orphans.length > 0) removed += (await store.delete(orphans)).deleted;
		}

		if (!listing.next) break;
		token = listing.next;
	}

	return { scanned, removed, skipped: "" };
}

/**
 * Whether this run should do the deep pass. The cron is hourly because Supabase's
 * pause timer needs it; a bucket listing every hour is a lot of requests for something
 * that drifts slowly, so orphans are looked for once a day, in a quiet UTC hour.
 */
export function isDeepPassHour(now: number, hourUtc = 4): boolean {
	return new Date(now).getUTCHours() === hourUtc;
}

export async function runMaintenance(
	env: AppEnv,
	config: Config,
	now = Date.now(),
	transport?: typeof fetch,
): Promise<MaintenanceReport & { deep: boolean }> {
	const report = await tendSupabase(env, config, now, transport);
	report.orphans = 0;
	const deep = isDeepPassHour(now);
	if (deep) {
		try {
			report.orphans = (await sweepOrphans(env, config, now)).removed;
		} catch (error) {
			// A failed orphan pass is not a failed run; tomorrow's is the retry.
			console.error("orphan sweep failed", { message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { ...report, deep };
}
