import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageRecipe } from "@forever-tee/product-image-renderer";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProductImageV5Fixture, fixtureBinding, fixtureEvent, fixtureRecipe, hash, syntheticSources } from "../../../../../../../scripts/testing/product-image-v5-fixtures.mjs";

const { runtime } = vi.hoisted(() => ({ runtime: { apiOrigin: "" } }));
vi.mock("@/env", () => ({ env: {
  FOREVER_TEE_API_SHARED_SECRET: "synthetic-service-secret",
  get FOREVER_TEE_API_URL() { return runtime.apiOrigin; },
} }));
import { GET, POST } from "./route";

const root = fileURLToPath(new URL("../../../../../../../../../", import.meta.url));
const packager = join(root, "products/shop/scripts/testing/product-image-v5-capsule.mjs");
const smoke = join(root, "products/shop/scripts/testing/product-image-v5-smoke.mjs");
let directory: string, capsule: string, sources: Awaited<ReturnType<typeof syntheticSources>>;
const evidence: unknown[] = [];
function command(file: string, args: string[], input?: string, env = process.env) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => { resolve({ stdout, stderr, code }); });
    child.stdin.end(input);
  });
}
function httpRequest() {
  return new Request("https://shop.test/api/internal/product-image-render", {
    method: "POST", headers: { "x-forever-tee-service-secret": "synthetic-service-secret" },
    body: JSON.stringify(fixtureEvent()),
  });
}
async function native(fixture: Awaited<ReturnType<typeof createProductImageV5Fixture>>) {
  const buildId = hash(await readFile(join(capsule, "capsule-manifest.json")));
  return command(process.execPath, [smoke, capsule], JSON.stringify(fixtureEvent()), {
    ...process.env, SHOP_PRODUCT_IMAGE_V5_BINDING_JSON: JSON.stringify(fixtureBinding(fixture.origin, buildId)),
  });
}
beforeAll(async () => {
  directory = await mkdtemp(join(process.env["SHOP_NATIVE_V5_EVIDENCE_DIR"] ?? tmpdir(), "native-v5-parity-"));
  capsule = join(directory, "capsule");
  const packaged = await command(process.execPath, [packager, capsule]);
  expect(packaged.code, packaged.stderr).toBe(0);
  sources = await syntheticSources();
}, 30000);
afterAll(async () => {
  if (!directory) return;
  if (process.env["SHOP_NATIVE_V5_EVIDENCE_DIR"])
    await writeFile(join(directory, "parity.private.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  else await rm(directory, { recursive: true, force: true });
});
const variants: { color: ImageRecipe["color"]; view: ImageRecipe["view"]; slug: ImageRecipe["baseProductSlug"] }[] = [
  { color: "White", view: "flat", slug: "staple-tee" },
  { color: "Black", view: "flat", slug: "staple-tee" },
  { color: "White", view: "lifestyle", slug: "staple-tee" },
  { color: "Black", view: "lifestyle", slug: "staple-tee" },
  { color: "Cream", view: "flat", slug: "cotton-tote" },
  { color: "Black", view: "flat", slug: "cotton-tote" },
];
describe("real Sharp HTTP and packaged native-entry parity", () => {
  for (const sourceName of ["png", "jpeg", "webp", "exifJpeg"])
    for (const depth of [0, 4])
      for (const variant of variants)
        it(`${sourceName} ${variant.slug} ${variant.color} ${variant.view} depth ${String(depth)}`, async () => {
          const source = sourceName === "png" ? sources.png : sourceName === "jpeg" ? sources.jpeg : sourceName === "webp" ? sources.webp : sources.exifJpeg;
          const recipe = fixtureRecipe(variant.color, variant.view, variant.slug, depth);
          const http = await createProductImageV5Fixture({ source, recipe });
          const lambda = await createProductImageV5Fixture({ source, recipe });
          try {
            runtime.apiOrigin = http.origin;
            const response = await POST(httpRequest());
            const result = await native(lambda);
            expect(response.status).toBe(200);
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(result.code, result.stderr).toBe(0);
            expect(http.publications).toHaveLength(1);
            expect(lambda.publications).toHaveLength(1);
            const observed = http.publications[0], expected = lambda.publications[0];
            if (!observed || !expected) throw new Error("Missing real render publication.");
            expect(observed.bytes).toEqual(expected.bytes);
            const metadata = await sharp(expected.bytes).metadata();
            expect(metadata.format).toBe("webp");
            expect(metadata.width).toBe(768);
            expect(metadata.height).toBe(variant.view === "flat" ? 768 : 1024);
            expect(await response.json()).toMatchObject({ key: recipe.storageKey, sha256: expected.sha256, size: expected.bytes.length });
            evidence.push({ sourceName, sourceSha256: hash(source), variant, depth, outputSha256: expected.sha256, outputBytes: expected.bytes.length, width: metadata.width, height: metadata.height, byteParity: true, nativeEntry: "packaged-exported-handler" });
          }
          finally { await http.close(); await lambda.close(); }
        }, 15000);
});
it("base-image-only ignores nonzero recursive depth in both actual transports", async () => {
  const recipe = fixtureRecipe("Black", "lifestyle", "staple-tee", 8, "base-image-only");
  const http = await createProductImageV5Fixture({ source: sources.png, recipe });
  const lambda = await createProductImageV5Fixture({ source: sources.png, recipe });
  const depthZero = await createProductImageV5Fixture({ source: sources.png, recipe: fixtureRecipe("Black", "lifestyle", "staple-tee", 0) });
  try {
    runtime.apiOrigin = http.origin;
    expect((await POST(httpRequest())).status).toBe(200);
    expect((await native(lambda)).code).toBe(0);
    expect((await native(depthZero)).code).toBe(0);
    expect(http.stored).toEqual(lambda.stored);
    expect(lambda.stored).toEqual(depthZero.stored);
  }
  finally { await http.close(); await lambda.close(); await depthZero.close(); }
});
const fullSourceFormats: ("jpeg" | "png")[] = ["jpeg", "png"];
it.each(fullSourceFormats)("renders full 50 MP %s artwork through both actual transports", async format => {
  const source = await sharp({
    create: { width: 10000, height: 5000, channels: 4, background: "#126acc" },
  }).toFormat(format).toBuffer();
  const http = await createProductImageV5Fixture({ source });
  const lambda = await createProductImageV5Fixture({ source });
  try {
    runtime.apiOrigin = http.origin;
    const response = await POST(httpRequest()), result = await native(lambda);
    expect(response.status).toBe(200);
    expect(result.code, result.stderr).toBe(0);
    expect(http.publications).toHaveLength(1);
    expect(lambda.publications).toHaveLength(1);
    expect(http.stored).toEqual(lambda.stored);
    expect(http.failures).toHaveLength(0);
    expect(lambda.failures).toHaveLength(0);
    evidence.push({ mode: "full-50mp-source", format, sourceSha256: hash(source), sourceBytes: source.length,
      sourceWidth: 10000, sourceHeight: 5000, outputSha256: lambda.publications[0]?.sha256, byteParity: true });
  }
  finally { await http.close(); await lambda.close(); }
}, 15000);
it("rejects artwork above 50 MP through both actual transports before publication", async () => {
  const source = await sharp({
    create: { width: 10000, height: 5001, channels: 3, background: "#126acc" },
  }).jpeg().toBuffer();
  const http = await createProductImageV5Fixture({ source });
  const lambda = await createProductImageV5Fixture({ source });
  try {
    runtime.apiOrigin = http.origin;
    expect((await POST(httpRequest())).status).toBe(503);
    expect((await native(lambda)).code).toBe(1);
    for (const fixture of [http, lambda]) {
      expect(fixture.publications).toHaveLength(0);
      expect(fixture.failures).toHaveLength(1);
      expect(fixture.failures[0]?.owned).toBe(true);
    }
    evidence.push({ mode: "above-50mp-source", sourceSha256: hash(source), sourceWidth: 10000,
      sourceHeight: 5001, httpStatus: 503, nativeExitCode: 1, publications: 0 });
  }
  finally { await http.close(); await lambda.close(); }
}, 15000);
it.each(["legacy-claim", "duplicate", "lost-ack", "truncated-ack", "storage-error"])("preserves transfer/retry behavior in actual transports: %s", async mode => {
  const http = await createProductImageV5Fixture({ source: sources.png, mode });
  const lambda = await createProductImageV5Fixture({ source: sources.png, mode });
  try {
    runtime.apiOrigin = http.origin;
    const response = await POST(httpRequest()), result = await native(lambda);
    expect(response.status).toBe(200);
    expect(result.code, result.stderr).toBe(0);
    expect(http.failures).toHaveLength(0);
    expect(lambda.failures).toHaveLength(0);
    if (mode === "duplicate") {
      expect(http.calls).toHaveLength(1);
      expect(lambda.calls).toHaveLength(1);
      expect(http.publications).toHaveLength(0);
      expect(lambda.publications).toHaveLength(0);
      expect(await response.json()).toEqual({ status: "skipped", jobId: fixtureEvent().jobId });
    }
    else {
      expect(http.stored).toEqual(lambda.stored);
      if (mode !== "legacy-claim") {
        for (const fixture of [http, lambda]) {
          expect(fixture.publications).toHaveLength(2);
          expect(fixture.publications[0]?.bytes).toEqual(fixture.publications[1]?.bytes);
          expect(new Set(fixture.calls.map(call => call.executionId)).size).toBe(1);
        }
      }
    }
    evidence.push({ mode, httpStatus: response.status, nativeExitCode: result.code, httpPublications: http.publications.length, nativePublications: lambda.publications.length, sameBytes: http.stored?.equals(lambda.stored ?? Buffer.alloc(0)) });
  }
  finally { await http.close(); await lambda.close(); }
}, 15000);
it.each(["bad-source", "missing-hash", "invalid-recipe", "oversize-recipe", "bad-ack-key", "bad-ack-hash", "bad-ack-size", "late-publication", "redirect", "claim-failure", "reject-403", "reject-409", "reject-429", "reject-500", "oversize-ack"])("fails and reports the same execution fence: %s", async mode => {
  const http = await createProductImageV5Fixture({ source: sources.png, mode });
  const lambda = await createProductImageV5Fixture({ source: sources.png, mode });
  try {
    runtime.apiOrigin = http.origin;
    const response = await POST(httpRequest()), result = await native(lambda);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "IMAGE_RENDER_UNAVAILABLE" });
    expect(result.code).toBe(1);
    for (const fixture of [http, lambda]) {
      expect(new Set(fixture.calls.map(call => call.executionId)).size).toBe(1);
      expect(fixture.failures).toHaveLength(mode === "redirect" ? 0 : 1);
      if (["bad-source", "missing-hash", "invalid-recipe", "oversize-recipe", "redirect", "claim-failure"].includes(mode))
        expect(fixture.publications).toHaveLength(0);
    }
    expect(result.stdout + result.stderr).not.toContain(fixtureEvent().grant);
    evidence.push({ mode, httpStatus: response.status, nativeExitCode: result.code, httpPublications: http.publications.length, nativePublications: lambda.publications.length });
  }
  finally { await http.close(); await lambda.close(); }
}, 15000);
it("keeps authenticated GET version and rejects an unauthorized service request before transfer", async () => {
  const fixture = await createProductImageV5Fixture({ source: sources.png });
  try {
    runtime.apiOrigin = fixture.origin;
    expect(GET(new Request("https://shop.test")).status).toBe(401);
    const get = GET(new Request("https://shop.test", { headers: { "x-forever-tee-service-secret": "synthetic-service-secret" } }));
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await get.json()).toEqual({ rendererVersion: "product-images-v5" });
    expect((await POST(new Request("https://shop.test", { method: "POST", body: "invalid" }))).status).toBe(401);
    expect(fixture.calls).toHaveLength(0);
  }
  finally { await fixture.close(); }
});
it("binds every installed capsule file and rejects a changed runtime module", async () => {
  const handlerPath = join(capsule, "product-image-v5-handler.mjs");
  const original = await readFile(handlerPath);
  const fixture = await createProductImageV5Fixture({ source: sources.png });
  try {
    await writeFile(handlerPath, Buffer.concat([original, Buffer.from("\n// changed\n")]));
    const result = await native(fixture);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(fixture.calls).toHaveLength(0);
  }
  finally { await writeFile(handlerPath, original); await fixture.close(); }
});

