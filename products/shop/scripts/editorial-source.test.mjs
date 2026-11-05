import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyEditorialSource } from "./editorial-source.mjs";
const execute = promisify(execFile);

test("source pinning permits editorial-only ancestry but rejects changes to qualified inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "editorial-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (command, args) => execute(command, args, { cwd: directory });
  const git = async args => (await run("git", args)).stdout.trim();
  await git(["init", "-q"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["commit", "--allow-empty", "-qm", "qualified source"]);
  const source = await git(["rev-parse", "HEAD"]);
  const save = async path => {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), "fixture\n");
    await git(["add", path]); await git(["commit", "-qm", "change fixture"]);
    return git(["rev-parse", "HEAD"]);
  };
  const tooling = await save("scripts/web-production-release.mjs");
  const evidence = await verifyEditorialSource(source, tooling, run);
  assert.deepEqual(evidence.changedToolingPaths, ["scripts/web-production-release.mjs"]);
  await assert.rejects(verifyEditorialSource(source, source, run), /checkout differs/);
  await assert.rejects(verifyEditorialSource(tooling, source, run));
  for (const path of ["workers/api/src/index.ts", "workers/video-renderer/src/renderer.mjs", "apps/web/src/app/page.tsx",
    "bun.lock", "scripts/fixtures/content/featured-398-approved.json", "scripts/featured-composition-records.mjs", "scripts/native-production-release.mjs"]) {
    const changed = await save(path);
    await assert.rejects(verifyEditorialSource(source, changed, run), /qualified application, artwork or release inputs changed/);
    await git(["reset", "--hard", tooling]);
  }
});
