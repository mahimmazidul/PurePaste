import type { Config } from "../config";
import type { Stores } from "./paste-store";

export interface SweepReport {
	batches: number;
	expiredRows: number;
	expiredObjects: number;
	consumedRows: number;
	consumedObjects: number;
	/** Rows kept because their object could not be deleted; retried next run. */
	deferred: number;
}

/**
 * How long a claimed paste is left alone before its object is removed. This keeps
 * the sweep from pulling storage out from under a reader who is mid-download.
 */
export const CONSUMED_GRACE_MS = 5 * 60 * 1000;

/**
 * Removes expired pastes and the objects behind consumed ones.
 *
 * Designed for the free plan:
 *  - bounded: at most `cleanupMaxBatches` batches of `cleanupBatchSize` rows,
 *  - idempotent: safe to run twice, or to re-run after a failure,
 *  - object first: a row is only deleted once its object is gone, so a partial
 *    failure can never strand data in R2 with nothing pointing at it.
 */
export async function sweep(store: Stores, config: Config, now = Date.now()): Promise<SweepReport> {
	const { meta, objects } = store;
	const report: SweepReport = {
		batches: 0,
		expiredRows: 0,
		expiredObjects: 0,
		consumedRows: 0,
		consumedObjects: 0,
		deferred: 0,
	};

	report.batches += await sweepPass(
		report,
		"expired",
		async () => {
			const rows = await meta.listExpired(now, config.cleanupBatchSize);
			return rows;
		},
		objects,
		meta,
		config,
	);

	report.batches += await sweepPass(
		report,
		"consumed",
		async () => {
			const rows = await meta.listConsumed(now - CONSUMED_GRACE_MS, config.cleanupBatchSize);
			return rows;
		},
		objects,
		meta,
		config,
	);

	return report;
}

type SweepableRow = { id: string; objectKey: string | null };

async function sweepPass(
	report: SweepReport,
	pass: "expired" | "consumed",
	fetchBatch: () => Promise<SweepableRow[]>,
	objects: Stores["objects"],
	meta: Stores["meta"],
	config: Config,
): Promise<number> {
	let batches = 0;

	for (let index = 0; index < config.cleanupMaxBatches; index += 1) {
		const rows = await fetchBatch();
		if (rows.length === 0) break;

		batches += 1;
		const keys = rows.map((row) => row.objectKey).filter((key): key is string => Boolean(key));

		let failed = new Set<string>();
		if (keys.length > 0) {
			const result = await objects.delete(keys);
			failed = new Set(result.failed);
			if (pass === "expired") report.expiredObjects += result.deleted;
			else report.consumedObjects += result.deleted;
		}

		const removable = rows.filter((row) => !row.objectKey || !failed.has(row.objectKey)).map((row) => row.id);
		report.deferred += rows.length - removable.length;
		const removedRows = await meta.deleteMany(removable);
		if (pass === "expired") report.expiredRows += removedRows;
		else report.consumedRows += removedRows;

		// Nothing could be removed: stop instead of spinning on the same batch.
		if (removable.length === 0) break;
		// Last batch was not full: there is nothing left to do.
		if (rows.length < config.cleanupBatchSize) break;
	}

	return batches;
}
