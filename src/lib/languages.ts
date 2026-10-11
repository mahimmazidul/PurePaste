/**
 * Languages offered in the editor. `hljs` names a highlight.js grammar that the
 * client loads on demand; everything without a grammar renders as plain text.
 */
export interface LanguageOption {
	id: string;
	label: string;
	hljs?: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
	{ id: "text", label: "Plain text" },
	{ id: "bash", label: "Shell", hljs: "bash" },
	{ id: "c", label: "C", hljs: "c" },
	{ id: "cpp", label: "C++", hljs: "cpp" },
	{ id: "csharp", label: "C#", hljs: "csharp" },
	{ id: "css", label: "CSS", hljs: "css" },
	{ id: "diff", label: "Diff", hljs: "diff" },
	{ id: "dockerfile", label: "Dockerfile", hljs: "dockerfile" },
	{ id: "go", label: "Go", hljs: "go" },
	{ id: "graphql", label: "GraphQL", hljs: "graphql" },
	{ id: "html", label: "HTML", hljs: "xml" },
	{ id: "ini", label: "INI / TOML", hljs: "ini" },
	{ id: "java", label: "Java", hljs: "java" },
	{ id: "javascript", label: "JavaScript", hljs: "javascript" },
	{ id: "json", label: "JSON", hljs: "json" },
	{ id: "kotlin", label: "Kotlin", hljs: "kotlin" },
	{ id: "lua", label: "Lua", hljs: "lua" },
	{ id: "makefile", label: "Makefile", hljs: "makefile" },
	{ id: "markdown", label: "Markdown", hljs: "markdown" },
	{ id: "nginx", label: "Nginx", hljs: "nginx" },
	{ id: "php", label: "PHP", hljs: "php" },
	{ id: "plaintext", label: "Plain text" },
	{ id: "powershell", label: "PowerShell", hljs: "powershell" },
	{ id: "python", label: "Python", hljs: "python" },
	{ id: "ruby", label: "Ruby", hljs: "ruby" },
	{ id: "rust", label: "Rust", hljs: "rust" },
	{ id: "scss", label: "SCSS", hljs: "scss" },
	{ id: "sql", label: "SQL", hljs: "sql" },
	{ id: "swift", label: "Swift", hljs: "swift" },
	{ id: "typescript", label: "TypeScript", hljs: "typescript" },
	{ id: "xml", label: "XML", hljs: "xml" },
	{ id: "yaml", label: "YAML", hljs: "yaml" },
];

const BY_ID = new Map(LANGUAGES.map((language) => [language.id, language]));
/** Aliases accepted from the API so `-d language=js` does something sensible. */
const ALIASES: Record<string, string> = {
	js: "javascript",
	ts: "typescript",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
	py: "python",
	rs: "rust",
	yml: "yaml",
	toml: "ini",
	md: "markdown",
	text: "plaintext",
	txt: "plaintext",
	plain: "plaintext",
	"c++": "cpp",
	cs: "csharp",
	vue: "html",
	svelte: "html",
};

export const DEFAULT_LANGUAGE = "plaintext";

/** Returns a known language id, or the default. Unknown values never reach storage. */
export function resolveLanguage(raw: string | null | undefined): string {
	if (!raw) return DEFAULT_LANGUAGE;
	const candidate = raw.trim().toLowerCase();
	if (BY_ID.has(candidate)) return candidate;
	return ALIASES[candidate] ?? DEFAULT_LANGUAGE;
}

export function languageLabel(id: string): string {
	return BY_ID.get(id)?.label ?? "Plain text";
}

export function highlightGrammar(id: string): string | undefined {
	return BY_ID.get(id)?.hljs;
}
