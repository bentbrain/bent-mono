import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { promotionManifest } from "./release-manifest.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { verifyPromotionEvidence, verifyOriginalSourceArchive } from "./native-production-candidate.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
test("Production admission evidence binds the original image, pair, phone acceptance and received alert", async () => {
    const load = async (path) => JSON.parse(resolveProtectedTemplate(await readFile(new URL(`../${path}`, import.meta.url))));
    const candidate = { sourceDigest: promotionManifest.candidate.sourceDigest,
        imageDigest: promotionManifest.candidate.imageDigest,
        githubRunId: String(promotionManifest.candidate.buildRunId), sourceCommit: promotionManifest.candidate.sourceCommit };
    const qualification = { releaseId: promotionManifest.qualification.releaseId, sourceCommit: promotionManifest.qualification.sourceCommit,
        imageDigest: candidate.imageDigest, cloudQualificationVerified: true, qualificationRunId: promotionManifest.qualification.runId };
    const receipt = await load("infra/story-video-lambda/development-qualification.json");
    assert.deepEqual(receipt.expectedPair, { releaseId: qualification.releaseId,
        sourceCommit: qualification.sourceCommit, imageDigest: qualification.imageDigest }, "checked-in qualification receipt must match the pinned Production pair");
    assert.equal(receipt.qualificationRunId, qualification.qualificationRunId);
    const phone = await load(promotionManifest.phone.path), delivery = await load(promotionManifest.alertDelivery.path);
    const buildRun = { id: promotionManifest.candidate.buildRunId, head_sha: candidate.sourceCommit, head_branch: "main", path: ".github/workflows/native-development.yml" };
    const deliveryRun = { id: delivery.verificationRunId, head_sha: delivery.verificationSourceCommit, head_branch: "main", path: ".github/workflows/native-production-foundation.yml" };
    const values = [candidate, qualification, phone, delivery, buildRun, deliveryRun];
    assert.equal(verifyPromotionEvidence(...values).productionAdmissionGranted, false);
    for (const mutate of [
        values => { values[0].imageDigest = `sha256:${"f".repeat(64)}`; }, values => { values[0].sourceDigest = "other"; },
        values => { values[1].releaseId = "native-other"; },
        values => { values[1].releaseId = "native-33714370693"; }, values => { values[1].qualificationRunId = Number(protectedConfig("resource_8d0190ecec7d")); },
        values => { values[1].sourceCommit = "4633645d7b7534c9d1cf157ed1eaa209b1e27a22"; },
        values => { values[1].cloudQualificationVerified = false; }, values => { values[2].developmentReleaseId = "native-other"; },
        values => { values[1].printProvider = "durable-object"; },
        values => { values[2].qualificationRunId = 1; }, values => { values[2].workerVersionId = "other"; },
        values => { values[2].ownerResponse = "not checked"; },
        values => { values[2].requestedChecks.pop(); },
        values => { values[3].ownerConfirmedReceipt = false; }, values => { values[3].verificationRunId = 1; },
        values => { values[4].head_sha = "other"; }, values => { values[5].head_branch = "feature"; },
    ]) {
        const copy = structuredClone(values);
        mutate(copy);
        assert.throws(() => verifyPromotionEvidence(...copy));
    }
});
test("original archive verifies every binary byte, exact membership and manifest rather than trusting metadata", async () => {
    const content = Buffer.from([0, 255, 128, 7]), manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, files: { "product-assets/image.png": sha(content) } }));
    const run = async (_command, args, options) => {
        if (args[0] === "-Z")
            return { stdout: "bundle-manifest.json\nproduct-assets/image.png\n" };
        assert.equal(options.encoding, "buffer");
        return { stdout: args.at(-1) === "bundle-manifest.json" ? manifest : content };
    };
    assert.equal((await verifyOriginalSourceArchive("/private/source.zip", sha(manifest), run)).sourceArchiveFilesVerified, 1);
    await assert.rejects(verifyOriginalSourceArchive("/private/source.zip", "f".repeat(64), run), /manifest bytes/);
    await assert.rejects(verifyOriginalSourceArchive("/private/source.zip", sha(manifest), async (...args) => args[1].at(-1) === "product-assets/image.png" ? { stdout: Buffer.from("changed") } : run(...args)), /file bytes/);
    await assert.rejects(verifyOriginalSourceArchive("/private/source.zip", sha(manifest), async (...args) => args[1][0] === "-Z" ? { stdout: "bundle-manifest.json\nproduct-assets/image.png\nproduct-assets/image.png\n" } : run(...args)), /archive members/);
});
