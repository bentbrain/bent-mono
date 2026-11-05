// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { getDesign } from "./design-api";
import { getDraftForEditor, preloadCreatedDraft } from "./draft-handoff";

vi.mock("./design-api", () => ({ getDesign: vi.fn(() => Promise.resolve(undefined)) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("reuses only the matching draft read and makes later mounts fetch fresh data", async () => {
  preloadCreatedDraft("created");
  await getDraftForEditor("different");
  await getDraftForEditor("created");
  expect(getDesign).toHaveBeenCalledTimes(2);
  await getDraftForEditor("created");
  expect(getDesign).toHaveBeenCalledTimes(3);
});

it("expires an unclaimed read instead of serving it on a later visit", async () => {
  vi.useFakeTimers();
  preloadCreatedDraft("expired");
  vi.advanceTimersByTime(15_000);
  await getDraftForEditor("expired");
  expect(getDesign).toHaveBeenCalledTimes(2);
});

it("surfaces a failed handoff read and allows a fresh retry", async () => {
  vi.mocked(getDesign).mockRejectedValueOnce(new Error("Draft unavailable"));
  preloadCreatedDraft("failed");
  await expect(getDraftForEditor("failed")).rejects.toThrow("Draft unavailable");
  await getDraftForEditor("failed");
  expect(getDesign).toHaveBeenCalledTimes(2);
});
