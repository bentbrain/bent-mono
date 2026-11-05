import { afterEach, expect, it, vi } from "vitest";
import { StoryVideoNotificationHub, notifyStoryVideoReady } from "./story-video-notifications";

afterEach(() => vi.useRealTimers());

async function nextVideo(reader: ReadableStreamDefaultReader<Uint8Array> | undefined) {
  if (!reader) throw new Error("Missing event stream.");
  for (let index = 0; index < 12; index += 1) {
    const part = await reader.read();
    const text = new TextDecoder().decode(part.value);
    if (text.startsWith("event: video")) return text;
    if (part.done) break;
  }
  throw new Error("No video event received.");
}

it("pushes a committed change without waiting for the recovery interval and snapshots reconnects", async () => {
  vi.useFakeTimers();
  let status = "rendering";
  const load = vi.fn(() => Promise.resolve([{ product_id: "p", colour: "black", status, attempt_count: 1 }]));
  const hub = new StoryVideoNotificationHub(load);
  const response = hub.subscribe(new Request("https://test/events"));
  const reader = response.body?.getReader();
  await hub.notify();
  expect(await nextVideo(reader)).toContain('"pending"');
  status = "ready";
  await hub.notify();
  expect(await nextVideo(reader)).toContain('"ready"');
  await reader?.cancel();
  const before = load.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(load.mock.calls).toHaveLength(before);
  const reconnect = hub.subscribe(new Request("https://test/events"));
  const next = reconnect.body?.getReader();
  await hub.notify();
  expect(await nextVideo(next)).toContain('"ready"');
  await next?.cancel();
});

it("recovers missed notifications and closes once all four are terminal", async () => {
  vi.useFakeTimers();
  let status = "rendering";
  const hub = new StoryVideoNotificationHub(() => Promise.resolve(Array.from({ length: 4 }, (_, index) => ({
    product_id: `p${String(index)}`, colour: "black", status, attempt_count: 1,
  }))));
  const response = hub.subscribe(new Request("https://test/events"));
  await hub.notify();
  status = "ready";
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await response.text()).toContain("event: complete");
  expect(vi.getTimerCount()).toBe(0);
});

it("serializes a notification arriving during the initial database snapshot", async () => {
  vi.useFakeTimers();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const hub = new StoryVideoNotificationHub(async () => {
    const first = reads++ === 0;
    if (first) await gate;
    return [{ product_id: "p", colour: "black", status: first ? "rendering" : "ready", attempt_count: 1 }];
  });
  const response = hub.subscribe(new Request("https://test/events"));
  const pending = hub.notify();
  release();
  await pending;
  const reader = response.body?.getReader();
  await reader?.read();
  expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('"pending"');
  await reader?.read();
  expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('"ready"');
  await reader?.cancel();
});

it("notification failures never fail or requeue an already-stored video", async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
  const notified = await notifyStoryVideoReady({ STORY_VIDEO_NOTIFICATION_MODE: "push", STORY_VIDEO_NOTIFICATIONS: {
    getByName: () => ({ fetch }),
  } }, "revision");
  expect(fetch).toHaveBeenCalledOnce();
  expect(notified).toBe(false);
});

it("reports successful invalidation delivery separately from the configured mode", async () => {
  expect(await notifyStoryVideoReady({ STORY_VIDEO_NOTIFICATION_MODE: "push", STORY_VIDEO_NOTIFICATIONS: {
    getByName: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }),
  } }, "revision")).toBe(true);
  expect(await notifyStoryVideoReady({}, "revision")).toBe(false);
});

it("aborted clients and failed snapshots release every timer", async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const hub = new StoryVideoNotificationHub(() => Promise.resolve([]));
  const response = hub.subscribe(new Request("https://test/events", { signal: abort.signal }));
  abort.abort();
  await response.text();
  expect(vi.getTimerCount()).toBe(0);
  const failed = new StoryVideoNotificationHub(() => Promise.reject(new Error("D1 unavailable")));
  const stream = failed.subscribe(new Request("https://test/events"));
  await stream.text();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds subscribers and expires idle connections", async () => {
  vi.useFakeTimers();
  const hub = new StoryVideoNotificationHub(() => Promise.resolve([]));
  const responses = Array.from({ length: 32 }, () => hub.subscribe(new Request("https://test/events")));
  expect(hub.subscribe(new Request("https://test/events")).status).toBe(503);
  await vi.advanceTimersByTimeAsync(55_000);
  for (const response of responses) expect(await response.text()).toContain("notification-mode=push");
  expect(vi.getTimerCount()).toBe(0);
  const reconnect = hub.subscribe(new Request("https://test/events"));
  expect(reconnect.status).toBe(200);
  await reconnect.body?.cancel();
  expect(vi.getTimerCount()).toBe(0);
});
