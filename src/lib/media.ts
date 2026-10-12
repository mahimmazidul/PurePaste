/**
 * Which stored files may be drawn by a browser, rather than handed over as a
 * download.
 *
 * The rule is deliberately narrow. A pastebin cannot trust a content type that a
 * visitor chose, so the media routes classify by the *stored* name and type
 * together and refuse anything that a browser would be tempted to execute or
 * render as markup. `text/html`, `image/svg+xml` and anything unknown are the
 * notable refusals: SVG is a script container, and HTML on your own origin is a
 * stored-XSS machine. Those files still download exactly as before — this file
 * only decides what the viewer page may embed.
 */

export type MediaKind = "image" | "video" | "audio" | "pdf" | "text" | null;

export interface MediaDecision {
	kind: MediaKind;
	/** The type we will answer with, never the one the uploader claimed. */
	contentType: string | null;
	reason: string | null;
}

const IMAGE_TYPES: Record<string, string> = {
	"image/png": "image/png",
	"image/jpeg": "image/jpeg",
	"image/jpg": "image/jpeg",
	"image/gif": "image/gif",
	"image/webp": "image/webp",
	"image/avif": "image/avif",
	"image/bmp": "image/bmp",
	"image/apng": "image/apng",
};

const IMAGE_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	apng: "image/apng",
};

const VIDEO: Record<string, string> = {
	"video/mp4": "video/mp4",
	"video/webm": "video/webm",
	"video/ogg": "video/ogg",
};
const VIDEO_EXT: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", m4v: "video/mp4" };

const AUDIO: Record<string, string> = {
	"audio/mpeg": "audio/mpeg",
	"audio/mp3": "audio/mpeg",
	"audio/ogg": "audio/ogg",
	"audio/wav": "audio/wav",
	"audio/x-wav": "audio/wav",
	"audio/flac": "audio/flac",
	"audio/aac": "audio/aac",
	"audio/webm": "audio/webm",
	"audio/mp4": "audio/mp4",
};
const AUDIO_EXT: Record<string, string> = {
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	oga: "audio/ogg",
	wav: "audio/wav",
	flac: "audio/flac",
	aac: "audio/aac",
	m4a: "audio/mp4",
};

const TEXT_EXT = new Set([
	"txt",
	"md",
	"markdown",
	"csv",
	"tsv",
	"log",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"lock",
	"sql",
	"sh",
	"bash",
	"zsh",
	"py",
	"js",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"jsx",
	"go",
	"rs",
	"c",
	"h",
	"cpp",
	"hpp",
	"java",
	"kt",
	"rb",
	"php",
	"pl",
	"lua",
	"ex",
	"exs",
	"erl",
	"hs",
	"ml",
	"swift",
	"dart",
	"css",
	"scss",
]);

function extension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Classify one stored file. `contentType` is what the record carries (resolved
 * from the filename at creation, so it is already the app's own guess, not the
 * uploader's header); `filename` is the display name.
 */
export function classifyMedia(contentType: string | null, filename: string | null): MediaDecision {
	const type = ((contentType ?? "").split(";")[0] ?? "").trim().toLowerCase();
	const ext = extension(filename ?? "");
	const refuse = (reason: string): MediaDecision => ({ kind: null, contentType: null, reason });

	// Extension wins for images: a file called photo.png that claims
	// text/plain is still a PNG as far as the browser is concerned, and the
	// answer we send is our own allowlisted type either way.
	if (IMAGE_EXT[ext] || IMAGE_TYPES[type]) {
		return { kind: "image", contentType: IMAGE_EXT[ext] ?? IMAGE_TYPES[type] ?? null, reason: null };
	}
	if (VIDEO_EXT[ext] || VIDEO[type])
		return { kind: "video", contentType: VIDEO_EXT[ext] ?? VIDEO[type] ?? null, reason: null };
	if (AUDIO_EXT[ext] || AUDIO[type])
		return { kind: "audio", contentType: AUDIO_EXT[ext] ?? AUDIO[type] ?? null, reason: null };

	if (ext === "pdf" || type === "application/pdf") {
		return { kind: "pdf", contentType: "application/pdf", reason: null };
	}

	if (type.startsWith("text/") && !type.includes("html")) {
		return { kind: "text", contentType: "text/plain; charset=utf-8", reason: null };
	}
	if (TEXT_EXT.has(ext)) return { kind: "text", contentType: "text/plain; charset=utf-8", reason: null };
	if (type === "application/json" || type.endsWith("+json"))
		return { kind: "text", contentType: "text/plain; charset=utf-8", reason: null };

	// HTML, SVG, XML and everything unrecognised: download only.
	if (type.includes("html") || ext === "svg" || ext === "svgz" || type === "image/svg+xml") {
		return refuse("markup or scriptable image");
	}
	return refuse("not a previewable type");
}
