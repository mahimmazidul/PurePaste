import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Lint configuration.
 *
 * Two environments live in this repository: a Worker (no DOM) and a browser
 * bundle (DOM, no Node). They share a TypeScript baseline; anything stricter is
 * left to the compiler, which already runs with the strictest settings.
 */
export default tseslint.config(
	{
		ignores: ["node_modules/", ".wrangler/", "coverage/", "public/", "worker-configuration.d.ts", "migrations/"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
		},
		rules: {
			// Unused code is a smell, but an intentionally ignored binding is not.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					// `catch {}` blocks are used deliberately for optional paths.
					caughtErrors: "none",
				},
			],
			"no-empty": ["error", { allowEmptyCatch: true }],
			// The application deliberately re-checks values that come from the network.
			"@typescript-eslint/no-non-null-assertion": "off",
			"no-console": "off",
			eqeqeq: ["error", "always", { null: "ignore" }],
			"prefer-const": "error",
			"no-var": "error",
		},
	},
	{
		// The browser bundle may touch the DOM and localStorage; the Worker may not.
		files: ["src/client/**/*.ts"],
		rules: {
			"no-restricted-globals": ["error", "process", "Buffer", "require"],
		},
	},
	{
		files: ["scripts/**/*.mjs"],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: "module",
			globals: {
				console: "readonly",
				process: "readonly",
				setTimeout: "readonly",
				clearTimeout: "readonly",
				fetch: "readonly",
				URL: "readonly",
			},
		},
		rules: {
			"no-console": "off",
		},
	},
);
