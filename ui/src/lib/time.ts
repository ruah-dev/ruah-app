// Compact relative times for lists ("now", "5m", "3h", "2d", "Sep 3", "Sep 3, 2025").
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(input: string | number | null | undefined, now = Date.now()): string {
  if (input === null || input === undefined) return "";
  const t = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, now - t);
  if (d < MIN) return "now";
  if (d < HOUR) return `${Math.floor(d / MIN)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d`;
  const date = new Date(t);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Longer form for tooltips. */
export function absoluteTime(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return "";
  const t = typeof input === "number" ? input : Date.parse(input);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Home-relative display of an absolute path ("/Users/me/code/x" → "~/code/x"). */
export function prettyPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}
