/**
 * A small Markdown renderer that produces safe HTML.
 *
 * It is deliberately not a general purpose Markdown implementation:
 *
 *  - The input is plain text, never HTML. Every piece of text is escaped as it is
 *    emitted, and the only angle brackets in the output are the ones this module
 *    writes itself.
 *  - Link targets are checked against an allowlist of protocols, so
 *    `javascript:` and `data:` links become inert text.
 *  - A final pass removes any tag that is not on the allowlist, as a second line
 *    of defence in case a future edit introduces a mistake here.
 *
 * There is no DOM dependency, so the same code runs in tests inside workerd.
 */

const ALLOWED_TAGS = new Set([
	"p",
	"br",
	"strong",
	"em",
	"del",
	"code",
	"pre",
	"blockquote",
	"ul",
	"ol",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"a",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
]);

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Returns a safe href, or null when the target must not be linked. */
export function safeHref(raw: string): string | null {
	const value = raw.trim();
	if (!value) return null;
	// Relative links are pointless on a paste page and are easy to get wrong.
	if (value.startsWith("//")) return null;
	try {
		const url = new URL(value, "https://purepaste.invalid");
		if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
		return value;
	} catch {
		return null;
	}
}

function inline(text: string): string {
	let out = escapeHtml(text);

	// Inline code first, so its contents are not formatted further. The placeholder
	// is a NUL byte: it cannot occur in escaped text, so it cannot collide.
	const codeSpans: string[] = [];
	out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
		codeSpans.push(`<code>${code}</code>`);
		return `\u0000code${codeSpans.length - 1}\u0000`;
	});

	out = out.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
		const safe = safeHref(href);
		if (!safe) return match;
		return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank">${label}</a>`;
	});

	// Bare URLs become links too, but only http(s).
	out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_match, prefix: string, url: string) => {
		const safe = safeHref(url);
		if (!safe) return `${prefix}${url}`;
		return `${prefix}<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank">${url}</a>`;
	});

	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
	out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

	// eslint-disable-next-line no-control-regex -- matching the placeholder written above
	out = out.replace(/\u0000code(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
	return out;
}

export function renderMarkdown(source: string): string {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let paragraph: string[] = [];
	let listType: "ul" | "ol" | null = null;
	let inCode = false;
	let codeLines: string[] = [];
	let codeLanguage = "";
	let inQuote = false;
	let tableRows: string[][] = [];

	const closeParagraph = () => {
		if (paragraph.length > 0) {
			out.push(`<p>${inline(paragraph.join("\n")).replace(/\n/g, "<br>")}</p>`);
			paragraph = [];
		}
	};
	const closeList = () => {
		if (listType) {
			out.push(`</${listType}>`);
			listType = null;
		}
	};
	const closeQuote = () => {
		if (inQuote) {
			out.push("</blockquote>");
			inQuote = false;
		}
	};
	const closeTable = () => {
		if (tableRows.length === 0) return;
		const [head, ...rest] = tableRows;
		const headCells = (head ?? []).map((cell) => `<th>${inline(cell)}</th>`).join("");
		const bodyRows = rest.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("");
		out.push(`<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`);
		tableRows = [];
	};
	const closeBlocks = () => {
		closeParagraph();
		closeList();
		closeQuote();
		closeTable();
	};

	for (const line of lines) {
		const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
		if (fence) {
			if (inCode) {
				out.push(
					`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
				);
				inCode = false;
				codeLines = [];
				codeLanguage = "";
			} else {
				closeBlocks();
				inCode = true;
				codeLanguage = (fence[2] ?? "").slice(0, 32);
			}
			continue;
		}
		if (inCode) {
			codeLines.push(line);
			continue;
		}

		if (/^\s*$/.test(line)) {
			closeBlocks();
			continue;
		}

		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			closeBlocks();
			const level = heading[1]!.length;
			out.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
			continue;
		}

		if (/^\s{0,3}([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
			closeBlocks();
			out.push("<hr>");
			continue;
		}

		const quote = line.match(/^\s*>\s?(.*)$/);
		if (quote) {
			closeParagraph();
			closeList();
			if (!inQuote) {
				out.push("<blockquote>");
				inQuote = true;
			}
			out.push(`<p>${inline(quote[1] ?? "")}</p>`);
			continue;
		}
		closeQuote();

		const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
		const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
		if (bullet || numbered) {
			closeParagraph();
			const wanted: "ul" | "ol" = bullet ? "ul" : "ol";
			if (listType !== wanted) {
				closeList();
				out.push(`<${wanted}>`);
				listType = wanted;
			}
			out.push(`<li>${inline((bullet ?? numbered)![1] ?? "")}</li>`);
			continue;
		}
		closeList();

		if (line.includes("|") && line.trim().startsWith("|")) {
			const cells = line
				.trim()
				.replace(/^\|/, "")
				.replace(/\|$/, "")
				.split("|")
				.map((cell) => cell.trim());
			if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator row
			closeParagraph();
			tableRows.push(cells);
			continue;
		}
		closeTable();

		paragraph.push(line);
	}

	if (inCode) {
		out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
	}
	closeBlocks();

	return stripDisallowedTags(out.join("\n"));
}

/**
 * Belt and braces: any tag outside the allowlist is removed, and every attribute
 * except a validated href on an anchor is dropped.
 */
export function stripDisallowedTags(html: string): string {
	return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (match, rawTag: string, rawAttributes: string) => {
		const tag = rawTag.toLowerCase();
		if (!ALLOWED_TAGS.has(tag)) return "";
		const closing = match.startsWith("</");
		if (closing) return `</${tag}>`;
		if (tag === "a") {
			const href = rawAttributes.match(/href="([^"]*)"/)?.[1] ?? "";
			const safe = safeHref(decodeEntities(href));
			if (!safe) return "<a>";
			return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow" target="_blank">`;
		}
		if (tag === "code") {
			const language = rawAttributes.match(/class="(language-[\w+-]{1,32})"/)?.[1];
			return language ? `<code class="${language}">` : "<code>";
		}
		if (tag === "br" || tag === "hr") return `<${tag}>`;
		return `<${tag}>`;
	});
}

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}
