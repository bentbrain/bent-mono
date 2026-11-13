import "@tanstack/react-start/server-only";

import {
  MAX_DESIGN_SOURCE_BYTES,
  MAX_INLINE_ARTWORK_PREVIEW_BYTES,
} from "@forever-tee/contracts/limits";

import { acceptsSameOriginMutation } from "@/server/design-draft-bff-core";

const MAX_CREATION_TRACE_BYTES = 2_048;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const TRACE_STAGES = new Set([
  "draft_handoff_started",
  "artwork_upload_started",
  "artwork_upload_succeeded",
  "artwork_upload_failed",
  "artwork_preview_loaded",
  "cutout_reveal_started",
  "cutout_reveal_completed",
]);

interface CreationTrace {
  readonly attemptId: string;
  readonly code: string | undefined;
  readonly designId: string;
  readonly durationMs: number | undefined;
  readonly grantDurationMs: number | undefined;
  readonly uploadResponseDurationMs: number | undefined;
  readonly responseDownloadDurationMs: number | undefined;
  readonly uploadBodyDurationMs: number | undefined;
  readonly portraitDurationMs: number | undefined;
  readonly previewBytes: number | undefined;
  readonly networkSetupDurationMs: number | undefined;
  readonly networkRequestDurationMs: number | undefined;
  readonly workerDurationMs: number | undefined;
  readonly screeningDurationMs: number | undefined;
  readonly previewDurationMs: number | undefined;
  readonly uploadBytes: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly stage: string;
  readonly status: number | undefined;
}

export async function recordCreationTrace(request: Request) {
  if (!acceptsSameOriginMutation(request)) {
    return Response.json(
      { error: "A same-origin request is required." },
      {
        status: 403,
      },
    );
  }
  if (request.headers.get("content-type") !== "application/json") {
    return Response.json({ error: "JSON is required." }, { status: 415 });
  }
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_CREATION_TRACE_BYTES)
  ) {
    return Response.json(
      { error: "The trace event is invalid." },
      {
        status: 400,
      },
    );
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_CREATION_TRACE_BYTES) {
    return Response.json(
      { error: "The trace event is invalid." },
      {
        status: 400,
      },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json(
      { error: "The trace event is invalid." },
      {
        status: 400,
      },
    );
  }
  const event = parseCreationTrace(payload);
  if (!event) {
    return Response.json(
      { error: "The trace event is invalid." },
      {
        status: 400,
      },
    );
  }

  if (event.stage === "artwork_upload_failed") {
    console.error("[bent.shop creation] journey stage", event);
  } else {
    console.info("[bent.shop creation] journey stage", event);
  }
  return new Response(null, { status: 204 });
}

