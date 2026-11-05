// Cloud-only encode through the real development Queue -> Worker -> Lambda ->
// R2 path. Copies the design too, so benchmark products never join its family.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { aws, ROOT } from "./local-tools.mjs";
import { VARIANTS } from "./config.mjs";
import { APP_ARN } from "./app-handler.mjs";
import { cloudflareDevelopment, DEVELOPMENT_DB, DEVELOPMENT_QUEUE } from "./cloudflare-development.mjs";
const fixturePath = process.argv[2];
if (!fixturePath)
    throw new Error("Supply the saved-design benchmark fixture JSON.");
const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
const onlyVariant = process.argv[3];
const failOnce = process.argv[4] === "--fail-once";
if (failOnce && !onlyVariant)
    throw new Error("The recovery test must use one variant.");
if (onlyVariant && !["tee-black", "tee-white", "tote-black", "tote-cream"].includes(onlyVariant))
    throw new Error("Unknown test variant.");
assert.match(fixture.designId, /^[0-9a-f-]{36}$/);
assert.match(fixture.artwork.sha256, /^[0-9a-f]{64}$/);
const cf = await cloudflareDevelopment();
const settings = await cf("/workers/scripts/forever-tee-api-development/settings");
assert.ok(settings.bindings.some(binding => binding.name === "STORY_VIDEO_PROVIDER" && binding.text === "lambda"));
const queue = await cf(`/queues/${DEVELOPMENT_QUEUE}`);
assert.equal(queue.queue_name, "forever-tee-story-video-development");
const query = async (sql, params = []) => (await cf(`/d1/database/${DEVELOPMENT_DB}/query`, { sql, params }))[0].results;
const source = (await query("SELECT id FROM design_revisions WHERE design_id = ? AND sha256 = ? ORDER BY created_at DESC LIMIT 1", [fixture.designId, fixture.artwork.sha256]))[0];
assert.ok(source, "The saved personal design must exist in development.");
const artworkPath = resolve(dirname(resolve(fixturePath)), "artwork-saved.png");
const artwork = await readFile(artworkPath);
assert.equal(artwork.length, fixture.artwork.size);
assert.equal(createHash("sha256").update(artwork).digest("hex"), fixture.artwork.sha256);
const designId = randomUUID();
const artworkKey = `designs/${designId}/lambda-smoke.png`;
const revisionId = randomUUID();
const now = Date.now();
const directory = resolve(ROOT, ".data/aws-lambda");
await mkdir(directory, { recursive: true });
const output = await mkdtemp(resolve(directory, "app-smoke-"));
const jobs = fixture.variants.filter(variant => !onlyVariant || variant.variantId === onlyVariant).map(variant => ({ ...variant, jobId: randomUUID() }));
const products = [
    { id: randomUUID(), base: "a51b7acf-77e9-4762-83c4-62d96dd8942c", slug: "staple-tee", handle: "bent-shirt" },
    { id: randomUUID(), base: "97b629d7-1d3b-4d2a-a586-537168141e97", slug: "cotton-tote", handle: "cotton-tote" },
];
await writeFile(resolve(output, "fixture.json"), JSON.stringify({ sourceDesignId: fixture.designId, designId, artworkKey, sourceRevision: source.id, revisionId, products, jobs }, null, 2), { flag: "wx" });
await promisify(execFile)("bun", ["--filter", "@forever-tee/api", "exec", "wrangler", "r2", "object", "put",
    `forever-tee-design-artwork-development/${artworkKey}`, "--file", artworkPath, "--content-type", "image/png", "--remote"], { cwd: ROOT, timeout: 60000, maxBuffer: 128 * 1024 });
await query(`INSERT INTO designs (id, owner_id, artwork_key, content_type, byte_size, artwork_width, artwork_height,
  sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, status, version,
  finalized_at, created_at, updated_at)
  SELECT ?, ?, ?, content_type, byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
    placement_x, placement_y, placement_width, depth, 'ready', 0, NULL, ?, ? FROM design_revisions WHERE id = ?`, [designId, randomBytes(32).toString("hex"), artworkKey, now, now, source.id]);
await query(`INSERT INTO design_revisions (id, design_id, fingerprint, artwork_key, content_type, byte_size, sha256,
  crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, created_at)
  SELECT ?, ?, ?, ?, content_type, byte_size, sha256, crop_x, crop_y, crop_zoom,
    placement_x, placement_y, placement_width, depth, ? FROM design_revisions WHERE id = ?`, [revisionId, designId, `lambda-smoke:${revisionId}`, artworkKey, now, source.id]);
