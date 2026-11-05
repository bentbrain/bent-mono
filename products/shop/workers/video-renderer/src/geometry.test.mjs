import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_STORY_MOTION,
  STORY_CALL_TO_ACTION,
  STORY_FONT_FAMILY,
  storyArtworkBounds,
  storyCursorVisibleAt,
  storySceneAt,
} from "./geometry.mjs";
import {
  resolveStoryEncoding,
  storyCursorBlinkExpression,
} from "./renderer.mjs";

const settings = {
  cropX: 0.47,
  cropY: 0.62,
  cropZoom: 1.06,
  depth: 5,
  placementWidth: 0.42,
  placementX: 0.3,
  placementY: 0.3,
};

test("uses the approved opening and finished story scales", () => {
  assert.deepEqual(DEFAULT_STORY_MOTION, {
    easing: {
      x1: 0,
      x2: 0.216_191_724_829_368,
      y1: 0,
      y2: 0.994_106_626_115_634_6,
    },
    finishedScale: 0.64,
    openingScale: 19_988,
    zoomDurationSeconds: 3,
  });
  assert.equal(storySceneAt(settings, 0).cameraScale, 19_988);
  assert.equal(storySceneAt(settings, 0.5).cameraScale, 234.87937385496315);
  assert.equal(storySceneAt(settings, 1).cameraScale, 18.629049171931708);
  assert.equal(storySceneAt(settings, 2).cameraScale, 1.3244602747607679);
  assert.equal(storySceneAt(settings, 3).cameraScale, 0.64);
  assert.equal(storySceneAt(settings, 8).cameraScale, 0.64);
});

test("uses the approved copy, font, and lightweight cursor blink", () => {
  assert.equal(STORY_CALL_TO_ACTION, "make your own @");
  assert.equal(STORY_FONT_FAMILY, "Geist Mono");
  assert.equal(storyCursorVisibleAt(0), true);
  assert.equal(storyCursorVisibleAt(0.49), true);
  assert.equal(storyCursorVisibleAt(0.5), false);
  assert.equal(storyCursorVisibleAt(0.99), false);
  assert.equal(storyCursorVisibleAt(1), true);
  assert.equal(
    storyCursorBlinkExpression(3),
    "gte(t\\,3)*lt(mod(t\\,1)\\,0.5)",
  );
});

test("camera follows the repeated portrait's chest through the outer inset placement", () => {
  const outer = { ...settings, placementX: 0.25, placementY: 0.2, placementWidth: 0.5 };
  const recursivePlacement = { placementX: 0.25, placementY: 0.5, placementWidth: 0.5 };
  const scene = storySceneAt(outer, 0, DEFAULT_STORY_MOTION, recursivePlacement);
  assert.equal(scene.recursionFocusX, 0.5);
  assert.equal(scene.recursionFocusY, 0.7);
  assert.equal(scene.cameraScale, DEFAULT_STORY_MOTION.openingScale);
});

test("uses each provider print area's physical aspect ratio", () => {
  const shirt = storyArtworkBounds("staple-tee");
  assert.equal(shirt.width, 654);
  assert.ok(Math.abs(shirt.x - 424.5) < 0.000_001);
  assert.equal(shirt.y, 375);
  assert.ok(Math.abs(shirt.height - 819.567_845_659_163_9) < 0.000_001);

  const tote = storyArtworkBounds("cotton-tote");
  assert.ok(Math.abs(tote.width - 412.5) < 0.000_001);
  assert.ok(Math.abs(tote.x - 555) < 0.000_001);
  assert.equal(tote.y, 780);
  assert.ok(Math.abs(tote.height - 498.346_560_846_560_86) < 0.000_001);
});

test("uses a reversible 720p internal render with 1080p override", () => {
  assert.deepEqual(resolveStoryEncoding(), {
    crf: 21,
    frameHeight: 1_280,
    frameRate: 30,
    frameWidth: 720,
  });
  assert.deepEqual(resolveStoryEncoding({ frameWidth: 1_080 }), {
    crf: 21,
    frameHeight: 1_920,
    frameRate: 30,
    frameWidth: 1_080,
  });
});
