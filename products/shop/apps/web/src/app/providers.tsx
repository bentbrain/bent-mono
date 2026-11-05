"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { useState } from "react";
import type { ReactNode } from "react";

import { CartProvider } from "@/lib/cart";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            gcTime: 15 * 60 * 1_000,
            refetchOnWindowFocus: false,
            staleTime: 5 * 60 * 1_000,
          },
        },
      }),
  );

  return (
    <NuqsAdapter>
      <QueryClientProvider client={queryClient}>
        <CartProvider>{children}</CartProvider>
      </QueryClientProvider>
    </NuqsAdapter>
  );
}
