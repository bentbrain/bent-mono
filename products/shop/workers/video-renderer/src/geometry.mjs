import { PRODUCT_MOCKUP_GEOMETRY } from "./product-mockup-geometry.mjs";

export const STORY_FRAME_WIDTH = 1_080;
export const STORY_FRAME_HEIGHT = 1_920;
export const STORY_DURATION_SECONDS = 8;
export const STORY_FRAME_RATE = 30;
export const STORY_CALL_TO_ACTION = "make your own @";
export const STORY_FONT_FAMILY = "Geist Mono";

const STORY_CURSOR_BLINK_SECONDS = 0.5;

export const DEFAULT_STORY_MOTION = {
  easing: {
    x1: 0,
    x2: 0.216_191_724_829_368,
    y1: 0,
    y2: 0.994_106_626_115_634_6,
  },
  finishedScale: 0.64,
  openingScale: 19_988,
  zoomDurationSeconds: 3,
};

const PRODUCT_SCENE_SIZE = 1_500;

export function storyCursorVisibleAt(timestamp) {
  const elapsed = Math.max(timestamp, 0);
  return Math.floor(elapsed / STORY_CURSOR_BLINK_SECONDS) % 2 === 0;
}

function cubicBezierCoordinate(position, firstControl, secondControl) {
  const remaining = 1 - position;
  return 3 * remaining * remaining * position * firstControl +
    3 * remaining * position * position * secondControl +
    position * position * position;
}

export function cubicBezierProgress(progress, easing) {
  const target = Math.min(Math.max(progress, 0), 1);
  if (target === 0 || target === 1) return target;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const position = (lower + upper) / 2;
    const x = cubicBezierCoordinate(
      position,
      Math.min(Math.max(easing.x1, 0), 1),
      Math.min(Math.max(easing.x2, 0), 1),
    );
    if (x < target) lower = position;
    else upper = position;
  }
  return cubicBezierCoordinate((lower + upper) / 2, easing.y1, easing.y2);
}

export function recursionFocalPoint(settings, recursivePlacement) {
  if (recursivePlacement) {
    const nestedFocus = recursionFocalPoint(recursivePlacement);
    return {
      x: settings.placementX + settings.placementWidth * nestedFocus.x,
      y: settings.placementY + settings.placementWidth * nestedFocus.y,
    };
  }
  const remainingScale = 1 - settings.placementWidth;
  return {
    x: settings.placementX / remainingScale,
    y: settings.placementY / remainingScale,
  };
}

export function storyArtworkBounds(baseProductSlug) {
  const geometry = PRODUCT_MOCKUP_GEOMETRY[baseProductSlug];
  const width = PRODUCT_SCENE_SIZE * geometry.mockup.width;
  return {
    height: width * (geometry.canvas.heightPx / geometry.canvas.widthPx),
    width,
    x: PRODUCT_SCENE_SIZE * geometry.mockup.left,
    y: PRODUCT_SCENE_SIZE * geometry.mockup.top,
  };
}

export function storySceneAt(settings, timestamp, motion = DEFAULT_STORY_MOTION, recursivePlacement) {
  const elapsed = Math.min(Math.max(timestamp, 0), STORY_DURATION_SECONDS);
  const recursionFocus = recursionFocalPoint(settings, recursivePlacement);
  const zoomDuration = Math.min(
    Math.max(motion.zoomDurationSeconds, 0.1),
    STORY_DURATION_SECONDS,
  );
  const progress = Math.min(elapsed / zoomDuration, 1);
  const easedProgress = cubicBezierProgress(progress, motion.easing);
  const openingScale = Math.max(motion.openingScale, 0.01);
  const finishedScale = Math.max(motion.finishedScale, 0.01);
  const cameraScale = progress === 0
    ? openingScale
    : progress === 1
      ? finishedScale
      : Math.exp(
          Math.log(openingScale) +
            (Math.log(finishedScale) - Math.log(openingScale)) * easedProgress,
        );
  return {
    cameraScale,
    focalScreenX: STORY_FRAME_WIDTH / 2,
    focalScreenY: STORY_FRAME_HEIGHT / 2,
    recursionFocusX: recursionFocus.x,
    recursionFocusY: recursionFocus.y,
  };
}
