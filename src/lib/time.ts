const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "in 5 days", "in 3 hours", "in 40 minutes", "within the hour" */
export function timeUntil(date: Date | string): string {
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return "expired";
  if (ms < HOUR) {
    const mins = Math.round(ms / MIN);
    if (mins < 2) return "any moment now";
    return `in ${mins} minutes`;
  }
  if (ms < DAY) {
    const hrs = Math.round(ms / HOUR);
    return hrs === 1 ? "in 1 hour" : `in ${hrs} hours`;
  }
  const days = Math.round(ms / DAY);
  if (days < 31) return days === 1 ? "in 1 day" : `in ${days} days`;
  const months = Math.round(days / 30);
  return months === 1 ? "in about a month" : `in ${months} months`;
}

/** "5 days ago" / "3 hours ago" / "just now" */
export function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime();
  if (ms < MIN) return "just now";
  if (ms < HOUR) {
    const m = Math.round(ms / MIN);
    return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  }
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }
  const d = Math.round(ms / DAY);
  if (d < 31) return d === 1 ? "1 day ago" : `${d} days ago`;
  const mo = Math.round(d / 30);
  return mo === 1 ? "about a month ago" : `${mo} months ago`;
}

/** "Mar 12, 2026, 4:20 PM" */
export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
