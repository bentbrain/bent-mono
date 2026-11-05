export const STORY_RENDERER_VERSION = "story-video-renderer-v7";

export function requireRendererVersion(headers) {
  if (headers.get("x-story-renderer-version") !== STORY_RENDERER_VERSION) {
    throw new Error("The container renderer version does not match this deployment.");
  }
}
