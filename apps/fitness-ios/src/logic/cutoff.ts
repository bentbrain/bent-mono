/** How much Health history the first sync sends. */
export type BackfillChoice = "30d" | "1y" | "all";

export const backfillChoices: { value: BackfillChoice; label: string }[] = [
  { value: "30d", label: "Last 30 days" },
  { value: "1y", label: "Last 12 months" },
  { value: "all", label: "All of Health" },
];

/** The earliest instant "All of Health" covers. */
const allHistory = Date.UTC(2000, 0, 1);

/** The absolute cutoff for a choice, as milliseconds since 1970. */
export function cutoffFor(choice: BackfillChoice, now: number): number {
  const day = 86_400_000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  switch (choice) {
    case "30d":
      return start.getTime() - 30 * day;
    case "1y": {
      const year = new Date(start);
      year.setFullYear(year.getFullYear() - 1);
      return year.getTime();
    }
    case "all":
      return allHistory;
  }
}
