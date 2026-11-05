import { describe, expect, it, vi } from "vitest";
import { scheduleStoryVideoWarmup } from "./story-video-warmup";

describe("story-video early warmup", () => {
  it.each([
    { method: "POST", path: "/v2/background-removal", status: 200, warm: true },
    { method: "PUT", path: `/v2/design-upload-grants?token=${"a".repeat(43)}`, status: 200, warm: true },
    { method: "PUT", path: `/v2/design-upload-grants/${"a".repeat(43)}`, status: 200, warm: false },
    { method: "PUT", path: "/v2/design-upload-grants?token=invalid", status: 200, warm: false },
    { method: "POST", path: "/v2/background-removal", status: 429, warm: false },
    { method: "PUT", path: `/v2/design-upload-grants?token=${"a".repeat(43)}`, status: 503, warm: false },
    { method: "POST", path: "/v2/design-drafts/uuid/upload-grants", status: 201, warm: false },
    { method: "POST", path: "/v2/configured-products", status: 201, warm: false },
  ])("warms=$warm after $method $path status=$status", async ({ method, path, status, warm }) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null)));
    const promises: Promise<unknown>[] = [];
    scheduleStoryVideoWarmup(new Request(`https://api.example.com${path}`, { method }),
      new Response(null, { status }), { STORY_VIDEO_RENDERER: { fetch } },
      { waitUntil: (promise) => { promises.push(promise); } });
    expect(fetch).toHaveBeenCalledTimes(warm ? 1 : 0);
    await Promise.all(promises);
  });

  it("does not delay the image response and contains warmup failures", async () => {
    let reject: (error: Error) => void = () => undefined;
    const pending = new Promise<Response>((_resolve, fail) => { reject = fail; });
    const promises: Promise<unknown>[] = [];
    const response = new Response("processed image");
    scheduleStoryVideoWarmup(new Request("https://api.example.com/v2/background-removal", { method: "POST" }),
      response, { STORY_VIDEO_RENDERER: { fetch: () => pending } },
      { waitUntil: (promise) => { promises.push(promise); } });
    expect(promises).toHaveLength(1);
    expect(await response.text()).toBe("processed image");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      reject(new Error("container unavailable"));
      await expect(Promise.all(promises)).resolves.toEqual([undefined]);
    } finally { warning.mockRestore(); }
  });

  it.each([201, 401, 409, 429, 503])("optional confirmation warmup only admits successful products: %s", async (status) => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null)));
    const promises: Promise<unknown>[] = [];
    scheduleStoryVideoWarmup(new Request("https://api.example.com/v2/configured-products", { method: "POST" }),
      new Response(null, { status }), { STORY_VIDEO_RENDERER: { fetch }, STORY_VIDEO_WARM_ON_CONFIRM: "1" },
      { waitUntil: (promise) => { promises.push(promise); } });
    expect(fetch).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
    await Promise.all(promises);
  });
});
