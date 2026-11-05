import { describe, expect, it, vi } from "vitest";

import { createLatestPersistence } from "./latest-persistence";

describe("latest persistence", () => {
  it.each([false, true])("waits for earlier saves before replacing artwork, including failed saves: %s", async (failSave) => {
    const write = Promise.withResolvers<string>();
    const save = vi.fn(() => write.promise);
    const persistence = createLatestPersistence({ save });
    persistence.submit("old placement");
    const upload = vi.fn();
    const replacement = persistence.settle().then(upload);
    await Promise.resolve();
    expect(upload).not.toHaveBeenCalled();
    if (failSave) write.reject(new Error("Old placement save failed"));
    else write.resolve("saved");
    await replacement;
    expect(upload).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("keeps at most one write in flight and supersedes queued values", async () => {
    let finishFirst: ((value: string) => void) | undefined;
    const save = vi.fn((value: string) => {
      if (value !== "first") return Promise.resolve(`saved:${value}`);
      return new Promise<string>((resolve) => {
        finishFirst = resolve;
      });
    });
    const persisted: string[] = [];
    const persistence = createLatestPersistence({
      onSuccess: ({ value }) => {
        persisted.push(value);
      },
      save,
    });

    persistence.submit("first");
    persistence.submit("second");
    persistence.submit("latest");

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith("first");

    const complete = finishFirst;
    if (!complete) throw new Error("Expected the first write to start.");
    complete("saved:first");
    await persistence.flush("latest");

    expect(save.mock.calls.map(([value]) => value)).toEqual([
      "first",
      "latest",
    ]);
    expect(persisted).toEqual(["first", "latest"]);
  });

  it("reports queue and request timings without including persisted values", async () => {
    const times = [100, 125, 175];
    const onSuccess = vi.fn();
    const persistence = createLatestPersistence({
      now: () => times.shift() ?? 175,
      onSuccess,
      save: (value: string) => Promise.resolve(value.length),
    });

    await persistence.flush("private-settings-value");

    expect(onSuccess).toHaveBeenCalledWith({
      queueMs: 25,
      requestMs: 50,
      result: 22,
      supersededCount: 0,
      value: "private-settings-value",
    });
  });

  it("continues with the latest value when a superseded in-flight write fails", async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const save = vi.fn((value: string) => {
      if (value !== "stale") return Promise.resolve(`saved:${value}`);
      return new Promise<string>((_resolve, reject) => {
        rejectFirst = reject;
      });
    });
    const onFailure = vi.fn();
    const persistence = createLatestPersistence({ onFailure, save });

    persistence.submit("stale");
    persistence.submit("latest");
    const completion = persistence.flush("latest");
    const fail = rejectFirst;
    if (!fail) throw new Error("Expected the stale write to start.");
    fail(new Error("stale write failed"));

    await expect(completion).resolves.toBe("saved:latest");
    expect(save.mock.calls.map(([value]) => value)).toEqual([
      "stale",
      "latest",
    ]);
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
