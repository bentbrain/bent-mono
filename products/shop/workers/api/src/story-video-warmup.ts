import type { StoryVideoEnv } from "./story-video-jobs";

// Start only after successful processing, or an explicitly enabled successful
// product confirmation. Rejected requests and unused upload grants cannot warm.
export function scheduleStoryVideoWarmup(
  request: Request,
  response: Response,
  env: Pick<StoryVideoEnv, "STORY_VIDEO_RENDERER" | "STORY_VIDEO_WARM_ON_CONFIRM" | "STORY_VIDEO_PROVIDER">,
  context?: Pick<ExecutionContext, "waitUntil">,
) {
  if (!response.ok || !context || !env.STORY_VIDEO_RENDERER || env.STORY_VIDEO_PROVIDER === "lambda") return;
  const url = new URL(request.url);
  const path = url.pathname;
  const processed = request.method === "POST" && path === "/v2/background-removal";
  const uploaded = request.method === "PUT" &&
    path === "/v2/design-upload-grants" && /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("token") ?? "");
  const confirmed = env.STORY_VIDEO_WARM_ON_CONFIRM === "1" &&
    request.method === "POST" && ["/v2/configured-products", "/v2/configured-product-families"].includes(path);
  if (!processed && !uploaded && !confirmed) return;
  const renderer = env.STORY_VIDEO_RENDERER;
  context.waitUntil((async () => {
    try {
      const result = await renderer.fetch("https://story-video.internal/warm", {
        method: "POST",
        signal: AbortSignal.timeout(25_000),
      });
      await result.arrayBuffer();
      if (!result.ok) console.warn("Story-video warmup unavailable", { status: result.status });
    } catch {
      // Warmup is optional. The queue still starts a cold renderer normally.
      console.warn("Story-video warmup unavailable");
    }
  })());
}
