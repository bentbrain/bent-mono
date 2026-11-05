import { protectedConfig } from "./protected-config.mjs";
import { verifyQualifiedPrintExecutor } from "./native-print-qualification.mjs";
import { shippingCases, paidOrderCases } from "./native-shipping-qualification.mjs";
import { isDeepStrictEqual as equal } from "node:util";
import { validateQualificationInventory } from "./native-qualification-inventory.mjs";
import { createHash } from "node:crypto";
import { completeQualificationSummary } from "./native-ci-qualification.mjs";
import { assertDeployableImage } from "./native-ci-image-policy.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Production qualification evidence rejected: ${reason}`); };
const names = ["families", "exhaustion", "faults", "termination", "load"];
const files = ["summary", "exhaustion-report", "faults-summary", "termination-summary", "load-summary"];
const faultNames = ["invoke-ack", "invoke-duplicate", "claim-ack", "upload-ack", "enqueue-send"];
function verifyCohort(reports, labels) {
    check(Array.isArray(reports) && reports.length === labels.length && reports.every((report, index) => report.label === labels[index] && report.videos === 4 && report.attemptsPerVideo === 1 &&
        [report.confirmationMs, report.firstPushMs, report.allPushMs].every(value => Number.isFinite(value) && value >= 0 && value < 180000) &&
        report.confirmationMs <= report.firstPushMs && report.firstPushMs <= report.allPushMs &&
        Number.isInteger(report.connections) && report.connections >= 1 && report.connections <= 4), "complete bounded family cohort.");
}
function verifyPrintReadiness(record, expectedPair, expectedFamilies, provider) {
    const latency = record.printLatency;
    check(latency?.passed === true && latency.sourceCommit === expectedPair.sourceCommit && latency.maxReadyMs === 12000 &&
        latency.expectedFamilies === expectedFamilies && latency.reportedFamilies === expectedFamilies &&
        latency.reports?.length === expectedFamilies && latency.reports.every(report => report.passed === true &&
        report.provider === provider && report.sourceCommit === expectedPair.sourceCommit && report.maxReadyMs === 12000 &&
        report.samples?.length === 2 && report.samples.every(sample => sample.complete === true &&
        Number.isSafeInteger(sample.recordToReadyMs) && sample.recordToReadyMs >= 0 && sample.recordToReadyMs <= 12000)), "complete print readiness cohort within the unchanged latency gate.");
}
function verifyPaidJourney(record, runId, commerce) {
    const cases = commerce ? [...shippingCases, ...paidOrderCases] : shippingCases;
    check(record.cloudShippingQualification === true && record.notificationSink === "in-process-simulated-shopify" &&
        record.customerNotificationsSent === 0 && record.cleanup?.databaseDeleted === true &&
        record.cleanup.databaseId === record.databaseId && record.cleanup.name === `forever-tee-shipping-qualification-${runId}` &&
        (!commerce || record.paidOrderJourneyVerified === true && record.providerSink === "in-process-simulated-printify" && record.providerMutations === 0) &&
        record.tests?.length === cases.length && cases.every(name => record.tests.filter(item => item.name === name && item.passed === true).length === 1), "real isolated D1 paid journey and controlled provider sinks with completed database cleanup.");
}
// The caller must read exact object versions from the private personal artifact
// bucket and obtain githubRun from the authenticated repository Actions API.
// This verifier performs no AWS calls, writes, credential lookup or promotion.
async function verifyFunctionalRecords({ reference, expectedPair, expectedQualificationCommit, githubRun, readObject, readRun }, expectedConclusion = "success", allowShipping = true) {
    assertDeployableImage(expectedPair?.imageDigest);
    check(/^native-\d+$/.test(expectedPair?.releaseId ?? "") && /^[a-f0-9]{40}$/.test(expectedPair?.sourceCommit ?? ""), "expected deployed pair.");
    check(Number.isSafeInteger(githubRun?.id) && githubRun.id > 0 && githubRun.status === "completed" && githubRun.conclusion === expectedConclusion &&
        githubRun.run_attempt === 1 && githubRun.event === "workflow_dispatch" &&
        githubRun.path === ".github/workflows/native-development.yml" && githubRun.head_branch === "main" &&
        /^[a-f0-9]{40}$/.test(expectedQualificationCommit ?? "") && githubRun.head_sha === expectedQualificationCommit &&
        githubRun.repository?.id === Number(protectedConfig("githubRepositoryId")) &&
        githubRun.repository.full_name === "bentbrain/bent-mono" && githubRun.repository.owner?.id === Number(protectedConfig("githubOwnerId")) &&
        githubRun.head_repository?.id === Number(protectedConfig("githubRepositoryId")), "successful first-attempt personal qualification workflow.");
    const prefix = "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-";
    const immutableSuffix = `-${expectedPair.releaseId}-run-${githubRun.id}`;
    const read = async (ref, suffix) => {
        check(ref?.key === `${prefix}${suffix}${immutableSuffix}.json` && typeof ref.version === "string" &&
            /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(ref.version) && ref.version !== "null" &&
            /^[a-f0-9]{64}$/.test(ref.sha256 ?? ""), "exact immutable object reference.");
        const bytes = await readObject(ref);
        check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536 &&
            createHash("sha256").update(bytes).digest("hex") === ref.sha256, "object bytes and checksum.");
        let record;
        try {
            record = JSON.parse(bytes);
        }
        catch {
            check(false, "object JSON.");
        }
        check(record !== null && typeof record === "object" && !Array.isArray(record) &&
            record.releaseId === expectedPair.releaseId && record.sourceCommit === expectedPair.sourceCommit &&
            record.imageDigest === expectedPair.imageDigest, "object belongs to the expected deployed pair.");
        return record;
    };
    const summary = await read(reference, "complete-summary");
    check(summary.cloudQualificationComplete === true && summary.realMobilePlaybackVerified === false &&
        summary.productionPromotionPerformed === false, "complete cloud-only evidence.");
    if (["shipping", "commerce"].includes(summary.qualificationKind)) {
        const commerce = summary.qualificationKind === "commerce";
        check(allowShipping && summary.schemaVersion === (commerce ? 4 : 3) && typeof readRun === "function", "bounded component qualification chain.");
        const shipping = await read(summary.shippingEvidence, "shipping-report");
        verifyPaidJourney(shipping, githubRun.id, commerce);
        const smoke = await read(summary.smokeEvidence, "summary");
        check(smoke.cloudFamilyQualification === true, "live video smoke");
        verifyCohort(smoke.reports, ["one", "two"]);
        const original = summary.rendererQualification;
        check(original?.expectedPair?.imageDigest === expectedPair.imageDigest && Number.isSafeInteger(original.qualificationRunId) &&
            original.qualificationRunId > 0 && original.qualificationRunId !== githubRun.id, "original full renderer qualification.");
        const originalRun = await readRun(original.qualificationRunId);
        check(originalRun.id === original.qualificationRunId, "original renderer run identity");
        const verified = await verifyDevelopmentQualification({ reference: original.reference, expectedPair: original.expectedPair,
            expectedQualificationCommit: original.expectedQualificationCommit, githubRun: originalRun, readObject, readRun }, false);
        check(!commerce || original.boundary === "isolated-printify-contracts-v2" && verified.rendererEvidence?.boundary === original.boundary, "same reviewed commerce boundary");
        const printProvider = smoke.printLatency?.provider ?? "queue";
        check(printProvider === verified.printProvider, "unchanged print provider");
        let printExecutor = verified.printExecutor;
        if (printProvider === "durable-object") {
            verifyPrintReadiness(smoke, expectedPair, 2, printProvider);
            printExecutor = await verifyQualifiedPrintExecutor(smoke.printExecutor, expectedPair, readObject, { archive: smoke.printExecutorArchive, cohort: "normal", runId: githubRun.id });
        }
        check(verified.qualificationKind === "full" && verified.rendererEvidence?.inputsDigest === original.inputsDigest &&
            /^[a-f0-9]{64}$/.test(original.inputsDigest ?? "") && verified.rendererEvidence?.configurationDigest === original.configurationDigest &&
            verified.workerVersionId === original.workerVersionId &&
            /^[a-f0-9]{64}$/.test(original.configurationDigest ?? ""), "same qualified renderer inputs and runtime configuration.");
        return { cloudQualificationVerified: true, releaseId: expectedPair.releaseId, sourceCommit: expectedPair.sourceCommit,
            imageDigest: expectedPair.imageDigest, qualificationRunId: githubRun.id, qualificationSourceCommit: githubRun.head_sha,
            reference, summary, qualificationKind: summary.qualificationKind, rendererQualification: original, printProvider,
            ...(verified.rendererArchive ? { rendererArchive: verified.rendererArchive } : {}),
            ...(printExecutor ? { printExecutor } : {}),
            ...(commerce ? { paidOrderJourneyVerified: true } : {}),
            stages: [{ name: commerce ? "paid-order-journey" : "shipping", evidence: summary.shippingEvidence }, { name: "video-smoke", evidence: summary.smokeEvidence }],
            realMobilePlaybackVerified: false, productionAdmissionGranted: false };
    }
    if (summary.rendererEvidence?.boundary === "isolated-printify-contracts-v2") {
        verifyPaidJourney(await read(summary.shippingEvidence, "shipping-report"), githubRun.id, true);
    }
    check(Array.isArray(summary.stages), "full qualification stages.");
    completeQualificationSummary(summary.stages, expectedPair.releaseId);
    check(summary.stages.every(stage => stage.sourceCommit === expectedPair.sourceCommit && stage.imageDigest === expectedPair.imageDigest), "stage references belong to the expected pair.");
    const stages = [];
    let printProvider, printExecutor;
    for (const [index, name] of names.entries()) {
        const record = await read(summary.stages[index].evidence, files[index]);
        if (name === "families" || name === "load") {
            const provider = record.printLatency?.provider ?? "queue", expectedFamilies = name === "families" ? 2 : 3;
            check(["queue", "durable-object"].includes(provider) && (!printProvider || printProvider === provider), "consistent qualified print provider.");
            printProvider = provider;
            if (provider === "durable-object") {
                verifyPrintReadiness(record, expectedPair, expectedFamilies, provider);
                const verified = await verifyQualifiedPrintExecutor(record.printExecutor, expectedPair, readObject, {
                    archive: record.printExecutorArchive, cohort: name === "families" ? "normal" : "load", runId: githubRun.id
                });
                check(!printExecutor || equal(verified, printExecutor), "executor changed between qualification cohorts.");
                printExecutor = verified;
            }
        }
        if (name === "families") {
            check(record.cloudFamilyQualification === true, "family qualification.");
            verifyCohort(record.reports, ["one", "two"]);
        }
        else if (name === "exhaustion") {
            check(record.cloudExhaustionQualification === true && record.videos === 4 && record.attemptsPerVideo === 3 &&
                record.terminalDuplicateStable === true && Number.isFinite(record.settledMs) && record.settledMs >= 0 && record.settledMs < 600000, "bounded exhaustion and terminal duplicate stability.");
        }
        else if (name === "faults") {
            check(record.cloudFaultQualification === true && record.reports?.length === faultNames.length &&
                record.reports.every((report, position) => report.point === faultNames[position] && report.videos === 4 && report.attemptsPerVideo === 1 &&
                    [report.confirmationMs, report.firstPushMs, report.allPushMs].every(value => Number.isFinite(value) && value >= 0 && value < 180000) &&
                    report.confirmationMs <= report.firstPushMs && report.firstPushMs <= report.allPushMs), "every required fault cohort.");
        }
        else if (name === "termination") {
            check(record.cloudTerminationQualification === true && record.leaseObserved === true && record.videos === 4 &&
                record.recoveredAttempt === 2 && record.unchangedSiblingAttempts === 1 && Number.isFinite(record.settledMs) &&
                record.settledMs >= 180000 && record.settledMs < 480000 && record.completed === true &&
                Array.isArray(record.readyKeys) && record.readyKeys.length === 4 && new Set(record.readyKeys).size === 4, "fenced termination recovery.");
        }
        else {
            const admission = record.admission;
            const capacity = record.capacity;
            const admitted = admission?.version === 1 && admission.limit === 8 &&
                Number.isInteger(admission.running) && admission.running > 0 && admission.running <= 8 &&
                Number.isInteger(admission.waiting) && admission.waiting > 0 && admission.waitingAttempts === 0 &&
                Number.isFinite(capacity?.peak) && capacity.peak > 0 && capacity.peak <= 8 && capacity.throttled === 0;
            const historical = !admission && capacity?.peak === 8 && Number.isFinite(capacity.throttled) && capacity.throttled > 0;
            check(record.cloudCapacityQualification === true && record.cloudFamilyQualification === true &&
                capacity?.qualified === true && (admission ? admitted : historical), "verified bounded capacity and durable admission or historical throttle recovery.");
            verifyCohort(record.reports, ["load-one", "load-two", "load-three"]);
        }
        stages.push({ name, evidence: summary.stages[index].evidence });
    }
    return { cloudQualificationVerified: true, releaseId: expectedPair.releaseId, sourceCommit: expectedPair.sourceCommit,
        imageDigest: expectedPair.imageDigest, qualificationRunId: githubRun.id,
        qualificationSourceCommit: githubRun.head_sha, reference, stages, summary, printProvider,
        ...(summary.rendererArchive ? { rendererArchive: { artifacts: summary.rendererArchive, releaseId: expectedPair.releaseId, runId: githubRun.id } } : {}), ...(printExecutor ? { printExecutor } : {}), qualificationKind: "full", rendererEvidence: summary.rendererEvidence, realMobilePlaybackVerified: false, productionAdmissionGranted: false };
}
async function readReceipt(reference, key, readObject) {
    check(reference?.key === key && typeof reference.version === "string" &&
        /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference.version) && reference.version !== "null" &&
        /^[a-f0-9]{64}$/.test(reference.sha256 ?? ""), "exact immutable receipt reference.");
    const bytes = await readObject(reference);
    check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 131072 &&
        createHash("sha256").update(bytes).digest("hex") === reference.sha256, "receipt checksum and size.");
    return JSON.parse(bytes);
}
const receiptKey = (name, releaseId, runId) => "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-" + (name) + "-" + (releaseId) + "-run-" + (runId) + ".json";
export async function verifyRecoverableQualification(input, allowShipping = true) {
    check(/^Native development · (?:qualify-all|qualify-components) · full · /.test(input.githubRun?.display_title ?? ""), "original full qualification operation.");
    const result = await verifyFunctionalRecords(input, "failure", allowShipping);
    check([2, 3, 4].includes(result.summary.schemaVersion) && result.summary.identity && result.summary.inventoryReference, "functional completion and cleanup inventory were preserved before failure.");
    return { ...result, cloudQualificationVerified: false, functionalQualificationVerified: true };
}
export async function verifyDevelopmentQualification(input, allowShipping = true) {
    const { reference, expectedPair, githubRun, readObject, expectedQualificationCommit, readRun } = input;
    if (reference?.key !== receiptKey("receipt", expectedPair?.releaseId, githubRun?.id)) {
        const result = await verifyFunctionalRecords(input, "success", allowShipping);
        // Existing schema-1 evidence remains valid. New functional-only summaries
        // must be accompanied by an immutable successful cleanup receipt.
        check(result.summary.schemaVersion === undefined || result.summary.schemaVersion === 1, "new qualification requires its cleanup receipt.");
        return result;
    }
    check(githubRun?.status === "completed" && githubRun.conclusion === "success" && githubRun.run_attempt === 1 &&
        githubRun.event === "workflow_dispatch" && githubRun.head_branch === "main" &&
        githubRun.path === ".github/workflows/native-development.yml" && githubRun.head_sha === expectedQualificationCommit &&
        githubRun.repository?.id === Number(protectedConfig("githubRepositoryId")) && githubRun.repository?.owner?.id === Number(protectedConfig("githubOwnerId")) &&
        githubRun.head_repository?.id === Number(protectedConfig("githubRepositoryId")), "successful completion workflow.");
    const receipt = await readReceipt(reference, receiptKey("receipt", expectedPair.releaseId, githubRun.id), readObject);
    check(receipt.schemaVersion === 1 && receipt.qualificationComplete === true && Number.isSafeInteger(receipt.functionalRunId) &&
        receipt.functionalRunId > 0 && equal(receipt.expectedPair, expectedPair), "complete original-pair receipt.");
    const recovery = receipt.functionalRunId !== githubRun.id;
    check(!recovery || typeof readRun === "function", "authenticated original-run reader required.");
    const originalRun = recovery ? await readRun(receipt.functionalRunId) : githubRun;
    check(originalRun.id === receipt.functionalRunId && originalRun.head_sha === expectedQualificationCommit, "cleanup cannot change the qualified source.");
    const originalInput = { ...input, reference: receipt.functionalReference, githubRun: originalRun };
    const functional = recovery ? await verifyRecoverableQualification(originalInput, allowShipping) : await verifyFunctionalRecords(originalInput, "success", allowShipping);
    check(allowShipping || functional.qualificationKind === "full", "component qualification cannot establish another renderer baseline.");
    check([2, 3, 4].includes(functional.summary.schemaVersion) && equal(functional.summary.identity, receipt.identity), "original Worker identity.");
    check(receipt.identity.releaseId === expectedPair.releaseId && receipt.identity.sourceCommit === expectedPair.sourceCommit &&
        receipt.identity.imageDigest === expectedPair.imageDigest && /^[a-f0-9-]{36}$/.test(receipt.identity.workerVersionId ?? "") &&
        /^[a-f0-9]{64}$/.test(receipt.identity.workerBundleSha256 ?? "") && /^[a-f0-9]{64}$/.test(receipt.identity.workerResourcesSha256 ?? ""), "exact qualified Worker bundle and resources.");
    const cleanup = await readReceipt(receipt.cleanupReference, receiptKey("cleanup-complete", expectedPair.releaseId, githubRun.id), readObject);
    check(cleanup.schemaVersion === 1 && cleanup.cleanupComplete === true && cleanup.runId === String(githubRun.id) &&
        cleanup.originalRunId === String(originalRun.id) && cleanup.releaseId === expectedPair.releaseId &&
        cleanup.qualificationSourceCommit === originalRun.head_sha &&
        equal(cleanup.inventoryReference, functional.summary.inventoryReference), "cleanup belongs to the original inventory.");
    const inventory = await readReceipt(cleanup.inventoryReference, receiptKey("cleanup-inventory", expectedPair.releaseId, originalRun.id), readObject);
    validateQualificationInventory(inventory, { GITHUB_RUN_ID: String(originalRun.id), GITHUB_SHA: originalRun.head_sha, NATIVE_VERIFY_RELEASE: expectedPair.releaseId });
    check(cleanup.qualificationFixturesDeleted === inventory.fixtures.length && inventory.fixtures.length > 0, "every original fixture was cleaned.");
    return { ...functional, cloudQualificationVerified: true, qualificationRunId: githubRun.id, reference,
        workerVersionId: receipt.identity.workerVersionId, functionalRunId: originalRun.id, cleanupReference: receipt.cleanupReference, cleanupVerified: true,
        summary: undefined, functionalQualificationVerified: undefined };
}
