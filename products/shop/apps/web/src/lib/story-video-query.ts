import { queryOptions } from "@tanstack/react-query";

export type StoryVideoReadiness =
  | { status: "ready"; url: string }
  | { status: "pending"; retryAfterMs: number }
  | { status: "unavailable"; terminal?: boolean };

async function readStoryVideo(
  productId: string | undefined,
  color: string,
  signal: AbortSignal,
): Promise<StoryVideoReadiness> {
  if (!productId) return { status: "unavailable" };
  const sourceUrl = `/api/configured-product-video/${encodeURIComponent(productId)}/${encodeURIComponent(color)}.mp4`;
  const response = await fetch(sourceUrl, {
    cache: "no-store",
    method: "HEAD",
    signal,
  });
  if (response.status === 204) return { status: "unavailable", terminal: true };
  if (response.status === 202) {
    const seconds = Number.parseInt(response.headers.get("retry-after") ?? "2", 10);
    return {
      status: "pending",
      retryAfterMs: (Number.isSafeInteger(seconds) ? Math.max(1, seconds) : 2) * 1_000,
    };
  }
  if (response.status >= 500) throw new Error("Story video readiness is unavailable.");
  if (!response.ok) return { status: "unavailable" };
  const etag = response.headers.get("etag");
  if (!etag) return { status: "pending", retryAfterMs: 15_000 };
  return { status: "ready", url: `${sourceUrl}?v=${encodeURIComponent(etag)}&access=revocable-v1` };
}

export function storyVideoQueryOptions(
  productId: string | undefined,
  color: string,
  streaming = false,
  enabled = true,
) {
  const normalizedColor = color.toLowerCase();
  return queryOptions({
    queryKey: ["story-video", productId, normalizedColor],
    queryFn: ({ signal }) => readStoryVideo(productId, normalizedColor, signal),
    enabled: Boolean(productId) && enabled,
    // Reuse readiness across colour switches and client-side navigation. A
    // stale entry stays visible while its ETag is checked in the background.
    staleTime: (query) => query.state.data?.status === "ready" ? 5 * 60_000 : 0,
    gcTime: 15 * 60_000,
    refetchInterval: (query) => {
      if (streaming) return false;
      if (query.state.status === "error") return 15_000;
      if (query.state.data?.status === "unavailable") return query.state.data.terminal ? false : 15_000;
      return query.state.data?.status === "pending"
        ? query.state.data.retryAfterMs
        : false;
    },
    refetchOnWindowFocus: true,
    retry: 2,
    retryDelay: (attempt) => Math.min(15_000, 2 ** (attempt + 1) * 1_000),
  });
}
