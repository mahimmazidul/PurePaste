import { createApp } from "./app";
import type { AppEnv } from "./env";
import { resolveConfig } from "./config";
import { sweep } from "./services/cleanup";
import { stores } from "./services/paste-store";
import { flushViewsNow } from "./services/views";
import { runMaintenance } from "./services/maintenance";

const app = createApp();

/**
 * Worker entry point.
 *
 * `fetch` serves everything; `scheduled` runs the hourly work: the expiry sweep, the
 * Supabase keep-alive and purge, and — once a day — the bucket orphan pass. Both
 * share the same configuration resolution, so limits behave identically in both paths.
 */
export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	async scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
		const config = resolveConfig(env);
		const at = controller.scheduledTime || Date.now();
		ctx.waitUntil(
			(async () => {
				// Three jobs, three failures: whatever goes wrong in one is logged and
				// left for the next hour, and never stops the others from running.
				const run = async (name: string, work: () => Promise<object>): Promise<void> => {
					try {
						console.log(`${name} finished`, { cron: controller.cron, ...(await work()) });
					} catch (error) {
						console.error(`${name} failed`, {
							cron: controller.cron,
							message: error instanceof Error ? error.message : String(error),
						});
					}
				};

				await run("cleanup", async () => sweep(stores(env), config, at));
				// Buffered view counts ride along, so a quiet isolate does not hold them.
				await run("views", async () => ({ flushed: await flushViewsNow(env) }));
				await run("maintenance", async () => runMaintenance(env, config, at));
			})(),
		);
	},
} satisfies ExportedHandler<AppEnv>;
