import { describe, expect, test } from "bun:test";
import { LaunchRouter } from "../src/logic/launch";
import type { LaunchSources, LaunchTarget } from "../src/logic/launch";

type Link = { tab: "week" | "food"; day: string };

/** A promise the test settles later. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function sources(overrides: Partial<LaunchSources<Link>> = {}) {
  const asked: string[] = [];
  const value: LaunchSources<Link> = {
    reminder: () => {
      asked.push("reminder");
      return null;
    },
    widget: async () => {
      asked.push("widget");
      return null;
    },
    health: async () => {
      asked.push("health");
      return false;
    },
    ...overrides,
  };
  return { value, asked };
}

describe("the launch destination", () => {
  test("is the reminder that opened the app, before the widget or Health", async () => {
    const { value, asked } = sources({
      reminder: () => {
        asked.push("reminder");
        return "2026-11-23";
      },
    });
    expect(await new LaunchRouter<Link>().resolve(value)).toEqual({ kind: "reminder", day: "2026-11-23" });
    expect(asked).toEqual(["reminder"]);
  });

  test("is the widget link that opened the app, without asking Health", async () => {
    const { value, asked } = sources({
      widget: async () => {
        asked.push("widget");
        return { tab: "food", day: "2026-11-24" };
      },
    });
    expect(await new LaunchRouter<Link>().resolve(value)).toEqual({ kind: "widget", link: { tab: "food", day: "2026-11-24" } });
    expect(asked).toEqual(["reminder", "widget"]);
  });

  test("asks Health only after the launch link is known", async () => {
    const link = deferred<Link | null>();
    const asked: string[] = [];
    const { value } = sources({
      widget: () => {
        asked.push("widget");
        return link.promise;
      },
      health: async () => {
        asked.push("health");
        return true;
      },
    });
    const result = new LaunchRouter<Link>().resolve(value);
    await Promise.resolve();
    expect(asked).toEqual(["widget"]);
    link.resolve(null);
    expect(await result).toEqual({ kind: "health" });
    expect(asked).toEqual(["widget", "health"]);
  });

  test("is nothing without a tap or a waiting Health step, or when a lookup fails", async () => {
    expect(await new LaunchRouter<Link>().resolve(sources().value)).toBeNull();
    const failing = sources({
      widget: () => Promise.reject(new Error("Synthetic failure")),
      health: () => Promise.reject(new Error("Synthetic failure")),
    });
    expect(await new LaunchRouter<Link>().resolve(failing.value)).toBeNull();
  });

  test("gives way to a tap while the launch link is still loading", async () => {
    const link = deferred<Link | null>();
    const router = new LaunchRouter<Link>();
    const { value, asked } = sources({ widget: () => link.promise });
    const result = router.resolve(value);
    // A reminder tapped while the app runs opens its own day.
    router.replace();
    link.resolve({ tab: "week", day: "2026-11-23" });
    expect(await result).toBeNull();
    expect(asked).not.toContain("health");
  });

  test("gives way to a tap while Health is still being asked", async () => {
    const health = deferred<boolean>();
    const router = new LaunchRouter<Link>();
    const result = router.resolve(sources({ health: () => health.promise }).value);
    await Promise.resolve();
    router.replace();
    health.resolve(true);
    expect(await result).toBeNull();
  });

  test("opens a destination only if no tap replaced it before it opens", () => {
    const opened: LaunchTarget<Link>[] = [];
    const router = new LaunchRouter<Link>();
    router.openIfCurrent({ kind: "health" }, (target) => opened.push(target));
    router.openIfCurrent(null, (target) => opened.push(target));
    expect(opened).toEqual([{ kind: "health" }]);
    router.replace();
    router.openIfCurrent({ kind: "reminder", day: "2026-11-23" }, (target) => opened.push(target));
    expect(opened).toHaveLength(1);
  });

  test("is a tap that came before navigation was ready, in place of the launch taps", async () => {
    const router = new LaunchRouter<Link>();
    router.replace({ kind: "widget", link: { tab: "food", day: "2026-11-24" } });
    // A later tap before navigation is ready wins.
    router.replace({ kind: "reminder", day: "2026-11-25" });
    const { value, asked } = sources({ reminder: () => "2026-11-23" });
    const target = await router.resolve(value);
    expect(target).toEqual({ kind: "reminder", day: "2026-11-25", early: true });
    expect(asked).toEqual([]);
    const opened: LaunchTarget<Link>[] = [];
    router.openIfCurrent(target, (next) => opened.push(next));
    expect(opened).toEqual([{ kind: "reminder", day: "2026-11-25", early: true }]);
    // It opens once.
    expect(await router.resolve(value)).toBeNull();
  });

  test("is nothing when a tap that opened at once replaced it", async () => {
    const router = new LaunchRouter<Link>();
    router.replace();
    const { value, asked } = sources();
    expect(await router.resolve(value)).toBeNull();
    expect(asked).toEqual([]);
  });
});
