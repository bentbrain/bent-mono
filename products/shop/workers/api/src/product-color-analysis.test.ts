import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import type { ModerationPreview } from "./image-processing";
import {
  makeClefProductColorAnalysisClient,
  PRODUCT_COLOR_MODEL,
  startProductColorAnalysis,
} from "./product-color-analysis";

const PREVIEW: ModerationPreview = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  contentType: "image/jpeg",
};

function response(color: "Black" | "White") {
  return {
    model: PRODUCT_COLOR_MODEL,
    answers: {
      color: {
        type: "choice",
        choice: color,
        probabilities: { Black: color === "Black" ? 0.9 : 0.1, White: color === "White" ? 0.9 : 0.1 },
        confidence: 0.9,
      },
    },
  };
}

describe("Clef product colour analysis", () => {
  it.each(["Black", "White"] satisfies ("Black" | "White")[])("uses the AI binding and persists the typed %s selection", async (color) => {
    let requestInputs: Record<string, unknown> | undefined;
    const run = vi.fn((model: string, inputs: Record<string, unknown>) => {
      expect(model).toBe("@cf/cloudflare/clef-flash");
      requestInputs = inputs;
      return Promise.resolve(response(color));
    });
    const client = makeClefProductColorAnalysisClient({ AI: { run } });
    await expect(Effect.runPromise(client.analyze(PREVIEW, "owner-digest")))
      .resolves.toEqual({ color, model: PRODUCT_COLOR_MODEL });
    const inputs = requestInputs;
    const questions = inputs?.["questions"];
    if (!isRecord(questions) || !isRecord(questions["color"]) ||
        typeof questions["color"]["instructions"] !== "string") throw new Error("Expected a colour question.");
    const instructions = questions["color"]["instructions"];
    expect(instructions).toContain("A standalone black shirt, black bag");
    expect(instructions).toContain("primary HUMAN PERSON");
    expect(run).toHaveBeenCalledExactlyOnceWith("@cf/cloudflare/clef-flash", {
      model: "clef-flash",
      state: "Evaluate the attached portrait image.",
      images: ["data:image/jpeg;base64,/9j/2Q=="],
      questions: {
        color: {
          type: "choice",
          instructions,
          criteria: {
            Black: "A visible primary human person is wearing a clearly predominantly dark T-shirt or top.",
            White: "A light top worn by a human; or any image without a visible human wearing a clearly dark top, including standalone garments, bags, symbols and head-only portraits. Also mixed, obscured, ambiguous or uncertain clothing.",
          },
        },
      },
    });
  });

  it("requires the AI binding", () => {
    expect(() => makeClefProductColorAnalysisClient({})).toThrow("Workers AI configuration is missing: AI.");
  });

  it.each([
    null,
    { model: "clef", answers: response("Black").answers },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, type: "score" } } },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, choice: "Cream" } } },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, confidence: NaN } } },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, confidence: 1.1 } } },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, probabilities: { Black: 0.9, White: 0.9 } } } },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, probabilities: { Black: -0.1, White: 1.1 } } } },
    { model: PRODUCT_COLOR_MODEL, answers: { color: { ...response("Black").answers.color, probabilities: { Black: 0.9, White: 0.1, Cream: 0 } } } },
  ])("fails open on malformed output %j", async (payload) => {
    const client = makeClefProductColorAnalysisClient({ AI: { run: () => Promise.resolve(payload) } });
    await expect(startProductColorAnalysis(client, PREVIEW, "owner-digest").result)
      .resolves.toEqual({ ok: false, reason: "malformed" });
  });

  it("fails open without logging provider errors or image data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = makeClefProductColorAnalysisClient({ AI: { run: () => Promise.reject(new Error("private provider payload")) } });
      await expect(startProductColorAnalysis(client, PREVIEW, "owner-digest").result)
        .resolves.toEqual({ ok: false, reason: "unavailable" });
      expect(warn).toHaveBeenCalledExactlyOnceWith("bent.shop product colour analysis failed", { kind: "request" });
    } finally {
      warn.mockRestore();
    }
  });

  it("finishes at the timeout and ignores a late provider result", async () => {
    let complete: ((value: unknown) => void) | undefined;
    const client = makeClefProductColorAnalysisClient({ AI: {
      run: () => new Promise<unknown>(resolve => { complete = resolve; }),
    } }, { timeoutMs: 1 });
    const pending = startProductColorAnalysis(client, PREVIEW, "owner-digest");
    await expect(pending.result).resolves.toEqual({ ok: false, reason: "timeout" });
    if (!complete) throw new Error("Expected an AI request.");
    complete(response("Black"));
    await Promise.resolve();
    expect(pending.completed()).toEqual({ ok: false, reason: "timeout" });
  });

  it("exposes an already-completed result without adding another await", async () => {
    const pending = startProductColorAnalysis({
      analyze: () => Effect.succeed({ color: "White", model: PRODUCT_COLOR_MODEL }),
    }, PREVIEW, "owner-digest");
    expect(pending.completed()).toBeUndefined();
    const result = await pending.result;
    expect(pending.completed()).toEqual(result);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
