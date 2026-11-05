import { Schema } from "effect";

export {
  MAX_DESIGN_ARTWORK_BYTES,
  MAX_DESIGN_SOURCE_BYTES,
} from "./limits";

const FiniteNumber = Schema.Number.pipe(Schema.finite());
const UnitInterval = FiniteNumber.pipe(Schema.between(0, 1));

export const DesignId = Schema.UUID;
export const DesignRevisionId = Schema.UUID;

export const EditorSettingsSchema = Schema.Struct({
  removeBackground: Schema.optional(Schema.Boolean),
  cropX: UnitInterval,
  cropY: UnitInterval,
  cropZoom: FiniteNumber.pipe(Schema.between(0.65, 2.6)),
  placementX: UnitInterval,
  placementY: UnitInterval,
  placementWidth: FiniteNumber.pipe(Schema.between(0.08, 0.48)),
  depth: Schema.Int.pipe(Schema.between(0, 8)),
}).pipe(
  Schema.filter(
    (settings) =>
      settings.placementX + settings.placementWidth <= 1 &&
      settings.placementY + settings.placementWidth <= 1,
    { message: () => "Artwork placement must remain inside the print area." },
  ),
);

export type EditorSettingsDto = Schema.Schema.Type<typeof EditorSettingsSchema>;

export const DesignStatusSchema = Schema.Literal("creating", "ready");

export const DesignSchema = Schema.Struct({
  id: DesignId,
  status: DesignStatusSchema,
  contentType: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  artworkRevision: Schema.optionalWith(
    Schema.NullOr(Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))),
    { default: () => null },
  ),
  settings: EditorSettingsSchema,
  artworkUrl: Schema.String,
});

export type DesignDto = Schema.Schema.Type<typeof DesignSchema>;

export const AnonymousDesignDraftSchema = Schema.Struct({
  ...DesignSchema.fields,
  previewReady: Schema.optional(Schema.Boolean),
  artworkJobId: Schema.optional(Schema.NullOr(Schema.String)),
  artworkProcessingStatus: Schema.optional(Schema.NullOr(Schema.Literal("pending", "processing", "complete", "failed"))),
  defaultColor: Schema.optional(Schema.Literal("Black", "White")),
  defaultColorStatus: Schema.optional(Schema.Literal("pending", "complete", "fallback")),
  version: Schema.Int.pipe(Schema.nonNegative()),
  finalized: Schema.Boolean,
  hasOriginalArtwork: Schema.optional(Schema.Boolean),
  maximumCropZoom: Schema.optional(Schema.NullOr(FiniteNumber.pipe(Schema.between(0, 2.6)))),
});

export type AnonymousDesignDraftDto = Schema.Schema.Type<
  typeof AnonymousDesignDraftSchema
>;

export const SavedDesignSchema = Schema.Struct({
  id: DesignId,
  productId: Schema.UUID,
  color: Schema.String,
  createdAt: Schema.String,
});

export const SavedDesignsSchema = Schema.Array(SavedDesignSchema);
export const SavedDesignPageSchema = Schema.Struct({
  items: Schema.Array(SavedDesignSchema).pipe(Schema.maxItems(40)),
  nextCursor: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^v1\.\d{1,16}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/))),
});
export type SavedDesignPageDto = Schema.Schema.Type<typeof SavedDesignPageSchema>;

export type SavedDesignDto = Schema.Schema.Type<typeof SavedDesignSchema>;

export const DeleteDesignResponseSchema = Schema.Struct({
  id: DesignId,
  productIds: Schema.Array(Schema.UUID),
});

export const CreateAnonymousDesignDraftResponseSchema = Schema.Struct({
  id: DesignId,
  version: Schema.Int.pipe(Schema.nonNegative()),
});

export const DesignSettingsMutationSchema = Schema.Struct({
  expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  settings: EditorSettingsSchema,
});

export const UploadGrantRequestSchema = Schema.Struct({
  progressive: Schema.optional(Schema.Boolean),
  expectedVersion: Schema.Int.pipe(Schema.nonNegative()),
  contentType: Schema.String,
  maxBytes: Schema.Int.pipe(Schema.positive()),
});

export const UploadGrantResponseSchema = Schema.Struct({
  uploadUrl: Schema.String,
  expiresAt: Schema.String,
});

export const VersionedDesignMutationResponseSchema = Schema.Struct({
  id: DesignId,
  updatedAt: Schema.String,
  version: Schema.Int.pipe(Schema.nonNegative()),
});

export const CreateDesignResponseSchema = Schema.Struct({
  id: DesignId,
});

export type CreateDesignResponse = Schema.Schema.Type<
  typeof CreateDesignResponseSchema
>;

export const UploadDesignArtworkResponseSchema = Schema.Struct({
  printReady: Schema.optional(Schema.Boolean),
  artworkJobId: Schema.optional(Schema.String),
  id: DesignId,
  artworkUrl: Schema.String,
  updatedAt: Schema.String,
});

export const UpdateDesignResponseSchema = Schema.Struct({
  id: DesignId,
  updatedAt: Schema.String,
});

export const ApiErrorSchema = Schema.Struct({
  error: Schema.Struct({
    code: Schema.Literal(
      "BAD_REQUEST",
      "CHALLENGE_REQUIRED",
      "CART_REJECTED",
      "NOT_FOUND",
      "PAYLOAD_TOO_LARGE",
      "RATE_LIMITED",
      "UNSUPPORTED_MEDIA_TYPE",
      "DEPENDENCY_UNAVAILABLE",
      "PRODUCT_COLOR_PENDING",
      "INTERNAL_ERROR",
    ),
    message: Schema.String,
  }),
});

export type ApiErrorDto = Schema.Schema.Type<typeof ApiErrorSchema>;

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  "InvalidRequest",
  { message: Schema.String },
) {}

export class DesignNotFound extends Schema.TaggedError<DesignNotFound>()(
  "DesignNotFound",
  { message: Schema.String },
) {}

export class DesignNotReady extends Schema.TaggedError<DesignNotReady>()(
  "DesignNotReady",
  { message: Schema.String },
) {}

export class DependencyUnavailable extends Schema.TaggedError<DependencyUnavailable>()(
  "DependencyUnavailable",
  { message: Schema.String },
) {}

export class RateLimitExceeded extends Schema.TaggedError<RateLimitExceeded>()(
  "RateLimitExceeded",
  { message: Schema.String },
) {}

export class UnexpectedServerError extends Schema.TaggedError<UnexpectedServerError>()(
  "UnexpectedServerError",
  { message: Schema.String },
) {}

export const BackgroundRemovalQuality = Schema.Literal("preview", "print");
export type BackgroundRemovalQuality = Schema.Schema.Type<
  typeof BackgroundRemovalQuality
>;
