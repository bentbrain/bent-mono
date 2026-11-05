import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealReleaseArchive, openReleaseArchive } from "./release-evidence.mjs";

test("realistic report HTML, large trace ZIP, raw trace and screenshot round-trip byte-for-byte; tampering leaves no plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shop-browser-archive-"));
  const identity = { sourceCommit: "a".repeat(40), runId: "123", filename: "browser-evidence.json" };
  const env = { SHOP_EVIDENCE_KEY_VERSION: "v1", SHOP_EVIDENCE_ENCRYPTION_KEY: "07".repeat(32) };
  try {
    const input = join(directory, "input"), report = join(input, "apps/web/playwright-report"), results = join(input, "apps/web/test-results/create-flow");
    await mkdir(join(report, "data"), { recursive: true }); await mkdir(results, { recursive: true });
    const html = Buffer.from('<html><a href="data/trace.zip">Protected browser trace</a></html>');
    const trace = Buffer.from('synthetic-browser-bypass-header and cookie\n'.repeat(160000));
    const screenshot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
    await writeFile(join(report, "index.html"), html);
    await writeFile(join(results, "network.trace"), trace);
    await writeFile(join(results, "screenshot.png"), screenshot);
    execFileSync("zip", ["-q", "-0", join(report, "data/trace.zip"), "network.trace", "screenshot.png"], { cwd: results });
    await copyFile(join(report, "data/trace.zip"), join(results, "trace.zip"));
    const archive = join(directory, "browser.tar");
    execFileSync("tar", ["-cf", archive, "apps/web/playwright-report", "apps/web/test-results"], { cwd: input });
    const original = await readFile(archive);
    assert.ok(original.length > 4 * 1024 * 1024, "large binary diagnostics exceed the pointer bound");
    const encrypted = join(directory, "browser.tar.enc"), restored = join(directory, "restored.tar");
    await sealReleaseArchive(archive, encrypted, identity, env);
    assert.equal((await readFile(encrypted)).includes(Buffer.from("synthetic-browser-bypass-header")), false);
    await openReleaseArchive(encrypted, restored, identity, env);
    assert.deepEqual(await readFile(restored), original);
    const output = join(directory, "output"); await mkdir(output);
    execFileSync("tar", ["-xf", restored], { cwd: output });
    for (const path of ["apps/web/playwright-report/index.html", "apps/web/playwright-report/data/trace.zip", "apps/web/test-results/create-flow/network.trace", "apps/web/test-results/create-flow/screenshot.png", "apps/web/test-results/create-flow/trace.zip"]) {
      assert.deepEqual(await readFile(join(output, path)), await readFile(join(input, path)), path);
    }
    const corrupt = await readFile(encrypted); corrupt[Math.floor(corrupt.length / 2)] ^= 1;
    const corrupted = join(directory, "corrupted.enc");
    await writeFile(corrupted, corrupt); await copyFile(`${encrypted}.json`, `${corrupted}.json`);
    const failedOutput = join(directory, "failed.tar");
    await assert.rejects(openReleaseArchive(corrupted, failedOutput, identity, env), /authentication failed/);
    await assert.rejects(access(failedOutput), { code: "ENOENT" });
    await assert.rejects(openReleaseArchive(encrypted, failedOutput, { ...identity, runId: "124" }, env));
    await assert.rejects(access(failedOutput), { code: "ENOENT" });
    await writeFile(failedOutput, "preserve existing private file");
    await assert.rejects(openReleaseArchive(encrypted, failedOutput, identity, env));
    assert.equal(await readFile(failedOutput, "utf8"), "preserve existing private file");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
