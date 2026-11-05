import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import type { ModerationPreview } from "./image-processing";
import {
  makeOpenAiSafetyScreeningClient,
  OPENAI_MODERATION_MODEL,
} from "./openai-safety-screening";

const PREVIEW: ModerationPreview = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  contentType: "image/jpeg",
};

describe("OpenAI portrait Safety Screening", () => {
  it("submits only the bounded image preview and accepts an allowed decision", async () => {
    let request: Request | undefined;
    const fetcher: typeof fetch = (input, init) => {
      request = new Request(input, init);
      return Promise.resolve(Response.json({
        id: "modr-test",
        model: "omni-moderation-2024-09-26",
        results: [{
          categories: { violence: false },
          category_scores: { violence: 0.01 },
          flagged: false,
        }],
      }));
    };
    const result = await Effect.runPromise(
      makeOpenAiSafetyScreeningClient(
        { OPENAI_API_KEY: "secret-key" },
        { fetcher },
      ).screen(PREVIEW),
    );

    expect(result).toEqual({
      decision: "allowed",
      model: "omni-moderation-2024-09-26",
    });
    expect(request?.url).toBe("https://api.openai.com/v1/moderations");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-key");
    expect(request?.redirect).toBe("follow");
    const body: unknown = await request?.json();
    expect(body).toEqual({
      input: [{
        image_url: { url: "data:image/jpeg;base64,/9j/2Q==" },
        type: "image_url",
      }],
      model: OPENAI_MODERATION_MODEL,
    });
  });

  it("returns the aggregate flagged decision without retaining category data", async () => {
    const result = await Effect.runPromise(
      makeOpenAiSafetyScreeningClient(
        { OPENAI_API_KEY: "secret-key" },
        { fetcher: () => Promise.resolve(Response.json({
          model: "omni-moderation-2024-09-26",
          results: [{
            categories: { violence: true },
            category_scores: { violence: 0.99 },
            flagged: true,
          }],
        })) },
      ).screen(PREVIEW),
    );

    expect(result).toEqual({
      decision: "flagged",
      model: "omni-moderation-2024-09-26",
    });
  });

  it("fails closed on malformed success responses", async () => {
    const malformedResponses: unknown[] = [
      {},
      { model: "omni-moderation-2024-09-26", results: [] },
      { model: "omni-moderation-2024-09-26", results: [{}] },
      { model: "invalid model value", results: [{ flagged: false }] },
    ];
    for (const payload of malformedResponses) {
      const failure = await Effect.runPromise(
        makeOpenAiSafetyScreeningClient(
          { OPENAI_API_KEY: "secret-key" },
          { fetcher: () => Promise.resolve(Response.json(payload)) },
        ).screen(PREVIEW).pipe(Effect.flip),
      );
      expect(failure).toMatchObject({
        _tag: "SafetyScreeningFailure",
        kind: "malformed-response",
      });
    }
  });

  it("aborts screening at the configured timeout", async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected a timeout signal."));
          return;
        }
        signal.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          reject(reason instanceof Error
            ? reason
            : new Error("The screening request timed out."));
        }, { once: true });
      });
    const failure = await Effect.runPromise(
      makeOpenAiSafetyScreeningClient(
        { OPENAI_API_KEY: "secret-key" },
        { fetcher, timeoutMs: 1 },
      ).screen(PREVIEW).pipe(Effect.flip),
    );

    expect(failure).toMatchObject({
      _tag: "SafetyScreeningFailure",
      kind: "timeout",
    });
  });

  it("does not pass the Worker-incompatible error redirect mode", async () => {
    const fetcher: typeof fetch = (_input, init) => {
      if (init?.redirect === "error") {
        return Promise.reject(new TypeError("Unsupported redirect mode."));
      }
      return Promise.resolve(Response.json({
        model: "omni-moderation-2024-09-26",
        results: [{ flagged: false }],
      }));
    };

    const result = await Effect.runPromise(
      makeOpenAiSafetyScreeningClient(
        { OPENAI_API_KEY: "secret-key" },
        { fetcher },
      ).screen(PREVIEW),
    );

    expect(result.decision).toBe("allowed");
  });
});
