import { readFile, writeFile, mkdir, readdir, chmod } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { MockAgent, setGlobalDispatcher } from "undici";
import { captureInputs } from "./proof-inputs.mjs";
import { seedCatalogue } from "./seed-fixture.mjs";
import { browserJourney } from "./browser-journey.mjs";
import { imageService } from "./image-service-fixture.mjs";
import { createShopifyFixture } from "./shopify-fixture.mjs";
import {
  fixtureBinding,
  fixtureContext,
} from "../../../scripts/testing/product-image-v5-fixtures.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(app, "../../../..");
const artifact = process.argv[2];
if (!artifact || resolve(artifact).startsWith(root + "/"))
  throw new Error(
    "Supply a private artifact directory outside the repository.",
  );
const capsule = process.argv[3];
if (!capsule)
  throw new Error("Supply the verified native v5 capsule directory.");
const manifest = await readFile(resolve(capsule, "capsule-manifest.json"));
const nativeBuildId = createHash("sha256").update(manifest).digest("hex");
let nativeHandler;
process.umask(0o077);
await mkdir(artifact, { recursive: true, mode: 0o700 });
await chmod(artifact, 0o700);
const inputManifest = await captureInputs(root, artifact);
for (const key of Object.keys(process.env))
  if (/^(AWS_|CLOUDFLARE_|CF_API_|VERCEL_|SHOP_)/.test(key))
    delete process.env[key];
