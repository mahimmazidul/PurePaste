import { beforeEach, describe, expect, it } from "vitest";
import { sweep } from "../src/services/cleanup";
import { stores, type Stores } from "../src/services/paste-store";
import type { ObjectStore } from "../src/services/object-store";
import { createPaste, objectKeys, readRow, resetStorage, testConfig, testEnv } from "./helpers";

const SMALL_CONFIG = { ...testConfig, cleanupBatchSize: 2, cleanupMaxBatches: 2 };

/** Wraps the real object store so specific keys can be made to fail. */
function flakyStores(failingKeys: Set<string>): Stores {
	const real = stores(testEnv);
	const fake: Pick<ObjectStore, "delete"> = {
		async delete(keys: string[]) {
			const blocked = keys.filter((key) => failingKeys.has(key));
			const deletable = keys.filter((key) => !failingKeys.has(key));
			const result = deletable.length > 0 ? await real.objects.delete(deletable) : { deleted: 0, failed: [] };
			return { deleted: result.deleted, failed: [...result.failed, ...blocked] };
		},
	};
	return { meta: real.meta, objects: fake as unknown as ObjectStore };
}

async function expire(id: string, msAgo = 1000): Promise<void> {
	await testEnv.DB.prepare("UPDATE pastes SET expires_at = ? WHERE id = ?")
		.bind(Date.now() - msAgo, id)
		.run();
}

/** A paste small enough to live in D1, and one big enough to have an R2 object. */
async function createPair(): Promise<{ inline: string; stored: string }> {
	const inline = await createPaste({ content: "small inline paste" });
	const stored = await createPaste({ content: "y".repeat(testConfig.inlineTextMaxBytes + 32) });
	return { inline: inline.id, stored: stored.id };
}

describe("scheduled cleanup", () => {
	beforeEach(resetStorage);

	it("removes expired rows and their objects", async () => {
		const { inline, stored } = await createPair();
		await expire(inline);
		await expire(stored);

		const report = await sweep(stores(testEnv), testConfig);

		expect(report.expiredRows).toBe(2);
		expect(report.expiredObjects).toBe(1);
		expect(await readRow(inline)).toBeNull();
		expect(await readRow(stored)).toBeNull();
		expect(await objectKeys()).toHaveLength(0);
	});

	it("leaves live pastes untouched", async () => {
		const { inline, stored } = await createPair();
		const report = await sweep(stores(testEnv), testConfig);

		expect(report.expiredRows).toBe(0);
		expect(report.consumedRows).toBe(0);
		expect(await readRow(inline)).not.toBeNull();
		expect(await readRow(stored)).not.toBeNull();
	});

	it("is idempotent", async () => {
		const { stored } = await createPair();
		await expire(stored);

		const first = await sweep(stores(testEnv), testConfig);
		const second = await sweep(stores(testEnv), testConfig);

		expect(first.expiredRows).toBe(1);
		expect(second.expiredRows).toBe(0);
		expect(second.expiredObjects).toBe(0);
	});

	it("stays inside its batch budget when there is more work than one run allows", async () => {
		const ids: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			const created = await createPaste({ content: `expired ${index}` });
			ids.push(created.id);
			await expire(created.id);
		}

		const report = await sweep(stores(testEnv), SMALL_CONFIG);

		// Two batches of two: the sweep stops well short of Worker limits.
		expect(report.batches).toBe(2);
		expect(report.expiredRows).toBe(4);
		const remaining = await Promise.all(ids.map((id) => readRow(id)));
		expect(remaining.filter((row) => row !== null)).toHaveLength(1);

		// A second run finishes the job.
		const second = await sweep(stores(testEnv), SMALL_CONFIG);
		expect(second.expiredRows).toBe(1);
	});

	it("keeps rows whose object could not be deleted, and retries them later", async () => {
		const { stored } = await createPair();
		await expire(stored);
		const key = `pp/v1/text/${stored}`;

		const report = await sweep(flakyStores(new Set([key])), testConfig);
		expect(report.expiredRows).toBe(0);
		expect(report.deferred).toBe(1);
		expect(await readRow(stored)).not.toBeNull();
		expect(await objectKeys()).toEqual([key]);

		// Once storage recovers, the same row is removed without special handling.
		const recovered = await sweep(stores(testEnv), testConfig);
		expect(recovered.expiredRows).toBe(1);
		expect(recovered.expiredObjects).toBe(1);
		expect(await objectKeys()).toHaveLength(0);
		expect(await readRow(stored)).toBeNull();
	});

	it("stops instead of spinning when nothing can be removed", async () => {
		const { stored } = await createPair();
		await expire(stored);
		const key = `pp/v1/text/${stored}`;

		const report = await sweep(flakyStores(new Set([key])), SMALL_CONFIG);
		expect(report.batches).toBeGreaterThan(0);
		expect(report.batches).toBeLessThanOrEqual(SMALL_CONFIG.cleanupMaxBatches * 2);
	});

	it("clears claimed burn-after-reading pastes after the grace period", async () => {
		const created = await createPaste({ content: "z".repeat(testConfig.inlineTextMaxBytes + 16), burn: "1" });
		await testEnv.DB.prepare("UPDATE pastes SET consumed_at = ? WHERE id = ?")
			.bind(Date.now() - 10 * 60 * 1000, created.id)
			.run();

		const report = await sweep(stores(testEnv), testConfig);
		expect(report.consumedRows).toBe(1);
		expect(report.consumedObjects).toBe(1);
		expect(await readRow(created.id)).toBeNull();
		expect(await objectKeys()).toHaveLength(0);
	});

	it("leaves a freshly claimed paste alone so a reader can finish downloading", async () => {
		const created = await createPaste({ content: "reading right now", burn: "1" });
		await testEnv.DB.prepare("UPDATE pastes SET consumed_at = ? WHERE id = ?").bind(Date.now(), created.id).run();

		const report = await sweep(stores(testEnv), testConfig);
		expect(report.consumedRows).toBe(0);
		expect(await readRow(created.id)).not.toBeNull();
	});
});
