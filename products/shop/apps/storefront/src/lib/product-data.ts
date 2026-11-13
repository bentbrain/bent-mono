import "@tanstack/react-start/server-only";

import {
  getSelectedProductOptions,
  type SelectedOption,
} from "@shopify/hydrogen";

import { PRODUCT_QUERY } from "@/lib/product-query";
import type { ProductData, QueriedProductData } from "@/lib/product-query";
import { requiresExplicitSizeSelection } from "@/lib/product-selection";
import { shopifyI18n } from "@/lib/shopify-config";
import { createRequestStorefrontClient } from "@/lib/storefront";

export async function getForeverTeeProduct(
  input: Record<string, string | string[] | undefined>,
  handle = "bent-shirt",
) {
  const selectedOptions = getSelectedProductOptions({
    searchParams: toURLSearchParams(input),
  });
  const product = await fetchForeverTeeProduct(
    handle,
    shopifyI18n.country,
    shopifyI18n.language,
  );
  if (!product) return product;
  // Preserve exact server resolution if a future catalogue exceeds our matrix.
  if (product.variants.pageInfo.hasNextPage) {
    const result = await createRequestStorefrontClient({
      headers: new Headers(),
    }).storefrontClient.graphql(PRODUCT_QUERY, {
      variables: { handle, selectedOptions },
    });
    if (result.errors?.length)
      throw new Error("Storefront product query failed.");
    const serverProduct = result.data?.product;
    return serverProduct
      ? normalizeProductVariants(serverProduct, selectedOptions, true)
      : serverProduct;
  }
  return normalizeProductVariants(product, selectedOptions);
}

async function fetchForeverTeeProduct(
  handle: string,
  country: typeof shopifyI18n.country,
  language: typeof shopifyI18n.language,
) {
  // Short-lived display data; cart and checkout retain their live validation.

  const storefrontClient = createRequestStorefrontClient(
    {
      headers: new Headers(),
    },
    { country, language },
  ).storefrontClient;
  const result = await storefrontClient.graphql(PRODUCT_QUERY, {
    variables: { handle, selectedOptions: [] },
  });
  if (result.errors?.length)
    throw new Error("Storefront product query failed.");
  return result.data?.product;
}

function normalizeProductVariants(
  product: QueriedProductData,
  selectedOptions: readonly SelectedOption[] = [],
  serverResolved = false,
): ProductData {
  const { variants, ...productData } = product;
  const byId = new Map(variants.nodes.map((variant) => [variant.id, variant]));
  const requiresSizeSelection = requiresExplicitSizeSelection(
    product.options,
    selectedOptions,
  );
  const knownOptions = selectedOptions.filter((selected) =>
    product.options.some(
      (option) => option.name.toLowerCase() === selected.name.toLowerCase(),
    ),
  );
  const matching = variants.nodes.filter((variant) =>
    knownOptions.every((selected) =>
      variant.selectedOptions.some(
        (option) =>
          option.name.toLowerCase() === selected.name.toLowerCase() &&
          option.value.toLowerCase() === selected.value.toLowerCase(),
      ),
    ),
  );
  const selectedVariant =
    serverResolved || knownOptions.length === 0
      ? productData.selectedOrFirstAvailableVariant
      : (matching.find((variant) => variant.availableForSale) ??
        matching[0] ??
        null);

  return {
    ...productData,
    adjacentVariants: [...byId.values()],
    selectedOrFirstAvailableVariant: requiresSizeSelection
      ? null
      : selectedVariant,
  };
}

function toURLSearchParams(
  input: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params;
}
