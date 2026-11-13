import "@tanstack/react-start/server-only";

import { env } from "@/server/runtime-env";

const VARIANT_UNAVAILABLE_MESSAGE =
  "That colour and size is currently unavailable. Please choose another option.";

export class VariantMappingDependencyError extends Error {}
export class VariantUnavailableError extends Error {}
export class PrintAssetsPendingError extends Error {}

export async function revalidateCartLineCapability(
  capability: string,
  configuredProductId: string,
  merchandiseId: string,
  quantity: number,
) {
  const response = await capabilityRequest({
    capability,
    configuredProductId,
    merchandiseId,
    quantity,
  });
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => undefined);
    if (
      isRecord(payload) &&
      isRecord(payload["error"]) &&
      payload["error"]["code"] === "PRINT_ASSETS_PENDING"
    ) {
      throw new PrintAssetsPendingError(
        "Your artwork is still being prepared. Checkout will be available shortly.",
      );
    }
    throw new VariantUnavailableError(
      "This cart item changed and must be added again.",
    );
  }
  if (!response.ok) {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  if (!isRecord(payload) || payload["valid"] !== true) {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  if (capability.startsWith("i1.")) {
    if (
      !isCapabilityPayload(payload) ||
      !payload.capability.startsWith("v1.")
    ) {
      throw new VariantMappingDependencyError(
        "Print-ready product identity could not be verified.",
      );
    }
    return payload.capability;
  }
  return undefined;
}

export async function issueCartLineCapability(
  configuredProductId: string,
  merchandiseId: string,
  quantity: number,
) {
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await capabilityRequest({
      allowPending: true,
      configuredProductId,
      merchandiseId,
      quantity,
    });
  } catch {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  if (response.status === 409) {
    const payload: unknown = await response.json().catch(() => undefined);
    if (
      isRecord(payload) &&
      isRecord(payload["error"]) &&
      payload["error"]["code"] === "PRINT_ASSETS_PENDING"
    ) {
      throw new VariantMappingDependencyError(
        "Your artwork is still being prepared. Please try again shortly.",
      );
    }
    throw new VariantUnavailableError(VARIANT_UNAVAILABLE_MESSAGE);
  }
  if (!response.ok) {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  if (!isCapabilityPayload(payload)) {
    throw new VariantMappingDependencyError(
      "Print-ready product identity could not be verified.",
    );
  }
  return payload.capability;
}

function capabilityRequest(payload: Record<string, unknown>) {
  const url = new URL(
    "/v2/internal/cart-line-capabilities",
    `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`,
  );
  return fetch(url, {
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET,
    },
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
}

export async function assertMappedVariantAvailable(
  merchandiseId: string,
  baseHandle: string,
) {
  const url = new URL(
    "/v2/internal/variant-mapping",
    `${env.FOREVER_TEE_API_URL.replace(/\/$/, "")}/`,
  );
  url.searchParams.set("merchandiseId", merchandiseId);
  url.searchParams.set("baseHandle", baseHandle);
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(url, {
      headers: {
        "x-forever-tee-service-secret": env.FOREVER_TEE_API_SHARED_SECRET,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new VariantMappingDependencyError(
      "Product availability could not be verified.",
    );
  }
  if (!response.ok) {
    throw new VariantMappingDependencyError(
      "Product availability could not be verified.",
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VariantMappingDependencyError(
      "Product availability could not be verified.",
    );
  }
  if (
    !isMappingPayload(payload) ||
    payload.shopifyVariantId !== merchandiseId
  ) {
    throw new VariantMappingDependencyError(
      "Product availability could not be verified.",
    );
  }
  if (!payload.available) {
    throw new VariantUnavailableError(VARIANT_UNAVAILABLE_MESSAGE);
  }
}

function isMappingPayload(
  value: unknown,
): value is { available: boolean; shopifyVariantId: string } {
  return (
    isRecord(value) &&
    typeof value["available"] === "boolean" &&
    typeof value["shopifyVariantId"] === "string"
  );
}

function isCapabilityPayload(value: unknown): value is { capability: string } {
  return (
    isRecord(value) &&
    typeof value["capability"] === "string" &&
    value["capability"].length > 0 &&
    value["capability"].length <= 500
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
