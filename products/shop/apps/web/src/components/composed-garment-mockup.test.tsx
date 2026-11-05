// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ComposedGarmentMockup } from "./composed-garment-mockup";
import { renderFlatPreview } from "@/client/product-preview";

vi.mock('@/client/product-preview',()=>({renderFlatPreview:vi.fn(()=>Promise.reject(new Error('Canvas unavailable in this test')))}));
const originalCanvasContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
afterEach(() => {
  document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals();
  if (originalCanvasContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalCanvasContext);
});
function activeMockup(container: HTMLElement) {
  const active = container.querySelector<HTMLElement>('[data-variant-active="true"]');
  if (!active) throw new Error("Expected the selected mockup");
  return active;
}
function mount() {
  const revision = crypto.randomUUID();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const render = (color = "White", imageRevision = revision) => { act(() => { root.render(<ComposedGarmentMockup ariaLabel="Your shirt" baseProductSlug="staple-tee" color={color} designId="design" productId="product" revision={imageRevision} sizes="100vw" preload />); }); };
  render();
  return {container, root, render};
}
it("shows loading immediately, bounds pending readiness, and permits a fresh retry", async () => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, {status:202}))));
  const {container, root} = mount();
  expect(activeMockup(container).textContent).toContain("Preparing preview");
  await act(async () => { activeMockup(container).querySelector("img")?.dispatchEvent(new Event("error")); await vi.advanceTimersByTimeAsync(15_000); });
  expect(activeMockup(container).textContent).toContain("Preview is taking longer than expected");
  expect(activeMockup(container).querySelector("img")?.style.visibility).toBe("hidden");
  act(() => { activeMockup(container).querySelector("button")?.click(); });
  expect(activeMockup(container).textContent).toContain("Preparing preview");
  act(() => { activeMockup(container).querySelector("img")?.dispatchEvent(new Event("load")); });
  expect(activeMockup(container).querySelector("[role=status]")).toBeNull();
  act(() => { root.unmount(); });
  expect(vi.getTimerCount()).toBe(0);
});
it("reports terminal image failures independently for both warmed colours", async () => {
  const send=vi.fn(() => Promise.resolve(new Response(null,{status:410})));
  vi.stubGlobal("fetch",send);
  const {container,root,render}=mount();
  await act(async()=>{activeMockup(container).querySelector("img")?.dispatchEvent(new Event("error")); await vi.advanceTimersByTimeAsync(0);});
  expect(activeMockup(container).textContent).toContain("Preview could not be loaded");
  expect(send).toHaveBeenCalledTimes(2);
  render("Black");
  expect(activeMockup(container).textContent).toContain("Preview could not be loaded");
  expect(activeMockup(container).querySelector("img")?.src).toContain("black.webp");
  act(()=>{root.unmount();});
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds an image request that never fires load or error",async()=>{
  vi.stubGlobal("fetch",vi.fn(()=>Promise.resolve(new Response(null,{status:202}))));
  const {container,root}=mount();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect(activeMockup(container).textContent).toContain("Preview is taking longer than expected");
  act(()=>{root.unmount();});
});

it("automatically displays an image that becomes ready after the slow notice",async()=>{
 let ready=false;
 const send=vi.fn(()=>Promise.resolve(new Response(null,{status:ready?200:202})));
 vi.stubGlobal("fetch",send);
 const {container,root}=mount();
 await act(async()=>{activeMockup(container).querySelector("img")?.dispatchEvent(new Event("error"));await vi.advanceTimersByTimeAsync(15_000);});
 expect(activeMockup(container).textContent).toContain("Preview is taking longer than expected");
 const oldSource=activeMockup(container).querySelector("img")?.src;
 ready=true;
 await act(async()=>{await vi.advanceTimersByTimeAsync(5_000);});
 expect(activeMockup(container).querySelector("img")?.src).not.toBe(oldSource);
 act(()=>{activeMockup(container).querySelector("img")?.dispatchEvent(new Event("load"));});
 expect(activeMockup(container).querySelector("img")?.style.visibility).toBe("visible");
 expect(activeMockup(container).querySelector("[role=status]")).toBeNull();
 act(()=>{root.unmount();});expect(vi.getTimerCount()).toBe(0);
});

it("keeps an already drawn variant visible when switching back during preparation", async () => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ drawImage: vi.fn() })) });
  vi.mocked(renderFlatPreview).mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
  const { container, root, render } = mount();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(activeMockup(container).querySelector("[role=status]")).toBeNull();
    render("Black");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(activeMockup(container).querySelector("[role=status]")).toBeNull();
    render("White");
    expect(activeMockup(container).querySelector("[role=status]")).toBeNull();
  } finally {
    act(() => { root.unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
    vi.restoreAllMocks();
    vi.mocked(renderFlatPreview).mockRejectedValue(new Error("Canvas unavailable in this test"));
  }
});

it("switches warmed browser flatlays without copying their canvases again", async () => {
  const draw = vi.fn();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true, value: vi.fn(() => ({ drawImage: draw })),
  });
  vi.mocked(renderFlatPreview).mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(null, { status: 202 }))));
  const { root, render } = mount();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    const initialCopies = draw.mock.calls.length;
    expect(initialCopies).toBeGreaterThan(0);
    for (const color of ["Black", "White", "Black", "White"]) render(color);
    expect(draw).toHaveBeenCalledTimes(initialCopies);
  } finally {
    act(() => { root.unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
    vi.mocked(renderFlatPreview).mockRejectedValue(new Error("Canvas unavailable in this test"));
  }
});

it("retains a loaded server image across colours and verifies access for a new revision", async () => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({ drawImage: vi.fn() })) });
  const send = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
  vi.stubGlobal("fetch", send);
  const { container, root, render } = mount();
  try {
    const image = activeMockup(container).querySelector("img");
    if (!image) throw new Error("Expected the authoritative product image.");
    Object.defineProperties(image, { naturalWidth: { value: 768 }, naturalHeight: { value: 768 } });
    act(() => { image.dispatchEvent(new Event("load")); });
    render("Black");
    const blackImage = activeMockup(container).querySelector("img");
    if (!blackImage) throw new Error("Expected the black product image");
    Object.defineProperties(blackImage, { naturalWidth: { value: 768 }, naturalHeight: { value: 768 } });
    await act(async () => { blackImage.dispatchEvent(new Event("load")); await vi.advanceTimersByTimeAsync(0); });
    const previousCalls = send.mock.calls.length;
    render("White");
    expect(activeMockup(container).querySelector("[role=status]")).toBeNull();
    expect(activeMockup(container).querySelector("img")).toBe(image);
    expect(send).toHaveBeenCalledTimes(previousCalls);
    render("White", crypto.randomUUID());
    await act(async () => { activeMockup(container).querySelector("img")?.dispatchEvent(new Event("error")); await vi.advanceTimersByTimeAsync(0); });
    expect(send).toHaveBeenCalled();
    expect(activeMockup(container).textContent).toContain("Preview could not be loaded");
    expect(activeMockup(container).querySelector("canvas")).toBeNull();
  } finally {
    act(() => { root.unmount(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_001); });
  }
});
