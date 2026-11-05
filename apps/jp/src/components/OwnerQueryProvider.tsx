import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function OwnerQueryProvider({ children }: { children: ReactNode }) {
  // Each Astro island owns a client. Never share private caches between SSR
  // requests or persist owner records in browser storage.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
