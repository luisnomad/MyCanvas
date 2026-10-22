/**
 * "5 minutes ago" style timestamps; the locale date once over a week old.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${String(hours)} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${String(days)} ${days === 1 ? "day" : "days"} ago`;
  }
  return new Date(iso).toLocaleDateString();
}

/** "Edited 5 minutes ago" for the project list. */
export function relativeEditedTime(iso: string): string {
  const relative = relativeTime(iso);
  return relative ? `Edited ${relative}` : "";
}
