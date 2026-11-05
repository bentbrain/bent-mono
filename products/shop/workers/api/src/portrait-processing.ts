import { Effect, Either } from "effect";

import {
  deriveModerationPreview,
  type ImageProcessingBinding,
  segmentJpeg,
  validateSourceImage,
  prepareStoredArtwork,
  byteStream,
  readBoundedStream,
} from "./image-processing";
import type {
  AllowedSafetyScreeningDecision,
  SafetyScreeningClient,
  SafetyScreeningDecision,
  SafetyScreeningFailure,
} from "./openai-safety-screening";
import {
  type PendingProductColorAnalysis,
  type ProductColorAnalysisClient,
  startProductColorAnalysis,
} from "./product-color-analysis";

interface ScreenedPortraitMetadata {
  readonly ok: true;
  readonly screening: AllowedSafetyScreeningDecision;
  readonly screeningDurationMs: number;
  readonly productColorAnalysis?: PendingProductColorAnalysis;
}

interface ScreenedPortrait extends ScreenedPortraitMetadata {
  readonly sourceDimensions?: { readonly width: number; readonly height: number };
  readonly bytes: Uint8Array;
  readonly height: number;
  readonly width: number;
  readonly original?: { readonly bytes: Uint8Array; readonly width: number; readonly height: number };
}

interface RejectedPortrait {
  readonly ok: false;
  readonly reason:
    | "blocked"
    | "image-dependency"
    | "invalid"
    | "output-too-large"
    | "quota"
    | "screening-dependency";
  readonly screeningDurationMs?: number;
}

export type ScreenedPortraitResult = ScreenedPortrait | RejectedPortrait;

interface TimedScreening {
  readonly durationMs: number;
  readonly result: Either.Either<
    SafetyScreeningDecision,
    SafetyScreeningFailure
  >;
}

export async function processPortraitForStorage(
  images: ImageProcessingBinding,
  source: Uint8Array,
  beforeTransform: () => Promise<boolean>,
  screeningClient: SafetyScreeningClient,
  productColorAnalysis?: {
    readonly client: ProductColorAnalysisClient;
    readonly safetyIdentifier: string;
  },
  retainOriginal = false,
): Promise<ScreenedPortraitResult> {
  const validation = await validateSourceImage(images, source);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason === "invalid" ? "invalid" : "image-dependency",
    };
  }
  if (!await beforeTransform()) return { ok: false, reason: "quota" };

  // Screen independently while normalizing and then segmenting. Sequential
  // full-size encodings bound memory; Promise.all also waits for an in-flight
  // encoding on screening failure. Nothing is stored before screening succeeds.
  const [screened, prepared] = await Promise.all([
    screenPortrait(images, source, screeningClient, productColorAnalysis),
    (async () => {
      if (!retainOriginal) return { segmented: await segmentJpeg(images, source, validation.image, "print") };
      const original = await prepareStoredArtwork(images, source, false, validation.image);
      if (!original.ok) return { segmented: original };
      const segmented = await prepareStoredArtwork(images, original.bytes, true, original);
      return { original, segmented };
    })(),
  ]);
  if (!screened.ok) return screened;
  const { original, segmented } = prepared;
  if (!segmented.ok) return {
    ok: false,
    reason: segmented.reason === "output-too-large" ? "output-too-large" : "image-dependency",
    screeningDurationMs: screened.screeningDurationMs,
  };
  return {
    ...screened,
    bytes: segmented.bytes,
    height: segmented.height,
    width: segmented.width,
    ...(original?.ok ? { original: { bytes: original.bytes, width: original.width, height: original.height } } : {}),
  };
}

