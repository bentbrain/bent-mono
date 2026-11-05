import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { preserveQualifiedPrintExecutor } from "./native-print-qualification.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture({ corruptSource = false, uncertainCopy = false, corruptCopy = false, unversionedCopy = false } = {}) {
  const objects = new Map(), writes = [];
  const original = name => {
    const bytes = Buffer.from(name), reference = { key: `source/releases/native-100/${name}`, version: "original", sha256: hash(bytes) };
    objects.set(reference.key, bytes); return reference;
  };
  const record = { evidence: original("deployed-print-executor.json"), artifacts: {
    foundationArtifact: original("print-executor-foundation.json"), candidateArtifact: original("candidate-print-executor.js") } };
  return { record, writes, store: {
    read: async reference => {
      if (corruptSource && reference.version === "original" || corruptCopy && reference.version === "copy") return Buffer.from("altered");
      return objects.get(reference.key);
    },
    save: async (name, bytes) => {
      writes.push(name);
      if (uncertainCopy) throw Error("lost acknowledgement");
      const reference = { key: `source/releases/native-100/${name}`, version: unversionedCopy ? "null" : "copy", sha256: hash(bytes) };
      objects.set(reference.key, bytes); return reference;
    },
  } };
}

test("qualification preserves byte-identical bounded executor copies without changing original references", async () => {
  const input = fixture(), before = structuredClone(input.record);
  const archive = await preserveQualifiedPrintExecutor(input.record, input.store, "normal");
  assert.deepEqual(input.record, before);
  assert.deepEqual(input.writes, ["qualification-print-executor-normal-deployment.json",
    "qualification-print-executor-normal-foundation.json", "qualification-print-executor-normal-bundle.js"]);
  assert.equal(archive.bundle.sha256, before.artifacts.candidateArtifact.sha256);
});

test("corrupted or uncertain copies never produce an archive receipt or retry the write", async () => {
  for (const options of [{ corruptSource: true }, { uncertainCopy: true }, { corruptCopy: true }, { unversionedCopy: true }]) {
    const input = fixture(options);
    await assert.rejects(preserveQualifiedPrintExecutor(input.record, input.store, "load"));
    assert.equal(input.writes.length, options.corruptSource ? 0 : 1);
  }
  const input = fixture();
  await assert.rejects(preserveQualifiedPrintExecutor(input.record, input.store, "other"));
  assert.equal(input.writes.length, 0);
});