function parseCreationTrace(value: unknown): CreationTrace | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        ![
          "attemptId",
          "code",
          "designId",
          "durationMs",
          "grantDurationMs",
          "uploadResponseDurationMs",
          "responseDownloadDurationMs",
          "uploadBodyDurationMs",
          "portraitDurationMs",
          "previewBytes",
          "networkSetupDurationMs",
          "networkRequestDurationMs",
          "workerDurationMs",
          "screeningDurationMs",
          "previewDurationMs",
          "uploadBytes",
          "requestId",
          "retryAfterSeconds",
          "stage",
          "status",
        ].includes(key),
    )
  )
    return undefined;
  if (!("attemptId" in value) || !isUuid(value.attemptId)) return undefined;
  if (!("designId" in value) || !isUuid(value.designId)) return undefined;
  if (
    !("stage" in value) ||
    typeof value.stage !== "string" ||
    !TRACE_STAGES.has(value.stage)
  )
    return undefined;
  const code = "code" in value ? value.code : undefined;
  if (code !== undefined && (typeof code !== "string" || !SAFE_CODE.test(code)))
    return undefined;
  const requestId = "requestId" in value ? value.requestId : undefined;
  if (
    requestId !== undefined &&
    (typeof requestId !== "string" || !SAFE_REQUEST_ID.test(requestId))
  ) {
    return undefined;
  }
  const durationMs = "durationMs" in value ? value.durationMs : undefined;
  if (durationMs !== undefined && !isBoundedInteger(durationMs, 600_000)) {
    return undefined;
  }
  const status = "status" in value ? value.status : undefined;
  const grantDurationMs =
    "grantDurationMs" in value ? value.grantDurationMs : undefined;
  const uploadResponseDurationMs =
    "uploadResponseDurationMs" in value
      ? value.uploadResponseDurationMs
      : undefined;
  const responseDownloadDurationMs =
    "responseDownloadDurationMs" in value
      ? value.responseDownloadDurationMs
      : undefined;
  const uploadBodyDurationMs =
    "uploadBodyDurationMs" in value ? value.uploadBodyDurationMs : undefined;
  const portraitDurationMs =
    "portraitDurationMs" in value ? value.portraitDurationMs : undefined;
  const previewBytes = "previewBytes" in value ? value.previewBytes : undefined;
  const networkSetupDurationMs =
    "networkSetupDurationMs" in value
      ? value.networkSetupDurationMs
      : undefined;
  const networkRequestDurationMs =
    "networkRequestDurationMs" in value
      ? value.networkRequestDurationMs
      : undefined;
  if (
    networkSetupDurationMs !== undefined &&
    !isBoundedInteger(networkSetupDurationMs, 600_000)
  )
    return undefined;
  if (
    networkRequestDurationMs !== undefined &&
    !isBoundedInteger(networkRequestDurationMs, 600_000)
  )
    return undefined;
  if (
    grantDurationMs !== undefined &&
    !isBoundedInteger(grantDurationMs, 600_000)
  )
    return undefined;
  if (
    uploadResponseDurationMs !== undefined &&
    !isBoundedInteger(uploadResponseDurationMs, 600_000)
  )
    return undefined;
  if (
    responseDownloadDurationMs !== undefined &&
    !isBoundedInteger(responseDownloadDurationMs, 600_000)
  )
    return undefined;
  if (
    uploadBodyDurationMs !== undefined &&
    !isBoundedInteger(uploadBodyDurationMs, 600_000)
  )
    return undefined;
  if (
    portraitDurationMs !== undefined &&
    !isBoundedInteger(portraitDurationMs, 600_000)
  )
    return undefined;
  if (
    previewBytes !== undefined &&
    !isBoundedInteger(previewBytes, MAX_INLINE_ARTWORK_PREVIEW_BYTES)
  )
    return undefined;
  const workerDurationMs =
    "workerDurationMs" in value ? value.workerDurationMs : undefined;
  const screeningDurationMs =
    "screeningDurationMs" in value ? value.screeningDurationMs : undefined;
  const previewDurationMs =
    "previewDurationMs" in value ? value.previewDurationMs : undefined;
  const uploadBytes = "uploadBytes" in value ? value.uploadBytes : undefined;
  if (
    workerDurationMs !== undefined &&
    !isBoundedInteger(workerDurationMs, 600_000)
  )
    return undefined;
  if (
    screeningDurationMs !== undefined &&
    !isBoundedInteger(screeningDurationMs, 600_000)
  )
    return undefined;
  if (
    previewDurationMs !== undefined &&
    !isBoundedInteger(previewDurationMs, 600_000)
  )
    return undefined;
  if (
    uploadBytes !== undefined &&
    !isBoundedInteger(uploadBytes, MAX_DESIGN_SOURCE_BYTES)
  )
    return undefined;
  if (status !== undefined && !isBoundedInteger(status, 599)) return undefined;
  const retryAfterSeconds =
    "retryAfterSeconds" in value ? value.retryAfterSeconds : undefined;
  if (
    retryAfterSeconds !== undefined &&
    !isBoundedInteger(retryAfterSeconds, 86_400)
  )
    return undefined;
  return {
    attemptId: value.attemptId,
    code,
    designId: value.designId,
    durationMs,
    grantDurationMs,
    uploadResponseDurationMs,
    responseDownloadDurationMs,
    uploadBodyDurationMs,
    portraitDurationMs,
    previewBytes,
    networkSetupDurationMs,
    networkRequestDurationMs,
    workerDurationMs,
    screeningDurationMs,
    previewDurationMs,
    uploadBytes,
    requestId,
    retryAfterSeconds,
    stage: value.stage,
    status,
  };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}
