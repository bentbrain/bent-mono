import { describe, expect, it } from "vitest";
import { consumeRenderResults } from "./story-video-results";

function stream(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "application/x-ndjson" } });
}

describe("renderer stream protocol", () => {
  it("keeps only bounded numeric stage diagnostics", async () => {
    const received: unknown[] = [];
    await consumeRenderResults(stream([
      '{"type":"ready","key":"one","size":123,"timings":{"renderMs":42,"secret":"no","bad-key":2,"negative":-1}}\n',
      '{"type":"complete","count":1}\n',
    ]), (item) => { received.push(item); return Promise.resolve(); });
    expect(received).toEqual([{ key: "one", size: 123, timings: { renderMs: 42 } }]);
  });
  it("handles split and combined lines", async () => {
    const received: string[] = [];
    await consumeRenderResults(stream([
      '{"type":"started"}\n{"type":"rea',
      'dy","key":"one","size":123}\n{"type":"ready","key":"two","size":456}\n',
      '{"type":"complete","count":2}',
    ]), (item) => { received.push(item.key); return Promise.resolve(); });
    expect(received).toEqual(["one", "two"]);
  });
  it.each([
    '{"type":"ready","key":"one","size":123}\n',
    '{"type":"ready","key":"one","size":0}\n',
    '{"type":"complete","count":1}\n',
    '{"type":"complete","count":0}\n{"type":"ready","key":"one","size":123}\n',
    "x".repeat(65_537),
  ])("rejects malformed, truncated, or inconsistent streams", async (chunk) => {
    await expect(consumeRenderResults(stream([chunk]), () => Promise.resolve())).rejects.toThrow();
  });
});
