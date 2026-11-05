import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const appRequire = createRequire(import.meta.url);
const clerkRequire = createRequire(appRequire.resolve("@clerk/ui"));

function dependencyContext(parentRequire, name) {
  return createRequire(parentRequire.resolve(name));
}

test("Clerk wallet dependencies retain JSON-RPC loading and request semantics", async () => {
  const solanaRequire = dependencyContext(clerkRequire, "@solana/web3.js");
  assert.doesNotThrow(() => solanaRequire("jayson"));
  const { Connection, PublicKey } = clerkRequire("@solana/web3.js");
  const requests = [];
  const connection = new Connection("https://rpc.example.invalid", {
    disableRetryOnRateLimit: true,
    fetch: async (_input, init) => {
      assert.equal(typeof init.body, "string");
      const request = JSON.parse(init.body);
      requests.push(request);
      const response = request.method === "getBalance"
        ? { jsonrpc: "2.0", id: request.id, result: { context: { slot: 12 }, value: 12345 } }
        : { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture rejected" } };
      return globalThis.Response.json(response);
    },
  });
  assert.equal(await connection.getBalance(new PublicKey("11111111111111111111111111111111")), 12345);
  await assert.rejects(connection.getBlockHeight(), /fixture rejected/);
  assert.deepEqual(requests.map((request) => request.method), ["getBalance", "getBlockHeight"]);
  for (const request of requests) {
    assert.equal(request.jsonrpc, "2.0");
    assert.match(request.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  }
  assert.notEqual(requests[0].id, requests[1].id);
});

test("Clerk native-wallet dependencies retain Metro asset file parsing", async () => {
  let require = clerkRequire;
  for (const dependency of ["@solana/wallet-adapter-react", "@solana-mobile/wallet-adapter-mobile", "react-native", "@react-native/community-cli-plugin"]) {
    require = dependencyContext(require, dependency);
  }
  const { getAssetData } = require("metro/private/Assets");
  const directory = await mkdtemp(join(tmpdir(), "bridge-asset-compat-"));
  const file = join(directory, "pixel.png");
  try {
    await writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz0AAAAASUVORK5CYII=", "base64"));
    const asset = await getAssetData(file, "pixel.png", [], null, "/assets");
    assert.equal(asset.width, 1);
    assert.equal(asset.height, 1);
    assert.equal(asset.type, "png");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
