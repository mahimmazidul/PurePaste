/**
 * Builds the browser bundle.
 *
 * Two outputs come out of this:
 *   app.js    the module bundle, with splitting so the QR encoder, the Markdown
 *             renderer and each syntax grammar are only fetched when used
 *   theme.js  a few lines that apply the saved theme before first paint
 *
 * No CSS build step: the stylesheet is written by hand and served as it is.
 */
import { build, context } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(root, "public", "assets", "scripts");
const watch = process.argv.includes("--watch");
const production = !watch && process.env.NODE_ENV !== "development";

const common = {
	bundle: true,
	platform: "browser",
	target: ["es2022", "chrome110", "firefox110", "safari16"],
	legalComments: "none",
	define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
};

const appOptions = {
	...common,
	entryPoints: [join(root, "src", "client", "main.ts")],
	outdir,
	entryNames: "app",
	chunkNames: "chunks/[name]-[hash]",
	format: "esm",
	splitting: true,
	minify: production,
	sourcemap: production ? false : "linked",
	logLevel: "info",
};

const themeOptions = {
	...common,
	entryPoints: [join(root, "src", "client", "theme.ts")],
	outdir,
	entryNames: "theme",
	format: "iife",
	splitting: false,
	minify: production,
	sourcemap: production ? false : "linked",
	logLevel: "info",
	// The head script must stay synchronous and as small as possible.
	charset: "utf8",
};

async function run() {
	await mkdir(outdir, { recursive: true });

	if (watch) {
		// Old chunks would otherwise pile up in the output directory.
		await rm(join(outdir, "chunks"), { recursive: true, force: true });
		for (const options of [appOptions, themeOptions]) {
			const ctx = await context(options);
			await ctx.watch();
			console.log(`watching ${options.entryPoints[0].replace(`${root}/`, "")}`);
		}
		console.log("client build ready — changes rebuild on save");
		return;
	}

	await Promise.all([build(appOptions), build(themeOptions)]);
	console.log(`client bundle written to ${outdir.replace(`${root}/`, "")}`);
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
