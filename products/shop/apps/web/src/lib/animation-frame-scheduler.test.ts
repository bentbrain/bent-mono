import { describe, expect, it, vi } from "vitest";

import { createAnimationFrameScheduler } from "@/lib/animation-frame-scheduler";

describe("createAnimationFrameScheduler", () => {
  it("coalesces changes into one frame and commits the latest value", () => {
    let frameCallback: (() => void) | undefined;
    const commit = vi.fn();
    const scheduler = createAnimationFrameScheduler({
      cancelFrame: vi.fn(),
      commit,
      requestFrame(callback) {
        frameCallback = callback;
        return 7;
      },
    });

    const latest = { value: "latest" };
    scheduler.schedule({ value: "first" });
    scheduler.schedule(latest);

    expect(commit).not.toHaveBeenCalled();
    expect(frameCallback).toBeTypeOf("function");
    frameCallback?.();
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(latest);
  });

  it("flushes the final value and cancels discarded work", () => {
    const cancelFrame = vi.fn();
    const commit = vi.fn();
    const scheduler = createAnimationFrameScheduler({
      cancelFrame,
      commit,
      requestFrame: () => 11,
    });

    const first = { value: 1 };
    scheduler.schedule(first);
    scheduler.flush();
    expect(cancelFrame).toHaveBeenCalledWith(11);
    expect(commit).toHaveBeenCalledWith(first);

    scheduler.schedule({ value: 2 });
    scheduler.cancel();
    scheduler.flush();
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
