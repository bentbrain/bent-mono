import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { verifyAutomatedBrowserEvidence, readAutomatedBrowserEvidence } from './automated-release-acceptance.mjs';
import { rendererArchiveReference } from "./native-renderer-archive.mjs";
import { assertQualifiedSource } from './release-qualification-policy.mjs';
import { promotionInput, sealPromotionInput } from "./release-promotion-input.mjs";
import { renderingInputManifest, shippingOnlyPaths, commerceOnlyPaths, commerceBoundary } from "./rendering-inputs.mjs";
import { gitChanges } from "./deployment-plan.mjs";
import { readQualificationRun } from "./native-qualification-reference.mjs";
import { promotionManifest } from "./release-manifest.mjs";
import { createHash } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertProductionContext, productionAWS, readProductionEvidenceRun } from "./native-production-ci.mjs";
import { verifyCandidateRecord } from "./native-ci-candidate.mjs";
import { verifyCandidateCheckout, verifyCloudBuild } from "./native-ci-build.mjs";
import { verifyDevelopmentQualification } from "./native-production-qualification.mjs";
import { packageAppSource } from "../workers/video-renderer/aws-lambda/package-app-source.mjs";
import { verifyFoundationStorage, verifyAlertSubscription, foundationEvidenceSaver } from "./native-production-foundation.mjs";
const execute = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const check = (value, reason) => {
    if (!value)
        throw new Error(`Production candidate stopped: ${reason}`);
};
const PROJECT = "forever-tee-video-development", BUCKET = (PROJECT) + "-" + protectedConfig("awsAccountId") + "-ap-southeast-2";
export function verifyPromotionEvidence(candidate, qualification, phone, delivery, buildRun, deliveryRun, manifest = promotionManifest, automated = null) {
    check(!qualification.printProvider || qualification.printProvider === "queue" ||
        qualification.printProvider === "durable-object" && qualification.printExecutor?.sourceCommit === qualification.sourceCommit &&
            qualification.printExecutor.releaseId === qualification.releaseId, "durable print promotion requires the qualified executor's immutable artifact evidence.");
    const pinned = manifest.candidate, qualified = manifest.qualification;
    check(candidate.sourceDigest === pinned.sourceDigest &&
        candidate.imageDigest === pinned.imageDigest &&
        candidate.githubRunId === String(pinned.buildRunId) && candidate.sourceCommit === pinned.sourceCommit, "exact qualified image, not a replacement build.");
    check(buildRun.id === pinned.buildRunId && buildRun.head_sha === candidate.sourceCommit && buildRun.head_branch === "main" &&
        buildRun.path === ".github/workflows/native-development.yml", "original candidate Actions build.");
    check(qualification.cloudQualificationVerified === true && qualification.releaseId === qualified.releaseId &&
        qualification.imageDigest === candidate.imageDigest && qualification.qualificationRunId === qualified.runId &&
        qualification.sourceCommit === qualified.sourceCommit, "qualified compatible pair.");
    const acceptedPair = qualification.qualificationKind === "shipping" ? qualification.rendererQualification?.expectedPair : qualification;
    const acceptedRunId = qualification.qualificationKind === "shipping" ? qualification.rendererQualification?.qualificationRunId : qualification.qualificationRunId;
    if (automated)
        check(automated.acceptanceVerified === true && automated.acceptanceType === 'automated-cloud-and-browser' &&
            automated.phoneAcceptanceVerified === false && ['full', 'commerce'].includes(qualification.qualificationKind), 'verified automated qualification.');
    else
        check(phone.schemaVersion === 1 && phone.acceptanceType === "owner-phone-report" && phone.ownerResponse === manifest.phone.ownerResponse &&
            phone.developmentReleaseId === acceptedPair?.releaseId && phone.imageDigest === candidate.imageDigest &&
            phone.qualificationRunId === acceptedRunId && phone.workerVersionId === manifest.phone.workerVersionId &&
            (qualification.qualificationKind === "shipping" ? phone.workerVersionId === qualification.rendererQualification.workerVersionId :
                !qualification.workerVersionId || phone.workerVersionId === qualification.workerVersionId) &&
            equal(phone.requestedChecks, manifest.phone.requestedChecks), "owner phone acceptance of this exact pair.");
    check(delivery.schemaVersion === 1 && delivery.acceptanceType === "owner-email-receipt-report" && delivery.ownerConfirmedReceipt === true &&
        delivery.emailSubscriptionConfirmed === true && delivery.runtimeAlarmsVerified === 7 && delivery.environment === "production" &&
        delivery.verificationRunId === manifest.alertDelivery.runId && delivery.verificationSourceCommit === manifest.alertDelivery.sourceCommit &&
        deliveryRun.id === delivery.verificationRunId && deliveryRun.head_sha === delivery.verificationSourceCommit && deliveryRun.head_branch === "main" &&
        deliveryRun.path === ".github/workflows/native-production-foundation.yml", "owner receipt and original verification run.");
    return { qualifiedImageVerified: true, acceptanceVerified: true, phoneAcceptanceVerified: !automated,
        acceptanceType: automated?.acceptanceType ?? 'owner-phone-report', alertDeliveryVerified: true, productionAdmissionGranted: false };
}
export async function verifyOriginalSourceArchive(path, sourceDigest, run = execute) {
    const manifest = (await run("/usr/bin/unzip", ["-p", path, "bundle-manifest.json"], { encoding: "buffer", maxBuffer: 65536, timeout: 30000 })).stdout;
    check(hash(manifest) === sourceDigest, "original source manifest bytes.");
    const record = JSON.parse(manifest);
    check(record.schemaVersion === 1 && record.files && Object.keys(record.files).length <= 40, "bounded manifest.");
    const names = (await run("/usr/bin/unzip", ["-Z", "-1", path], { encoding: "utf8", maxBuffer: 65536, timeout: 30000 })).stdout.trim().split("\n");
    check(equal(names.sort(), ["bundle-manifest.json", ...Object.keys(record.files)].sort()), "exact archive members; no extra files or duplicates.");
    for (const [name, digest] of Object.entries(record.files)) {
        check(/^[a-zA-Z0-9][a-zA-Z0-9./_-]+$/.test(name) && !name.includes("..") && /^[a-f0-9]{64}$/.test(digest), "safe manifest path and checksum.");
        const bytes = (await run("/usr/bin/unzip", ["-p", path, name], { encoding: "buffer", maxBuffer: 25 * 1024 * 1024, timeout: 30000 })).stdout;
        check(hash(bytes) === digest, "original source file bytes.");
    }
    return { sourceArchiveFilesVerified: names.length - 1, sourceDigest };
}
export async function runProductionCandidate(env = process.env) {
    assertProductionContext(env);
    check(process.platform === "linux" && process.arch === "x64" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only x86 Actions execution.");
    await verifyCandidateCheckout(env);
    const { call } = await productionAWS(env);
    const storage = await verifyFoundationStorage(call);
    const alerts = await verifyAlertSubscription(call, env.NATIVE_ALERT_EMAIL, false);
    check(alerts.emailSubscriptionConfirmed === true && alerts.runtimeAlarmsVerified === 7, "live Production alert configuration.");
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-production-candidate-"));
    const load = async (path) => JSON.parse(resolveProtectedTemplate(await readFile(new URL(`../${path}`, import.meta.url))));
    const input = promotionInput(env), manifest = input?.manifest ?? promotionManifest;
    const receipt = input?.candidateReceipt ?? await load("infra/story-video-lambda/development-candidate.json");
    const qualified = input?.qualification ?? await load("infra/story-video-lambda/development-qualification.json");
    const inputReference = input ? await sealPromotionInput(input, env.GITHUB_SHA, foundationEvidenceSaver(directory, env.GITHUB_RUN_ID, call)) : null;
    let index = 0;
    const read = async (reference) => {
        check(typeof reference.key === "string" && reference.key.startsWith("source/") && !reference.key.includes("..") &&
            typeof reference.version === "string" && reference.version !== "null" && reference.version.length > 0 && reference.version.length < 1024 &&
            /^[a-f0-9]{64}$/.test(reference.sha256), "version/hash-pinned evidence reference.");
        const path = join(directory, `object-${index++}`);
        const result = await call(["s3api", "get-object", "--bucket", BUCKET, "--expected-bucket-owner", protectedConfig("awsAccountId"), "--key", reference.key, "--version-id", reference.version, path]);
        const bytes = await readFile(path);
        check(result.VersionId === reference.version && hash(bytes) === reference.sha256, "exact immutable artifact bytes.");
        return { bytes, path };
    };
    const qualification = await verifyDevelopmentQualification({ reference: qualified.reference, expectedPair: qualified.expectedPair,
        expectedQualificationCommit: qualified.expectedQualificationCommit, githubRun: await readProductionEvidenceRun(env, qualified.qualificationRunId),
        readRun: id => readQualificationRun(env, id), readObject: async (reference) => (await read(reference)).bytes });
    const readBuildArtifact = (name, reference) => read(qualification.rendererArchive
        ? rendererArchiveReference(qualification, name, reference) : reference);
    const bytes = (await readBuildArtifact("candidate", { key: receipt.candidateKey, version: receipt.candidateVersion, sha256: receipt.candidateSha256 })).bytes;
    check(bytes.length < 16384, "bounded candidate record.");
    const packaged = await packageAppSource(directory);
    const candidate = verifyCandidateRecord(receipt, JSON.parse(bytes), packaged.sourceDigest);
    const archive = await readBuildArtifact("source", { key: candidate.sourceKey, version: candidate.sourceVersion, sha256: candidate.zipSha256 });
    const source = await verifyOriginalSourceArchive(archive.path, candidate.sourceDigest);
    const builds = await call(["codebuild", "batch-get-builds", "--ids", candidate.buildId]);
    check(builds.builds?.length === 1 && !builds.buildsNotFound?.length && equal(verifyCloudBuild(builds.builds[0], candidate), { buildId: candidate.buildId, buildArn: candidate.buildArn }), "original successful cloud build.");
    const repositories = await call(["ecr", "describe-repositories", "--repository-names", PROJECT]);
    const repository = repositories.repositories?.[0];
    check(repositories.repositories?.length === 1 && repository.registryId === protectedConfig("awsAccountId") && repository.repositoryName === PROJECT &&
        repository.imageTagMutability === "IMMUTABLE" && !repository.imageTagMutabilityExclusionFilters?.length, "immutable image repository.");
    const images = await call(["ecr", "describe-images", "--repository-name", PROJECT, "--image-ids", `imageTag=source-${candidate.sourceDigest}`]);
    check(images.imageDetails?.length === 1 && images.imageDetails[0].registryId === protectedConfig("awsAccountId") && images.imageDetails[0].repositoryName === PROJECT &&
        images.imageDetails[0].imageDigest === candidate.imageDigest, "actual original image digest.");
    if (["shipping", "commerce"].includes(qualification.qualificationKind)) {
        const boundary = qualification.rendererQualification?.boundary ?? "isolated-printify-webhooks-v1";
        check(qualification.qualificationKind !== "commerce" || boundary === commerceBoundary, "commerce renderer boundary");
        const inputs = renderingInputManifest(qualification.sourceCommit, { boundary });
        check(inputs?.inputsDigest === qualification.rendererQualification?.inputsDigest &&
            (boundary === commerceBoundary ? commerceOnlyPaths : shippingOnlyPaths)(gitChanges(qualification.rendererQualification.expectedPair.sourceCommit, qualification.sourceCommit)), "isolated shipping source and every renderer input must still match the accepted full qualification.");
    }
    let automated = null;
    if (input?.schemaVersion === 2) {
        const browserRun = await readProductionEvidenceRun(env, input.acceptance.previewRunId);
        const [before, after] = await readAutomatedBrowserEvidence(env, input.acceptance.previewRunId);
        automated = verifyAutomatedBrowserEvidence(input.acceptance, qualification, browserRun, before, after);
    }
    const acceptance = verifyPromotionEvidence(candidate, qualification, input?.schemaVersion === 2 ? null : input?.phone ?? await load(manifest.phone.path), await load(manifest.alertDelivery.path), await readProductionEvidenceRun(env, manifest.candidate.buildRunId), await readProductionEvidenceRun(env, manifest.alertDelivery.runId), manifest, automated);
    assertQualifiedSource(qualification.sourceCommit, env.GITHUB_SHA);
    const result = { ...storage, ...acceptance, source, qualification, inputReference, imageDigest: candidate.imageDigest, sourceDigest: candidate.sourceDigest,
        workerSourceUnchanged: true, applicationMutations: false, firstAndAllReadyMonitoringComplete: false, sourceCommit: env.GITHUB_SHA };
    const evidence = await foundationEvidenceSaver(directory, env.GITHUB_RUN_ID, call)("candidate-verification.json", JSON.stringify(result));
    return { ...result, evidence };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await runProductionCandidate()));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