const protectedFixtures = JSON.parse(
  await readFile(
    resolve(root, "products/shop/scripts/protected-config.fixtures.json"),
    "utf8",
  ),
);
process.env.SHOP_PROTECTED_CONFIG_JSON = JSON.stringify(protectedFixtures);
process.env.TMPDIR = resolve(artifact, "tmp");
await mkdir(process.env.TMPDIR, { mode: 0o700 });
const videoTasks = [];
let videoHandler;
const secret = "synthetic-storefront-service-secret-00001";
const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(/^(localhost|127\.0\.0\.1):\d+$/);
setGlobalDispatcher(agent);
const deliveredPrint = [];
const events = [];
events.push = (...items) => {
  console.log(JSON.stringify(items));
  return Array.prototype.push.apply(events, items);
};
const queue = [];
const videoQueue = [];
const blocked = [];
const shopify = createShopifyFixture(events);
let api;
let platform;
let storefront;
let releaseImages;
const imageGate = new Promise((done) => {
  releaseImages = done;
});
const outbound = async (request) => {
  const url = new URL(request.url);
  if (url.origin === "https://fixture-services.invalid") {
    if (url.pathname.startsWith("/images/"))
      return imageService(request, events);
    if (url.pathname === "/observations/native-input") {
      const bytes = Buffer.from(await request.arrayBuffer());
      const { default: sharp } = await import("sharp");
      const metadata = await sharp(bytes).metadata();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, request.headers.get("x-image-source-sha256"));
      const path = request.headers.get("x-proof-source-path");
      const jobId = path.split("/")[4];
      await writeFile(resolve(artifact, `native-input-${jobId}.bin`), bytes, {
        mode: 0o600,
      });
      events.push({
        operation: "actual-native-v5-input",
        jobId,
        path,
        sha256,
        bytes: bytes.length,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        recipe: JSON.parse(request.headers.get("x-image-recipe") || "null"),
      });
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/queue/")) {
      (url.pathname.endsWith("print") ? queue : videoQueue).push(
        await request.json(),
      );
      return new Response(null, { status: 204 });
    }
  }
  if (url.origin === "https://challenges.cloudflare.com")
    events.push({ operation: "turnstile-boundary", path: url.pathname });
  if (
    url.origin === "https://challenges.cloudflare.com" &&
    url.pathname === "/turnstile/v0/siteverify"
  )
    return Response.json({
      success: true,
      hostname: "localhost",
      action: "design_processing",
    });
  if (
    url.origin === "https://ci.myshopify.com" &&
    url.pathname.endsWith("/graphql.json")
  )
    return shopify.fetch(request);
  if (
    url.origin === protectedFixtures.previewRendererOrigin &&
    url.pathname === "/api/internal/product-image-render"
  ) {
    if (request.method === "GET")
      return Response.json({ rendererVersion: "product-images-v5" });
    const payload = await request.json();
    await imageGate;
    if (!nativeHandler) {
      process.env.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON = JSON.stringify(
        fixtureBinding((await api.url).origin, nativeBuildId),
      );
      nativeHandler = (
        await import(
          pathToFileURL(resolve(capsule, "product-image-v5-entry.mjs")).href
        )
      ).handler;
    }
    const result = await nativeHandler(
      { kind: "product-image-v5", schemaVersion: 1, ...payload },
      fixtureContext(),
    );
    events.push({
      operation: "native-v5",
      jobId: payload.jobId,
      status: result.status,
    });
    return Response.json(result, { status: 200 });
  }
  if (
    url.origin === "https://lambda.ap-southeast-2.amazonaws.com" &&
    url.pathname.includes(
      encodeURIComponent(
        `arn:aws:lambda:ap-southeast-2:${protectedFixtures.awsAccountId}:function:forever-tee-video-development`,
      ),
    )
  ) {
    const event = await request.json();
    if (!videoHandler) {
      const { createAppHandler } =
        await import("../../../workers/video-renderer/aws-lambda/app-handler.mjs");
      const { renderStoryVideo } =
        await import("../../../workers/video-renderer/src/renderer.mjs");
      const apiOrigin =
        "https://forever-tee-api-development.socialqueue.workers.dev";
      videoHandler = createAppHandler({
        apiOrigin,
        buildId: "b".repeat(64),
        render: renderStoryVideo,
        readMockup: (file) =>
          readFile(
            resolve(root, "products/shop/apps/web/public/mockups", file),
          ),
        send: async (input, init) => {
          try {
            const requested = new Request(input, init);
            const target = new URL(requested.url);
            if (target.origin !== apiOrigin)
              throw new Error("Denied native video origin");
            return await api.fetch(
              new Request(
                new URL(target.pathname + target.search, await api.url),
                {
                  method: requested.method,
                  headers: requested.headers,
                  redirect: "manual",
                  ...(!["GET", "HEAD"].includes(requested.method)
                    ? { body: await requested.arrayBuffer() }
                    : {}),
                },
              ),
            );
          } catch (error) {
            events.push({
              operation: "native-video-transport-failure",
              message: error.message,
            });
            throw error;
          }
        },
      });
    }
    const task = videoHandler(event, {
      invokedFunctionArn: `arn:aws:lambda:ap-southeast-2:${protectedFixtures.awsAccountId}:function:forever-tee-video-development`,
      awsRequestId: crypto.randomUUID(),
      getRemainingTimeInMillis: () => 120000,
    })
      .then((result) => {
        events.push({
          operation: "native-video",
          jobId: event.jobId,
          bytes: result.size,
        });
        return result;
      })
      .catch((error) => {
        events.push({
          operation: "native-video-failed",
          jobId: event.jobId,
          error: error.message,
        });
        throw error;
      });
    videoTasks.push(task);
    void task.catch(() => {});
    return new Response(null, { status: 202 });
  }
  if (api && url.origin === (await api.url).origin) return api.fetch(request);
  blocked.push({ origin: url.origin, path: url.pathname });
  throw new Error(
    `Denied outbound fixture request: ${url.origin}${url.pathname}`,
  );
};
async function config(name, main, values) {
  const path = resolve(artifact, `${name}.json`);
  await writeFile(path, JSON.stringify(values), { mode: 0o600 });
  return path;
}
try {
  const apiConfig = await config("business", null, {
    name: "storefront-local-business-proof",
    main: resolve(app, "scripts/fixture-api-worker.mjs"),
    compatibility_date: "2026-05-15",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_name: "storefront-local-proof",
        database_id: "00000000-0000-4000-8000-000000000099",
      },
    ],
    r2_buckets: [
      { binding: "DESIGN_ARTWORK", bucket_name: "storefront-proof-artwork" },
      { binding: "STORY_VIDEOS", bucket_name: "storefront-proof-videos" },
    ],
    durable_objects: {
      bindings: [
        {
          name: "STORY_VIDEO_NOTIFICATIONS",
          class_name: "StoryVideoNotifications",
        },
        { name: "PRINT_EXECUTIONS", class_name: "PrintAssetExecution" },
      ],
    },
    services: [
      {
        binding: "STORY_VIDEO_RENDERER",
        service: "business",
        entrypoint: "StoryVideoService",
      },
    ],
    migrations: [
      {
        tag: "v1",
        new_sqlite_classes: ["StoryVideoNotifications", "PrintAssetExecution"],
      },
    ],
    vars: {
      SHOP_PROTECTED_CONFIG_JSON: JSON.stringify(protectedFixtures),
      FOREVER_TEE_API_SHARED_SECRET: secret,
      BENT_SHIRT_OPERATIONS_SECRET: "synthetic-operations-secret",
      CART_LINE_CAPABILITY_SECRET: "synthetic-cart-capability-secret-00001",
      STORY_VIDEO_PROVIDER: "lambda",
      STORY_VIDEO_ENVIRONMENT: "development",
      STORY_VIDEO_FAMILY_CONFIGURATION: "1",
      STORY_VIDEO_GRANT_SECRET: "synthetic-render-grant-secret-00001",
      STORY_VIDEO_LAMBDA_FUNCTION: `arn:aws:lambda:ap-southeast-2:${protectedFixtures.awsAccountId}:function:forever-tee-video-development`,
      STORY_VIDEO_LAMBDA_ACCESS_KEY_ID: "synthetic-key-id",
      STORY_VIDEO_LAMBDA_SECRET_ACCESS_KEY: "synthetic-lambda-secret",
      PRODUCT_IMAGE_PROVIDER: "vercel",
      PRODUCT_IMAGE_RENDERER_BYPASS_SECRET: "synthetic-bypass",
      PRINT_EXECUTION_RELEASE_ID: "native-123",
      PRINT_EXECUTION_MODE: "durable-object",
      STORY_VIDEO_NOTIFICATION_MODE: "push",
      SHOPIFY_CLIENT_ID: "synthetic-client-id",
      SHOPIFY_CLIENT_SECRET: "synthetic-client-secret",
      SHOPIFY_ADMIN_STORE_DOMAIN: "ci.myshopify.com",
      PRINTIFY_API_TOKEN: "synthetic-printify-token",
      PRINTIFY_SHOP_ID: "synthetic-shop",
      PRINTIFY_ASSET_DELIVERY_SECRET:
        "synthetic-printify-delivery-secret-00001",
      PRINTIFY_ASSET_ORIGIN: "http://localhost:4517",
      PRINTIFY_WEBHOOK_SECRET: "synthetic-printify-webhook-secret-00001",
      OPENAI_API_KEY: "synthetic-only",
      WEB_ORIGIN: "http://localhost:4517",
    },
  });
  const apiBundle = resolve(artifact, "business-worker.mjs");
  await build({
    entryPoints: [resolve(app, "scripts/fixture-api-worker.mjs")],
    outfile: apiBundle,
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"],
    mainFields: ["module", "main"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.SHOP_PROTECTED_CONFIG_JSON": JSON.stringify(
        JSON.stringify(protectedFixtures),
      ),
    },
  });
  const apiOptions = unstable_getMiniflareWorkerOptions(apiConfig);
  const apiRuntime = new Miniflare({
    ...apiOptions.workerOptions,
    name: "business",
    modules: true,
    modulesRoot: artifact,
    scriptPath: apiBundle,
    outboundService: outbound,
    host: "127.0.0.1",
    port: 0,
    d1Persist: resolve(artifact, "d1"),
    r2Persist: resolve(artifact, "r2"),
    durableObjectsPersist: resolve(artifact, "do"),
    cf: false,
  });
  api = {
    url: apiRuntime.ready,
    fetch: async (request) =>
      apiRuntime.dispatchFetch(request.url, {
        method: request.method,
        headers: [...request.headers],
        redirect: "manual",
        ...(!["GET", "HEAD"].includes(request.method)
          ? { body: await request.arrayBuffer() }
          : {}),
      }),
    queue: async (name, messages) =>
      (await apiRuntime.getWorker()).queue(name, messages),
    scheduled: async (...args) =>
      (await apiRuntime.getWorker()).scheduled(...args),
    dispose: () => apiRuntime.dispose(),
  };
  await api.url;
  platform = {
    env: {
      DB: await apiRuntime.getD1Database("DB"),
      DESIGN_ARTWORK: await apiRuntime.getR2Bucket("DESIGN_ARTWORK"),
      STORY_VIDEOS: await apiRuntime.getR2Bucket("STORY_VIDEOS"),
    },
    dispose: async () => {},
  };
  const migrations = resolve(root, "products/shop/workers/api/drizzle");
  for (const name of (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(resolve(migrations, name), "utf8");
    for (const part of sql.split("--> statement-breakpoint"))
      if (part.trim()) await platform.env.DB.prepare(part.trim()).run();
  }
  await seedCatalogue(platform.env.DB);
  events.push({
    operation: "migrations",
    count: (await readdir(migrations)).filter((name) => name.endsWith(".sql"))
      .length,
  });
  const origin = (await api.url).origin;
  const built = JSON.parse(
    await readFile(resolve(app, "dist/server/wrangler.json"), "utf8"),
  );
  built.main = resolve(app, "dist/server/index.js");
  built.assets.directory = resolve(app, "dist/client");
  built.vars = {
    FOREVER_TEE_API_URL: origin,
    FOREVER_TEE_API_SHARED_SECRET: secret,
    TURNSTILE_SECRET: "synthetic-turnstile-secret",
    TURNSTILE_SITE_KEY: "synthetic-site-key",
    PUBLIC_STORE_DOMAIN: "ci.myshopify.com",
    PUBLIC_STOREFRONT_API_TOKEN: "synthetic-public",
    PRIVATE_STOREFRONT_API_TOKEN: "synthetic-private",
  };
  delete built.configPath;
  delete built.userConfigPath;
  const builtConfig = await config("storefront", null, built);
  const storefrontOptions = unstable_getMiniflareWorkerOptions(builtConfig);
  const storefrontRuntime = new Miniflare({
    ...storefrontOptions.workerOptions,
    name: "storefront",
    modules: true,
    scriptPath: built.main,
    modulesRoot: resolve(app, "dist/server"),
    outboundService: outbound,
    host: "localhost",
    port: 4517,
    cf: false,
  });
  storefront = {
    fetch: (request) => storefrontRuntime.dispatchFetch(request),
    dispose: () => storefrontRuntime.dispose(),
  };
  await storefrontRuntime.ready;
  const response = await storefront.fetch("http://localhost:4517/create");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Upload image/);
  events.push({ operation: "built-start-create", status: 200 });
  await writeFile(
    resolve(artifact, "service-identity.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        node: process.execPath,
        nodeVersion: process.version,
        argv: process.argv,
        storefrontOrigin: "http://localhost:4517",
        businessOrigin: origin,
        nativeCapsule: capsule,
        nativeBuildId,
        lockSha256: createHash("sha256")
          .update(await readFile(resolve(root, "bun.lock")))
          .digest("hex"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const journey = await browserJourney({
    events,
    blocked,
    artifact,
    sourceFormat: process.argv[4] ?? "png",
    releaseImages,
    queue,
    db: platform.env.DB,
    api,
    secret,
    shopify,
    videoTasks,
    videos: platform.env.STORY_VIDEOS,
    artwork: platform.env.DESIGN_ARTWORK,
    deliverPrint: async (duplicate = false) => {
      const messages = duplicate ? deliveredPrint : queue.splice(0);
      for (const message of messages) {
        if (!duplicate) deliveredPrint.push(message);
        const result = await api.queue("forever-tee-print-assets-development", [
          {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            attempts: 1,
            body: message,
          },
        ]);
        events.push({
          operation: duplicate ? "duplicate-queue-delivery" : "queue-delivery",
          result,
        });
      }
    },
  });
  events.push({ operation: "journey", ...journey });
  await writeFile(
    resolve(artifact, "startup-proof.json"),
    JSON.stringify({ events, blocked }, null, 2),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: "local-journey-assertions-passed",
      events,
      blocked,
    }),
  );
} finally {
  releaseImages();
  await Promise.allSettled(videoTasks);
  await storefront?.dispose();
  await api?.dispose();
  await platform?.dispose();
  await agent.close();
  await writeFile(
    resolve(artifact, "events.json"),
    JSON.stringify({ events, blocked }, null, 2),
    { mode: 0o600 },
  );
}
