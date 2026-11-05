import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../lib/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './ui/button';

const providerSchema = z.object({
  paused: z.boolean(),
  canResume: z.boolean(),
});
export function CategoryIconProviderStatus() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['owner', 'icon-provider'],
    queryFn: async ({ signal }) =>
      providerSchema.parse(
        await api(
          '/api/trip/category-icons/provider',
          undefined,
          'GET',
          signal,
        ),
      ),
    refetchInterval: 15_000,
  });
  const provider = query.data;
  const mutation = useMutation({
    mutationFn: () =>
      api('/api/trip/category-icons/provider', { action: 'resume' }),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({ queryKey: ['owner', 'icon-provider'] });
    };
    window.addEventListener('category-icons:changed', refresh);
    return () => {
      window.removeEventListener('category-icons:changed', refresh);
    };
  }, [client]);
  async function resume() {
    setBusy(true);
    try {
      await mutation.mutateAsync();
      setError('');
      setNotice('icon generation resumed');
      window.dispatchEvent(new Event('category-icons:changed'));
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'could not resume icon generation',
      );
    } finally {
      setBusy(false);
    }
  }
  if (!provider?.paused && !error && !query.isError && !notice) return null;
  return (
    <section
      aria-label="Icon generation service"
      className="mb-5 space-y-2 border p-3 text-xs"
    >
      {provider?.paused && (
        <>
          <p>icon generation paused. check service access, then resume.</p>
          <p>
            resuming allows queued icons to generate and may incur charges.
            unknown results still need a separate retry.
          </p>
          {!provider.canResume && (
            <p>configure the image service before resuming.</p>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || query.isFetching || !provider.canResume}
            onClick={() => {
              void resume();
            }}
          >
            {busy ? 'RESUMING' : 'RESUME QUEUED ICONS'}
          </Button>
        </>
      )}
      <p role="status" className="empty:hidden">
        {error ||
          (query.isError ? 'could not load icon service status' : '') ||
          notice}
      </p>
    </section>
  );
}
