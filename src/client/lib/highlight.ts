/**
 * Syntax highlighting, loaded only when a paste actually has a language worth
 * highlighting. The grammar for each language is a separate chunk, so a page in
 * Python never downloads the Rust rules.
 */
type HighlightResult = { value: string };

const GRAMMARS: Record<string, () => Promise<{ default: unknown }>> = {
	bash: () => import("highlight.js/lib/languages/bash"),
	c: () => import("highlight.js/lib/languages/c"),
	cpp: () => import("highlight.js/lib/languages/cpp"),
	csharp: () => import("highlight.js/lib/languages/csharp"),
	css: () => import("highlight.js/lib/languages/css"),
	diff: () => import("highlight.js/lib/languages/diff"),
	dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
	go: () => import("highlight.js/lib/languages/go"),
	graphql: () => import("highlight.js/lib/languages/graphql"),
	ini: () => import("highlight.js/lib/languages/ini"),
	java: () => import("highlight.js/lib/languages/java"),
	javascript: () => import("highlight.js/lib/languages/javascript"),
	json: () => import("highlight.js/lib/languages/json"),
	kotlin: () => import("highlight.js/lib/languages/kotlin"),
	lua: () => import("highlight.js/lib/languages/lua"),
	makefile: () => import("highlight.js/lib/languages/makefile"),
	markdown: () => import("highlight.js/lib/languages/markdown"),
	nginx: () => import("highlight.js/lib/languages/nginx"),
	php: () => import("highlight.js/lib/languages/php"),
	powershell: () => import("highlight.js/lib/languages/powershell"),
	python: () => import("highlight.js/lib/languages/python"),
	ruby: () => import("highlight.js/lib/languages/ruby"),
	rust: () => import("highlight.js/lib/languages/rust"),
	scss: () => import("highlight.js/lib/languages/scss"),
	sql: () => import("highlight.js/lib/languages/sql"),
	swift: () => import("highlight.js/lib/languages/swift"),
	typescript: () => import("highlight.js/lib/languages/typescript"),
	xml: () => import("highlight.js/lib/languages/xml"),
	yaml: () => import("highlight.js/lib/languages/yaml"),
};

const loaded = new Set<string>();

/** Returns true when the block was highlighted, false when it stays plain text. */
export async function highlightBlock(block: HTMLElement, language: string): Promise<boolean> {
	const load = GRAMMARS[language];
	const code = block.querySelector("code");
	if (!load || !code) return false;

	try {
		const [{ default: hljs }, grammar] = await Promise.all([import("highlight.js/lib/core"), load()]);
		const core = hljs as unknown as {
			registerLanguage(name: string, grammar: unknown): void;
			highlight(code: string, options: { language: string; ignoreIllegals: boolean }): HighlightResult;
		};
		if (!loaded.has(language)) {
			core.registerLanguage(language, grammar.default);
			loaded.add(language);
		}
		// The source is taken from the DOM as text, never as markup.
		const result = core.highlight(code.textContent ?? "", { language, ignoreIllegals: true });
		// highlight.js escapes the input and only adds its own spans.
		code.innerHTML = result.value;
		block.classList.add("is-highlighted");
		return true;
	} catch {
		return false;
	}
}
