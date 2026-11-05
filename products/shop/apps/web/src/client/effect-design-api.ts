import { captureClientException, captureStorefrontFailure, type ClientFailureContext } from "@/client/posthog";
import {
  AnonymousDesignDraftSchema,
  SavedDesignPageSchema,
  DeleteDesignResponseSchema,
  CreateAnonymousDesignDraftResponseSchema,
  UploadDesignArtworkResponseSchema,
  UploadGrantResponseSchema,
  VersionedDesignMutationResponseSchema,
  type BackgroundRemovalQuality,
  type EditorSettingsDto,
} from "@forever-tee/contracts/design";
import { MAX_DESIGN_SOURCE_BYTES, MAX_INLINE_ARTWORK_PREVIEW_BYTES } from "@forever-tee/contracts/limits";
import { Schema } from "effect";

const versions = new Map<string, number>();

class DesignApiError extends Error {
  readonly attemptCount: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable = false;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    metadata: {
      attemptCount?: number | undefined;
      code?: string | undefined;
      requestId?: string | undefined;
      retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(message);
    this.name = "DesignApiError";
    this.attemptCount = metadata.attemptCount ?? 1;
    this.code = metadata.code;
    this.requestId = metadata.requestId;
    this.retryAfterSeconds = metadata.retryAfterSeconds;
    this.status = status;
  }
}

export function designApiErrorMetadata(error: unknown) {
  if (!(error instanceof DesignApiError)) return undefined;
  return {
    attemptCount: error.attemptCount,
    code: error.code,
    requestId: error.requestId,
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
    status: error.status,
  };
}

export async function createDesign(challengeToken: string, signal?: AbortSignal) {
  const startedAt = performance.now();
  const response = await bffFetch("/api/design-drafts", {
    method: "POST",
    headers: { "x-turnstile-token": challengeToken },
    ...(signal ? { signal } : {}),
  });
  const result = Schema.decodeUnknownSync(CreateAnonymousDesignDraftResponseSchema)(await response.json());
  versions.set(result.id, result.version);
  return {
    ...result,
    diagnostics: {
      durationMs: Math.round(performance.now() - startedAt),
      requestId: response.headers.get("x-request-id") ?? undefined,
    },
  };
}

export async function processDesignArtwork(id: string, image: Blob, challengeToken?: string) {
  if (image.size > MAX_DESIGN_SOURCE_BYTES) {
    throw new DesignApiError("Print artwork must be no larger than 20 MB.", 413);
  }
  // This deadline includes transferring a source image of up to 20 MB as well
  // as processing it. A 30-second total cancelled real mobile uploads just as
  // the Worker received them, before it could return the processed artwork.
  const signal = AbortSignal.timeout(180_000);
  const startedAt = performance.now();
  let requestId: string | undefined;
  for (let attemptCount = 1; attemptCount <= 2; attemptCount += 1) {
    try {
      const grantStartedAt = performance.now();
      const expectedVersion = await designVersion(id, signal);
      const proofHeaders = challengeToken ? { "x-turnstile-token": challengeToken } : undefined;
      // A proof is single-use. A successful verification renews the owner-bound
      // clearance even if the Worker reports a version conflict.
      challengeToken = undefined;
      const grantResponse = await bffFetch(`/api/design-drafts/${encodeURIComponent(id)}/upload-grants`, {
        method: "POST",
        headers: { "content-type": "application/json", ...proofHeaders },
        body: JSON.stringify({
          contentType: image.type || "image/jpeg",
          expectedVersion,
          maxBytes: image.size,
          progressive: true,
        }),
        signal,
      }, attemptCount);
      requestId = grantResponse.headers.get("x-request-id") ?? undefined;
      const grant = Schema.decodeUnknownSync(UploadGrantResponseSchema)(await grantResponse.json());
      const uploadStartedAt = performance.now();
      const grantDurationMs = Math.round(uploadStartedAt - grantStartedAt);
      const uploadResponse = await fetch(grant.uploadUrl, {
        method: "PUT",
        headers: { "content-type": image.type || "image/jpeg" },
        body: image,
        signal,
      });
      const responseStartedAt = performance.now();
      requestId = uploadResponse.headers.get("x-request-id") ?? requestId;
      await requireOk(uploadResponse, attemptCount, "artwork_upload");
      const payload: unknown = await uploadResponse.json();
      const responseDownloadDurationMs = Math.round(performance.now() - responseStartedAt);
      const versioned = Schema.decodeUnknownSync(VersionedDesignMutationResponseSchema)(payload);
      const result = Schema.decodeUnknownSync(UploadDesignArtworkResponseSchema)(payload);
      const preview = inlineArtworkPreview(payload);
      const network = uploadNetworkTimings(grant.uploadUrl, uploadStartedAt);
      rememberVersion(id, versioned.version);
      return {
        ...result,
        preview,
        diagnostics: {
          durationMs: Math.round(performance.now() - startedAt),
          grantDurationMs,
          uploadResponseDurationMs: Math.round(responseStartedAt - uploadStartedAt),
          responseDownloadDurationMs,
          uploadBodyDurationMs: serverDuration(uploadResponse, "upload-body"),
          portraitDurationMs: serverDuration(uploadResponse, "portrait-processing"),
          previewBytes: preview?.size,
          networkSetupDurationMs: network?.setupDurationMs,
          networkRequestDurationMs: network?.requestDurationMs,
          workerDurationMs: serverDuration(uploadResponse, "worker"),
          screeningDurationMs: serverDuration(uploadResponse, "safety-screening"),
          previewDurationMs: serverDuration(uploadResponse, "artwork-preview"),
          requestId,
        },
      };
    } catch (error) {
      versions.delete(id);
      const metadata = designApiErrorMetadata(error);
      if (attemptCount === 1 && !signal.aborted &&
          metadata?.status === 409 && metadata.code === "VERSION_CONFLICT") {
        // Background preparation can advance the draft while a replacement
        // photo is transferring. Reserve against a fresh version and grant.
        continue;
      }
      if (signal.aborted || error instanceof TypeError) {
        const context = { operation: "artwork_upload", status: 0, requestId,
          code: signal.aborted ? "REQUEST_TIMEOUT" : "NETWORK_ERROR" } satisfies ClientFailureContext;
        captureStorefrontFailure(context);
        if (error instanceof Error) captureClientException(error, context);
      }
      if (signal.aborted || (typeof error === "object" && error !== null &&
        "name" in error && (error.name === "TimeoutError" || error.name === "AbortError"))) {
        throw new DesignApiError(
          "Preparing the photo took too long. Please try again.",
          0,
          { attemptCount, code: "REQUEST_TIMEOUT", requestId },
        );
      }
      if (error instanceof TypeError) {
        throw new DesignApiError(
          "The design service could not be reached. Please try again.",
          0,
          { attemptCount, code: "NETWORK_ERROR", requestId },
        );
      }
      throw error;
    }
  }
  throw new Error("The artwork upload retry limit was reached.");
}

