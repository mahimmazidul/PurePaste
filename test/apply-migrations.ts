import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

/**
 * The migrations folder is read by vitest.config.ts and handed to the test
 * environment through a binding, so every test file starts from the real schema.
 */
interface TestMigration {
	name: string;
	queries: string[];
}

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: TestMigration[] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);
