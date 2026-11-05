import assert from "node:assert/strict";
import test from "node:test";
import { STORY_RENDERER_VERSION, requireRendererVersion } from "./version.mjs";

test("does not store an old container's output under a new renderer key", () => {
  assert.throws(() => requireRendererVersion(new Headers()), /version/);
  assert.throws(() => requireRendererVersion(new Headers({
    "x-story-renderer-version": "story-video-renderer-v5",
  })), /version/);
  assert.doesNotThrow(() => requireRendererVersion(new Headers({
    "x-story-renderer-version": STORY_RENDERER_VERSION,
  })));
});
