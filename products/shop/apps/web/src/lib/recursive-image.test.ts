// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  renderRecursiveImage,
} from "@/lib/recursive-image";

interface RecordedContext {
  readonly clearRect: ReturnType<typeof vi.fn>;
  readonly drawImage: ReturnType<typeof vi.fn>;
}

const contexts = new WeakMap<HTMLCanvasElement, RecordedContext>();
const recordedContexts: RecordedContext[] = [];

beforeEach(() => {
  recordedContexts.length = 0;
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(this: HTMLCanvasElement) {
      const existing = contexts.get(this);
      if (existing) return existing;
      const created = { clearRect: vi.fn(), drawImage: vi.fn() };
      contexts.set(this, created);
      recordedContexts.push(created);
      return created;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renderRecursiveImage", () => {
  it("draws only the outer photo when recursion is off", () => {
    const destination = document.createElement("canvas");
    const source = document.createElement("canvas");
    renderRecursiveImage(destination, source, { ...DEFAULT_SETTINGS, depth: 0 });
    expect(recordedContexts).toHaveLength(2);
    expect(recordedContexts[0]?.drawImage).toHaveBeenCalledOnce();
    expect(recordedContexts[0]?.drawImage.mock.calls[0]?.[0]).toBe(source);
    expect(recordedContexts[1]?.drawImage).toHaveBeenCalledOnce();
  });
  it("allocates two scratch canvases per destination and reuses them", () => {
    const destination = document.createElement("canvas");
    destination.width = 750;
    destination.height = 900;
    const source = document.createElement("canvas");
    source.width = 80;
    source.height = 100;
    const createElement = vi.spyOn(document, "createElement");

    renderRecursiveImage(destination, source, DEFAULT_SETTINGS);
    renderRecursiveImage(destination, source, { ...DEFAULT_SETTINGS, depth: 8 });

    const canvasAllocations = createElement.mock.calls.filter(
      ([tagName]) => tagName === "canvas",
    );
    expect(canvasAllocations).toHaveLength(2);
  });

  it("preserves recursive draw order while alternating the scratch canvases", () => {
    const destination = document.createElement("canvas");
    destination.width = 100;
    destination.height = 120;
    const source = document.createElement("canvas");
    source.width = 80;
    source.height = 100;
    renderRecursiveImage(destination, source, { ...DEFAULT_SETTINGS, depth: 2 });

    const destinationContext = contexts.get(destination);
    expect(destinationContext?.clearRect).toHaveBeenCalledWith(0, 0, 100, 120);
    expect(destinationContext?.drawImage).toHaveBeenCalledOnce();

    const finalContext = recordedContexts[0];
    expect(finalContext?.drawImage).toHaveBeenCalledTimes(3);
    expect(finalContext?.clearRect).toHaveBeenCalledTimes(2);
  });
});
