import { protectedConfig } from "./protected-config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { preserveRendererArchive, rendererArchiveReference, rendererOriginalReferences } from "./native-renderer-archive.mjs";
import { developmentReleaseObjectKey } from "./native-ci-release-store.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
    const sourceBytes = Buffer.from("original source zip"), sourceCommit = "a".repeat(40), sourceDigest = "b".repeat(64);
    const candidate = { sourceDigest, sourceCommit, githubRunId: "100", zipSha256: hash(sourceBytes), sourceVersion: "source-version",
        sourceKey: `source/${sourceCommit}/100/${hash(sourceBytes)}.zip` };
    const candidateBytes = Buffer.from(JSON.stringify(candidate));
    const receipt = { candidateKey: `source/candidates/${sourceDigest}/100.json`, candidateVersion: "candidate-version", candidateSha256: hash(candidateBytes) };
    const objects = new Map([[receipt.candidateKey, candidateBytes], [candidate.sourceKey, sourceBytes]]), writes = [];
    const env = { GITHUB_RUN_ID: "789", NATIVE_OPERATION: "qualify-all", NATIVE_VERIFY_RELEASE: "native-456" };
    const readObject = async (ref) => objects.get(ref.key);
    const store = { read: readObject, save: async (name, bytes) => {
            const key = developmentReleaseObjectKey(env, name);
            writes.push(key);
            objects.set(key, bytes);
            return { key, version: "copy-version", sha256: hash(bytes) };
        } };
    return { receipt, candidate, readObject, store, objects, writes };
}
test("renderer copies retain original build references and Production reads only exact qualification copies", async () => {
    const input = fixture(), artifacts = await preserveRendererArchive(input);
    const qualification = { rendererArchive: { artifacts, releaseId: "native-456", runId: 789 } };
    for (const [name, original] of Object.entries(rendererOriginalReferences(input.receipt, input.candidate))) {
        const copy = rendererArchiveReference(qualification, name, original);
        assert.match(copy.key, new RegExp("^source\\/releases\\/native-" + protectedConfig("resource_8d0190ecec7d") + "\\/qualification-renderer-", ""));
        assert.deepEqual(await input.readObject(copy), await input.readObject(original));
    }
    assert.equal(input.writes.length, 2);
});
test("cross-run, changed-original, mutable or incomplete renderer archives reject before read", async () => {
    const input = fixture(), artifacts = await preserveRendererArchive(input);
    const original = rendererOriginalReferences(input.receipt, input.candidate).candidate;
    for (const mutate of [
        value => { value.runId++; }, value => { value.releaseId = "native-999"; },
        value => { value.artifacts.candidate.copy.version = "null"; },
        value => { value.artifacts.candidate.original.version = "other"; },
        value => { value.artifacts.candidate.copy.sha256 = "f".repeat(64); },
        value => { delete value.artifacts.source; },
    ]) {
        const archive = { artifacts: structuredClone(artifacts), releaseId: "native-456", runId: 789 };
        mutate(archive);
        assert.throws(() => rendererArchiveReference({ rendererArchive: archive }, "candidate", original));
    }
});
test("changed source, unversioned writes and lost write responses do not produce receipts or retry", async () => {
    for (const kind of ["source", "mutable", "uncertain"]) {
        const input = fixture();
        if (kind === "source")
            input.objects.set(input.receipt.candidateKey, Buffer.from("changed"));
        else {
            const save = input.store.save;
            input.store.save = async (...args) => {
                const ref = await save(...args);
                if (kind === "uncertain")
                    throw Error("lost acknowledgement");
                return { ...ref, version: "null" };
            };
        }
        await assert.rejects(preserveRendererArchive(input));
        assert.equal(input.writes.length, kind === "source" ? 0 : 1);
    }
});
