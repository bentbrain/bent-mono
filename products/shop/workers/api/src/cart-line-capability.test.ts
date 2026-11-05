import {
  CartLineCapabilityError,
  signCartLineCapability,
  signCartLineIntent,
  verifyCartLineIntent,
  type CartLineCapabilityPayload,
  verifyCartLineCapability,
} from "@forever-tee/contracts/cart-line-capability";
import { describe, expect, it } from "vitest";

const SIGNING_SECRET = "test-cart-capability-secret-value-123456";
const NOW = 1_788_000_000_000;
const PAYLOAD: CartLineCapabilityPayload = {
  baseProductId: "07af71c7-67b6-48a6-bbc5-437589ad7f26",
  color: "Black",
  configuredProductId: "322f1f12-f5fa-46e4-9ee9-68e526578271",
  designRevisionId: "8fe42ca7-fd6d-4422-b73d-2bce5d11c28c",
  expiresAt: NOW + 15 * 60_000,
  issuedAt: NOW,
  printGeometryKey: "dtg:4150x4690",
  printAssetId: "49c0fe5d-3982-4bdd-a1ce-1813e75a59ea",
  printAssetSha256: "a".repeat(64),
  printifyVariantId: 12345,
  projectionVersion: "safe-margin-v1",
  quantity: 2,
  shopifyVariantId: "gid://shopify/ProductVariant/1234567890",
  size: "M",
  variantMappingSnapshotId: "ef5dc595-f96a-42f8-85cf-154198a2e3ec",
  version: 1,
};

describe("cart-line capabilities", () => {
  it("round-trips an immutable line identity inside Shopify's attribute limit", async () => {
    const token = await signCartLineCapability(PAYLOAD, SIGNING_SECRET);

    expect(token.length).toBeLessThanOrEqual(500);
    await expect(
      verifyCartLineCapability(token, SIGNING_SECRET, NOW + 1),
    ).resolves.toEqual(PAYLOAD);
  });

  it("rejects tampering and expiry", async () => {
    const token = await signCartLineCapability(PAYLOAD, SIGNING_SECRET);
    const lastCharacter = token.at(-1);
    const tampered = `${token.slice(0, -1)}${lastCharacter === "A" ? "B" : "A"}`;

    await expect(
      verifyCartLineCapability(tampered, SIGNING_SECRET, NOW + 1),
    ).resolves.toBeUndefined();
    await expect(
      verifyCartLineCapability(token, SIGNING_SECRET, PAYLOAD.expiresAt),
    ).resolves.toBeUndefined();

    const futureToken = await signCartLineCapability({
      ...PAYLOAD,
      expiresAt: NOW + 30 * 60_000,
      issuedAt: NOW + 15 * 60_000,
    }, SIGNING_SECRET);
    await expect(
      verifyCartLineCapability(futureToken, SIGNING_SECRET, NOW),
    ).resolves.toBeUndefined();
  });

  it("refuses an insecure signing secret", async () => {
    await expect(
      signCartLineCapability(PAYLOAD, "too-short"),
    ).rejects.toBeInstanceOf(CartLineCapabilityError);
  });
});

it("keeps pending cart intents distinct from purchase capabilities and enforces their lifetime", async () => {
  const token = await signCartLineIntent(PAYLOAD, SIGNING_SECRET);
  expect(token.length).toBeLessThanOrEqual(500);
  expect(await verifyCartLineIntent(token, SIGNING_SECRET, NOW + 1)).toMatchObject({ quantity: 2, configuredProductId: PAYLOAD.configuredProductId });
  expect(await verifyCartLineCapability(token, SIGNING_SECRET, NOW + 1)).toBeUndefined();
  expect(await verifyCartLineCapability(token.replace("i1.", "v1."), SIGNING_SECRET, NOW + 1)).toBeUndefined();
  expect(await verifyCartLineIntent(token, SIGNING_SECRET, PAYLOAD.expiresAt)).toBeUndefined();
  expect(await verifyCartLineIntent(token, SIGNING_SECRET, NOW - 1)).toBeUndefined();
  expect(await verifyCartLineIntent(token.slice(0, -4) + "AAAA", SIGNING_SECRET, NOW + 1)).toBeUndefined();
  await expect(signCartLineIntent(PAYLOAD, "short")).rejects.toThrow();
});
