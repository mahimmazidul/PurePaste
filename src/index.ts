import { createApp } from "./app";
import type { AppEnv } from "./env";
import { resolveConfig } from "./config";
import { sweep } from "./services/cleanup";
import { stores } from "./services/paste-store";
import { flushViewsNow } from "./services/views";

const app = createApp();

/**
 * Worker entry point.
 *
 * `fetch` serves everything; `scheduled` runs the hourly cleanup. Both share the
 * same configuration resolution, so limits behave identically in both paths.
 */
export default {
	async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
		return app.fetch(request, env, ctx);
	},

	async scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
		const config = resolveConfig(env);
		ctx.waitUntil(
			(async () => {
				try {
					const report = await sweep(stores(env), config, controller.scheduledTime || Date.now());
					// Flush any buffered view counts while we are here, so a quiet
					// isolate does not hold them forever.
					await flushViewsNow(env);
					console.log("cleanup finished", { cron: controller.cron, ...report });
				} catch (error) {
					// Surfaced in Workers Logs; the next run picks up where this one stopped.
					console.error("cleanup failed", {
						cron: controller.cron,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			})(),
		);
	},
} satisfies ExportedHandler<AppEnv>;
