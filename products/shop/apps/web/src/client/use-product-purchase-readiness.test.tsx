// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useProductPurchaseReadiness, useProductsPurchaseReadiness } from "./use-product-purchase-readiness";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("bounds preparation polling, permits explicit retry, and stops once ready", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let ready = false;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({ ready })));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    const preparation = useProductPurchaseReadiness("new-product");
    return <button onClick={preparation.retry}>{preparation.error ? "retry" : preparation.ready ? "ready" : "preparing"}</button>;
  }
  try {
    act(() => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    for (let index = 0; index < 65; index++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetcher).toHaveBeenCalledTimes(60);
    expect(container.textContent).toBe("retry");
    ready = true;
    await act(async () => { container.querySelector("button")?.click(); await vi.advanceTimersByTimeAsync(1); });
    expect(container.textContent).toBe("ready");
    const count = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(count);
  } finally {
    act(() => { root.unmount(); });
    client.clear();
  }
});

const retryArtwork = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/client/effect-design-api", () => ({ retryArtworkPreparation: retryArtwork }));

it("retries a shared failed source once for both cart products and resumes readiness checks", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let failed = true;
  retryArtwork.mockImplementation(() => { failed = false; return Promise.resolve(); });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json(failed
    ? { ready: false, retryArtwork: { designId: "design", artworkJobId: "job" } } : { ready: true })));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    const preparation = useProductsPurchaseReadiness(["shirt", "tote"]);
    return <button onClick={preparation.retry}>{preparation.error ? "retry" : preparation.ready ? "ready" : "preparing"}</button>;
  }
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(container.textContent).toBe("retry");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { container.querySelector("button")?.click(); await vi.advanceTimersByTimeAsync(1); });
    expect(retryArtwork).toHaveBeenCalledTimes(1);
    expect(retryArtwork).toHaveBeenCalledWith("design", "job");
    expect(container.textContent).toBe("ready");
  } finally { act(() => { root.unmount(); }); client.clear(); }
});
