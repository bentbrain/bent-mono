import "@tanstack/react-start/server-only";

import { env } from "@/server/runtime-env";
import { CART_ATTRIBUTES_UPDATE_QUERY } from "@/lib/cart-query";
import { getStorefrontClient } from "@/lib/storefront";

const CAPABILITY_ATTRIBUTE = "_orderManagementCapability";

class OrderManagementCapabilityError extends Error {}

export async function bindOrderManagementCapability(
  shopifyCartId: string,
  attributes: readonly {
    readonly key: string;
    readonly value: string | null;
  }[],
) {
  const capability = await issueOrderManagementCapability(shopifyCartId);
  const storefrontClient = await getStorefrontClient();
  const nextAttributes = [
    ...attributes.flatMap(({ key, value }) =>
      key === CAPABILITY_ATTRIBUTE || value === null ? [] : [{ key, value }],
    ),
    { key: CAPABILITY_ATTRIBUTE, value: capability },
  ];
  const result = await storefrontClient.graphql(CART_ATTRIBUTES_UPDATE_QUERY, {
    variables: { attributes: nextAttributes, cartId: shopifyCartId },
  });
  if (result.errors) {
    throw new OrderManagementCapabilityError(
      "Shopify could not bind this checkout to an order.",
    );
  }
  const update = result.data.cartAttributesUpdate;
  if (!update) {
    throw new OrderManagementCapabilityError(
      "Shopify could not bind this checkout to an order.",
    );
  }
  const returnedCapabilities = update.cart?.attributes.filter(
    ({ key, value }) => key === CAPABILITY_ATTRIBUTE && value === capability,
  );
  if (
    update.cart?.id !== shopifyCartId ||
    update.userErrors.length > 0 ||
    returnedCapabilities?.length !== 1
  ) {
    throw new OrderManagementCapabilityError(
      "Shopify could not bind this checkout to an order.",
    );
  }
}

async function issueOrderManagementCapability(shopifyCartId: string) {
  const url = new URL(
    "/v2/internal/order-management-capabilities",
    `${env.FOREVER_TEE_API_URL.replace(/\/$/u, "")}/`,
  );
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      body: JSON.stringify({ shopifyCartId }),
      headers: {
        "content-type": "application/json",
        "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET,
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new OrderManagementCapabilityError(
      "Checkout order binding is unavailable.",
    );
  }
  if (!response.ok) {
    throw new OrderManagementCapabilityError(
      "Checkout order binding is unavailable.",
    );
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!isCapabilityPayload(payload)) {
    throw new OrderManagementCapabilityError(
      "Checkout order binding is unavailable.",
    );
  }
  return payload.capability;
}

function isCapabilityPayload(value: unknown): value is { capability: string } {
  return (
    isRecord(value) &&
    typeof value["capability"] === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value["capability"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
