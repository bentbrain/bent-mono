import { Data, Effect } from "effect";

import type { ModerationPreview } from "./image-processing";
import {
  type IntegrationEnv,
  requireOpenAiConfig,
} from "./integration-config";

const MODERATIONS_ENDPOINT = "https://api.openai.com/v1/moderations";
export const OPENAI_MODERATION_MODEL = "omni-moderation-latest";
const OPENAI_MODERATION_TIMEOUT_MS = 5_000;

export interface SafetyScreeningDecision {
  readonly decision: "allowed" | "flagged";
  readonly model: string;
}

export interface AllowedSafetyScreeningDecision {
  readonly decision: "allowed";
  readonly model: string;
}

export type SafetyScreeningFailureKind =
  | "http"
  | "malformed-response"
  | "request"
  | "timeout";

export class SafetyScreeningFailure extends Data.TaggedError(
  "SafetyScreeningFailure",
)<{
  readonly kind: SafetyScreeningFailureKind;
  readonly status?: number;
}> {}

export interface SafetyScreeningClient {
  readonly screen: (
    preview: ModerationPreview,
  ) => Effect.Effect<SafetyScreeningDecision, SafetyScreeningFailure>;
}

interface OpenAiSafetyScreeningOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

export function makeOpenAiSafetyScreeningClient(
  env: IntegrationEnv,
  options: OpenAiSafetyScreeningOptions = {},
): SafetyScreeningClient {
  const { apiKey } = requireOpenAiConfig(env);
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? OPENAI_MODERATION_TIMEOUT_MS;
  return {
    screen: (preview) => screenPreview(apiKey, preview, fetcher, timeoutMs),
  };
}

function screenPreview(
  apiKey: string,
  preview: ModerationPreview,
  fetcher: typeof fetch,
  timeoutMs: number,
): Effect.Effect<SafetyScreeningDecision, SafetyScreeningFailure> {
  return Effect.try({
    try: () => JSON.stringify({
      input: [{
        image_url: { url: dataUrl(preview) },
        type: "image_url",
      }],
      model: OPENAI_MODERATION_MODEL,
    }),
    catch: () => new SafetyScreeningFailure({ kind: "request" }),
  }).pipe(
    Effect.flatMap((body) =>
      Effect.tryPromise({
        try: (signal) => fetcher(MODERATIONS_ENDPOINT, {
          body,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          method: "POST",
          signal,
        }),
        catch: () => new SafetyScreeningFailure({ kind: "request" }),
      })
    ),
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout: () => new SafetyScreeningFailure({ kind: "timeout" }),
    }),
    Effect.flatMap((response) => {
      if (!response.ok) {
        return Effect.fail(new SafetyScreeningFailure({
          kind: "http",
          status: response.status,
        }));
      }
      return Effect.tryPromise({
        try: () => response.json(),
        catch: () => new SafetyScreeningFailure({
          kind: "malformed-response",
        }),
      }).pipe(Effect.flatMap(parseModerationResponse));
    }),
    Effect.tapError((failure) => Effect.sync(() => {
      console.warn("bent.shop safety screening failed", {
        kind: failure.kind,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
    })),
    Effect.withSpan("portrait.safetyScreen", {
      attributes: { model: OPENAI_MODERATION_MODEL },
    }),
  );
}

function parseModerationResponse(
  payload: unknown,
): Effect.Effect<SafetyScreeningDecision, SafetyScreeningFailure> {
  if (
    typeof payload !== "object" || payload === null ||
    !("model" in payload) || typeof payload.model !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(payload.model) ||
    !("results" in payload) || !Array.isArray(payload.results) ||
    payload.results.length !== 1
  ) return malformedResponse();
  const result: unknown = payload.results[0];
  if (
    typeof result !== "object" || result === null ||
    !("flagged" in result) || typeof result.flagged !== "boolean"
  ) return malformedResponse();
  return Effect.succeed({
    decision: result.flagged ? "flagged" : "allowed",
    model: payload.model,
  });
}

function malformedResponse() {
  return Effect.fail(new SafetyScreeningFailure({
    kind: "malformed-response",
  }));
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
