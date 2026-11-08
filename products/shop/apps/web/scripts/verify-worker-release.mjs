import { ARTWORK_MEDIA_CAPABILITY } from "../../../scripts/artwork-media-compatibility.mjs";
import { pathToFileURL } from "node:url";

export const EXPECTED_RELEASE = "bent-shirt-pilot-m2-v1";
export const REQUIRED_CAPABILITIES = [
  "cart-product-context-v1",
  "anonymous-drafts-v2",
  ARTWORK_MEDIA_CAPABILITY,
  "saved-designs-v1",
  "saved-design-pages-v1",
  "order-management-v1",
  "featured-products-v1",
  "immutable-product-snapshots-v1",
  "printify-catalogue-snapshots-v1",
  "portrait-safety-screening-v1",
  "product-projections-v1",
  "sales-pause-v1",
  "shopify-printify-variant-mapping-v1",
];

export async function enforceWorkerRelease({
  enforcement,
  apiUrl,
  sharedSecret,
  fetcher = fetch,
}) {
  if (enforcement === undefined) return;
  if (enforcement !== "1") {
    throw new Error(
      "FOREVER_TEE_ENFORCE_WORKER_RELEASE must be exactly 1 when configured.",
    );
  }
  if (!apiUrl || !sharedSecret) {
    throw new Error(
      "Production Worker release verification requires its URL and shared secret.",
    );
  }

  const url = new URL(
    "/v2/internal/capabilities",
    `${apiUrl.replace(/\/$/, "")}/`,
  );
  const response = await fetcher(url, {
    headers: { "x-forever-tee-service-secret": sharedSecret },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const payload = response.ok
    ? await response.json().catch(() => undefined)
    : undefined;
  if (
    !isRecord(payload) ||
    payload["release"] !== EXPECTED_RELEASE ||
    !Array.isArray(payload["capabilities"]) ||
    !REQUIRED_CAPABILITIES.every((capability) =>
      payload["capabilities"].includes(capability)
    )
  ) {
    throw new Error(
      `Production Worker must report release ${EXPECTED_RELEASE} with every required capability before this web build can deploy.`,
    );
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await enforceWorkerRelease({
    enforcement: process.env["FOREVER_TEE_ENFORCE_WORKER_RELEASE"],
    apiUrl: process.env["FOREVER_TEE_API_URL"],
    sharedSecret: process.env["FOREVER_TEE_API_SHARED_SECRET"],
  });
}
