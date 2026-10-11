/** Presentation helpers. All of these render text the templates can use directly. */

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${units[unit]}`;
}

const DAY = 86_400;
const HOUR = 3_600;
const MINUTE = 60;

/** "7 days", "1 hour", "in 12 minutes" style durations, deliberately coarse. */
export function formatDuration(seconds: number): string {
	const abs = Math.max(0, Math.round(seconds));
	if (abs < 60) return `${abs} second${abs === 1 ? "" : "s"}`;
	if (abs < HOUR) {
		const minutes = Math.round(abs / MINUTE);
		return `${minutes} minute${minutes === 1 ? "" : "s"}`;
	}
	if (abs < DAY) {
		const hours = Math.round(abs / HOUR);
		return `${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const days = Math.round(abs / DAY);
	return `${days} day${days === 1 ? "" : "s"}`;
}

export function formatDateTime(epochMs: number): string {
	return new Date(epochMs).toISOString().replace(".000Z", "Z");
}

export function formatDate(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10);
}

/** Absolute, human readable expiry line. The client upgrades this to "in 3 hours". */
export function formatExpiry(expiresAt: number, now: number): string {
	const remaining = Math.round((expiresAt - now) / 1000);
	if (remaining <= 0) return "Expired";
	return `Expires in ${formatDuration(remaining)}`;
}
