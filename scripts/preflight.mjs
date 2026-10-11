/**
 * Checks that a deploy has everything it needs, and says so plainly when it does
 * not. It runs offline first: the configuration itself must be sound before
 * anything is uploaded.
 *
 *   npm run preflight
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

/** Strips // and /* ... *\/ comments, leaving strings untouched. */
function stripJsonc(text) {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	let escaped = false;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];

		if (inLine) {
			if (char === "\n") {
				inLine = false;
				out += char;
			}
			continue;
		}
		if (inBlock) {
			if (char === "*" && next === "/") {
				inBlock = false;
				index += 1;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === "/" && next === "/") {
			inLine = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			inBlock = true;
			index += 1;
			continue;
		}
		out += char;
	}
	return out;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function run(command, args, timeout = 25_000) {
	return new Promise((resolve) => {
		execFile(command, args, { cwd: root, timeout, shell: process.platform === "win32" }, (error, stdout, stderr) => {
			resolve({ ok: !error, stdout: stdout ?? "", stderr: stderr ?? "", error });
		});
	});
}

const configPath = join(root, "wrangler.jsonc");
if (!(await exists(configPath))) {
	problems.push("wrangler.jsonc is missing.");
} else {
	const raw = await readFile(configPath, "utf8");
	let config = null;
	try {
		config = JSON.parse(stripJsonc(raw));
	} catch (error) {
		problems.push(`wrangler.jsonc could not be parsed: ${error.message}`);
	}

	if (config) {
		const database = config.d1_databases?.[0];
		if (!database) problems.push("No D1 database is bound. Add a d1_databases entry.");
		else {
			const id = String(database.database_id ?? "");
			if (!/^[0-9a-f-]{32,36}$/i.test(id) || /^0{8}-/.test(id)) {
				problems.push(
					`The D1 database id is still a placeholder (${id || "empty"}). Run: npm run db:create — then paste the id it prints into wrangler.jsonc.`,
				);
			}
		}

		if (!config.r2_buckets?.[0]?.bucket_name) problems.push("No R2 bucket is bound. Add an r2_buckets entry.");
		if (!config.triggers?.crons?.length) warnings.push("No cron trigger is configured, so expired pastes will only be cleaned up lazily.");
		if (config.vars?.FEATURE_VIEW_COUNTING === "on") {
			warnings.push(
				"FEATURE_VIEW_COUNTING is on. Every read then writes to D1 — useful, but it consumes row-write quota.",
			);
		}
		if (!config.observability?.redact_query_string) {
			warnings.push("observability.redact_query_string is off. Query strings can end up in logs.");
		}
	}
}

for (const asset of ["public/assets/styles/app.css", "public/assets/scripts/app.js", "public/assets/fonts/fonts.css"]) {
	if (!(await exists(join(root, asset)))) problems.push(`${asset} is missing. Run: npm run build`);
}

// Secrets cannot be read from the config file, so ask Wrangler when possible.
const secretList = await run("npx", ["wrangler", "secret", "list"]);
if (secretList.ok) {
	if (!/APP_SECRET/.test(secretList.stdout)) {
		warnings.push("APP_SECRET is not set for this Worker. Run: npx wrangler secret put APP_SECRET");
	}
} else {
	warnings.push("Could not list Worker secrets (not logged in, or offline). Make sure APP_SECRET is set before deploying.");
}

const migrations = await run("npx", ["wrangler", "d1", "migrations", "list", "purepaste", "--remote"]);
if (migrations.ok && /unapplied/i.test(migrations.stdout)) {
	warnings.push("There are unapplied migrations. Run: npm run migrate:remote");
} else if (!migrations.ok) {
	warnings.push("Could not check remote migrations. Run: npm run migrate:remote before the first deploy.");
}

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (problems.length > 0) {
	console.error("\nPreflight failed:\n");
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error("");
	process.exit(1);
}

console.log(`preflight passed${warnings.length > 0 ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}.`);