it("keeps PNG/WebP alpha and the synthetic JPEG EXIF orientation in its source fixtures", async () => {
  expect((await sharp(sources.png).metadata()).hasAlpha).toBe(true);
  expect((await sharp(sources.webp).metadata()).hasAlpha).toBe(true);
  expect((await sharp(sources.exifJpeg).metadata()).orientation).toBe(6);
});
it.each(["oversize-source", "invalid-source"])("rejects unusable source data through both actual transports: %s", async mode => {
  const source = mode === "oversize-source" ? Buffer.alloc(25000001, 7) : Buffer.from("synthetic invalid image");
  const http = await createProductImageV5Fixture({ source });
  const lambda = await createProductImageV5Fixture({ source });
  try {
    runtime.apiOrigin = http.origin;
    expect((await POST(httpRequest())).status).toBe(503);
    const result = await native(lambda);
    expect(result.code).toBe(1);
    for (const fixture of [http, lambda]) {
      expect(fixture.publications).toHaveLength(0);
      expect(fixture.failures).toHaveLength(1);
      expect(fixture.failures[0]?.owned).toBe(true);
    }
    evidence.push({ mode, httpStatus: 503, nativeExitCode: result.code, publications: 0 });
  }
  finally { await http.close(); await lambda.close(); }
}, 15000);
it("enforces the actual 25-second claim deadline in the HTTP wrapper and packaged native entry", async () => {
  const http = await createProductImageV5Fixture({ source: sources.png, mode: "claim-timeout" });
  const lambda = await createProductImageV5Fixture({ source: sources.png, mode: "claim-timeout" });
  try {
    runtime.apiOrigin = http.origin;
    const started = performance.now();
    const [response, result] = await Promise.all([POST(httpRequest()), native(lambda)]);
    const elapsedMs = performance.now() - started;
    expect(response.status).toBe(503);
    expect(result.code).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(24000);
    expect(elapsedMs).toBeLessThan(30000);
    for (const fixture of [http, lambda]) {
      expect(fixture.calls).toHaveLength(1);
      expect(fixture.publications).toHaveLength(0);
      expect(fixture.failures).toHaveLength(0);
    }
    evidence.push({ mode: "actual-claim-timeout", elapsedMs, httpStatus: response.status, nativeExitCode: result.code });
  }
  finally { await http.close(); await lambda.close(); }
}, 35000);

it("the actual capsule entry rejects a mismatched installed build identity before claiming", async () => {
  const fixture = await createProductImageV5Fixture({ source: sources.png });
  try {
    const result = await command(process.execPath, [smoke, capsule], JSON.stringify(fixtureEvent()), {
      ...process.env, SHOP_PRODUCT_IMAGE_V5_BINDING_JSON: JSON.stringify(fixtureBinding(fixture.origin, "0".repeat(64))),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("binding does not match");
    expect(fixture.calls).toHaveLength(0);
  }
  finally { await fixture.close(); }
});
