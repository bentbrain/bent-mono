function laneCount(env) {
  return env.STORY_VIDEO_LANES === "4" ? 4 : 2;
}

export function renderConcurrency(requested, env) {
  if (requested === 1) return 1;
  return requested === 4 ? laneCount(env) : 2;
}

export function laneNumbers(env) {
  return Array.from({ length: laneCount(env) }, (_, lane) => lane);
}
