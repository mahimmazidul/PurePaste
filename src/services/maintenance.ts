import type { Config } from "../config";
import type { AppEnv } from "../env";
import type { BlobPool } from "./storage-provider";
import { CONSUMED_GRACE_MS } from "./cleanup";
import { resolveStorage } from "./storage-provider";
import { supabaseStore } from "./supabase-store";

/**
 * The other two things the hourly cron does, kept out of `sweep` because they are
 * aimed at services outside this Worker and must never hold it up.
 */

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
): Promise<{
	scanned: number;
	removed: number;
	skipped: string;
	stores: Record<string, { scanned: number; removed: number }>;
}> {
	// Resolve failure is a skip, not a crash: an instance whose storage is
	// misconfigured has bigger things to fix than an orphan sweep, and the cron has
	// already logged that one.
	let pool: BlobPool;
	try {
		pool = resolveStorage(env).objects;
	} catch (error) {
		return { scanned: 0, removed: 0, skipped: error instanceof Error ? error.message : String(error), stores: {} };
	}

	const listables = pool.listables();
	if (listables.length === 0) {
		return { scanned: 0, removed: 0, skipped: "no store in this pool can list", stores: {} };
	}

	const graceMs = options.graceMs ?? 2 * 60 * 60 * 1000;
	const maxPages = options.maxPages ?? 5;
	const cutoff = now - graceMs;
	const report = {
		scanned: 0,
		removed: 0,
		skipped: "",
		stores: {} as Record<string, { scanned: number; removed: number }>,
	};

	// Every store gets walked, not just the one that takes writes: an object nobody
	// points at costs the same in a retired namespace as it does in a bucket, and
	// "which store had it" is exactly the question a row may no longer be able to answer.
	for (const { provider, store, prefix } of listables) {
		let token: string | undefined;
		let scanned = 0;
		let removed = 0;

		for (let page = 0; page < maxPages; page += 1) {
			const listing = await store.list!(prefix, token);
			// A key with no known age is left alone. The sweep will meet it again tomorrow,
			// and an object written seconds ago is somebody's upload still in flight.
			const stale = listing.keys
				.filter((entry) => entry.lastModified !== null && entry.lastModified < cutoff)
				.map((entry) => entry.key);
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
			token = listing.next ?? undefined;
		}

		report.stores[provider] = { scanned, removed };
		report.scanned += scanned;
		report.removed += removed;
	}

	return report;
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
