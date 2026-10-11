import type { Config } from "../config";
import type { AppEnv } from "../env";
import { stores } from "./paste-store";

/**
 * Optional view counting.
 *
 * A D1 write on every read is the single easiest way to exhaust a free plan, so
 * counts are buffered in the isolate and flushed in one batched statement per
 * flush window. Counts are therefore approximate by design: a cold isolate, a
 * crash, or a shift in traffic can lose or double a few reads. Nothing about a
 * visitor is recorded — only an increment against a paste id.
 */
const MAX_BUFFERED_PASTES = 64;
const MIN_FLUSH_INTERVAL_MS = 15_000;

export interface Deferrer {
	waitUntil(promise: Promise<unknown>): void;
}

let buffer = new Map<string, number>();
// Flush timing is measured from the start of the window, not from zero, so the
// first read after a cold start is buffered like every other read.
let lastFlushAt = Date.now();

export function recordView(env: AppEnv, config: Config, id: string, ctx?: Deferrer): void {
	if (!config.viewCounting) return;

	buffer.set(id, (buffer.get(id) ?? 0) + 1);
	const now = Date.now();
	if (buffer.size >= MAX_BUFFERED_PASTES || now - lastFlushAt >= MIN_FLUSH_INTERVAL_MS) {
		flushViews(env, ctx);
	}
}

function flushViews(env: AppEnv, ctx?: Deferrer): void {
	if (buffer.size === 0) return;
	const entries = [...buffer.entries()].map(([id, count]) => ({ id, count }));
	buffer = new Map();
	lastFlushAt = Date.now();

	const write = stores(env)
		.meta.addViews(entries)
		.catch(() => {
			// Approximation is acceptable: a dropped flush must never fail a read.
		});
	if (ctx) ctx.waitUntil(write);
}

/** Flushes on demand; used by tests and by the cleanup cron. */
export async function flushViewsNow(env: AppEnv): Promise<number> {
	const entries = [...buffer.entries()].map(([id, count]) => ({ id, count }));
	buffer = new Map();
	lastFlushAt = Date.now();
	if (entries.length === 0) return 0;
	await stores(env).meta.addViews(entries);
	return entries.length;
}

export function resetViewBuffer(): void {
	buffer = new Map();
	lastFlushAt = Date.now();
}
