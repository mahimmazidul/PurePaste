/**
 * Access to the Worker execution context that cannot throw.
 *
 * `c.executionCtx` is a getter that raises "This context has no ExecutionContext"
 * when the app is fetched directly — in tests, in an embedder, or from any caller
 * that does not have a context to hand over. Background work is an optimisation
 * here (a mirror write, a deferred delete), so a missing context must mean "skip
 * the optimisation", never "fail the request".
 */
export interface Deferrer {
	waitUntil(promise: Promise<unknown>): void;
}

export function deferrer(c: object): Deferrer | undefined {
	try {
		const candidate = (c as { executionCtx?: Deferrer }).executionCtx;
		return typeof candidate?.waitUntil === "function" ? candidate : undefined;
	} catch {
		return undefined;
	}
}
