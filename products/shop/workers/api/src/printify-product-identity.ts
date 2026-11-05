import { Schema } from "effect";

const NonEmptyText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512));
const ProviderId = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
export const INTERNAL_PRODUCT_DESCRIPTION = "Internal bent.shop fulfilment resource. Not for publication.";

export interface ProductionProductIdentity {
  readonly configured_product_id: string;
  readonly print_asset_sha256: string;
  readonly printify_variant_id: number;
  readonly retail_price_minor_units: number;
  readonly blueprint_id: number;
  readonly print_provider_id: number;
  readonly width_px: number;
  readonly height_px: number;
}

const ProductVariantFields = {
  cost: NonNegativeInt,
  id: PositiveInt,
  is_available: Schema.Boolean,
  price: PositiveInt,
};

// Printify includes disabled catalogue variants without SKUs in product reads.
// The enabled variant still needs the exact nonempty production SKU.
const PrintifyProductVariantSchema = Schema.Union(
  Schema.Struct({ ...ProductVariantFields, is_enabled: Schema.Literal(true), sku: NonEmptyText }),
  Schema.Struct({ ...ProductVariantFields, is_enabled: Schema.Literal(false),
    sku: Schema.String.pipe(Schema.maxLength(512)) }),
);

const PrintifyProductImageSchema = Schema.Struct({
  angle: Schema.Number.pipe(Schema.finite()),
  height: PositiveInt,
  id: ProviderId,
  scale: Schema.Number.pipe(Schema.finite(), Schema.positive()),
  type: Schema.Literal("image/png", "image/jpeg", "image/jpg"),
  width: PositiveInt,
  x: Schema.Number.pipe(Schema.finite()),
  y: Schema.Number.pipe(Schema.finite()),
});

const PrintifyProductPlaceholderSchema = Schema.Struct({
  decoration_method: NonEmptyText,
  images: Schema.Array(PrintifyProductImageSchema),
  position: NonEmptyText,
});

const PrintifyProductPrintAreaSchema = Schema.Struct({
  placeholders: Schema.Array(PrintifyProductPlaceholderSchema),
  variant_ids: Schema.Array(PositiveInt).pipe(Schema.minItems(1)),
});

export const PrintifyProductionProductSchema = Schema.Struct({
  blueprint_id: PositiveInt,
  description: Schema.String,
  id: ProviderId,
  is_locked: Schema.Boolean,
  print_areas: Schema.Array(PrintifyProductPrintAreaSchema).pipe(
    Schema.minItems(1),
  ),
  print_provider_id: PositiveInt,
  shop_id: PositiveInt,
  title: NonEmptyText,
  variants: Schema.Array(PrintifyProductVariantSchema).pipe(
    Schema.minItems(1),
  ),
  visible: Schema.Boolean,
});

export type PrintifyProductionProduct = Schema.Schema.Type<
  typeof PrintifyProductionProductSchema
>;

export function productionProductSku(candidate: ProductionProductIdentity) {
  return [
    "bnt",
    candidate.configured_product_id.replaceAll("-", "").slice(0, 12),
    candidate.print_asset_sha256.slice(0, 12),
    String(candidate.printify_variant_id),
    String(candidate.retail_price_minor_units),
  ].join("-");
}

export function productionProductTitle(candidate: ProductionProductIdentity) {
  return [
    "Bent internal",
    candidate.configured_product_id,
    candidate.print_asset_sha256.slice(0, 12),
    String(candidate.printify_variant_id),
    String(candidate.retail_price_minor_units),
  ].join(" ");
}

export function productIdentityMismatchFields(
  candidate: ProductionProductIdentity,
  providerImageId: string,
  providerProductId: string,
  title: string,
  shopId: number,
  product: PrintifyProductionProduct,
) {
  const failures: string[] = [];
  const check = (valid: boolean, field: string) => { if (!valid) failures.push(field); };
  check(product.id === providerProductId, "product.id");
  check(product.title === title, "product.title");
  check(product.description === INTERNAL_PRODUCT_DESCRIPTION, "product.description");
  check(product.blueprint_id === candidate.blueprint_id, "product.blueprint_id");
  check(product.print_provider_id === candidate.print_provider_id, "product.print_provider_id");
  check(product.shop_id === shopId, "product.shop_id");
  check(!product.is_locked, "product.is_locked");
  check(new Set(product.variants.map(variant => variant.id)).size === product.variants.length, "variants.unique_ids");
  // The provider returns disabled catalogue variants and empty print positions.
  // Only the one enabled variant and its actual printed artwork may be ordered.
  const enabled = product.variants.filter(variant => variant.is_enabled);
  const areas = product.print_areas.filter(area => area.variant_ids.includes(candidate.printify_variant_id));
  check(enabled.length === 1, "variants.enabled_count");
  check(areas.length === 1, "print_areas.selected_count");
  const variant = enabled[0];
  const area = areas[0];
  if (!variant || !area) return failures;
  check(variant.id === candidate.printify_variant_id, "variant.id");
  check(variant.price === candidate.retail_price_minor_units, "variant.price");
  check(variant.sku === productionProductSku(candidate), "variant.sku");
  check(variant.is_available, "variant.is_available");
  check(new Set(area.variant_ids).size === area.variant_ids.length &&
    area.variant_ids.every(id => product.variants.some(variant => variant.id === id)), "print_area.variant_ids");
  const fronts = area.placeholders.filter(placeholder => placeholder.position === "front");
  check(fronts.length === 1, "placeholders.front_count");
  check(area.placeholders.every(placeholder => placeholder.position === "front" || placeholder.images.length === 0), "placeholders.extra_artwork");
  const front = fronts[0];
  if (!front) return failures;
  check(front.decoration_method.toLowerCase() === "dtg", "front.decoration_method");
  check(front.images.length === 1, "front.image_count");
  const image = front.images[0];
  if (!image) return failures;
  check(image.id === providerImageId, "image.id");
  check(image.type === "image/png", "image.type");
  check(image.width === candidate.width_px && image.height === candidate.height_px, "image.dimensions");
  check(image.x === 0.5 && image.y === 0.5 && image.scale === 1 && image.angle === 0, "image.placement");
  return failures;
}

export function productMatches(
  candidate: ProductionProductIdentity,
  providerImageId: string,
  providerProductId: string,
  title: string,
  shopId: number,
  product: PrintifyProductionProduct,
) {
  return productIdentityMismatchFields(candidate, providerImageId, providerProductId, title, shopId, product).length === 0;
}

export function productReadbackIdentity(product: PrintifyProductionProduct) {
  return {
    blueprintId: product.blueprint_id,
    description: product.description,
    id: product.id,
    isLocked: product.is_locked,
    printAreas: product.print_areas,
    printProviderId: product.print_provider_id,
    shopId: product.shop_id,
    title: product.title,
    variants: product.variants,
    visible: product.visible,
  };
}

