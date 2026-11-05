import "server-only";

import type { StorefrontClient } from "@shopify/hydrogen";

import {
  CartIntegrityError,
  type CartLineSnapshot,
  type CartSnapshot,
  validateVariantCandidate,
} from "@/lib/cart-integrity";
import {
  CART_INTEGRITY_QUERY,
  CART_VARIANT_INTEGRITY_QUERY,
} from "@/lib/cart-query";
import {
  assertMappedVariantAvailable,
  VariantMappingDependencyError,
  VariantUnavailableError,
} from "@/server/variant-mapping";

export class CartDependencyError extends Error {}

export async function readVerifiedCart(
  storefrontClient: StorefrontClient,
  cartId: string,
): Promise<CartSnapshot> {
  const result = await storefrontClient.graphql(CART_INTEGRITY_QUERY, {
    variables: { cartId },
  });
  if (result.errors) {
    throw new CartDependencyError("Shopify could not verify the cart.");
  }
  const cart = result.data.cart;
  if (cart?.id !== cartId) {
    throw new CartIntegrityError("The cart is unavailable.");
  }
  return {
    id: cart.id,
    lines: cart.lines.nodes.map((line): CartLineSnapshot => ({
      attributes: line.attributes.flatMap(({ key, value }) =>
        value === null ? [] : [{ key, value }]
      ),
      id: line.id,
      merchandiseId: line.merchandise.id,
      quantity: line.quantity,
      ...(line.sellingPlanAllocation?.sellingPlan.id
        ? { sellingPlanId: line.sellingPlanAllocation.sellingPlan.id }
        : {}),
    })),
    totalQuantity: cart.totalQuantity,
  };
}

export async function readVerifiedCartForAdd(
  storefrontClient: StorefrontClient,
  cartId: string,
): Promise<CartSnapshot | undefined> {
  try {
    return await readVerifiedCart(storefrontClient, cartId);
  } catch (error) {
    if (error instanceof CartIntegrityError) return undefined;
    throw error;
  }
}

export async function verifyShopifyVariant(
  storefrontClient: StorefrontClient,
  merchandiseId: string,
  baseShopifyHandle: string,
  sellingPlanId: string | undefined,
) {
  const result = await storefrontClient.graphql(
    CART_VARIANT_INTEGRITY_QUERY,
    { variables: { baseHandle: baseShopifyHandle, merchandiseId } },
  );
  if (result.errors) {
    throw new CartDependencyError("Shopify could not verify the product.");
  }
  const merchandise = result.data.merchandise;
  const baseProductId = result.data.baseProduct?.id;
  validateVariantCandidate(
    {
      availableForSale:
        merchandise?.__typename === "ProductVariant" &&
        merchandise.availableForSale,
      ...(baseProductId ? { baseProductId } : {}),
      productId:
        merchandise?.__typename === "ProductVariant"
          ? merchandise.product.id
          : "",
      requiresSellingPlan:
        merchandise?.__typename === "ProductVariant" &&
        merchandise.product.requiresSellingPlan,
      sellingPlanIds:
        merchandise?.__typename === "ProductVariant"
          ? merchandise.sellingPlanAllocations.nodes.map(
              ({ sellingPlan }) => sellingPlan.id,
            )
          : [],
      typeName: merchandise?.__typename ?? "Unknown",
    },
    sellingPlanId,
  );
  try {
    await assertMappedVariantAvailable(merchandiseId, baseShopifyHandle);
  } catch (error) {
    if (error instanceof VariantUnavailableError) {
      throw new CartIntegrityError(error.message);
    }
    if (error instanceof VariantMappingDependencyError) {
      throw new CartDependencyError(error.message);
    }
    throw error;
  }
}
