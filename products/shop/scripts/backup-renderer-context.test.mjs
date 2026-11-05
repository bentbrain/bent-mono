import { resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { prepareBackupContext, standaloneBackupConfig } from "./backup-renderer-context.mjs";
test("temporary config retains all environment settings while resolving every local path", async () => {
    const root = fileURLToPath(new URL("../workers/video-renderer", import.meta.url));
    const source = JSON.parse(resolveProtectedTemplate(await readFile(join(root, "wrangler.jsonc"), "utf8")));
    const before = structuredClone(source);
    const config = standaloneBackupConfig(source, root);
    assert.deepEqual(source, before);
    await access(config.main);
    for (const [index, selected] of [config, ...Object.values(config.env)].entries()) {
        const original = [source, ...Object.values(source.env)][index];
        await access(selected.assets.directory);
        for (const container of selected.containers)
            await access(container.image);
        assert.deepEqual(selected.durable_objects, original.durable_objects);
        assert.deepEqual(selected.r2_buckets, original.r2_buckets);
        assert.deepEqual(selected.containers.map(({ image, ...settings }) => settings), original.containers.map(({ image, ...settings }) => settings));
    }
    const pinned = "registry.cloudflare.com/personal/renderer@sha256:" + "a".repeat(64);
    source.env.development.containers[0].image = pinned;
    assert.equal(standaloneBackupConfig(source, root).env.development.containers[0].image, pinned);
});
test("the standalone backup context resolves geometry without the repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "backup-context-"));
    try {
        await prepareBackupContext(directory);
        assert.deepEqual(await readFile(join(directory, "src/product-mockup-geometry.mjs")), await readFile(new URL("../packages/contracts/src/product-mockup-geometry.js", import.meta.url)));
        const geometry = await import(pathToFileURL(join(directory, "src/geometry.mjs")));
        assert.ok(geometry.storyArtworkBounds("staple-tee").width > 0);
        assert.ok(geometry.storyArtworkBounds("cotton-tote").width > 0);
        for (const name of await readdir(join(directory, "src"))) {
            const source = await readFile(join(directory, "src", name), "utf8");
            for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
                const target = resolve(directory, "src", match[1]);
                assert.ok(target.startsWith(directory + "/"), `${name} escapes the container context`);
                await access(target);
            }
        }
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
