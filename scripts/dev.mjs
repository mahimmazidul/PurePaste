/**
 * Local development: the client bundle in watch mode next to `wrangler dev`.
 *
 * Ctrl+C stops both. Anything wrangler prints is passed straight through, so the
 * usual local routes work — including the cron test endpoint:
 *
 *   curl "http://localhost:8787/cdn-cgi/local/scheduled?format=json&cron=17+*+*+*+*"
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];

function start(name, command, args, extraEnv = {}) {
	const child = spawn(command, args, {
		cwd: root,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, ...extraEnv },
		shell: process.platform === "win32",
	});
	child.on("exit", (code) => {
		if (stopping) return;
		console.error(`\n${name} stopped (exit ${code ?? 0}). Shutting the rest down.`);
		shutdown(code ?? 0);
	});
	children.push({ name, child });
	return child;
}

let stopping = false;

function shutdown(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const { child } of children) {
		if (!child.killed) child.kill("SIGTERM");
	}
	setTimeout(() => process.exit(code), 150);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("building the client bundle, then starting wrangler…");
start("client build", process.execPath, [join(root, "scripts", "build-client.mjs"), "--watch"]);
start("wrangler dev", "npx", ["wrangler", "dev", "--port", "8787"]);
