import { Schema } from "effect";

import { DesignId, DesignRevisionId } from "./design";
import { MAX_DESIGN_ARTWORK_BYTES } from "./limits";
export * from "./product-projection";

export const ProductId = Schema.UUID;

export const BaseProductSlugSchema = Schema.Literal(
  "staple-tee",
  "cotton-tote",
);

export const ProductProjectionVersionSchema = Schema.Literal(
  "legacy-shirt-v1",
  "safe-margin-v1",
);

export const ProductDefaultColorSchema = Schema.Literal("Black", "White");
export type ProductDefaultColor = Schema.Schema.Type<
  typeof ProductDefaultColorSchema
>;

const FiniteNumber = Schema.Number.pipe(Schema.finite());

export const ProductPlacementSchema = Schema.Struct({
  x: FiniteNumber.pipe(Schema.between(0, 1)),
  y: FiniteNumber.pipe(Schema.between(0, 1)),
  width: FiniteNumber.pipe(Schema.between(0.08, 0.48)),
  depth: Schema.Int.pipe(Schema.between(0, 8)),
}).pipe(
  Schema.filter(
    (placement) =>
      placement.x + placement.width <= 1 &&
      placement.y + placement.width <= 1,
    { message: () => "Artwork placement must remain inside the print area." },
  ),
);

export const ProductPrintModeSchema = Schema.Literal("recursive", "base-image-only");

export const ProductSchema = Schema.Struct({
  id: ProductId,
  baseProductId: ProductId,
  designId: Schema.NullOr(DesignId),
  designRevisionId: Schema.optionalWith(Schema.NullOr(DesignRevisionId), {
    default: () => null,
  }),
  preparationId: Schema.optional(DesignRevisionId),
  placement: Schema.optionalWith(Schema.NullOr(ProductPlacementSchema), {
    default: () => null,
  }),
  printMode: Schema.optional(ProductPrintModeSchema),
  projectionVersion: Schema.optionalWith(
    Schema.NullOr(ProductProjectionVersionSchema),
    { default: () => null },
  ),
  defaultColor: Schema.optionalWith(ProductDefaultColorSchema, {
    default: () => "White",
  }),
  shopifyHandle: Schema.String.pipe(Schema.minLength(1)),
  createdAt: Schema.String,
});

export type ProductDto = Schema.Schema.Type<typeof ProductSchema>;

export const ProductFamilySchema = Schema.Array(ProductSchema);

export type ProductFamilyDto = Schema.Schema.Type<typeof ProductFamilySchema>;

export const ArtworkSha256Schema = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{64}$/),
);
export const ArtworkContentTypeSchema = Schema.String.pipe(
  Schema.pattern(/^image\/[a-z0-9.+-]+$/),
);
export const ArtworkByteSizeSchema = Schema.Int.pipe(
  Schema.between(1, MAX_DESIGN_ARTWORK_BYTES),
);

export const ConfiguredProductRevisionSnapshotSchema = Schema.Struct({
  configuredProductId: ProductId,
  baseProductId: ProductId,
  designId: DesignId,
  designRevisionId: DesignRevisionId,
  baseProductSlug: BaseProductSlugSchema,
  placement: ProductPlacementSchema,
  projectionVersion: ProductProjectionVersionSchema,
  printMode: Schema.optional(ProductPrintModeSchema),
  artworkSha256: ArtworkSha256Schema,
  contentType: ArtworkContentTypeSchema,
  byteSize: ArtworkByteSizeSchema,
  shopifyHandle: Schema.String.pipe(Schema.minLength(1)),
  artworkUrl: Schema.String.pipe(Schema.minLength(1)),
});

export type ConfiguredProductRevisionSnapshotDto = Schema.Schema.Type<
  typeof ConfiguredProductRevisionSnapshotSchema
>;

export const CreateConfiguredProductRequestSchema = Schema.Struct({
  baseProductId: ProductId,
  designId: DesignId,
});

export type CreateConfiguredProductRequest = Schema.Schema.Type<
  typeof CreateConfiguredProductRequestSchema
>;

export const CreateConfiguredProductFamilyRequestSchema = Schema.Struct({
  baseProductIds: Schema.Array(ProductId).pipe(Schema.minItems(1), Schema.maxItems(2)),
  designId: DesignId,
});

export type CreateConfiguredProductFamilyRequest = Schema.Schema.Type<
  typeof CreateConfiguredProductFamilyRequestSchema
>;

export const ConfiguredProductFamilyResponseSchema = Schema.Struct({
  products: ProductFamilySchema.pipe(Schema.minItems(1), Schema.maxItems(2)),
});

export class ProductNotFound extends Schema.TaggedError<ProductNotFound>()(
  "ProductNotFound",
  { message: Schema.String },
) {}
