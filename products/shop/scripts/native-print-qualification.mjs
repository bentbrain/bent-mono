import { protectedConfig } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { verifyPrintExecutorConfig } from "./native-print-executor.mjs";
const check = (value, reason) => { if (!value)
    throw Error(`Print qualification rejected: ${reason}`); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function archiveNames(cohort) {
    check(["normal", "load"].includes(cohort), "bounded qualification cohort.");
    return { deployment: `qualification-print-executor-${cohort}-deployment.json`,
        foundation: `qualification-print-executor-${cohort}-foundation.json`,
        bundle: `qualification-print-executor-${cohort}-bundle.js` };
}
function immutableReference(reference) {
    check(/^source\/releases\/native-\d+\/[a-z0-9-]+\.(?:json|js)$/.test(reference?.key ?? "") &&
        typeof reference.version === "string" && /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference.version) &&
        reference.version !== "null" && /^[a-f0-9]{64}$/.test(reference.sha256 ?? ""), "immutable artifact reference.");
}
function originalReferences(record) {
    return { deployment: record?.evidence, foundation: record?.artifacts?.foundationArtifact,
        bundle: record?.artifacts?.candidateArtifact };
}
// Copy only the three already verified executor artifacts into the qualification
// prefix that Production can read. Their original references stay in the report.
// This avoids granting Production access to every Development release directory.
export async function preserveQualifiedPrintExecutor(record, store, cohort) {
    const names = archiveNames(cohort), archive = {};
    for (const [name, original] of Object.entries(originalReferences(record))) {
        immutableReference(original);
        const bytes = await store.read(original);
        check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 10000000 && hash(bytes) === original?.sha256, "source artifact copy bytes.");
        const copy = await store.save(names[name], bytes);
        immutableReference(copy);
        check(copy?.sha256 === original.sha256 && equal(await store.read(copy), bytes), "immutable artifact copy readback.");
        archive[name] = copy;
    }
    return archive;
}
// Read only immutable Development artifacts. The caller supplies the scoped,
// version-pinned object reader already used for native qualification evidence.
export async function verifyQualifiedPrintExecutor(record, pair, readObject, { archive, cohort, runId }) {
    check(record?.sourceCommit === pair.sourceCommit && record.releaseId === pair.releaseId &&
        /^[a-f0-9]{32}$/.test(record.namespaceId ?? "") &&
        /^[a-f0-9-]{36}$/.test(record.worker?.workerVersion ?? "") &&
        /^[a-f0-9]{64}$/.test(record.worker?.versionResourcesSha256 ?? "") &&
        equal(record.lifecycle, { migrationTag: "print-execution-v1" }), "source, generation and namespace identity.");
    const names = archiveNames(cohort), originals = originalReferences(record);
    check(Number.isSafeInteger(runId) && runId > 0 && archive &&
        equal(Object.keys(archive).sort(), Object.keys(names).sort()), "complete qualification artifact archive.");
    const read = async (name) => {
        const original = originals[name], reference = archive[name];
        immutableReference(original);
        immutableReference(reference);
        const filename = names[name].replace(/(\.[a-z]+)$/, `-${pair.releaseId}-run-${runId}$1`);
        check(reference?.key === "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/" + (filename) && reference.sha256 === original?.sha256, "exact cohort copy of the original artifact.");
        const bytes = await readObject(reference);
        check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 10000000 && hash(bytes) === reference.sha256, "immutable artifact bytes.");
        return bytes;
    };
    const { evidence, ...saved } = record;
    check(equal(JSON.parse(await read("deployment")), saved), "deployment evidence differs.");
    const review = JSON.parse(await read("foundation"));
    check(review.worker === "forever-tee-print-executor-development" &&
        review.accountId === protectedConfig("cloudflareAccountId") && review.sourceCommit === pair.sourceCommit &&
        review.releaseId === pair.releaseId && review.configSha256 === record.configSha256, "qualified Development preparation identity.");
    verifyPrintExecutorConfig(review.config);
    const bytes = await read("bundle");
    check(bytes.length === review.bundleBytes && hash(bytes) === review.bundleSha256 &&
        record.worker.content?.entrypoint === "index.js" && record.worker.content.modules?.length === 1 &&
        record.worker.content.modules[0].sha256 === review.bundleSha256 &&
        record.worker.content.modules[0].bytes === bytes.length, "qualified executor bundle.");
    return record;
}
