// Bound independent requests without changing result order or launching an
// unbounded number of fetches for large owner selections.
export async function concurrentMap<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('Positive concurrency required');
  const results: R[] = [];
  const queue = items.entries();
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (const [index, item] of queue)
        results[index] = await run(item, index);
    }),
  );
  return results;
}
