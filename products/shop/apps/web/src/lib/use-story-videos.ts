"use client";

import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { storyVideoQueryOptions, type StoryVideoReadiness } from "./story-video-query";

function videoEvent(data: unknown) {
  if (typeof data !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(data);
    if (
      typeof value !== "object" || value === null ||
      !("productId" in value) || typeof value.productId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.productId) ||
      !("color" in value) || typeof value.color !== "string" ||
      !["black", "white", "cream"].includes(value.color) ||
      !("status" in value) || (value.status !== "ready" && value.status !== "unavailable")
    ) return undefined;
    return { productId: value.productId, color: value.color, status: value.status };
  } catch { return undefined; }
}

export function useStoryVideos(
  productId: string | undefined,
  colors: readonly string[],
  enabled = true,
) {
  const client = useQueryClient();
  const [streamingProduct, setStreamingProduct] = useState<string>();
  const streaming = Boolean(productId && streamingProduct === productId);
  const queries = useQueries({
    queries: colors.map((color) =>
      storyVideoQueryOptions(productId, color, streaming, enabled)
    ),
  });
  const needsEvents = enabled && queries.some((query) => query.data?.status !== "ready" &&
    !(query.data?.status === "unavailable" && query.data.terminal)) &&
    queries.some((query) => query.isFetched);

  useEffect(() => {
    if (!enabled || !productId || !needsEvents || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/configured-product-video/${encodeURIComponent(productId)}/events`);
    let disposed = false;
    source.onopen = () => { setStreamingProduct(productId); };
    source.onerror = () => { setStreamingProduct(undefined); };
    source.addEventListener("video", (event: MessageEvent<unknown>) => {
      const video = videoEvent(event.data);
      if (!video || disposed) return;
      const options = storyVideoQueryOptions(video.productId, video.color);
      if (video.status === "unavailable") {
        const unavailable: StoryVideoReadiness = { status: "unavailable", terminal: true };
        client.setQueryData(options.queryKey, unavailable);
        return;
      }
      // HEAD supplies the actual R2 ETag. Never cache a guessed URL or the
      // event itself as proof that a downloadable file is still available.
      void client.query({ ...options, staleTime: 0 }).catch(() => undefined);
    });
    source.addEventListener("complete", () => {
      source.close();
      setStreamingProduct(undefined);
    });
    source.addEventListener("unavailable", () => {
      source.close();
      setStreamingProduct(undefined);
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [client, enabled, needsEvents, productId]);
  return queries;
}