for (const product of products) {
    const productJobs = jobs.filter(job => job.variantId.startsWith(product.slug === "staple-tee" ? "tee-" : "tote-"));
    if (productJobs.length === 0)
        continue;
    const placement = productJobs[0].settings;
    await query(`INSERT INTO products (id, base_product_id, design_id, design_revision_id, shopify_handle,
    placement_x, placement_y, placement_width, placement_depth, projection_version, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'safe-margin-v1', 'active', ?)`, [product.id, product.base, designId, revisionId, product.handle, placement.placementX, placement.placementY, placement.placementWidth, placement.depth, now]);
    for (const job of productJobs) {
        const colour = job.variantId.split("-")[1];
        job.storyKey = `story-videos/v7/${revisionId}/${product.id}/${colour}.mp4`;
        await query(`INSERT INTO story_video_jobs (id, product_id, design_revision_id, colour, renderer_version, story_key,
      status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'story-video-renderer-v7', ?, 'queued', 0, ?, ?)`, [job.jobId, product.id, revisionId, `${colour[0].toUpperCase()}${colour.slice(1)}`, job.storyKey, now, now]);
    }
}
const enqueuedAt = Date.now();
if (failOnce) {
    const job = jobs[0];
    await query("UPDATE story_video_jobs SET status = 'rendering', attempt_count = 1, updated_at = ? WHERE id = ? AND status = 'queued' AND attempt_count = 0", [Date.now(), job.jobId]);
    const secrets = JSON.parse(await readFile(resolve(ROOT, ".data/aws-personal/lambda-worker-secrets.json"), "utf8"));
    const payload = Buffer.from(JSON.stringify({ jobId: job.jobId, attempt: 1, expiresAt: Date.now() + 180000 })).toString("base64url");
    const grant = `${payload}.${createHmac("sha256", secrets.STORY_VIDEO_GRANT_SECRET).update(payload).digest("base64url")}`;
    const variant = VARIANTS[job.variantId];
    const invocation = { schemaVersion: 1, jobId: job.jobId, attempt: 1, baseProductSlug: variant.baseProductSlug, color: variant.color,
        settings: job.settings, artwork: { sha256: "0".repeat(64), size: fixture.artwork.size },
        storyKey: job.storyKey, rendererVersion: "story-video-renderer-v7", grant };
    const payloadPath = resolve(output, "failure-payload.json");
    await writeFile(payloadPath, JSON.stringify(invocation), { flag: "wx", mode: 0o600 });
    const response = await aws(["lambda", "invoke", "--function-name", APP_ARN, "--invocation-type", "Event", "--payload", `fileb://${payloadPath}`, resolve(output, "acceptance.json")]);
    assert.equal(response.StatusCode, 202);
}
else {
    await cf(`/queues/${DEVELOPMENT_QUEUE}/messages`, { body: { designRevisionId: revisionId }, content_type: "json" });
}
console.info(JSON.stringify({ event: "enqueued", revisionId, output }));
let rows = [], previous = "", observedFirstMs;
const deadline = enqueuedAt + 150000;
while (Date.now() < deadline) {
    rows = await query("SELECT id, colour, status, attempt_count, output_byte_size, last_error, rendered_at FROM story_video_jobs WHERE design_revision_id = ? ORDER BY id", [revisionId]);
    if (rows.some(row => row.status === "ready"))
        observedFirstMs ??= Date.now() - enqueuedAt;
    const status = rows.map(row => `${row.colour}:${row.status}:${row.attempt_count}`).join(",");
    if (status !== previous)
        console.info(JSON.stringify({ event: "progress", elapsedMs: Date.now() - enqueuedAt, status }));
    previous = status;
    if (rows.length === jobs.length && rows.every(row => row.status === "ready"))
        break;
    if (rows.some(row => row.status === "failed" && row.attempt_count >= 3))
        break;
    await new Promise(resolve => setTimeout(resolve, 2000));
}
const report = { revisionId, enqueuedAt, observedFirstMs, observedAllMs: Date.now() - enqueuedAt,
    firstCommittedMs: Math.min(...rows.filter(row => row.rendered_at).map(row => row.rendered_at)) - enqueuedAt,
    allCommittedMs: Math.max(...rows.filter(row => row.rendered_at).map(row => row.rendered_at)) - enqueuedAt, rows, products, jobs };
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
assert.equal(rows.filter(row => row.status === "ready").length, jobs.length, "Every real development render must finish.");
assert.ok(rows.every(row => row.attempt_count === (failOnce ? 2 : 1)), "Unexpected render attempt count.");
console.info(JSON.stringify({ event: "complete", firstCommittedMs: report.firstCommittedMs, allCommittedMs: report.allCommittedMs, output }));