function uploadNetworkTimings(url: string, startedAt: number) {
  // Optional browser diagnostics must never fail a committed upload. The URL
  // contains a capability and is used only to select the entry, never logged.
  try {
    const entry = performance.getEntriesByName(url, "resource")
      .findLast((candidate) => candidate.startTime >= startedAt);
    if (!entry || !("requestStart" in entry) || !("responseStart" in entry) ||
        typeof entry.requestStart !== "number" || typeof entry.responseStart !== "number" ||
        entry.requestStart <= 0 || entry.responseStart < entry.requestStart) return undefined;
    const setupDurationMs = Math.round(entry.requestStart - entry.startTime);
    const requestDurationMs = Math.round(entry.responseStart - entry.requestStart);
    if (![setupDurationMs, requestDurationMs].every((value) =>
      Number.isFinite(value) && value >= 0 && value <= 600_000,
    )) return undefined;
    return { setupDurationMs, requestDurationMs };
  } catch {
    return undefined;
  }
}

function serverDuration(response: Response, name: string): number | undefined {
  for (const entry of (response.headers.get("server-timing") ?? "").split(",")) {
    const [metric, duration] = entry.trim().split(";");
    if (metric !== name || !duration?.startsWith("dur=")) continue;
    const value = Number(duration.slice(4));
    if (Number.isFinite(value) && value >= 0 && value <= 600_000) return Math.round(value);
  }
  return undefined;
}

function inlineArtworkPreview(payload: unknown): Blob | undefined {
  if (typeof payload !== "object" || payload === null || !("preview" in payload)) return undefined;
  const preview = payload.preview;
  if (typeof preview !== "object" || preview === null ||
      !("contentType" in preview) || preview.contentType !== "image/webp" ||
      !("base64" in preview) || typeof preview.base64 !== "string" ||
      preview.base64.length > Math.ceil(MAX_INLINE_ARTWORK_PREVIEW_BYTES / 3) * 4) return undefined;
  try {
    const binary = atob(preview.base64);
    if (binary.length === 0 || binary.length > MAX_INLINE_ARTWORK_PREVIEW_BYTES) return undefined;
    return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
      type: "image/webp",
    });
  } catch {
    return undefined;
  }
}

