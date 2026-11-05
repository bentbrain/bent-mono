import { z } from 'zod';
export const savedItemSchema = z.object({ item: z.object({ id: z.string() }) });
export async function publishItem(
  emdash: {
    [Method in 'handleContentGet' | 'handleContentPublish']: (
      ...args: Parameters<App.Locals['emdash'][Method]>
    ) => Promise<{
      success: boolean;
      data?: unknown;
      error?: { code: string; message: string; details?: unknown };
    }>;
  },
  collection: string,
  id: string,
  actor: { id: string; role: number },
) {
  const current = await emdash.handleContentGet(collection, id);
  if (!current.success || !current.data) return current;
  const revision = z
    .object({ _rev: z.string().optional() })
    .parse(current.data)._rev;
  return emdash.handleContentPublish(collection, id, {
    _rev: revision,
    actor,
    origin: { source: 'api' },
  });
}
