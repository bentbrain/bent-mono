import type {
  BaseProductSlug,
  ProductDefaultColor,
} from "@forever-tee/contracts";
import { productProjectionSpecification } from "@forever-tee/contracts/product-projection";
import {
  createLoader,
  parseAsString,
  parseAsStringLiteral,
  type inferParserType,
} from "nuqs/server";

type ProductQuery = Record<string, string | string[] | undefined>;
const landingProductNames: ["shirt", "tote"] = ["shirt", "tote"];

export const landingProductParsers = {
  product: parseAsStringLiteral(landingProductNames).withDefault("shirt"),
  shirtColor: parseAsString,
  shirtSize: parseAsString,
  toteColor: parseAsString,
  toteSize: parseAsString,
};

export const canonicalProductParsers = {
  Color: parseAsString,
  Size: parseAsString,
};

export type LandingProductParams = inferParserType<
  typeof landingProductParsers
>;
export type LandingProductOptionPrefix = "shirt" | "tote";

export const loadLandingProductParams = createLoader(landingProductParsers);

export function landingProductOptionPrefix(
  baseProductSlug: BaseProductSlug,
): LandingProductOptionPrefix {
  return baseProductSlug === "staple-tee" ? "shirt" : "tote";
}

export function landingProductQuery(
  params: LandingProductParams,
  baseProductSlug: BaseProductSlug,
  legacyQuery: ProductQuery,
) {
  const prefix = landingProductOptionPrefix(baseProductSlug);
  const color = prefix === "shirt" ? params.shirtColor : params.toteColor;
  const size = prefix === "shirt" ? params.shirtSize : params.toteSize;
  const productQuery: ProductQuery = {
    ...(color ? { Color: color } : {}),
    ...(size ? { Size: size } : {}),
  };

  if (
    Object.keys(productQuery).length === 0 &&
    baseProductSlug === landingProductSlug(params.product)
  ) {
    for (const optionName of ["Color", "Size"]) {
      if (legacyQuery[optionName] !== undefined) {
        productQuery[optionName] = legacyQuery[optionName];
      }
    }
  }

  return productQuery;
}

export function productDefaultColorValue(
  defaultColor: ProductDefaultColor,
  baseProductSlug: BaseProductSlug,
) {
  return defaultColor === "White" && baseProductSlug === "cotton-tote"
    ? "Cream"
    : defaultColor;
}

export function productQueryWithDefaultColor(
  query: ProductQuery,
  defaultColor: ProductDefaultColor,
  baseProductSlug: BaseProductSlug = "staple-tee",
) {
  const coloredQuery = query["Color"] === undefined
    ? { ...query, Color: productDefaultColorValue(defaultColor, baseProductSlug) }
    : query;
  const sizes = productProjectionSpecification(baseProductSlug).sizes;
  const onlySize = sizes.length === 1 ? sizes[0] : undefined;
  // Shopify can return its first variant for a partial colour-only selection.
  // Complete a one-size product without choosing a shirt size for the customer.
  return query["Size"] === undefined && onlySize
    ? { ...coloredQuery, Size: onlySize }
    : coloredQuery;
}

export function landingProductSelectionParams(
  prefix: LandingProductOptionPrefix,
  selectedOptions: readonly { name: string; value: string }[],
) {
  const { color, size } = selectedProductOptions(selectedOptions);

  return prefix === "shirt"
    ? { shirtColor: color, shirtSize: size }
    : { toteColor: color, toteSize: size };
}

export function canonicalProductSelectionParams(
  selectedOptions: readonly { name: string; value: string }[],
) {
  const { color, size } = selectedProductOptions(selectedOptions);
  return { Color: color, Size: size };
}

export function productVariantUrl(
  pathname: string,
  productOptions: readonly { name: string }[],
  selectedOptions: readonly { name: string; value: string }[],
  base: URLSearchParams | Readonly<URLSearchParams> = new URLSearchParams(),
  optionQueryParamPrefix?: string,
) {
  const params = new URLSearchParams(base);
  for (const option of productOptions) {
    params.delete(option.name);
    params.delete(
      productOptionQueryParamName(option.name, optionQueryParamPrefix),
    );
  }
  for (const option of selectedOptions) {
    params.set(
      productOptionQueryParamName(option.name, optionQueryParamPrefix),
      option.value,
    );
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

export function familyProductUrl(
  url: string,
  queryParamName: string | undefined,
  baseProductSlug: BaseProductSlug,
) {
  if (!queryParamName) return url;
  const [pathname = "/", query = ""] = url.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(
    queryParamName,
    baseProductSlug === "staple-tee" ? "shirt" : "tote",
  );
  const nextQuery = params.toString();
  return `${pathname}${nextQuery ? `?${nextQuery}` : ""}`;
}

export function landingProductSlug(product: "shirt" | "tote"):
  BaseProductSlug {
  return product === "tote" ? "cotton-tote" : "staple-tee";
}

function selectedProductOptions(
  selectedOptions: readonly { name: string; value: string }[],
) {
  const color = selectedOptions.find(
    (option) => option.name.toLowerCase() === "color",
  )?.value ?? null;
  const size = selectedOptions.find(
    (option) => option.name.toLowerCase() === "size",
  )?.value ?? null;
  return { color, size };
}

export function productOptionQueryParamName(
  name: string,
  prefix: string | undefined,
) {
  return prefix ? `${prefix}${name}` : name;
}
