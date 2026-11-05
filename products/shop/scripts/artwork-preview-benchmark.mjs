import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import sharp from "sharp";
import { assertEarlyPreview, benchmarkLossless, comparePreviews, comparePrintSources } from "./artwork-preview-benchmark/metrics.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const wranglerPath = require.resolve("wrangler", { paths: [join(root, "workers/api")] });
const esbuildPath = createRequire(wranglerPath).resolve("esbuild");
export async function readProbe(response, directory) {
    if (!response.ok)
        throw new Error(`Images probe HTTP ${response.status}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const events = [];
    const images = new Set(["early-preview", "print-ready", "final-preview"]);
    const names = new Set([...images, "preview-input", "original-ready", "complete", "error"]);
    let pending = "";
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        if (pending.length > 30000000)
            throw new Error("Probe response exceeded limit");
        while (pending.includes("\n")) {
            const end = pending.indexOf("\n");
            const { base64, ...event } = JSON.parse(pending.slice(0, end));
            pending = pending.slice(end + 1);
            if (!names.has(event.name) || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0) {
                throw new Error("Invalid probe event");
            }
            if (events.some(previous => previous.name === event.name))
                throw new Error("Duplicate probe event");
            if (images.has(event.name)) {
                if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
                    throw new Error("Invalid probe image");
                const bytes = Buffer.from(base64, "base64");
                if (bytes.length !== event.bytes || bytes.length > 19000000)
                    throw new Error("Invalid probe image length");
                await writeFile(join(directory, `${event.name}.webp`), bytes, { mode: 0o600 });
            }
            events.push(event);
            console.log(JSON.stringify(event));
        }
    }
    if (pending || events.at(-1)?.name !== "complete" || events.some(event => event.name === "error") ||
        !events.some(event => event.name === "print-ready") || !events.some(event => event.name === "final-preview")) {
        throw new Error("Probe did not complete both required outputs");
    }
    await writeFile(join(directory, "timings.json"), JSON.stringify(events, null, 2));
    return events;
}
async function fixtureImages(directory, quick) {
    const raw = join(directory, "portrait.png");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i",
        join(root, "apps/web/e2e/fixtures/portrait-camera.y4m"), "-frames:v", "1", raw]);
    const jpeg = join(directory, "portrait.jpg");
    await sharp(raw).jpeg({ quality: 95 }).toFile(jpeg);
    const fixtures = [{ name: "portrait", path: jpeg, edges: quick ? [1024] : [768, 1024, 1600] }];
    if (!quick) {
        const orientation = join(directory, "orientation.jpg");
        await sharp(raw).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toFile(orientation);
        fixtures.push({ name: "orientation", path: orientation, edges: [1024] });
        // The existing PNG has an opaque alpha channel. Add transparent and
        // half-transparent strips explicitly so this case really exercises alpha.
        const transparent = join(directory, "transparent.png");
        const artwork = join(root, "apps/web/e2e/local/artwork.png");
        const { width, height } = await sharp(artwork).metadata();
        const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect x="40" width="${width - 40}" height="${height}" fill="white"/><rect x="20" width="20" height="${height}" fill="white" opacity="0.5"/></svg>`);
        await sharp(artwork).ensureAlpha().composite([{ input: mask, blend: "dest-in" }]).png().toFile(transparent);
        fixtures.push({ name: "transparent", path: transparent, edges: [1024] });
    }
    return fixtures;
}
async function waitForProbe(child, port) {
    for (let attempt = 0; attempt < 40; attempt++) {
        if (child.exitCode !== null)
            throw new Error("Wrangler exited before readiness");
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok && await response.text() === "artwork-preview-benchmark-v1")
                return;
        }
        catch { /* Wrangler is still starting. */ }
        await setTimeout(500);
    }
    throw new Error("Wrangler did not become ready");
}
export async function writePrototype(directory, summary) {
    const { build } = await import(pathToFileURL(esbuildPath));
    const view = join(directory, "prototype");
    await mkdir(view, { recursive: true });
    await copyFile(join(root, "scripts/artwork-preview-benchmark/index.html"), join(view, "index.html"));
    await build({ entryPoints: [join(root, "scripts/artwork-preview-benchmark/player.mjs")],
        bundle: true, format: "esm", platform: "browser", outfile: join(view, "player.js"),
        tsconfig: join(root, "apps/web/tsconfig.json") });
    const candidate = summary.cases.find(item => item.fixture === "portrait" && item.edge === 1024);
    if (!candidate)
        throw new Error("The prototype needs the 1024 portrait case");
    await copyFile(join(directory, "portrait-1024/early-preview.webp"), join(view, "early.webp"));
    await copyFile(join(directory, "portrait-1024/final-preview.webp"), join(view, "final.webp"));
    await copyFile(join(directory, "portrait-baseline/final-preview.webp"), join(view, "baseline.webp"));
    await copyFile(join(directory, "portrait.jpg"), join(view, "source.jpg"));
    await writeFile(join(view, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(join(view, "data.json"), JSON.stringify({ ...candidate, baseline: summary.baselines.portrait }, null, 2));
}
async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--help")) {
        console.log("Usage: bun run artwork:benchmark [--quick] [--output NEW_DIRECTORY]\nRuns an isolated Wrangler dev Images probe against checked-in fixtures. No deployments or application writes.");
        return;
    }
    const outputIndex = args.indexOf("--output");
    if (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith("--")))
        throw new Error("--output requires a new directory");
    const directory = resolve(outputIndex >= 0 ? args[outputIndex + 1] : join(root, ".data/artwork-preview", new Date().toISOString().replaceAll(":", "-")));
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }); // Refuse to overwrite previous evidence.
    const fixtures = await fixtureImages(directory, args.includes("--quick"));
    const hashes = await Promise.all(fixtures.map(async (fixture) => createHash("sha256").update(await readFile(fixture.path)).digest("hex")));
    // Freeze the code for this run; editor changes must not trigger Wrangler
    // live reload in the middle of a timed image request.
    const { build } = await import(pathToFileURL(esbuildPath));
    const frozenWorker = join(directory, "probe.mjs");
    await build({ entryPoints: [join(root, "scripts/artwork-preview-benchmark/worker.ts")],
        bundle: true, format: "esm", platform: "neutral", outfile: frozenWorker });
    const config = join(directory, "wrangler.json");
    await writeFile(config, JSON.stringify({ name: "shirt-artwork-preview-benchmark",
        main: frozenWorker,
        account_id: protectedConfig("cloudflareAccountId"), compatibility_date: "2026-08-12",
        images: { binding: "IMAGES", remote: true }, vars: { SOURCE_SHA256: hashes.join(",") } }, null, 2));
    const port = 8795;
    const child = spawn(process.execPath, [wranglerPath, "dev", "--config", config, "--ip", "127.0.0.1", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let startup = "";
    child.stdout.on("data", chunk => { startup = (startup + chunk).slice(-6000); });
    child.stderr.on("data", chunk => { startup = (startup + chunk).slice(-6000); });
    const stop = () => { child.kill("SIGTERM"); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const summary = { schema: 1, measuredAt: new Date().toISOString(), source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        sourceDirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0,
        probeSha256: createHash("sha256").update(await readFile(frozenWorker)).digest("hex"),
        fixtureSha256: Object.fromEntries(fixtures.map((fixture, index) => [fixture.name, hashes[index]])),
        caveats: ["Local-to-Cloudflare Images proxy timings, not production latency", "Known fixtures only; no safety screening, R2, D1 or queue work", "Open stream is not a durable background job", "Lossless encoding runs on this computer, not Cloudflare or AWS"], baselines: {}, cases: [], lossless: {} };
    try {
        try {
            await waitForProbe(child, port);
        }
        catch (error) {
            // The generated config contains hashes only, never application secrets.
            console.error(startup);
            throw error;
        }
        for (const fixture of fixtures) {
            const source = await readFile(fixture.path);
            const run = async (mode, edge, name) => {
                console.log(`${fixture.name}: ${mode}, ${edge}px`);
                return readProbe(await fetch(`http://127.0.0.1:${port}/${mode}?edge=${edge}`, {
                    method: "POST", body: source, signal: AbortSignal.timeout(240000),
                }), join(directory, name));
            };
            const baselineName = `${fixture.name}-baseline`;
            const baseline = await run("baseline", 1024, baselineName);
            summary.baselines[fixture.name] = baseline;
            for (const edge of fixture.edges) {
                const name = `${fixture.name}-${edge}`;
                const events = await run("two-track", edge, name);
                const print = await comparePrintSources(await readFile(join(directory, baselineName, "print-ready.webp")), await readFile(join(directory, name, "print-ready.webp")));
                if (!print.identicalPixels)
                    throw new Error("The two-track print source differs from the baseline");
                const comparison = await comparePreviews(await readFile(join(directory, name, "early-preview.webp")), await readFile(join(directory, name, "final-preview.webp")));
                const result = { fixture: fixture.name, edge, events, timing: assertEarlyPreview(events), print, comparison };
                summary.cases.push(result);
                console.log(JSON.stringify(result));
                await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
            }
        }
    }
    finally {
        stop();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
    }
    // Do CPU-only benchmarks after network probes to avoid competing for CPU.
    for (const fixture of fixtures) {
        summary.lossless[fixture.name] = await benchmarkLossless(await readFile(fixture.path));
        await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    }
    await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
    await writePrototype(directory, summary);
    console.log(`Evidence: ${directory}\nServe prototype: python3 -m http.server 8796 --bind 127.0.0.1 --directory ${join(directory, "prototype")}`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    await main();
}
