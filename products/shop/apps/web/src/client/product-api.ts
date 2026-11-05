import type { CreateConfiguredProductFamilyRequest } from "@forever-tee/contracts";

export async function createConfiguredProductFamily(input: CreateConfiguredProductFamilyRequest) {
  const client = await import("@/client/effect-product-api");
  return client.createConfiguredProductFamily(input);
}
