"use client";

import { retryArtworkPreparation } from "@/client/effect-design-api";
import { useQueries, useQueryClient, type Query } from "@tanstack/react-query";

interface PurchaseReadiness {
  ready: boolean;
  retryArtwork: { designId: string; artworkJobId: string } | undefined;
}

export function useProductsPurchaseReadiness(productIds: readonly string[]) {
  const client = useQueryClient();
  const ids = [...new Set(productIds)];
  const queries = useQueries({ queries: ids.map(productId => ({
    queryKey: ["product-purchase-readiness", productId],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await fetch(`/api/product-purchase-readiness/${encodeURIComponent(productId)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      });
      if (!response.ok) throw new Error("Product preparation could not be checked.");
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("ready" in payload) || typeof payload.ready !== "boolean") {
        throw new Error("Product preparation could not be checked.");
      }
      const retry = "retryArtwork" in payload ? payload.retryArtwork : undefined;
      const retryArtwork = typeof retry === "object" && retry !== null && "designId" in retry && "artworkJobId" in retry &&
        typeof retry.designId === "string" && typeof retry.artworkJobId === "string"
        ? { designId: retry.designId, artworkJobId: retry.artworkJobId } : undefined;
      return { ready: payload.ready, retryArtwork };
    },
    retry: 1,
    staleTime: Infinity,
    // Bound foreground polling; failures retain the cart and offer explicit retry.
    refetchInterval: (query: Query<PurchaseReadiness>) =>
      !query.state.data?.ready && !query.state.data?.retryArtwork && query.state.status !== "error" && query.state.dataUpdateCount < 60 ? 2_000 : false,
  })) });
  const ready = queries.every(query => query.data?.ready === true);
  const error = queries.some((query, index) => query.isError || Boolean(query.data?.retryArtwork) ||
    (!query.isFetching && query.data?.ready !== true && (client.getQueryState(["product-purchase-readiness", ids[index]])?.dataUpdateCount ?? 0) >= 60));
  return {
    ready,
    pending: !ready && !error,
    error,
    retry: () => {
      const jobs = new Map<string, { designId: string; artworkJobId: string }>();
      for (const query of queries) {
        const job = query.data?.retryArtwork;
        if (job) jobs.set(job.artworkJobId, job);
      }
      void Promise.allSettled([...jobs.values()].map(job => retryArtworkPreparation(job.designId, job.artworkJobId)))
        .then(() => Promise.all(ids.map(id => client.resetQueries({ queryKey: ["product-purchase-readiness", id], exact: true }))));
    },
  };
}

export function useProductPurchaseReadiness(productId: string) {
  return useProductsPurchaseReadiness([productId]);
}
