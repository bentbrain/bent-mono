import { describe, expect, test } from "bun:test";
import { LaunchRouter, TapBuffer } from "../src/logic/launch";
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
    expect(await new LaunchRouter<Link>().resolve(value)).toEqual({ kind: "reminder", day: "2026-11-23", version: 0 });
    expect(asked).toEqual(["reminder"]);
  });

  test("is the widget link that opened the app, without asking Health", async () => {
    const { value, asked } = sources({
      widget: async () => {
        asked.push("widget");
        return { tab: "food", day: "2026-11-24" };
      },
    });
    expect(await new LaunchRouter<Link>().resolve(value)).toEqual({
      kind: "widget",
      link: { tab: "food", day: "2026-11-24" },
      version: 0,
    });
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
    expect(await result).toEqual({ kind: "health", version: 0 });
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
    expect(target).toEqual({ kind: "reminder", day: "2026-11-25", early: true, version: 2 });
    expect(asked).toEqual([]);
    const opened: LaunchTarget<Link>[] = [];
    router.openIfCurrent(target, (next) => opened.push(next));
    expect(opened).toEqual([{ kind: "reminder", day: "2026-11-25", early: true, version: 2 }]);
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

describe("taps while the app loads", () => {
  test("wait until navigation listens, keeping the latest", () => {
    const taps = new TapBuffer<Link>();
    taps.push({ tab: "week", day: "2026-12-01" });
    taps.push({ tab: "food", day: "2026-12-02" });
    const seen: Link[] = [];
    const stop = taps.listen((link) => seen.push(link));
    expect(seen).toEqual([{ tab: "food", day: "2026-12-02" }]);
    taps.push({ tab: "week", day: "2026-12-03" });
    expect(seen).toHaveLength(2);
    stop();
    taps.push({ tab: "food", day: "2026-12-04" });
    expect(seen).toHaveLength(2);
    // The next listener gets the tap that came while nobody listened.
    taps.listen((link) => seen.push(link));
    expect(seen.at(-1)).toEqual({ tab: "food", day: "2026-12-04" });
  });

  test("a widget tap during startup opens in place of the reminder that launched the app", async () => {
    const taps = new TapBuffer<Link>();
    // A reminder launched the app; the Food widget was tapped while the account loaded.
    taps.push({ tab: "food", day: "2026-12-01" });
    const router = new LaunchRouter<Link>();
    // Navigation mounts and listens before it is ready, so the tap becomes the launch destination.
    taps.listen((link) => router.replace({ kind: "widget", link }));
    const { value } = sources({ reminder: () => "2026-11-30" });
    const target = await router.resolve(value);
    const opened: LaunchTarget<Link>[] = [];
    router.openIfCurrent(target, (next) => opened.push(next));
    expect(opened).toMatchObject([{ kind: "widget", link: { tab: "food", day: "2026-12-01" }, early: true }]);
  });

  test("a tap after the destination was worked out makes it stale", async () => {
    const router = new LaunchRouter<Link>();
    router.replace({ kind: "widget", link: { tab: "food", day: "2026-12-01" } });
    const target = await router.resolve(sources().value);
    // A newer tap arrives before the earlier one opens; it opens itself.
    router.replace();
    const opened: LaunchTarget<Link>[] = [];
    router.openIfCurrent(target, (next) => opened.push(next));
    expect(opened).toEqual([]);
  });

  test("the latest tap during startup wins, whichever kind it is", async () => {
    type Tap = { kind: "reminder"; day: string } | { kind: "widget"; link: Link };
    const widgetTap: Tap = { kind: "widget", link: { tab: "food", day: "2026-12-01" } };
    const reminderTap: Tap = { kind: "reminder", day: "2026-12-02" };
    const orders: [Tap, Tap][] = [
      [widgetTap, reminderTap],
      [reminderTap, widgetTap],
    ];
    for (const [first, last] of orders) {
      // Both kinds share one buffer, filled from app start.
      const taps = new TapBuffer<Tap>();
      taps.push(first);
      taps.push(last);
      const router = new LaunchRouter<Link>();
      taps.listen((tap) => router.replace(tap));
      // A reminder that launched the app comes before both.
      const target = await router.resolve(sources({ reminder: () => "2026-11-30" }).value);
      const opened: LaunchTarget<Link>[] = [];
      router.openIfCurrent(target, (next) => opened.push(next));
      expect(opened).toMatchObject([{ ...last, early: true }]);
    }
  });
});

