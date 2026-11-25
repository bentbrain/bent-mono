/** A date for status lines, such as "20 Nov 2026, 6:10 am". */
export function formatTime(ms: number | null | undefined, locale?: string): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDay(ms: number | null | undefined, locale?: string): string | null {
  if (!ms) return null;
  return new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}
