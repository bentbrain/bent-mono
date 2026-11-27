/** What a chart says about one point: a short title and its lines. */
export type PointLabel = { title: string; detail: string };

/**
 * The selection after a VoiceOver adjustment. Swiping up from no selection
 * starts at the first point and swiping down at the last; the ends stay put.
 * Returns the selection unchanged for any other action.
 */
export function stepSelection(selected: number | null, count: number, action: string): number | null {
  if (!count) return null;
  const current = selected !== null && selected < count ? selected : null;
  if (action === "increment") return current === null ? 0 : Math.min(count - 1, current + 1);
  if (action === "decrement") return current === null ? count - 1 : Math.max(0, current - 1);
  return current;
}

/** The selected point as VoiceOver reads it, such as "Fri 20 Nov: 8 kg × 12, +2 kg since Mon 16 Nov". */
export function selectionValue(labels: PointLabel[], selected: number | null) {
  const label = selected === null ? undefined : labels[selected];
  return label ? `${label.title}: ${label.detail.split("\n").join(", ")}` : "";
}

/** The hint for a chart VoiceOver can adjust. */
export const chartHint = "Swipe up or down to hear each point.";
