import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../lib/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  categoryIconStatusSchema,
  categoryNames,
  isDefaultCategory,
  type CategoryIconStatus as Status,
} from '../lib/category-icons';
import { Button } from './ui/button';

const responseSchema = z.object({ icons: z.array(categoryIconStatusSchema) });
function statusLabel(icon: Status) {
  if (icon.state === 'setup')
    return 'add OPENAI_API_KEY in deployment secrets and configure an image model';
  if (icon.state === 'configuration')
    return 'check the image service key, model and account access, then retry';
  if (icon.state === 'uncertain')
    return 'result unknown; retry may charge again';
  if (icon.state === 'default')
    return isDefaultCategory(icon.normalized) ? 'built-in' : 'fallback';
  return icon.state;
}
export function CategoryIconStatus({ names }: { names: string[] }) {
  const client = useQueryClient();
  const identity = categoryNames(names)
    .map((name) => name.normalized)
    .sort();
  const queryKey = ['owner', 'category-icons', identity];
  const query = useQuery({
    queryKey,
    enabled: identity.length > 0,
    queryFn: async ({ signal }) =>
      responseSchema.parse(
        await api('/api/trip/category-icons', undefined, 'GET', signal),
      ).icons,
    refetchInterval: (query) =>
      query.state.data?.some((icon) => icon.state === 'pending')
        ? 15_000
        : false,
  });
  const icons = query.data ?? [];
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const mutation = useMutation({
    mutationFn: (icon: Status) =>
      api('/api/trip/category-icons', {
        category: icon.label,
        acknowledgeCharge: icon.state === 'uncertain',
      }),
  });
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['owner', 'category-icons'] });
    };
    window.addEventListener('category-icons:changed', refresh);
    return () => {
      window.removeEventListener('category-icons:changed', refresh);
    };
  }, [client]);
  const selected = new Set(categoryNames(names).map((name) => name.normalized));
  async function retry(icon: Status) {
    setBusy(icon.normalized);
    try {
      await mutation.mutateAsync(icon);
      setError('');
      window.dispatchEvent(new Event('category-icons:changed'));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'could not retry icon');
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <div className="space-y-2 text-xs" aria-label="Category icons">
      {icons
        .filter((icon) => selected.has(icon.normalized))
        .map((icon) => (
          <div
            key={icon.normalized}
            className="flex flex-wrap items-center gap-2"
          >
            {icon.url && (
              <span
                aria-hidden="true"
                className="size-6 shrink-0 bg-current [mask-size:contain] [mask-repeat:no-repeat]"
                style={{ maskImage: `url("${icon.url}")` }}
              />
            )}
            <span>
              {icon.label} icon · {statusLabel(icon)}
            </span>
            {icon.canRetry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(busy) || query.isFetching}
                onClick={() => {
                  void retry(icon);
                }}
              >
                {busy === icon.normalized
                  ? 'QUEUING'
                  : icon.state === 'ready'
                    ? 'REGENERATE'
                    : icon.state === 'uncertain'
                      ? 'RETRY (MAY CHARGE)'
                      : 'RETRY'}
              </Button>
            )}
          </div>
        ))}
      <p role="status" className="empty:hidden">
        {error || (query.isError ? 'could not load icon status' : '')}
      </p>
    </div>
  );
}
