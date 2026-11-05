import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundationEvidenceSaver } from "./native-production-foundation.mjs";

test("preserving a Terraform-generated plan does not overwrite it or collide with its filename", async t => {
  const directory = await mkdtemp(join(tmpdir(), "production-evidence-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("reviewed-plan-bytes"), original = join(directory, "recovery.tfplan");
  await writeFile(original, bytes, { flag: "wx", mode: 0o600 });
  const calls = [];
  const save = foundationEvidenceSaver(directory, "33216354767", async args => {
    calls.push(args);
    const path = args[args.indexOf("--body") + 1];
    assert.notEqual(path, original);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(args[args.indexOf("--if-none-match") + 1], "*");
    return { VersionId: "immutable-version", ETag: "etag" };
  });
  const result = await save("recovery.tfplan", bytes);
  assert.equal(result.key, "source/foundation/native-33216354767/recovery.tfplan");
  assert.equal(result.version, "immutable-version");
  assert.deepEqual(await readFile(original), bytes);
  await assert.rejects(save("recovery.tfplan", Buffer.from("different")), { code: "EEXIST" });
  assert.equal(calls.length, 1);
  await assert.rejects(save("../override", bytes), /filename/);
});
