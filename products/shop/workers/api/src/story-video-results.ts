export interface StoryVideoResult {
  readonly key: string;
  readonly size: number;
  readonly timings?: Readonly<Record<string, number>>;
}

function result(value: unknown): StoryVideoResult {
  if (
    typeof value !== "object" || value === null ||
    !("key" in value) || typeof value.key !== "string" ||
    !("size" in value) || typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) || value.size <= 0
  ) throw new Error("Invalid renderer result.");
  const timings: Record<string, number> = {};
  if ("timings" in value && typeof value.timings === "object" && value.timings !== null) {
    for (const [key, number] of Object.entries(value.timings).slice(0, 40)) {
      if (/^[a-zA-Z][a-zA-Z0-9]{0,47}$/.test(key) && typeof number === "number" && Number.isFinite(number) && number >= 0) {
        timings[key] = number;
      }
    }
  }
  return { key: value.key, size: value.size, ...(Object.keys(timings).length ? { timings } : {}) };
}

export async function consumeRenderResults(
  response: Response,
  ready: (item: StoryVideoResult) => Promise<void>,
) {
  if (!response.ok) throw new Error(`Renderer request failed: ${response.status.toString()}.`);
  // Old Workers remain compatible during a rolling deployment or rollback.
  if (!response.headers.get("content-type")?.startsWith("application/x-ndjson")) {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("results" in payload)) {
      throw new Error("Invalid renderer batch.");
    }
    const items: readonly unknown[] | undefined = Array.isArray(payload.results)
      ? payload.results : undefined;
    if (!items) throw new Error("Invalid renderer batch.");
    for (const item of items) await ready(result(item));
    return;
  }
  if (!response.body) throw new Error("Missing renderer stream.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const state = { complete: false };
  let count = 0;
  async function line(text: string) {
    if (!text.trim()) return;
    const event: unknown = JSON.parse(text);
    if (typeof event !== "object" || event === null || !("type" in event)) {
      throw new Error("Invalid renderer event.");
    }
    if (state.complete) throw new Error("Renderer sent events after completion.");
    if (event.type === "ready") {
      await ready(result(event));
      count += 1;
    } else if (event.type === "complete") {
      if (!("count" in event) || event.count !== count) throw new Error("Incomplete renderer batch.");
      state.complete = true;
    } else if (event.type === "error") {
      throw new Error("Renderer could not complete the batch.");
    } else if (event.type !== "started") {
      throw new Error("Unknown renderer event.");
    }
  }
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer += chunk.value;
      if (buffer.length > 65_536) throw new Error("Renderer event exceeds the size limit.");
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        await line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    }
    await line(buffer);
    if (!state.complete) throw new Error("Renderer stream ended before completion.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
