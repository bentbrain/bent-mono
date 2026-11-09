import { resolveProtectedTemplate } from "./protected-config.mjs";
import { protectedConfig } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import { verifyDevelopmentQualification } from "./native-production-qualification.mjs";
function fixture(mutate = () => { }) {
    const expectedPair = { releaseId: "native-100", sourceCommit: "a".repeat(40), imageDigest: `sha256:${"b".repeat(64)}` };
    const githubRun = { id: 200, status: "completed", conclusion: "success", run_attempt: 1, event: "workflow_dispatch",
        path: ".github/workflows/native-development.yml", head_branch: "main", head_sha: "c".repeat(40),
        repository: { id: Number(protectedConfig("githubRepositoryId")), full_name: "bentbrain/bent-mono", owner: { id: Number(protectedConfig("githubOwnerId")) } }, head_repository: { id: Number(protectedConfig("githubRepositoryId")) } };
    const cohort = labels => labels.map(label => ({ label, confirmationMs: 1000, firstPushMs: 14000, allPushMs: 15000, connections: 1, videos: 4, attemptsPerVideo: 1 }));
    const records = [
        { cloudFamilyQualification: true, reports: cohort(["one", "two"]) },
        { cloudExhaustionQualification: true, videos: 4, attemptsPerVideo: 3, terminalDuplicateStable: true, settledMs: 83000 },
        { cloudFaultQualification: true, reports: ["invoke-ack", "invoke-duplicate", "claim-ack", "upload-ack", "enqueue-send"].map(point => ({
                point, confirmationMs: 1000, firstPushMs: 14000, allPushMs: 15000, videos: 4, attemptsPerVideo: 1
            })) },
        { cloudTerminationQualification: true, leaseObserved: true, videos: 4, recoveredAttempt: 2, unchangedSiblingAttempts: 1,
            settledMs: 230000, completed: true, readyKeys: ["tee:black", "tee:white", "tote:black", "tote:cream"] },
        { cloudCapacityQualification: true, cloudFamilyQualification: true, capacity: { qualified: true, peak: 8, throttled: 2 }, reports: cohort(["load-one", "load-two", "load-three"]) },
    ].map(record => ({ ...expectedPair, ...record }));
    const objects = new Map();
    const save = (name, value, extension = "json", original = false) => {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        const key = original ? `source/releases/native-100/${name}.${extension}`
            : "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-" + (name) + "-native-100-run-200." + (extension);
        const reference = { key, version: "immutable-version", sha256: createHash("sha256").update(bytes).digest("hex") };
        objects.set(key, bytes);
        return reference;
    };
    mutate({ records, githubRun, save });
    const names = ["families", "exhaustion", "faults", "termination", "load"];
    const files = ["summary", "exhaustion-report", "faults-summary", "termination-summary", "load-summary"];
    const stages = names.map((name, index) => ({ name, ...expectedPair, evidence: save(files[index], records[index]) }));
    const reference = save("complete-summary", { ...expectedPair, cloudQualificationComplete: true, stages,
        realMobilePlaybackVerified: false, productionPromotionPerformed: false });
    return { reference, expectedPair, expectedQualificationCommit: "c".repeat(40), githubRun, readObject: async (ref) => objects.get(ref.key) };
}
test("promotion evidence reads six exact version-pinned objects and does not grant Production admission", async () => {
    const input = fixture(), calls = [];
    const result = await verifyDevelopmentQualification({ ...input, readObject: async (ref) => { calls.push(ref); return input.readObject(ref); } });
    assert.equal(calls.length, 6);
    assert.equal(result.cloudQualificationVerified, true);
    assert.equal(result.realMobilePlaybackVerified, false);
    assert.equal(result.productionAdmissionGranted, false);
    assert.equal(result.sourceCommit, "a".repeat(40));
    assert.equal(result.qualificationSourceCommit, "c".repeat(40));
});
test("accepts durable admission evidence and rejects throttling or unbounded claims", async () => {
    const admission = { version: 1, limit: 8, running: 8, waiting: 4, waitingAttempts: 0 };
    const input = (delta = {}, throttled = 0) => fixture(({ records }) => {
        records[4].admission = { ...admission, ...delta };
        records[4].capacity.throttled = throttled;
    });
    assert.equal((await verifyDevelopmentQualification(input())).cloudQualificationVerified, true);
    for (const delta of [{ running: 0 }, { running: 9 }, { waiting: 0 }, { waitingAttempts: 1 }, { limit: 16 }, { version: 2 }]) {
        await assert.rejects(verifyDevelopmentQualification(input(delta)));
    }
    await assert.rejects(verifyDevelopmentQualification(input({}, 1)));
});
function addQualifiedPrints({ records, save, sourceCommit = "a".repeat(40), releaseId = "native-100", withMap = false }) {
    const bytes = Buffer.from("qualified executor fixture"), digest = createHash("sha256").update(bytes).digest("hex");
    const configBytes = readFileSync(new URL("../workers/print-executor/wrangler.jsonc", import.meta.url));
    const review = { worker: "forever-tee-print-executor-development", accountId: protectedConfig("cloudflareAccountId"),
        sourceCommit, releaseId, config: JSON.parse(resolveProtectedTemplate(configBytes)),
        configSha256: createHash("sha256").update(configBytes).digest("hex"), bundleSha256: digest, bundleBytes: bytes.length };
    const record = { sourceCommit: review.sourceCommit, releaseId: review.releaseId, configSha256: review.configSha256,
        namespaceId: "e".repeat(32), lifecycle: { migrationTag: "print-execution-v1" },
        worker: { workerVersion: "11111111-1111-4111-8111-111111111111", versionResourcesSha256: "f".repeat(64),
            content: { entrypoint: "index.js", modules: [{ name: "index.js", bytes: bytes.length, sha256: digest }], sha256: createHash("sha256").update(JSON.stringify({ entrypoint: "index.js", modules: [{ name: "index.js", bytes: bytes.length, sha256: digest }] })).digest("hex") } },
        artifacts: { foundationArtifact: save("print-executor-foundation", review, "json", true), candidateArtifact: save("candidate-print-executor", bytes, "js", true) } };
    const map = Buffer.from(JSON.stringify({ version: 3, file: "index.js", sources: ["src.ts"], names: [], mappings: "" }));
    if (withMap) {
        record.worker.content.modules.push({ name: "index.js.map", bytes: map.length, sha256: createHash("sha256").update(map).digest("hex") });
        record.worker.content.sha256 = createHash("sha256").update(JSON.stringify({ entrypoint: "index.js", modules: record.worker.content.modules })).digest("hex");
        review.schemaVersion = 2;
        review.content = record.worker.content;
        record.artifacts.candidateMapArtifact = save("candidate-print-executor-map", map, "json", true);
        record.artifacts.foundationArtifact = save("print-executor-foundation", review, "json", true);
    }
    const printExecutor = { ...record, evidence: save("deployed-print-executor", record, "json", true) };
    for (const index of [0, 4]) {
        const count = index === 0 ? 2 : 3;
        records[index].printExecutor = structuredClone(printExecutor);
        const cohort = index === 0 ? "normal" : "load";
        records[index].printExecutorArchive = {
            deployment: save(`print-executor-${cohort}-deployment`, record),
            foundation: save(`print-executor-${cohort}-foundation`, review),
            bundle: save(`print-executor-${cohort}-bundle`, bytes, "js"),
            ...(withMap ? { map: save(`print-executor-${cohort}-map`, map) } : {}),
        };
        records[index].printLatency = { provider: "durable-object", passed: true, sourceCommit: review.sourceCommit,
            maxReadyMs: 12000, expectedFamilies: count, reportedFamilies: count,
            reports: Array.from({ length: count }, () => ({ passed: true, provider: "durable-object", sourceCommit: review.sourceCommit,
                maxReadyMs: 12000, samples: [{ complete: true, recordToReadyMs: 6000 }, { complete: true, recordToReadyMs: 7000 }] })) };
    }
}
test("durable print admission requires matching immutable executor bytes across both bounded cohorts", async () => {
    const input = fixture(addQualifiedPrints);
    const result = await verifyDevelopmentQualification({ ...input, readObject: async (reference) => {
            assert.ok(reference.key.startsWith("source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/"), "Production must not read another Development release prefix");
            return input.readObject(reference);
        } });
    assert.equal(result.printProvider, "durable-object");
    assert.equal(result.printExecutor.releaseId, "native-100");
    assert.equal(result.productionAdmissionGranted, false);
    for (const mutate of [records => { records[4].printLatency.provider = "queue"; },
        records => { delete records[0].printExecutor; },
        records => { delete records[0].printExecutorArchive; },
        records => { records[0].printExecutorArchive.bundle.key = records[0].printExecutor.artifacts.candidateArtifact.key; },
        records => { records[4].printExecutorArchive = records[0].printExecutorArchive; },
        records => { records[4].printExecutor.namespaceId = "b".repeat(32); },
        records => { records[0].printExecutor.artifacts.candidateArtifact.sha256 = "0".repeat(64); },
        records => { records[4].printLatency.reports[0].samples[0].recordToReadyMs = 12001; },
        records => { records[4].printLatency.reports.pop(); },
        records => { records[0].printExecutor.sourceCommit = "b".repeat(40); }]) {
        await assert.rejects(verifyDevelopmentQualification(fixture(input => { addQualifiedPrints(input); mutate(input.records); })));
    }
    await assert.rejects(verifyDevelopmentQualification(fixture(({ records }) => {
        records[0].printLatency = { provider: "durable-object" };
    })), /complete print readiness/);
});
test("rejects failed, rerun, foreign, fork and wrong-workflow runs before reading private objects", async () => {
    for (const delta of [{ status: "in_progress" }, { conclusion: "failure" }, { run_attempt: 2 }, { event: "push" },
        { path: ".github/workflows/deploy.yml" }, { head_branch: "perf/story-video-family-experiments" }, { head_sha: "d".repeat(40) },
        { repository: { id: 1 } }, { head_repository: { id: 1 } }]) {
        const input = fixture(({ githubRun }) => Object.assign(githubRun, delta));
        await assert.rejects(verifyDevelopmentQualification({ ...input, readObject: () => assert.fail("No object reads before Actions verification") }));
    }
});
test("rejects missing stage results even when each bad report has a matching checksum", async () => {
    for (const change of [
        records => { records[0].reports.pop(); }, records => { records[0].reports[0].connections = 0; },
        records => { records[1].terminalDuplicateStable = false; }, records => { records[1].attemptsPerVideo = 2; },
        records => { records[2].reports.pop(); }, records => { records[2].reports[0].attemptsPerVideo = 2; },
        records => { records[3].leaseObserved = false; }, records => { records[3].recoveredAttempt = 3; },
        records => { records[4].capacity.throttled = 0; }, records => { records[4].capacity.peak = 9; },
        records => { records[4].reports[0].allPushMs = 180000; }, records => { records[0].imageDigest = `sha256:${"d".repeat(64)}`; },
    ])
        await assert.rejects(verifyDevelopmentQualification(fixture(({ records }) => change(records))));
});
test("rejects mutable, cross-run and corrupted object references", async () => {
    const input = fixture();
    for (const delta of [{ version: "null" }, { version: "" }, { version: "with whitespace" }, { version: "v".repeat(1025) }, { key: input.reference.key.replace("200", "201") }, { sha256: "0".repeat(64) }]) {
        await assert.rejects(verifyDevelopmentQualification({ ...input, reference: { ...input.reference, ...delta } }));
    }
    await assert.rejects(verifyDevelopmentQualification({ ...input, readObject: async () => Buffer.from("tampered") }));
});
test("does not mix nested evidence from another run or inconsistent pair metadata", async () => {
    for (const change of [
        summary => { summary.stages[0].evidence.key = summary.stages[0].evidence.key.replace("200", "201"); },
        summary => { for (const stage of summary.stages)
            stage.sourceCommit = "d".repeat(40); },
        summary => { summary.stages.pop(); },
        summary => { summary.realMobilePlaybackVerified = true; },
    ]) {
        const input = fixture(), summary = JSON.parse(await input.readObject(input.reference));
        change(summary);
        const bytes = Buffer.from(JSON.stringify(summary));
        const reference = { ...input.reference, sha256: createHash("sha256").update(bytes).digest("hex") };
        await assert.rejects(verifyDevelopmentQualification({ ...input, reference,
            readObject: async (ref) => ref.key === reference.key ? bytes : input.readObject(ref) }));
    }
});
test("accepts the opaque S3 version ID returned for the saved-design qualification", async () => {
    const input = fixture();
    const reference = { ...input.reference, version: "_JWauhmlhAv23Knfcy3X1gswmHAtv6e7" };
    const result = await verifyDevelopmentQualification({ ...input, reference });
    assert.equal(result.cloudQualificationVerified, true);
    assert.deepEqual(result.reference, reference);
});
async function completedFixture(recovery = true, mutate = () => { }, configure = () => { }) {
    const original = fixture(configure), objects = new Map();
    const readObject = async (ref) => objects.get(ref.key) ?? original.readObject(ref);
    const save = (name, value, runId = 200) => {
        const bytes = Buffer.from(JSON.stringify(value)), key = "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-" + (name) + "-native-100-run-" + (runId) + ".json";
        objects.set(key, bytes);
        return { key, version: 'version', sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const identity = { ...original.expectedPair, workerVersionId: '11111111-1111-4111-8111-111111111111', workerBundleSha256: 'd'.repeat(64), workerResourcesSha256: 'e'.repeat(64) };
    const inventory = { schemaVersion: 1, runId: '200', releaseId: 'native-100', sourceCommit: original.expectedQualificationCommit,
        fixtures: [{ designId: '22222222-2222-4222-8222-222222222222', sha256: 'f'.repeat(64),
                artworkKey: `designs/22222222-2222-4222-8222-222222222222/artwork/${'f'.repeat(64)}`, products: [], revisions: [], assets: [], videos: [] }] };
    const inventoryReference = save('cleanup-inventory', inventory);
    const functional = { ...JSON.parse(await original.readObject(original.reference)), schemaVersion: 2, identity, inventoryReference };
    const functionalReference = save('complete-summary', functional);
    const originalRun = { ...original.githubRun, conclusion: recovery ? 'failure' : 'success', display_title: 'Native development · qualify-all · full · native-100' };
    const githubRun = recovery ? { ...original.githubRun, id: 201, display_title: 'Native development · cleanup-qualification · full · native-100' } : originalRun;
    const cleanup = { schemaVersion: 1, cleanupComplete: true, runId: String(githubRun.id), originalRunId: '200', releaseId: 'native-100',
        qualificationSourceCommit: original.expectedQualificationCommit, inventoryReference, qualificationFixturesDeleted: 1, sharedObjectsDeferred: [] };
    mutate({ cleanup, originalRun, githubRun, inventory, functional, save, expectedPair: original.expectedPair });
    const receipt = { schemaVersion: 1, qualificationComplete: true, expectedPair: original.expectedPair, identity,
        functionalRunId: 200, functionalReference: save('complete-summary', functional), cleanupReference: save('cleanup-complete', cleanup, githubRun.id) };
    return { ...original, githubRun, reference: save('receipt', receipt, githubRun.id), readObject,
        readRun: async (id) => { assert.equal(id, 200); return originalRun; }, functionalReference };
}
test('successful cleanup recovery qualifies immutable functional results without blessing the failed run', async () => {
    const input = await completedFixture(), result = await verifyDevelopmentQualification(input);
    assert.equal(result.cloudQualificationVerified, true);
    assert.equal(result.qualificationRunId, 201);
    assert.equal(result.functionalRunId, 200);
    assert.equal(result.cleanupVerified, true);
    await assert.rejects(verifyDevelopmentQualification({ ...input, reference: input.functionalReference, githubRun: await input.readRun(200) }));
});
test('normal completion also requires a separate cleanup receipt', async () => {
    const input = await completedFixture(false), result = await verifyDevelopmentQualification(input);
    assert.equal(result.qualificationRunId, 200);
    assert.equal(result.cleanupVerified, true);
    await assert.rejects(verifyDevelopmentQualification({ ...input, reference: input.functionalReference }), /cleanup receipt/);
});
test('incomplete cleanup, failed functional stages and altered run identities reject recovery', async () => {
    for (const change of [
        ({ cleanup }) => cleanup.cleanupComplete = false,
        ({ cleanup }) => cleanup.qualificationFixturesDeleted = 0,
        ({ cleanup }) => cleanup.originalRunId = '199',
        ({ cleanup }) => cleanup.qualificationSourceCommit = 'a'.repeat(40),
        ({ originalRun }) => originalRun.conclusion = 'cancelled',
        ({ originalRun }) => originalRun.run_attempt = 2,
        ({ originalRun }) => originalRun.head_sha = 'a'.repeat(40),
        ({ githubRun }) => githubRun.conclusion = 'failure',
        ({ functional }) => functional.stages.pop(),
    ])
        await assert.rejects(verifyDevelopmentQualification(await completedFixture(true, change)));
});
async function shippingFixture(mutate = () => { }, commerce = false, durable = false) {
    const { shippingCases, paidOrderCases } = await import('./native-shipping-qualification.mjs');
    const original = await completedFixture(false, ({ functional, save, expectedPair }) => {
        functional.rendererEvidence = { schemaVersion: 1, inputsDigest: '1'.repeat(64), configurationDigest: '2'.repeat(64), ...(commerce ? { boundary: 'isolated-printify-contracts-v2' } : {}) };
        if (commerce)
            functional.shippingEvidence = save('shipping-report', { ...expectedPair, cloudShippingQualification: true,
                notificationSink: 'in-process-simulated-shopify', customerNotificationsSent: 0, paidOrderJourneyVerified: true,
                providerSink: 'in-process-simulated-printify', providerMutations: 0, databaseId: '44444444-4444-4444-8444-444444444444',
                cleanup: { databaseDeleted: true, databaseId: '44444444-4444-4444-8444-444444444444', name: 'forever-tee-shipping-qualification-200' },
                tests: [...shippingCases, ...paidOrderCases].map(name => ({ name, passed: true })) });
    }, durable ? addQualifiedPrints : undefined);
    const pair = { ...original.expectedPair, releaseId: 'native-300', sourceCommit: 'f'.repeat(40) };
    const objects = new Map(), save = (name, value, extension = 'json', original = false) => {
        const key = original ? `source/releases/native-300/${name}.${extension}` : "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-" + (name) + "-native-300-run-400." + (extension), bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        objects.set(key, bytes);
        return { key, version: 'immutable', sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const githubRun = { ...original.githubRun, id: 400, head_sha: pair.sourceCommit };
    const identity = { ...pair, workerVersionId: '33333333-3333-4333-8333-333333333333', workerBundleSha256: '3'.repeat(64), workerResourcesSha256: '4'.repeat(64) };
    const inventory = { schemaVersion: 1, runId: '400', releaseId: pair.releaseId, sourceCommit: pair.sourceCommit,
        fixtures: [{ designId: '22222222-2222-4222-8222-222222222222', sha256: 'f'.repeat(64),
                artworkKey: `designs/22222222-2222-4222-8222-222222222222/artwork/${'f'.repeat(64)}`, products: [], revisions: [], assets: [], videos: [] }] };
    const inventoryReference = save('cleanup-inventory', inventory);
    const shipping = { ...pair, cloudShippingQualification: true, notificationSink: 'in-process-simulated-shopify', customerNotificationsSent: 0,
        databaseId: '44444444-4444-4444-8444-444444444444', cleanup: { databaseDeleted: true, databaseId: '44444444-4444-4444-8444-444444444444', name: 'forever-tee-shipping-qualification-400' },
        ...(commerce ? { paidOrderJourneyVerified: true, providerSink: 'in-process-simulated-printify', providerMutations: 0 } : {}), tests: (commerce ? [...shippingCases, ...paidOrderCases] : shippingCases).map(name => ({ name, passed: true })) };
    const smoke = { ...pair, cloudFamilyQualification: true, reports: ['one', 'two'].map(label => ({ label, confirmationMs: 1, firstPushMs: 2, allPushMs: 3, connections: 1, videos: 4, attemptsPerVideo: 1 })) };
    if (durable) {
        const records = Array.from({ length: 5 }, () => ({}));
        addQualifiedPrints({ records, save, sourceCommit: pair.sourceCommit, releaseId: pair.releaseId });
        Object.assign(smoke, records[0]);
    }
    const rendererQualification = { reference: original.reference, expectedPair: original.expectedPair, qualificationRunId: 200,
        expectedQualificationCommit: original.expectedQualificationCommit, workerVersionId: '11111111-1111-4111-8111-111111111111', inputsDigest: '1'.repeat(64), configurationDigest: '2'.repeat(64) };
    if (commerce)
        rendererQualification.boundary = 'isolated-printify-contracts-v2';
    mutate({ shipping, smoke, rendererQualification, original });
    const functional = { ...pair, schemaVersion: commerce ? 4 : 3, qualificationKind: commerce ? 'commerce' : 'shipping', cloudQualificationComplete: true, realMobilePlaybackVerified: false,
        productionPromotionPerformed: false, identity, inventoryReference, shippingEvidence: save('shipping-report', shipping), smokeEvidence: save('summary', smoke), rendererQualification };
    const cleanup = { schemaVersion: 1, cleanupComplete: true, runId: '400', originalRunId: '400', releaseId: pair.releaseId, qualificationSourceCommit: pair.sourceCommit,
        inventoryReference, qualificationFixturesDeleted: 1 };
    return { expectedPair: pair, githubRun, expectedQualificationCommit: pair.sourceCommit,
        reference: save('receipt', { schemaVersion: 1, qualificationComplete: true, expectedPair: pair, identity, functionalRunId: 400,
            functionalReference: save('complete-summary', functional), cleanupReference: save('cleanup-complete', cleanup) }),
        readObject: async (ref) => objects.get(ref.key) ?? original.readObject(ref), readRun: async (id) => { assert.equal(id, 200); return original.githubRun; } };
}
test('shipping qualification requires real D1, the full original renderer receipt and a live video smoke', async () => {
    const result = await verifyDevelopmentQualification(await shippingFixture());
    assert.equal(result.qualificationKind, 'shipping');
    assert.equal(result.cleanupVerified, true);
    assert.equal(result.realMobilePlaybackVerified, false);
    for (const mutate of [({ shipping }) => shipping.tests.pop(), ({ shipping }) => shipping.customerNotificationsSent = 1,
        ({ shipping }) => shipping.cleanup.databaseDeleted = false, ({ smoke }) => smoke.reports.pop(),
        ({ rendererQualification }) => rendererQualification.inputsDigest = '0'.repeat(64),
        ({ rendererQualification }) => rendererQualification.expectedPair.imageDigest = `sha256:${'0'.repeat(64)}`,
        ({ original }) => original.githubRun.conclusion = 'failure', ({ rendererQualification }) => rendererQualification.qualificationRunId = 400])
        await assert.rejects(verifyDevelopmentQualification(await shippingFixture(mutate)));
    await assert.rejects(verifyDevelopmentQualification(await shippingFixture(), false), /bounded component/);
});
test('commerce qualification binds the entire paid journey, original full renderer and cleanup', async () => {
    const result = await verifyDevelopmentQualification(await shippingFixture(() => { }, true));
    assert.equal(result.qualificationKind, 'commerce');
    assert.equal(result.paidOrderJourneyVerified, true);
    assert.equal(result.cleanupVerified, true);
    for (const mutate of [({ shipping }) => shipping.paidOrderJourneyVerified = false, ({ shipping }) => shipping.providerMutations = 1,
        ({ shipping }) => shipping.tests.pop(), ({ shipping }) => shipping.cleanup.databaseDeleted = false,
        ({ rendererQualification }) => rendererQualification.boundary = 'unreviewed', ({ smoke }) => smoke.printLatency = { provider: 'durable-object' }])
        await assert.rejects(verifyDevelopmentQualification(await shippingFixture(mutate, true)));
    await assert.rejects(verifyDevelopmentQualification(await shippingFixture(() => { }, true), false));
});
test('new full renderer baselines cannot omit the paid-order receipt', async () => {
    const input = await completedFixture(false, ({ functional }) => {
        functional.rendererEvidence = { schemaVersion: 1, boundary: 'isolated-printify-contracts-v2' };
    });
    await assert.rejects(verifyDevelopmentQualification(input), /exact immutable object reference/);
});
test('commerce admission uses the freshly qualified executor generation, never the old renderer generation', async () => {
    const input = await shippingFixture(() => { }, true, true);
    const result = await verifyDevelopmentQualification(input);
    assert.equal(result.printProvider, 'durable-object');
    assert.equal(result.printExecutor.sourceCommit, input.expectedPair.sourceCommit);
    assert.equal(result.printExecutor.releaseId, input.expectedPair.releaseId);
    for (const mutate of [({ smoke }) => smoke.printExecutor.sourceCommit = 'a'.repeat(40),
        ({ smoke }) => smoke.printExecutorArchive.bundle.sha256 = '0'.repeat(64),
        ({ smoke }) => smoke.printLatency.reports[0].samples[0].recordToReadyMs = 12001])
        await assert.rejects(verifyDevelopmentQualification(await shippingFixture(mutate, true, true)));
});

test("Production qualification authenticates the complete source-map archive and rejects a missing or altered sidecar", async () => {
    const input = () => fixture(value => addQualifiedPrints({ ...value, withMap: true }));
    assert.equal((await verifyDevelopmentQualification(input())).printExecutor.worker.content.modules.length, 2);
    for (const mutate of [records => delete records[0].printExecutorArchive.map,
        records => { records[0].printExecutorArchive.map.sha256 = "0".repeat(64); },
        records => { delete records[0].printExecutor.artifacts.candidateMapArtifact; }]) {
        await assert.rejects(verifyDevelopmentQualification(fixture(value => { addQualifiedPrints({ ...value, withMap: true }); mutate(value.records); })));
    }
});
