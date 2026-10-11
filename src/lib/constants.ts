export const MAX_TITLE = 120;
export const MAX_CONTENT_CHARS = 400_000;
export const MAX_URL_CHARS = 2_048;

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
export const RESERVED_SLUGS = new Set(["raw", "new", "edit", "index"]);

export type ExpiryKey = "1h" | "1d" | "1w" | "1mo";

export const EXPIRIES: { key: ExpiryKey; label: string; ms: number }[] = [
  { key: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { key: "1d", label: "1 day", ms: 24 * 60 * 60 * 1000 },
  { key: "1w", label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "1mo", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
];

export const DEFAULT_EXPIRY: ExpiryKey = "1w";

export function expiryMs(key: string | undefined): number | null {
  const found = EXPIRIES.find((e) => e.key === key);
  return found ? found.ms : null;
}

export type LanguageOption = { id: string; label: string };

export const LANGUAGES: LanguageOption[] = [
  { id: "plain", label: "Plain text" },
  { id: "bash", label: "Bash" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "csharp", label: "C#" },
  { id: "css", label: "CSS" },
  { id: "diff", label: "Diff" },
  { id: "go", label: "Go" },
  { id: "graphql", label: "GraphQL" },
  { id: "ini", label: "INI" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "kotlin", label: "Kotlin" },
  { id: "lua", label: "Lua" },
  { id: "makefile", label: "Makefile" },
  { id: "markdown", label: "Markdown" },
  { id: "php", label: "PHP" },
  { id: "python", label: "Python" },
  { id: "r", label: "R" },
  { id: "ruby", label: "Ruby" },
  { id: "rust", label: "Rust" },
  { id: "scss", label: "SCSS" },
  { id: "shell", label: "Shell" },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "typescript", label: "TypeScript" },
  { id: "xml", label: "HTML / XML" },
  { id: "yaml", label: "YAML" },
];

export const LANGUAGE_IDS = new Set(LANGUAGES.map((l) => l.id));

export function languageLabel(id: string): string {
  return LANGUAGES.find((l) => l.id === id)?.label ?? "Plain text";
}
