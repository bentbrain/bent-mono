// Exercise the real development confirmation API and push stream using a copy
// of the owner's saved artwork. No customer draft is changed or finalized.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";
import { ROOT } from "./local-tools.mjs";
import { cloudflareDevelopment, API_ORIGIN, DEVELOPMENT_DB } from "./cloudflare-development.mjs";
if (!process.argv[2])
    throw new Error("Supply the saved-design fixture JSON.");
const fixturePath = resolve(process.argv[2]);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const preview = parseEnv(await readFile(resolve(ROOT, process.argv[3] ?? ".vercel/.env.preview.local"), "utf8"));
assert.equal(preview.FOREVER_TEE_API_URL, API_ORIGIN, "Only the development API is allowed.");
assert.ok(preview.FOREVER_TEE_API_SHARED_SECRET, "Preview service authentication is required.");
const ownerId = randomBytes(32).toString("hex");
const headers = { "x-forever-tee-service-secret": preview.FOREVER_TEE_API_SHARED_SECRET,
    "x-forever-tee-owner-id": ownerId, "content-type": "application/json" };
// A fresh test owner cannot see the source draft. Check authentication before
// creating any fixture; stale local preview credentials must not leave copies.
const access = await fetch(`${API_ORIGIN}/v2/design-drafts/${fixture.designId}`, { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
await access.body?.cancel();
assert.equal(access.status, 404, "A valid development service credential is required.");
const cf = await cloudflareDevelopment();
const settings = await cf("/workers/scripts/forever-tee-api-development/settings");
assert.ok(settings.bindings.some(binding => binding.name === "STORY_VIDEO_PROVIDER" && binding.text === "lambda"));
const query = async (sql, params = []) => (await cf(`/d1/database/${DEVELOPMENT_DB}/query`, { sql, params }))[0].results;
const artworkPath = resolve(dirname(fixturePath), "artwork-saved.png");
const artwork = await readFile(artworkPath);
assert.equal(artwork.length, fixture.artwork.size);
assert.equal(createHash("sha256").update(artwork).digest("hex"), fixture.artwork.sha256);
const source = await query("SELECT id FROM designs WHERE id = ? AND sha256 = ? AND status = 'ready' AND deleted_at IS NULL", [fixture.designId, fixture.artwork.sha256]);
assert.equal(source.length, 1);
const output = await mkdtemp(resolve(ROOT, ".data/aws-lambda/app-confirmation-"));
const designId = randomUUID(), now = Date.now();
const artworkKey = `designs/${designId}/lambda-confirmation.png`;
await promisify(execFile)("bun", ["--filter", "@forever-tee/api", "exec", "wrangler", "r2", "object", "put",
    `forever-tee-design-artwork-development/${artworkKey}`, "--file", artworkPath, "--content-type", "image/png", "--remote"], { cwd: ROOT, timeout: 60000, maxBuffer: 128 * 1024 });
await query(`INSERT INTO designs (id, owner_id, artwork_key, content_type, byte_size, artwork_width, artwork_height,
  sha256, crop_x, crop_y, crop_zoom, placement_x, placement_y, placement_width, depth, status, version,
  finalized_at, created_at, updated_at)
  SELECT ?, ?, ?, content_type, byte_size, artwork_width, artwork_height, sha256, crop_x, crop_y, crop_zoom,
    placement_x, placement_y, placement_width, depth, 'ready', 0, NULL, ?, ? FROM designs WHERE id = ?`, [designId, ownerId, artworkKey, now, now, fixture.designId]);
await writeFile(resolve(output, "fixture.json"), JSON.stringify({ designId, artworkKey, sourceDesignId: fixture.designId }, null, 2), { flag: "wx" });
console.info(JSON.stringify({ event: "fixture-ready", designId, output }));
const startedAt = Date.now();
const response = await fetch(`${API_ORIGIN}/v2/configured-product-families`, { method: "POST", headers,
    body: JSON.stringify({ designId, expectedVersion: 0, baseProductIds: ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "97b629d7-1d3b-4d2a-a586-537168141e97"] }),
    redirect: "error", signal: AbortSignal.timeout(30000) });
assert.equal(response.status, 201, "Development family confirmation must succeed.");
const { products } = await response.json();
assert.equal(products.length, 2);
const responseMs = Date.now() - startedAt;
console.info(JSON.stringify({ event: "confirmed", responseMs }));
const stream = await fetch(`${API_ORIGIN}/v2/internal/configured-products/${products[0].id}/story-video-events`, { headers, redirect: "error", signal: AbortSignal.timeout(60000) });
assert.equal(stream.status, 200);
assert.ok(stream.headers.get("content-type")?.startsWith("text/event-stream"));
assert.ok(stream.body);
const decoder = new TextDecoder(), ready = new Map();
let pending = "", pushMode = false;
for await (const chunk of stream.body) {
    pending += decoder.decode(chunk, { stream: true });
    for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
        const message = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (message.includes("notification-mode=push"))
            pushMode = true;
        if (!message.startsWith("event: video\n"))
            continue;
        const value = JSON.parse(message.slice(message.indexOf("data: ") + 6));
        assert.ok(products.some(product => product.id === value.productId));
        if (value.status !== "ready")
            continue;
        const key = `${value.productId}:${value.color}`;
        if (!ready.has(key)) {
            ready.set(key, Date.now() - startedAt);
            console.info(JSON.stringify({ event: "video-ready", productId: value.productId, color: value.color, elapsedMs: ready.get(key) }));
        }
    }
}
assert.equal(pushMode, true);
assert.equal(ready.size, 4, "All four videos must arrive through the existing push stream.");
const rows = await query(`SELECT jobs.id, jobs.product_id, jobs.colour, jobs.status, jobs.attempt_count, jobs.rendered_at,
  jobs.output_byte_size FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id WHERE products.design_id = ?`, [designId]);
assert.equal(rows.length, 4);
assert.ok(rows.every(row => row.status === "ready" && row.attempt_count === 1));
for (const row of rows) {
    const media = await fetch(`${API_ORIGIN}/v2/internal/configured-products/${row.product_id}/story-videos/${row.colour.toLowerCase()}`, { method: "HEAD", headers, redirect: "error", signal: AbortSignal.timeout(10000) });
    assert.equal(media.status, 200, "The existing gallery media route must serve the R2 result.");
    assert.equal(media.headers.get("content-type"), "video/mp4");
    assert.equal(Number(media.headers.get("content-length")), row.output_byte_size);
}
const report = { designId, startedAt, responseMs, firstPushMs: Math.min(...ready.values()), allPushMs: Math.max(...ready.values()),
    firstCommittedMs: Math.min(...rows.map(row => row.rendered_at)) - startedAt,
    allCommittedMs: Math.max(...rows.map(row => row.rendered_at)) - startedAt, rows, products };
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.info(JSON.stringify({ event: "complete", firstPushMs: report.firstPushMs, allPushMs: report.allPushMs, output }));