async function screenPortrait(
  images: ImageProcessingBinding,
  source: Uint8Array,
  screeningClient: SafetyScreeningClient,
  productColorAnalysis: Parameters<typeof processPortraitForStorage>[4],
): Promise<ScreenedPortraitMetadata | RejectedPortrait> {
  const moderationPreview = await deriveModerationPreview(images, source);
  if (!moderationPreview.ok) {
    return {
      ok: false,
      reason: moderationPreview.reason === "output-too-large"
        ? "output-too-large"
        : "image-dependency",
    };
  }

  const pendingProductColorAnalysis = productColorAnalysis
    ? startProductColorAnalysis(
        productColorAnalysis.client,
        moderationPreview.preview,
        productColorAnalysis.safetyIdentifier,
      )
    : undefined;
  const screening = await timedScreening(screeningClient, moderationPreview.preview);
  if (Either.isLeft(screening.result)) {
    return {
      ok: false,
      reason: "screening-dependency",
      screeningDurationMs: screening.durationMs,
    };
  }
  if (screening.result.right.decision === "flagged") {
    return {
      ok: false,
      reason: "blocked",
      screeningDurationMs: screening.durationMs,
    };
  }
  return {
    ok: true,
    screening: {
      decision: "allowed",
      model: screening.result.right.model,
    },
    screeningDurationMs: screening.durationMs,
    ...(pendingProductColorAnalysis
      ? { productColorAnalysis: pendingProductColorAnalysis }
      : {}),
  };
}

async function timedScreening(
  client: SafetyScreeningClient,
  preview: Parameters<SafetyScreeningClient["screen"]>[0],
): Promise<TimedScreening> {
  const startedAt = performance.now();
  const result = await Effect.runPromise(
    client.screen(preview).pipe(Effect.either),
  );
  return {
    durationMs: Math.round(performance.now() - startedAt),
    result,
  };
}

// This branch is display-only. Print preparation always starts from the source.
export async function processPortraitForCanvas(
  images: ImageProcessingBinding,
  source: Uint8Array,
  beforeTransform: () => Promise<boolean>,
  screeningClient: SafetyScreeningClient,
  productColorAnalysis?: Parameters<typeof processPortraitForStorage>[4],
): Promise<ScreenedPortraitResult> {
  const validation = await validateSourceImage(images, source);
  if (!validation.ok) return { ok: false, reason: validation.reason === "invalid" ? "invalid" : "image-dependency" };
  if (!await beforeTransform()) return { ok: false, reason: "quota" };
  const [screened, preview] = await Promise.all([
    screenPortrait(images, source, screeningClient, productColorAnalysis),
    (async () => {
      try {
        const output = await images.input(byteStream(source))
          .transform({ background: "white", fit: "scale-down", width: 1024, height: 1024 })
          .output({ format: "image/png", anim: false });
        const response = output.response();
        if (!response.ok || !response.body) return undefined;
        const original = await readBoundedStream(response.body, 5 * 1024 * 1024);
        if (!original) return undefined;
        const info = await images.info(byteStream(original));
        if (!info.width || !info.height || info.width > 1024 || info.height > 1024) return undefined;
        const segmented = await images.input(byteStream(original)).transform({ segment: "foreground" })
          .output({ format: "image/webp", quality: 90, anim: false });
        const cutout = segmented.response();
        if (!cutout.ok || !cutout.body) return undefined;
        const bytes = await readBoundedStream(cutout.body, 1024 * 1024);
        if (!bytes) return undefined;
        return { bytes, width: info.width, height: info.height,
          original: { bytes: original, width: info.width, height: info.height } };
      } catch { return undefined; }
    })(),
  ]);
  if (!screened.ok) return screened;
  if (!preview) return { ok: false, reason: "image-dependency" };
  // Images applies EXIF orientation while producing the display bitmap. Use
  // that orientation for the early crop limit, retaining all source pixels.
  const rotated = (validation.image.width > validation.image.height && preview.width < preview.height) ||
    (validation.image.width < validation.image.height && preview.width > preview.height);
  const sourceDimensions = rotated
    ? { width: validation.image.height, height: validation.image.width } : validation.image;
  return { ...screened, ...preview, sourceDimensions };
}
