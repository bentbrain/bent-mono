import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";

import {
  createPrintAssetDeliveryUrl,
  handlePrintAssetDeliveryRequest,
  printAssetGrantExpiry,
} from "./print-asset-delivery";

const ASSET_ID = "f0584c5e-0583-453a-8f85-4fb53faabbd8";
const OTHER_ASSET_ID = "c9a4d42a-1a5c-4a26-b537-dd1d4ba5a983";
const NOW = 1_788_000_000_000;
const SECRET = "printify-asset-delivery-test-secret-value";
const STORAGE_KEY = `print-assets/${ASSET_ID}.png`;
const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
let platform: PlatformProxy<Env> | undefined;

function testPlatform() {
  if (!platform) throw new Error("Test bindings are unavailable.");
  return platform;
}

function testEnv() {
  return {
    DB: testPlatform().env.DB,
    DESIGN_ARTWORK: testPlatform().env.DESIGN_ARTWORK,
    PRINTIFY_API_TOKEN: "printify-test-token",
    PRINTIFY_ASSET_DELIVERY_SECRET: SECRET,
    PRINTIFY_ASSET_ORIGIN: "https://api.example.test",
    PRINTIFY_SHOP_ID: "12345",
  };
}

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ environment: "", persist: false });
  await testPlatform().env.DB.prepare(`
    CREATE TABLE print_asset_objects (
      sha256 text PRIMARY KEY NOT NULL,
      storage_key text NOT NULL UNIQUE,
      content_type text NOT NULL,
      byte_size integer NOT NULL,
      width_px integer NOT NULL,
      height_px integer NOT NULL,
      created_at integer NOT NULL
    )
  `).run();
  await testPlatform().env.DB.prepare(`
    CREATE TABLE print_assets (
      id text PRIMARY KEY NOT NULL,
      storage_key text,
      content_type text,
      byte_size integer,
      sha256 text,
      object_sha256 text REFERENCES print_asset_objects(sha256),
      status text NOT NULL
    )
  `).run();
});

beforeEach(async () => {
  await testPlatform().env.DB.prepare("DELETE FROM print_assets").run();
  await testPlatform().env.DB.prepare("DELETE FROM print_asset_objects").run();
  await testPlatform().env.DESIGN_ARTWORK.delete(STORAGE_KEY);
});

afterAll(async () => platform?.dispose());

describe("Printify print-asset delivery", () => {
  it("serves only the exact ready R2 object authorized by the grant", async () => {
    const digest = await sha256Digest(BYTES);
    const sha256 = bytesToHex(new Uint8Array(digest));
    await testPlatform().env.DESIGN_ARTWORK.put(STORAGE_KEY, BYTES, {
      sha256: digest,
    });
    await insertAsset(sha256, BYTES.byteLength);
    const url = await deliveryUrl(ASSET_ID, sha256, NOW);

    const response = await handlePrintAssetDeliveryRequest(
      new Request(url),
      testEnv(),
      () => NOW + 1_000,
    );

    if (!response) throw new Error("Asset handler did not handle the request.");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("rejects expired and cross-asset grants before reading storage", async () => {
    const sha256 = bytesToHex(new Uint8Array(await sha256Digest(BYTES)));
    const url = await deliveryUrl(ASSET_ID, sha256, NOW);
    const crossed = new URL(url);
    crossed.pathname = `/v2/print-assets/${OTHER_ASSET_ID}/download`;

    const expired = await handlePrintAssetDeliveryRequest(
      new Request(url),
      testEnv(),
      () => printAssetGrantExpiry(NOW),
    );
    const wrongAsset = await handlePrintAssetDeliveryRequest(
      new Request(crossed),
      testEnv(),
      () => NOW + 1_000,
    );

    expect(expired?.status).toBe(401);
    expect(wrongAsset?.status).toBe(401);
  });

  it("fails closed when D1 and R2 disagree", async () => {
    const sha256 = bytesToHex(new Uint8Array(await sha256Digest(BYTES)));
    const wrongBytes = new Uint8Array([...BYTES, 9]);
    await testPlatform().env.DESIGN_ARTWORK.put(
      STORAGE_KEY,
      wrongBytes,
      { sha256: await sha256Digest(wrongBytes) },
    );
    await insertAsset(sha256, BYTES.byteLength);

    const response = await handlePrintAssetDeliveryRequest(
      new Request(await deliveryUrl(ASSET_ID, sha256, NOW)),
      testEnv(),
      () => NOW + 1_000,
    );

    expect(response?.status).toBe(503);
  });
});

function deliveryUrl(assetId: string, sha256: string, issuedAt: number) {
  return createPrintAssetDeliveryUrl(
    "https://api.example.test",
    {
      assetId,
      expiresAt: printAssetGrantExpiry(issuedAt),
      issuedAt,
      sha256,
    },
    SECRET,
  );
}

function insertAsset(sha256: string, byteSize: number) {
  return testPlatform().env.DB.batch([
    testPlatform().env.DB.prepare(`
      INSERT INTO print_asset_objects (
        sha256, storage_key, content_type, byte_size, width_px, height_px,
        created_at
      ) VALUES (?, ?, 'image/png', ?, 1, 1, ?)
    `).bind(sha256, STORAGE_KEY, byteSize, NOW),
    testPlatform().env.DB.prepare(`
      INSERT INTO print_assets (
        id, storage_key, content_type, byte_size, sha256, object_sha256, status
      ) VALUES (?, ?, 'image/png', ?, ?, ?, 'ready')
    `).bind(ASSET_ID, STORAGE_KEY, byteSize, sha256, sha256),
  ]);
}

function sha256Digest(bytes: Uint8Array) {
  return crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
