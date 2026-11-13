import { createServer } from "node:http";
import { createHash } from "node:crypto";
import sharp from "sharp";

const fixtureJobId = "11111111-1111-4111-8111-111111111111";
const fixtureGrant = "synthetic.grant";
export const fixtureFunctionArn = "arn:aws:lambda:ap-southeast-2:111111111111:function:synthetic-native-v5";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export function fixtureRecipe(color = "White", view = "flat", baseProductSlug = "staple-tee", depth = 0, printMode = "recursive") {
    return {
        storageKey: `designs/${fixtureJobId}/product-images/v5/${fixtureJobId}/${fixtureJobId}/${color.toLowerCase()}-${view}.webp`,
        baseProductSlug, color, view, printMode,
        settings: { cropX: 0.41, cropY: 0.62, cropZoom: 1.06, depth, placementX: 0.39, placementY: 0.43, placementWidth: 0.22 },
    };
}
export function fixtureEvent() {
    return { kind: "product-image-v5", schemaVersion: 1, jobId: fixtureJobId, grant: fixtureGrant, rendererVersion: "product-images-v5" };
}
export function fixtureBinding(apiOrigin, buildId = "a".repeat(64)) {
    return { schemaVersion: 1, environment: "local-proof", apiOrigin, functionArn: fixtureFunctionArn,
        qualifiedFunctionArns: [`${fixtureFunctionArn}:7`, `${fixtureFunctionArn}:8`], buildId };
}
export function fixtureContext(version = "7") {
    return { invokedFunctionArn: `${fixtureFunctionArn}:${version}`, awsRequestId: "synthetic-request", getRemainingTimeInMillis: () => 120000 };
}
export async function syntheticSources() {
    const rgba = await sharp(Buffer.from('<svg width="320" height="410"><rect x="8" y="12" width="235" height="350" fill="#126acc"/><circle cx="90" cy="110" r="64" fill="#ffc720"/><path d="M20 370L260 150L315 400Z" fill="#ce3451"/><rect x="215" y="38" width="86" height="41" fill="white"/></svg>')).png().toBuffer();
    return {
        png: rgba,
        jpeg: await sharp(rgba).flatten({ background: "#e9ebee" }).jpeg({ quality: 95 }).toBuffer(),
        webp: await sharp(rgba).webp({ lossless: true }).toBuffer(),
        exifJpeg: await sharp(rgba).flatten({ background: "#e9ebee" }).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer(),
    };
}
// This server exercises transfers and fences. D1/R2/queue integration is a separate proof.
export async function createProductImageV5Fixture({ source, recipe = fixtureRecipe(), mode = "valid" }) {
    const calls = [], publications = [], failures = [];
    let owner, stored;
    const server = createServer(async (request, response) => {
        try {
            const url = request.url ?? "", executionId = request.headers["x-image-execution-id"];
            calls.push({ path: url, method: request.method, executionId, rendererVersion: request.headers["x-image-renderer-version"] });
            if (request.headers.authorization !== `Bearer ${fixtureGrant}`) {
                response.writeHead(403).end(); return;
            }
            if (request.headers["x-image-renderer-version"] !== "product-images-v5" ||
                typeof executionId !== "string" || !/^[a-f0-9-]{36}$/.test(executionId)) {
                response.writeHead(400).end(); return;
            }
            if (url.endsWith("/claim")) {
                if (mode === "duplicate") { response.writeHead(204).end(); return; }
                if (mode === "redirect") { response.writeHead(307, { location: "https://external.invalid/artwork" }).end(); return; }
                if (mode === "claim-timeout") return;
                if (owner && owner !== executionId) { response.writeHead(204).end(); return; }
                owner = executionId;
                if (mode === "claim-failure") { response.writeHead(500).end(); return; }
                if (mode === "legacy-claim") { response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify(recipe)); return; }
            }
            if (url.endsWith("/claim") || url.endsWith("/artwork")) {
                const headers = { "x-image-source-sha256": mode === "bad-source" ? "0".repeat(64) : hash(source) };
                if (mode !== "legacy-claim")
                    headers["x-image-recipe"] = mode === "invalid-recipe" ? "{}" : mode === "oversize-recipe" ? "x".repeat(4097) : JSON.stringify(recipe);
                if (mode === "missing-hash") delete headers["x-image-source-sha256"];
                response.writeHead(url.endsWith("/claim") ? 201 : 200, headers).end(source); return;
            }
            if (url.endsWith("/failure")) {
                failures.push({ executionId, owned: owner === executionId });
                response.writeHead(owner === executionId ? 204 : 409).end(); return;
            }
            if (url.endsWith("/image")) {
                const chunks = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const image = Buffer.concat(chunks), sha256 = hash(image);
                publications.push({ bytes: image, sha256, executionId, length: request.headers["content-length"], claimedHash: request.headers["x-image-sha256"] });
                if (owner !== executionId || mode === "late-publication") { response.writeHead(409).end(); return; }
                if (mode.startsWith("reject-")) { response.writeHead(Number(mode.slice(7))).end(); return; }
                if (request.headers["content-type"] !== "image/webp" || request.headers["x-image-sha256"] !== sha256 || Number(request.headers["content-length"]) !== image.length) {
                    response.writeHead(400).end(); return;
                }
                if (stored && !stored.equals(image)) { response.writeHead(409).end(); return; }
                stored = image;
                if (publications.length === 1 && mode === "lost-ack") { response.destroy(); return; }
                if (publications.length === 1 && mode === "truncated-ack") { response.end('{"key":'); return; }
                if (publications.length === 1 && mode === "storage-error") { response.writeHead(500).end(); return; }
                if (mode === "oversize-ack") { response.end("x".repeat(4097)); return; }
                const ack = { key: recipe.storageKey, sha256, size: image.length };
                if (mode === "bad-ack-key") ack.key += ".wrong";
                if (mode === "bad-ack-hash") ack.sha256 = "0".repeat(64);
                if (mode === "bad-ack-size") ack.size++;
                response.setHeader("content-type", "application/json"); response.end(JSON.stringify(ack)); return;
            }
            response.writeHead(404).end();
        }
        catch { response.destroy(); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local TCP fixture.");
    return {
        origin: `http://127.0.0.1:${address.port}`, calls, publications, failures,
        get stored() { return stored; },
        async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
    };
}
