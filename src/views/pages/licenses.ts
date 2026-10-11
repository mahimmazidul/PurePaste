import type { Config } from "../../config";
import { escapeHtml } from "../../lib/format";
import { renderLayout } from "../layout";

interface Entry {
	name: string;
	what: string;
	licence: string;
	file: string;
	note?: string;
}

/**
 * Everything Slip ships that somebody else wrote, with the licence text
 * alongside it. Fonts and scripts are served from this domain, so their terms
 * belong on a page that can be linked without any third party being contacted.
 */
const ENTRIES: Entry[] = [
	{
		name: "Inter",
		what: "The interface typeface, served as one variable font.",
		licence: "SIL Open Font Licence 1.1",
		file: "/assets/licenses/inter-OFL.txt",
		note: "Copyright 2020 The Inter Project Authors.",
	},
	{
		name: "Instrument Serif",
		what: "The display face — the wordmark, and the headings worth saying slowly.",
		licence: "SIL Open Font Licence 1.1",
		file: "/assets/licenses/instrument-serif-OFL.txt",
		note: "Copyright 2022 The Instrument Serif Project Authors.",
	},
	{
		name: "JetBrains Mono",
		what: "The typeface used for slip contents and code, served as one variable font.",
		licence: "SIL Open Font Licence 1.1",
		file: "/assets/licenses/jetbrains-mono-OFL.txt",
		note: "Copyright 2020 The JetBrains Mono Project Authors.",
	},
	{
		name: "highlight.js",
		what: "Syntax highlighting. One grammar is loaded at a time, and only when a slip is opened.",
		licence: "BSD 3-Clause",
		file: "/assets/licenses/highlight.js-BSD.txt",
		note: "Copyright 2006 Ivan Sagalaev and contributors.",
	},
];

export function renderLicensesPage(config: Config): string {
	const rows = ENTRIES.map(
		(entry) => `<li class="licence-item">
	<h2 class="h3">${escapeHtml(entry.name)}</h2>
	<p class="lede">${escapeHtml(entry.what)}</p>
	<p class="field-note">${escapeHtml(entry.licence)}${entry.note ? ` — ${escapeHtml(entry.note)}` : ""} · <a href="${escapeHtml(entry.file)}">Read the licence</a></p>
</li>`,
	).join("");

	const body = `
	<section class="hero">
		<h1 class="h1">Licences</h1>
		<p class="lede">Slip loads nothing from a third party: the fonts, the scripts and the icons all arrive from this domain. Here is what they are and who wrote them.</p>
	</section>

	<section class="card">
		<h2 class="h3">This application</h2>
		<p>Slip itself is released under the MIT licence. The source, and the licences of everything listed below, sit together in the same repository.</p>
		<p class="field-note">Slips, files and links you seal belong to whoever pasted them. Nothing here claims a licence over your content.</p>
	</section>

	<section class="card">
		<ul class="licence-list">${rows}</ul>
	</section>
`;

	return renderLayout({
		config,
		page: "licenses",
		title: "Licences",
		body,
		description: "The licences for the fonts and scripts Slip serves from its own domain.",
	});
}
