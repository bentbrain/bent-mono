import { Data, Effect } from "effect";

import type { ProductDefaultColor } from "@forever-tee/contracts";

import type { ModerationPreview } from "./image-processing";
import { IntegrationConfigError } from "./integration-config";

export const PRODUCT_COLOR_MODEL = "clef-flash";
const PRODUCT_COLOR_TIMEOUT_MS = 5_000;

export interface ProductColorAnalysisEnv {
  readonly AI?: {
    readonly run: (
      model: "@cf/cloudflare/clef-flash",
      inputs: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

export interface ProductColorAnalysisDecision {
  readonly color: ProductDefaultColor;
  readonly model: string;
}

export type ProductColorAnalysisFailureKind =
  | "malformed-response"
  | "request"
  | "timeout";

export class ProductColorAnalysisFailure extends Data.TaggedError(
  "ProductColorAnalysisFailure",
)<{
  readonly kind: ProductColorAnalysisFailureKind;
}> {}

export type ProductColorAnalysisResult =
  | {
    readonly ok: true;
    readonly analysis: ProductColorAnalysisDecision;
  }
  | {
    readonly ok: false;
    readonly reason: "malformed" | "timeout" | "unavailable";
  };

export interface ProductColorAnalysisClient {
  readonly analyze: (
    preview: ModerationPreview,
    safetyIdentifier: string,
  ) => Effect.Effect<
    ProductColorAnalysisDecision,
    ProductColorAnalysisFailure
  >;
}

export interface PendingProductColorAnalysis {
  readonly completed: () => ProductColorAnalysisResult | undefined;
  readonly result: Promise<ProductColorAnalysisResult>;
}

interface ProductColorAnalysisOptions {
  readonly timeoutMs?: number;
}

export function makeClefProductColorAnalysisClient(
  env: ProductColorAnalysisEnv,
  options: ProductColorAnalysisOptions = {},
): ProductColorAnalysisClient {
  const ai = env.AI;
  if (!ai) throw new IntegrationConfigError("Workers AI", ["AI"]);
  const timeoutMs = options.timeoutMs ?? PRODUCT_COLOR_TIMEOUT_MS;
  return {
    analyze: (preview) => analyzePreview(ai, preview, timeoutMs),
  };
}

export function startProductColorAnalysis(
  client: ProductColorAnalysisClient,
  preview: ModerationPreview,
  safetyIdentifier: string,
): PendingProductColorAnalysis {
  let completed: ProductColorAnalysisResult | undefined;
  const result = Effect.runPromise(
    client.analyze(preview, safetyIdentifier).pipe(
      Effect.match({
        onFailure: analysisFailureResult,
        onSuccess: (analysis): ProductColorAnalysisResult => ({
          ok: true,
          analysis,
        }),
      }),
    ),
  ).catch((): ProductColorAnalysisResult => ({
    ok: false,
    reason: "unavailable",
  })).then((analysis) => {
    completed = analysis;
    return analysis;
  });
  return { completed: () => completed, result };
}

function analyzePreview(
  ai: NonNullable<ProductColorAnalysisEnv["AI"]>,
  preview: ModerationPreview,
  timeoutMs: number,
): Effect.Effect<
  ProductColorAnalysisDecision,
  ProductColorAnalysisFailure
> {
  return Effect.tryPromise({
    try: () => ai.run("@cf/cloudflare/clef-flash", {
      model: PRODUCT_COLOR_MODEL,
      state: "Evaluate the attached portrait image.",
      images: [dataUrl(preview)],
      questions: {
        color: {
          type: "choice",
          instructions: [
            "Choose the default blank product colour from the T-shirt or top visibly WORN by the primary HUMAN PERSON in the attached image.",
            "First check that a human person is visible and actually wearing a visible top.",
            "Choose Black only when that worn top is clearly predominantly dark.",
            "Choose White for light tops, or if no human person is visible, no worn top is visible, or clothing is mixed, obscured, ambiguous or uncertain.",
            "A standalone black shirt, black bag, dark hat, dark trousers, dark background or logo without a human wearing a visible dark top must be White.",
          ].join(" "),
          criteria: {
            Black: "A visible primary human person is wearing a clearly predominantly dark T-shirt or top.",
            White: "A light top worn by a human; or any image without a visible human wearing a clearly dark top, including standalone garments, bags, symbols and head-only portraits. Also mixed, obscured, ambiguous or uncertain clothing.",
          },
        },
      },
    }),
    catch: () => new ProductColorAnalysisFailure({ kind: "request" }),
  }).pipe(
    Effect.flatMap(parseAnalysisResponse),
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => new ProductColorAnalysisFailure({ kind: "timeout" }),
    }),
    Effect.tapError((failure) => Effect.sync(() => {
      console.warn("bent.shop product colour analysis failed", {
        kind: failure.kind,
      });
    })),
    Effect.withSpan("portrait.productColorAnalysis", {
      attributes: { model: PRODUCT_COLOR_MODEL },
    }),
  );
}

function parseAnalysisResponse(
  payload: unknown,
): Effect.Effect<
  ProductColorAnalysisDecision,
  ProductColorAnalysisFailure
> {
  if (!isRecord(payload) || payload["model"] !== PRODUCT_COLOR_MODEL ||
      !isRecord(payload["answers"])) return malformedResponse();
  const answer = payload["answers"]["color"];
  if (!isRecord(answer) || answer["type"] !== "choice" ||
      (answer["choice"] !== "Black" && answer["choice"] !== "White") ||
      !isRecord(answer["probabilities"]) ||
      Object.keys(answer["probabilities"]).sort().join(",") !== "Black,White" ||
      !isProbability(answer["probabilities"]["Black"]) ||
      !isProbability(answer["probabilities"]["White"]) ||
      Math.abs(answer["probabilities"]["Black"] + answer["probabilities"]["White"] - 1) > 0.001 ||
      !isProbability(answer["confidence"])) return malformedResponse();
  return Effect.succeed({ color: answer["choice"], model: PRODUCT_COLOR_MODEL });
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function analysisFailureResult(
  failure: ProductColorAnalysisFailure,
): ProductColorAnalysisResult {
  return {
    ok: false,
    reason: failure.kind === "timeout"
      ? "timeout"
      : failure.kind === "malformed-response"
        ? "malformed"
        : "unavailable",
  };
}

function malformedResponse() {
  return Effect.fail(new ProductColorAnalysisFailure({
    kind: "malformed-response",
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataUrl(preview: ModerationPreview) {
  let binary = "";
  const chunkSize = 8_192;
  for (
    let offset = 0;
    offset < preview.bytes.byteLength;
    offset += chunkSize
  ) {
    binary += String.fromCharCode(
      ...preview.bytes.subarray(offset, offset + chunkSize),
    );
  }
  return `data:${preview.contentType};base64,${btoa(binary)}`;
}
