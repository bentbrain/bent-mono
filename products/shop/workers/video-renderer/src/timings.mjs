// Numeric-only diagnostics: never copy artwork, request headers, or credentials.
export function numericTimings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, number]) =>
    /^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key) &&
    typeof number === "number" && Number.isFinite(number) && number >= 0,
  ).slice(0, 40));
}

export function requestTimings(request) {
  const header = request.headers.get("x-story-video-timings");
  if (!header || header.length > 4096) return {};
  try { return numericTimings(JSON.parse(header)); } catch { return {}; }
}

export function responseTimings(response) {
  const fields = {
    renderMs: "x-render-time-ms",
    nodeBodyReadMs: "x-request-read-time-ms",
    assetDecodeMs: "x-asset-load-time-ms",
    canvasMs: "x-canvas-time-ms",
    encoderPipeMs: "x-pipe-time-ms",
    encoderDrainMs: "x-encoder-drain-time-ms",
  };
  return numericTimings(Object.fromEntries(Object.entries(fields).flatMap(([key, header]) => {
    const value = response.headers.get(header);
    return value === null ? [] : [[key, Number(value)]];
  })));
}
