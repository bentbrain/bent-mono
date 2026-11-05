type CapturedItem = { id: string; data: { captured_at: Date } };

export function captureOrder<T extends CapturedItem>(
  items: T[],
  direction: 'asc' | 'desc' = 'asc',
): T[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...items].sort(
    (a, b) =>
      sign * (a.data.captured_at.getTime() - b.data.captured_at.getTime()) ||
      a.id.localeCompare(b.id),
  );
}

export function selectGalleryItem(
  selected: string[],
  id: string,
  items: CapturedItem[],
  preserveOrder: boolean,
): string[] {
  if (selected.includes(id)) return selected;
  const next = [...selected, id];
  if (preserveOrder) return next;
  const positions = new Map(
    captureOrder(items).map((item, index) => [item.id, index]),
  );
  return next.sort(
    (a, b) => (positions.get(a) ?? Infinity) - (positions.get(b) ?? Infinity),
  );
}
