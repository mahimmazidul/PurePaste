import { beforeEach, describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, safeHref, stripDisallowedTags } from "../src/client/lib/markdown";
import { createPaste, readJson, request, resetStorage, testConfig } from "./helpers";

/**
 * Markdown is rendered in the reader's browser, but the rules it follows are the
 * substance of the promise on the paste page: a paste can never run script in
 * somebody else's browser, no matter what the sender typed.
 */
describe("markdown rendering", () => {
	it("escapes every character that could start a tag", () => {
		expect(escapeHtml('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	});

	it("turns raw script tags into text", () => {
		const html = renderMarkdown('Hello <script>alert("x")</script> world');
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;");
	});

	it("keeps markup in paste text as text, not as tags", () => {
		const html = renderMarkdown('<p onclick="steal()">click me</p>');
		// The characters survive as escaped text; nothing becomes an attribute.
		expect(html).not.toContain("<p onclick");
		expect(html).toContain("&lt;p onclick=&quot;steal()&quot;&gt;click me&lt;/p&gt;");
	});

	it("refuses javascript: links", () => {
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
		expect(safeHref("vbscript:msgbox(1)")).toBeNull();
		expect(safeHref("file:///etc/passwd")).toBeNull();
		expect(safeHref("//evil.example.com/x")).toBeNull();

		const html = renderMarkdown("[click](javascript:alert(1))");
		expect(html).not.toContain("<a ");
	});

	it("keeps http, https and mailto links with safe attributes", () => {
		const html = renderMarkdown("[docs](https://example.com/a?b=c) and [mail](mailto:hi@example.com)");
		expect(html).toContain('href="https://example.com/a?b=c"');
		expect(html).toContain('rel="noopener noreferrer nofollow"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('href="mailto:hi@example.com"');
	});

	it("links bare addresses but never a dangerous scheme", () => {
		const html = renderMarkdown("see https://example.com/x for more");
		expect(html).toContain('<a href="https://example.com/x"');
		const dangerous = renderMarkdown("see javascript:alert(1) for more");
		expect(dangerous).not.toContain("<a ");
	});

	it("escapes code, including inside fences", () => {
		const html = renderMarkdown("```html\n<b>bold</b> & <i>italic</i>\n```");
		expect(html).toContain("<pre><code");
		expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;");
		expect(html).not.toContain("<b>bold</b>");
	});

	it("keeps inline code literal and does not format inside it", () => {
		const html = renderMarkdown("use `**not bold**` here");
		expect(html).toContain("<code>**not bold**</code>");
		expect(html).not.toContain("<strong>not bold</strong>");
	});

	it("renders the formatting it promises", () => {
		const html = renderMarkdown(
			"# Title\n\nSome **bold** and *italic* and ~~gone~~.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---",
		);
		expect(html).toContain("<h1>Title</h1>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
		expect(html).toContain("<del>gone</del>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>one</li>");
		expect(html).toContain("<li>two</li>");
		expect(html).toContain("</ul>");
		expect(html).toContain("<ol>");
		expect(html).toContain("<li>first</li>");
		expect(html).toContain("</ol>");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("<p>quoted</p>");
		expect(html).toContain("</blockquote>");
		expect(html).toContain("<th>a</th>");
		expect(html).toContain("<td>2</td>");
		expect(html).toContain("<hr>");
	});

	it("removes tags that are not on the allowlist, whatever their source", () => {
		expect(stripDisallowedTags('<iframe src="//evil"></iframe>ok')).toBe("ok");
		expect(stripDisallowedTags('<object data="x"></object><form action="/x">hi</form>')).toBe("hi");
		expect(stripDisallowedTags("<strong>kept</strong>")).toBe("<strong>kept</strong>");
		// An anchor with no usable href keeps its text but loses the link.
		expect(stripDisallowedTags('<a href="javascript:alert(1)">text</a>')).toBe("<a>text</a>");
	});

	it("leaves no attribute other than the ones it writes itself", () => {
		expect(stripDisallowedTags('<p style="position:fixed">x</p>')).toBe("<p>x</p>");
		expect(stripDisallowedTags('<code class="language-js" onmouseover="x">y</code>')).toBe(
			'<code class="language-js">y</code>',
		);
	});
});

describe("markdown on a real paste", () => {
	beforeEach(resetStorage);

	it("sends the source escaped, and never renders it on the server", async () => {
		const created = await readJson<{ id: string }>(
			await request("/api/pastes", {
				method: "POST",
				body: JSON.stringify({
					content: "# Heading\n\n<img src=x onerror=alert(1)>\n\n[link](javascript:alert(1))",
					markdown: true,
					expire: "1d",
				}),
				headers: { "Content-Type": "application/json", Accept: "application/json" },
			}),
		);

		const page = await request(`/${created.id}`);
		const html = await page.text();

		expect(html).toContain("data-markdown-source");
		expect(html).toContain("data-markdown-output");
		// The source is text, so it is escaped rather than interpreted: there is no
		// img element and no attribute anywhere in the response.
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		// Nothing is rendered server-side: the output holder ships empty.
		expect(html).toContain('<div class="markdown-body" data-markdown-output hidden></div>');
	});

	it("keeps the badges and meta honest about what it is", async () => {
		const created = await createPaste({ content: "**bold**", markdown: true });
		const html = await (await request(`/${created.id}`)).text();
		expect(html).toContain("Markdown");
		expect(testConfig.textMaxBytes).toBeGreaterThan(0);
	});
});
