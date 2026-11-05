// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStoryVideos } from "./use-story-videos";

const PRODUCT = "47cba7a2-498e-44cc-9769-b37641e6a63a";
const colors = ["Black", "White"];
class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { super(); TestEventSource.instances.push(this); }
}
function Status() {
  const videos = useStoryVideos(PRODUCT, colors);
  return <div>{videos.map((video) => video.data?.status ?? "loading").join(",")}</div>;
}
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  TestEventSource.instances = [];
  notifyManager.setScheduler(queueMicrotask);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", TestEventSource);
});
afterEach(() => {
  client.clear();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  vi.unstubAllGlobals();
});

it("refreshes each ready video from events and preserves cached readiness across navigation", async () => {
  const ready = new Set<string>();
  const fetchVideo = vi.fn((input: string) => Promise.resolve(
    ready.has(input) ? new Response(null, { headers: { etag: '"stored"' } })
      : new Response(null, { status: 202 }),
  ));
  vi.stubGlobal("fetch", fetchVideo);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={client}><Status /></QueryClientProvider>); await Promise.resolve(); });
  expect(container.textContent).toBe("pending,pending");
  expect(TestEventSource.instances).toHaveLength(1);
  const source = TestEventSource.instances[0];
  if (!source) throw new Error("Missing event source");
  await act(async () => { source.onopen?.(); await Promise.resolve(); });
  expect(source.url).toContain(`${PRODUCT}/events`);
  for (const color of ["black", "white"]) {
    ready.add(`/api/configured-product-video/${PRODUCT}/${color}.mp4`);
    await act(async () => {
      source.dispatchEvent(new MessageEvent("video", {
        data: JSON.stringify({ productId: PRODUCT, color, status: "ready" }),
      }));
      await Promise.resolve();
    });
    expect(client.getQueryData(["story-video", PRODUCT, color])).toEqual({
      status: "ready", url: `/api/configured-product-video/${PRODUCT}/${color}.mp4?v=%22stored%22&access=revocable-v1`,
    });
  }
  expect(container.textContent).toBe("ready,ready");
  expect(source.close).toHaveBeenCalled();
  await act(async () => { root.unmount(); await Promise.resolve(); });
  const nextRoot = createRoot(container);
  await act(async () => { nextRoot.render(<QueryClientProvider client={client}><Status /></QueryClientProvider>); await Promise.resolve(); });
  expect(TestEventSource.instances).toHaveLength(1);
  expect(fetchVideo).toHaveBeenCalledTimes(4);
  await act(async () => { nextRoot.unmount(); await Promise.resolve(); });
});

it("reconnects safely, ignores invalid messages, and closes on navigation", async () => {
  const fetchVideo = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
  vi.stubGlobal("fetch", fetchVideo);
  const root = createRoot(document.createElement("div"));
  await act(async () => { root.render(<QueryClientProvider client={client}><Status /></QueryClientProvider>); await Promise.resolve(); });
  const source = TestEventSource.instances[0];
  if (!source) throw new Error("Missing event source");
  await act(async () => {
    source.onopen?.();
    source.onerror?.();
    source.onopen?.();
    source.dispatchEvent(new MessageEvent("video", { data: "not json" }));
    source.dispatchEvent(new MessageEvent("video", { data: '{"productId":"../admin","color":"white","status":"ready"}' }));
    await Promise.resolve();
  });
  expect(fetchVideo).toHaveBeenCalledTimes(2);
  expect(TestEventSource.instances).toHaveLength(1);
  await act(async () => { root.unmount(); await Promise.resolve(); });
  expect(source.close).toHaveBeenCalledOnce();
});

it("stops retrying variants when the server reports exhausted render attempts", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Status /></QueryClientProvider>);
    await Promise.resolve();
  });
  const source = TestEventSource.instances[0];
  if (!source) throw new Error("Missing event source");
  await act(async () => {
    source.onopen?.();
    for (const color of ["black", "white"]) {
      source.dispatchEvent(new MessageEvent("video", {
        data: JSON.stringify({ productId: PRODUCT, color, status: "unavailable" }),
      }));
    }
    await Promise.resolve();
  });
  expect(source.close).toHaveBeenCalledOnce();
  expect(client.getQueryData(["story-video", PRODUCT, "white"])).toEqual({ status: "unavailable", terminal: true });
  await act(async () => { root.unmount(); await Promise.resolve(); });
});

it("does not poll or subscribe when a non-recursive product has no video", async () => {
  const fetchVideo = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal("fetch", fetchVideo);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={client}><Status /></QueryClientProvider>); await Promise.resolve(); });
  expect(container.textContent).toBe("unavailable,unavailable");
  expect(TestEventSource.instances).toHaveLength(0);
  for (const color of ["black", "white"]) expect(client.getQueryData(["story-video", PRODUCT, color]))
    .toEqual({ status: "unavailable", terminal: true });
  act(() => { root.unmount(); });
});
