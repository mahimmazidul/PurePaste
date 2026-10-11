/** Small DOM helpers shared by the page scripts. No framework, no dependencies. */

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T | null {
	return root.querySelector<T>(selector);
}

export function qsa<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
	return Array.from(root.querySelectorAll<T>(selector));
}

/** Announces a short status message to assistive technology and to the eye. */
export function announce(message: string, tone: "info" | "success" | "error" = "info"): void {
	const stack = qs("[data-toasts]");
	if (!stack) return;
	const toast = document.createElement("p");
	toast.className = `toast toast-${tone}`;
	toast.setAttribute("role", "status");
	toast.textContent = message;
	stack.append(toast);
	window.setTimeout(() => toast.remove(), 4200);
}

export async function copyText(value: string, label = "Copied"): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		announce(label, "success");
		return true;
	} catch {
		// Clipboard access can be denied; fall back to a selection-based copy.
		const area = document.createElement("textarea");
		area.value = value;
		area.setAttribute("readonly", "true");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const ok = document.execCommand?.("copy") ?? false;
		area.remove();
		announce(ok ? label : "Couldn't copy — select the text and copy it manually", ok ? "success" : "error");
		return ok;
	}
}

export function relativeTime(target: number, now = Date.now()): string {
	const delta = target - now;
	const abs = Math.abs(delta);
	if (abs < 45_000) return delta >= 0 ? "in a moment" : "just now";

	const minute = 60_000;
	const hour = 3_600_000;
	const day = 86_400_000;
	const month = 2_592_000_000;
	const year = 31_536_000_000;

	let value: number;
	let unit: string;
	if (abs < hour) {
		value = Math.round(abs / minute);
		unit = "minute";
	} else if (abs < day) {
		value = Math.round(abs / hour);
		unit = "hour";
	} else if (abs < month * 1.5) {
		value = Math.round(abs / day);
		unit = "day";
	} else if (abs < year) {
		value = Math.round(abs / month);
		unit = "month";
	} else {
		value = Math.round(abs / year);
		unit = "year";
	}

	const plural = value === 1 ? unit : `${unit}s`;
	return delta >= 0 ? `in ${value} ${plural}` : `${value} ${plural} ago`;
}

/** Upgrades every absolute timestamp the server rendered into a relative hint. */
export function upgradeRelativeTimes(root: ParentNode = document): void {
	for (const element of qsa<HTMLElement>("[data-relative]", root)) {
		const value = Number(element.dataset.relative);
		if (Number.isFinite(value)) element.title = relativeTime(value);
	}
	for (const element of qsa<HTMLElement>("[data-relative-expiry]", root)) {
		const value = Number(element.dataset.relativeExpiry);
		if (!Number.isFinite(value)) continue;
		const before = element.dataset.relativeBefore ?? "Expires";
		const remaining = value - Date.now();
		element.textContent = remaining > 0 ? `${before} ${relativeTime(value)}`.replace("in ", "in ") : "Expired";
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}
