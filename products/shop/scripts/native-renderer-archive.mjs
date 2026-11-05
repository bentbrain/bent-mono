import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { readFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";
import { loadVerifiedCandidate } from "./native-ci-candidate.mjs";
const check = (value, reason) => {
    if (!value)
        throw Error(`Renderer archive rejected: ${reason}`);
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const names = { candidate: "qualification-renderer-candidate.json", source: "qualification-renderer-source.zip" };
const valid = ref => typeof ref?.key === "string" && typeof ref.version === "string" &&
    /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(ref.version) && ref.version !== "null" && /^[a-f0-9]{64}$/.test(ref.sha256 ?? "");
export function rendererOriginalReferences(receipt, candidate) {
    check(receipt?.candidateKey === `source/candidates/${candidate?.sourceDigest}/${candidate?.githubRunId}.json` &&
        /^[a-f0-9]{64}$/.test(candidate?.sourceDigest ?? "") && /^[a-f0-9]{40}$/.test(candidate?.sourceCommit ?? "") &&
        /^[1-9][0-9]*$/.test(candidate?.githubRunId ?? "") &&
        candidate.sourceKey === `source/${candidate.sourceCommit}/${candidate.githubRunId}/${candidate.zipSha256}.zip`, "original build paths.");
    const refs = { candidate: { key: receipt.candidateKey, version: receipt.candidateVersion, sha256: receipt.candidateSha256 },
        source: { key: candidate.sourceKey, version: candidate.sourceVersion, sha256: candidate.zipSha256 } };
    check(Object.values(refs).every(valid), "original immutable versions.");
    return refs;
}
export async function preserveRendererArchive({ receipt, candidate, readObject, store }) {
    const originals = rendererOriginalReferences(receipt, candidate), archive = {};
    for (const [name, original] of Object.entries(originals)) {
        const bytes = await readObject(original);
        check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= (name === "candidate" ? 16384 : 25000000) &&
            hash(bytes) === original.sha256, "original bytes and checksum.");
        const copy = await store.save(names[name], bytes);
        check(valid(copy) && copy.sha256 === original.sha256 && equal(await store.read(copy), bytes), "immutable copy readback.");
        archive[name] = { original, copy };
    }
    return archive;
}
export function rendererArchiveReference(qualification, name, original) {
    const archive = qualification.rendererArchive;
    check(archive && Object.hasOwn(names, name) && equal(Object.keys(archive.artifacts ?? {}).sort(), Object.keys(names).sort()) &&
        /^native-\d+$/.test(archive.releaseId ?? "") && Number.isSafeInteger(archive.runId) && archive.runId > 0, "qualified archive identity.");
    const entry = archive.artifacts[name];
    const filename = names[name].replace(/(\.[a-z]+)$/, `-${archive.releaseId}-run-${archive.runId}$1`);
    check(valid(original) && equal(entry?.original, original) && valid(entry.copy) && entry.copy.sha256 === original.sha256 &&
        entry.copy.key === "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/" + (filename), "exact qualified copy of the original build artifact.");
    return entry.copy;
}
export async function captureRendererArchive(env, store, pair) {
    const receipt = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-lambda/development-candidate.json", import.meta.url))));
    const candidate = await loadVerifiedCandidate(receipt, env);
    check(candidate.imageDigest === pair.imageDigest && candidate.verifiedForCommit === pair.sourceCommit, "live qualified renderer.");
    const call = await createDevelopmentCICall(env), directory = await mkdtemp(join(env.RUNNER_TEMP, "renderer-archive-"));
    let index = 0;
    return preserveRendererArchive({ receipt, candidate, store, readObject: async (ref) => {
            const path = join(directory, `original-${index++}`);
            const response = await call(["s3api", "get-object", "--bucket", "forever-tee-video-development-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", ref.key, "--version-id", ref.version, path]);
            check(response.VersionId === ref.version, "original S3 version.");
            return readFile(path);
        } });
}
