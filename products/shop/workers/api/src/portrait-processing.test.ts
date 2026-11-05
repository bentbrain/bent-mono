import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import type { ImageProcessingBinding } from "./image-processing";
import { processPortraitForStorage } from "./portrait-processing";

afterEach(() => vi.useRealTimers());

describe("portrait processing critical path", () => {
  it("overlaps thumbnail preparation with segmentation after admission", async () => {
    vi.useFakeTimers();
    const stages: string[] = [];
    const images: ImageProcessingBinding = {
      info: () => Promise.resolve({ format: "image/jpeg", width: 3_000, height: 4_000 }),
      input: () => {
        let segmented = false;
        const transformer = {
          transform(options: ImageTransform) {
            if (options.segment) segmented = true;
            return transformer;
          },
          async output() {
            stages.push(segmented ? "segmentation" : "thumbnail");
            await new Promise<void>((resolve) => setTimeout(resolve, segmented ? 4_000 : 1_200));
            return { response: () => new Response(new Uint8Array([1, 2, 3])) };
          },
        };
        return transformer;
      },
    };
    const result = processPortraitForStorage(
      images,
      new Uint8Array([0xff, 0xd8, 0xff]),
      () => { stages.push("admitted"); return Promise.resolve(true); },
      { screen: () => Effect.succeed({ decision: "allowed", model: "test" }) },
    );
    const completed = vi.fn();
    void result.then(completed);

    await vi.advanceTimersByTimeAsync(4_000);

    expect(stages[0]).toBe("admitted");
    expect(completed).toHaveBeenCalledOnce();
    expect(await result).toMatchObject({ ok: true, width: 3_000, height: 4_000 });
  });
});
