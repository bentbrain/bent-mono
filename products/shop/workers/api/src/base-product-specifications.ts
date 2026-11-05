import {
  COTTON_TOTE_BASE_PRODUCT_ID,
  STAPLE_TEE_BASE_PRODUCT_ID,
  productProjectionSpecification,
  type BaseProductSlug,
  type ProductProjectionSpecification,
} from "@forever-tee/contracts";

export type LaunchProductColor = "Black" | "Cream" | "White";

export interface BaseProductSpecification {
  readonly baseProductId: string;
  readonly blueprintId: number;
  readonly brand: string;
  readonly colors: readonly LaunchProductColor[];
  readonly model: string;
  readonly shopifyHandle: string;
  readonly slug: BaseProductSlug;
  readonly singleSize: boolean;
  readonly projection: ProductProjectionSpecification;
}

const STAPLE_TEE_SPECIFICATION: BaseProductSpecification = {
  baseProductId: STAPLE_TEE_BASE_PRODUCT_ID,
  blueprintId: 440,
  brand: "AS Colour",
  colors: ["Black", "White"],
  model: "5001",
  shopifyHandle: "bent-shirt",
  slug: "staple-tee",
  singleSize: false,
  projection: productProjectionSpecification("staple-tee"),
};

const COTTON_TOTE_SPECIFICATION: BaseProductSpecification = {
  baseProductId: COTTON_TOTE_BASE_PRODUCT_ID,
  blueprintId: 553,
  brand: "AS Colour",
  colors: ["Black", "Cream"],
  model: "1001",
  shopifyHandle: "cotton-tote",
  slug: "cotton-tote",
  singleSize: true,
  projection: productProjectionSpecification("cotton-tote"),
};

export const LAUNCH_BASE_PRODUCTS: readonly BaseProductSpecification[] = [
  STAPLE_TEE_SPECIFICATION,
  COTTON_TOTE_SPECIFICATION,
];

export function baseProductSpecification(
  slug: BaseProductSlug,
): BaseProductSpecification {
  return slug === "staple-tee"
    ? STAPLE_TEE_SPECIFICATION
    : COTTON_TOTE_SPECIFICATION;
}

export function baseProductSpecificationForHandle(
  handle: string,
): BaseProductSpecification | undefined {
  return LAUNCH_BASE_PRODUCTS.find(
    (specification) => specification.shopifyHandle === handle,
  );
}

export function launchProductColor(
  value: string,
  specification: BaseProductSpecification,
): LaunchProductColor | undefined {
  const normalizedValue = value.trim().toLocaleLowerCase("en-AU");
  return specification.colors.find(
    (color) => color.toLocaleLowerCase("en-AU") === normalizedValue,
  );
}