export async function updateDesignSettings(id: string, settings: EditorSettingsDto) {
  for (let attemptCount = 1; attemptCount <= 2; attemptCount += 1) {
    try {
      const signal = AbortSignal.timeout(4_000);
      const expectedVersion = await designVersion(id, signal);
      const response = await bffFetch(`/api/design-drafts/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion, settings }),
        signal,
      }, attemptCount);
      const result = Schema.decodeUnknownSync(VersionedDesignMutationResponseSchema)(await response.json());
      rememberVersion(id, result.version);
      return {
        ...result,
        diagnostics: {
          attemptCount,
          requestId: response.headers.get("x-request-id") ?? undefined,
        },
      };
    } catch (error) {
      const metadata = designApiErrorMetadata(error);
      if (
        attemptCount === 1 &&
        metadata?.status === 409 &&
        metadata.code === "VERSION_CONFLICT"
      ) {
        versions.delete(id);
        continue;
      }
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new DesignApiError(
          "Saving the design took too long. Please try again.",
          0,
          { attemptCount, code: "REQUEST_TIMEOUT" },
        );
      }
      if (error instanceof TypeError) {
        throw new DesignApiError(
          "The design service could not be reached. Please try again.",
          0,
          { attemptCount, code: "NETWORK_ERROR" },
        );
      }
      throw error;
    }
  }
  throw new Error("The settings save retry limit was reached.");
}

export async function getDesign(id: string, signal?: AbortSignal) {
  const response = await bffFetch(
    `/api/design-drafts/${encodeURIComponent(id)}`,
    signal ? { signal } : undefined,
  );
  const result = Schema.decodeUnknownSync(AnonymousDesignDraftSchema)(await response.json());
  rememberVersion(id, result.version);
  return result;
}

export async function getSavedDesigns(cursor: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ page: "1" });
  if (cursor !== null) query.set("cursor", cursor);
  const response = await bffFetch(`/api/design-drafts?${query.toString()}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  return Schema.decodeUnknownSync(SavedDesignPageSchema)(await response.json());
}

export async function deleteDesign(id: string) {
  const response = await bffFetch(`/api/design-drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
  const result = Schema.decodeUnknownSync(DeleteDesignResponseSchema)(await response.json());
  versions.delete(id);
  return result;
}

async function claimLegacyDesign(id: string, signal?: AbortSignal) {
  const response = await bffFetch(`/api/design-drafts/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    ...(signal ? { signal } : {}),
  });
  const result = Schema.decodeUnknownSync(AnonymousDesignDraftSchema)(await response.json());
  rememberVersion(id, result.version);
  return result;
}

function rememberVersion(id: string, version: number) {
  const current = versions.get(id);
  if (current === undefined || version > current) {
    versions.set(id, version);
  }
}

export async function removeBackground(image: Blob, quality: BackgroundRemovalQuality) {
  const response = await bffFetch("/api/background-removal", {
    method: "POST",
    headers: {
      "content-type": image.type || "image/jpeg",
      "x-background-removal-quality": quality,
    },
    body: image,
  }, 1, "background_removal");
  return response.blob();
}

export async function designVersion(id: string, signal?: AbortSignal) {
  const existing = versions.get(id);
  if (existing !== undefined) return existing;
  try {
    return (await getDesign(id, signal)).version;
  } catch (error) {
    // A user-triggered mutation is the explicit compatibility claim. Plain
    // reads never claim ownership.
    if (!(error instanceof DesignApiError) || error.status !== 404) throw error;
    return (await claimLegacyDesign(id, signal)).version;
  }
}

export function forgetDesignVersion(id: string) {
  versions.delete(id);
}

async function bffFetch(path: string, init?: RequestInit, attemptCount = 1, operation: ClientFailureContext["operation"] = "design_request") {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    const timeout = init?.signal?.aborted && init.signal.reason instanceof Error && init.signal.reason.name === "TimeoutError";
    if (!init?.signal?.aborted || timeout) {
      captureStorefrontFailure({ operation, status: 0, code: timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR" });
      if (error instanceof Error) captureClientException(error, { operation, status: 0 });
    }
    throw error;
  }
  await requireOk(response, attemptCount, operation);
  return response;
}

async function requireOk(response: Response, attemptCount = 1, operation: ClientFailureContext["operation"] = "design_request") {
  if (response.ok) return;
  let message = "The design service is unavailable.";
  let code: string | undefined;
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "object" && payload.error !== null &&
      "message" in payload.error && typeof payload.error.message === "string"
    ) {
      message = payload.error.message;
    }
    if (
      typeof payload === "object" && payload !== null && "error" in payload &&
      typeof payload.error === "object" && payload.error !== null &&
      "code" in payload.error && typeof payload.error.code === "string"
    ) {
      code = payload.error.code;
    }
  } catch {
    // Preserve the stable fallback for non-JSON upstream failures.
  }
  const retryAfter = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter)
    ? Number(retryAfter)
    : undefined;
  captureStorefrontFailure({ operation, code, status: response.status,
    requestId: response.headers.get("x-request-id") ?? undefined });
  throw new DesignApiError(message, response.status, {
    attemptCount,
    code,
    requestId: response.headers.get("x-request-id") ?? undefined,
    retryAfterSeconds,
  });
}

export async function retryArtworkPreparation(id: string, artworkJobId: string) {
  await bffFetch(`/api/design-drafts/${encodeURIComponent(id)}/artwork-processing`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ artworkJobId }), signal: AbortSignal.timeout(10_000),
  });
}
