import { captureClientException, captureStorefrontFailure, type ClientFailureContext } from "@/client/posthog";
import {
  ProductSchema,
  ConfiguredProductFamilyResponseSchema,
  type CreateConfiguredProductRequest,
  type CreateConfiguredProductFamilyRequest,
} from "@forever-tee/contracts/product";
import { Schema } from "effect";

import {
  designVersion,
  forgetDesignVersion,
} from "@/client/effect-design-api";

class PrintQualityError extends Error {
  readonly retryable = false;
}

export async function createConfiguredProductFamily(input: CreateConfiguredProductFamilyRequest) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedVersion = await designVersion(input.designId);
    const response = await productFetch("/api/configured-product-families", "configured_product_family_creation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, expectedVersion }),
    });
    if (response.ok) {
      const family = await decodeResponse(response, ConfiguredProductFamilyResponseSchema, "configured_product_family_creation");
      forgetDesignVersion(input.designId);
      return family.products;
    }
    if (attempt === 0 && response.status === 409) {
      forgetDesignVersion(input.designId);
      continue;
    }
    captureStorefrontFailure({ operation: "configured_product_family_creation", status: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined });
    if (response.status === 422) {
      throw new PrintQualityError("Zoom out or use a higher-resolution photo to create both products.");
    }
    throw new Error("The configured products could not be created.");
  }
  throw new Error("The configured product family retry limit was reached.");
}

export async function createConfiguredProduct(input: CreateConfiguredProductRequest) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const expectedVersion = await designVersion(input.designId);
    const response = await productFetch("/api/configured-products", "configured_product_creation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, expectedVersion }),
    });
    if (response.ok) {
      return decodeResponse(response, ProductSchema, "configured_product_creation");
    }
    if (attempt === 0 && response.status === 409) {
      forgetDesignVersion(input.designId);
      continue;
    }
    captureStorefrontFailure({ operation: "configured_product_creation", status: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined });
    throw new Error("The configured product could not be created.");
  }
  throw new Error("The configured product retry limit was reached.");
}

async function productFetch(path: string, operation: ClientFailureContext["operation"], init: RequestInit) {
  try {
    return await fetch(path, init);
  } catch (error) {
    captureStorefrontFailure({ operation, status: 0, code: "NETWORK_ERROR" });
    if (error instanceof Error) captureClientException(error, { operation, status: 0 });
    throw error;
  }
}

async function decodeResponse<A, I>(response: Response, schema: Schema.Schema<A, I>, operation: ClientFailureContext["operation"]) {
  try {
    return Schema.decodeUnknownSync(schema)(await response.json());
  } catch (error) {
    const context = { operation, status: response.status, code: "INVALID_RESPONSE", requestId: response.headers.get("x-request-id") ?? undefined };
    captureStorefrontFailure(context);
    if (error instanceof Error) captureClientException(error, context);
    throw error;
  }
}
