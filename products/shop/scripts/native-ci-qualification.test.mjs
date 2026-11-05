import assert from "node:assert/strict";
import test from "node:test";
import { assertQualificationApiPath, awaitFamilyPrintReadiness, awaitInitialExhaustionStop, beginFamilyPrintQualification, boundedApiFailure, createQualificationDispatchBarrier, observeFamilyStream, qualificationArtworkKey, qualificationPngDimensions, qualificationPrintProvider, readQualifiedArtwork, exhaustedJobs, preparedExhaustionJobs, observeReconnectingFamily, summarizeCommittedPrintLatency, summarizePrintAssetFailures, summarizePrintSourceChecks, verifyFaultEvidence, verifyTerminationEvidence, capacityMetricEvidence, completeQualificationSummary } from "./native-ci-qualification.mjs";
const stream = events => new Response(events, { headers: { "Content-Type": "text/event-stream" } });
const videos = [["tee", "black"], ["tee", "white"], ["tote", "black"], ["tote", "cream"]];
const ready = videos.map(([productId, color]) => `event: video\ndata: ${JSON.stringify({ productId, color, status: "ready" })}\n\n`).join("");
const complete = "event: complete\ndata: {}\n\n";
test("qualification artwork uses the immutable Print Asset source key", () => {
    const designId = "11111111-1111-4111-8111-111111111111";
    const digest = "a".repeat(64);
    assert.equal(qualificationArtworkKey(designId, digest), `designs/${designId}/artwork/${digest}`);
    assert.throws(() => qualificationArtworkKey("invalid", digest));
    assert.throws(() => qualificationArtworkKey(designId, "short"));
});
test("qualification artwork dimensions come from a validated PNG header", () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(2400, 16);
    bytes.writeUInt32BE(3000, 20);
    assert.deepEqual(qualificationPngDimensions(bytes), { width: 2400, height: 3000 });
    assert.throws(() => qualificationPngDimensions(Buffer.from("not-a-png")));
    bytes.writeUInt32BE(0, 16);
    assert.throws(() => qualificationPngDimensions(bytes));
});
test("cloud cohort evidence requires four unique owned ready events, push mode and stream completion", async () => {
    const events = ": notification-mode=push\n\n" + ready + complete;
    const report = await observeFamilyStream(stream(events), ["tee", "tote"], 100, () => 300);
    assert.equal(report.readyKeys.length, 4);
    assert.equal(report.firstPushMs, 200);
    for (const body of [ready + complete, events.replace(complete, ""), events.replaceAll('"ready"', '"unavailable"'),
        events.replaceAll('"cream"', '"black"'), events.replaceAll('"tee"', '"foreign"')]) {
        await assert.rejects(observeFamilyStream(stream(body), ["tee", "tote"], 100));
    }
    await assert.rejects(readQualifiedArtwork(new Response("not the saved artwork")));
});
test("qualification failures expose only a bounded status and API code", async () => {
    assert.deepEqual(await boundedApiFailure(Response.json({ error: { code: "PRINT_ASSETS_UNAVAILABLE", message: "private detail" } }, { status: 503 })), { status: 503, code: "PRINT_ASSETS_UNAVAILABLE" });
    assert.deepEqual(await boundedApiFailure(new Response("not-json", { status: 409 })), { status: 409, code: "INVALID_JSON" });
    assert.deepEqual(await boundedApiFailure(new Response("x".repeat(4097), { status: 500 })), { status: 500, code: "OVERSIZED_BODY" });
});
test("Print Asset diagnostics redact identifiers, URLs and unbounded messages", () => {
    assert.deepEqual(summarizePrintAssetFailures([{ geometry_key: "dtg:4500x5100", status: "failed",
            last_error: `Transform failed for 11111111-1111-4111-8111-111111111111 at https://private.invalid/${"x".repeat(300)}` }]), [{
            geometry: "dtg:4500x5100", status: "failed", error: "Transform failed for <ID> at <URL>",
        }]);
    assert.throws(() => summarizePrintAssetFailures(Array.from({ length: 13 }, () => ({}))));
});
test("Print Asset source diagnostics expose only bounded prerequisite checks", () => {
    assert.deepEqual(summarizePrintSourceChecks([{ base_product_id: "a51b7acf-77e9-4762-83c4-62d96dd8942c", canonical_artwork: 1,
            dimensions_valid: 1, geometry_count: 3, has_revision: 1, projection_valid: 1, size_valid: 1 }]), [{
            baseProduct: "a51b7acf-77e9-4762-83c4-62d96dd8942c", canonicalArtwork: true, dimensionsValid: true,
            geometryCount: 3, hasRevision: true, projectionValid: true, sizeValid: true,
        }]);
    assert.throws(() => summarizePrintSourceChecks([{}, {}, {}]));
});
test("exhaustion requires all four fenced third attempts and no published output", () => {
    const jobs = videos.map(([product_id, colour]) => ({ product_id, colour, status: "failed", attempt_count: 3,
        execution_id: "fixture-execution", output_byte_size: null }));
    assert.equal(exhaustedJobs(jobs), true);
    assert.equal(exhaustedJobs([]), false);
    for (const delta of [{ status: "queued", attempt_count: 0 }, { attempt_count: 2 }, { execution_id: null }, { output_byte_size: 12 }]) {
        assert.equal(exhaustedJobs([{ ...jobs[0], ...delta }, ...jobs.slice(1)]), false);
    }
    for (const delta of [{ attempt_count: 4 }, { status: "ready" }, { status: "unexpected" }]) {
        assert.throws(() => exhaustedJobs([{ ...jobs[0], ...delta }, ...jobs.slice(1)]));
    }
    assert.throws(() => exhaustedJobs([jobs[0], jobs[0], ...jobs.slice(2)]));
});
test("exhaustion starts only after both initial dispatch paths are stopped", () => {
    const jobs = videos.map(([product_id, colour], index) => ({ id: `job-${index}`, product_id, colour,
        status: "queued", attempt_count: 0, execution_id: null, output_byte_size: null }));
    const faults = ["direct-dispatch", "enqueue-send"].map(point => ({ point, consumed_at: 123, job_id: "job-0" }));
    assert.equal(preparedExhaustionJobs(jobs, faults), true);
    assert.throws(() => preparedExhaustionJobs([{ ...jobs[0], attempt_count: 1 }, ...jobs.slice(1)], faults));
    assert.throws(() => preparedExhaustionJobs(jobs, faults.slice(1)));
    assert.throws(() => preparedExhaustionJobs(jobs, faults.map(fault => ({ ...fault, consumed_at: null }))));
});
test("exhaustion dispatch wait receives a fresh bounded polling window after confirmation", async () => {
    const jobs = videos.map(([product_id, colour], index) => ({ id: `job-${index}`, product_id, colour,
        status: "queued", attempt_count: 0, execution_id: null, output_byte_size: null }));
    const stopped = ["direct-dispatch", "enqueue-send"].map(point => ({ point, consumed_at: 30250, job_id: "job-0" }));
    let currentTime = 30000, polls = 0;
    const result = await awaitInitialExhaustionStop(async () => jobs, async () => ++polls === 1 ? stopped.map(fault => ({ ...fault, consumed_at: null })) : stopped, { now: () => currentTime, wait: async (milliseconds) => { currentTime += milliseconds; } });
    assert.equal(polls, 2);
    assert.deepEqual(result, { faults: stopped, jobs });
});
test("load dispatch waits for every staged revision and releases the cohort once", async () => {
    const dispatched = [];
    const barrier = createQualificationDispatchBarrier(3, async (revisions) => { dispatched.push(revisions); });
    let firstReleased = false;
    const first = barrier.arrive("revision-one").then(() => { firstReleased = true; });
    const second = barrier.arrive("revision-two");
    await Promise.resolve();
    assert.equal(firstReleased, false);
    assert.deepEqual(dispatched, []);
    const third = barrier.arrive("revision-three");
    await Promise.all([first, second, third]);
    assert.equal(firstReleased, true);
    assert.deepEqual(dispatched, [["revision-one", "revision-two", "revision-three"]]);
    await assert.rejects(barrier.arrive("revision-four"));
});
test("normal stream rotation reconnects within a bounded window without treating incomplete streams as success", async () => {
    let connections = 0;
    const report = await observeReconnectingFamily(async () => {
        connections++;
        return stream(": notification-mode=push\n\n" + (connections === 1 ? ready.split("\n\n")[0] + "\n\n" : ready + complete));
    }, ["tee", "tote"], 0, () => connections * 1000);
    assert.equal(report.connections, 2);
    assert.equal(report.firstPushMs, 1000);
    assert.equal(report.allPushMs, 2000);
    connections = 0;
    await assert.rejects(observeReconnectingFamily(async () => { connections++; return stream(": notification-mode=push\n\n"); }, ["tee", "tote"], 0, () => 1));
    assert.equal(connections, 4);
    await assert.rejects(observeReconnectingFamily(() => assert.fail("Expired window must not open a connection"), [], 0, () => 180000));
});
test("cloud faults require real acceptance, execution-fence evidence and unchanged first-attempt readiness", () => {
    const jobs = videos.map(([product_id, colour], index) => ({ id: `job-${index}`, product_id, colour, status: "ready", attempt_count: 1,
        execution_id: `execution-${index}`, output_byte_size: 100 }));
    const fault = point => ({ point, consumed_at: 123, job_id: "job-0" });
    const observation = (stage, status, execution_id = "execution-0") => ({ job_id: "job-0", stage, status, execution_id });
    const cases = [
        ["invoke-ack", [fault("invoke-ack")], [observation("invoke", 202)]],
        ["invoke-duplicate", [fault("invoke-duplicate")], [observation("invoke", 202), observation("duplicate-invoke", 202), observation("claim", 201), observation("claim", 204, "loser")]],
        ["claim-ack", [fault("claim-ack")], [observation("claim", 201), observation("claim", 201)]],
        ["upload-ack", [fault("upload-ack")], [observation("upload-committed", 200)]],
        ["enqueue-send", [fault("enqueue-send"), fault("direct-dispatch")], []],
    ];
    for (const [point, faults, observations] of cases) {
        assert.equal(verifyFaultEvidence(point, jobs, faults, observations), true);
        assert.throws(() => verifyFaultEvidence(point, jobs, [], observations));
        assert.throws(() => verifyFaultEvidence(point, [{ ...jobs[0], attempt_count: 2 }, ...jobs.slice(1)], faults, observations));
        assert.throws(() => verifyFaultEvidence(point, [jobs[0], jobs[0], ...jobs.slice(2)], faults, observations));
        assert.throws(() => verifyFaultEvidence(point, jobs, faults.map(row => ({ ...row, consumed_at: null })), observations));
        if (observations.length)
            assert.throws(() => verifyFaultEvidence(point, jobs, faults, observations.slice(1)));
    }
    assert.throws(() => verifyFaultEvidence("invoke-duplicate", jobs, [fault("invoke-duplicate")], [observation("invoke", 202), observation("duplicate-invoke", 202), observation("claim", 201), observation("claim", 204)]));
    assert.throws(() => verifyFaultEvidence("claim-ack", jobs, [fault("claim-ack")], [observation("claim", 201), observation("claim", 201, "another-execution")]));
});
test("termination evidence requires the original lease and exactly one new fenced attempt", () => {
    const jobs = videos.map(([product_id, colour], index) => ({ id: `job-${index}`, product_id, colour, status: "ready", attempt_count: index === 0 ? 2 : 1,
        execution_id: `execution-${index}`, output_byte_size: 100 }));
    const fault = { point: "terminate", job_id: "job-0", consumed_at: 123 };
    const observations = [{ job_id: "job-0", stage: "termination-issued", status: 200, execution_id: "killed-execution" }];
    assert.equal(verifyTerminationEvidence(jobs, fault, observations, true), true);
    assert.throws(() => verifyTerminationEvidence(jobs, fault, observations, false));
    assert.throws(() => verifyTerminationEvidence(jobs, fault, [], true));
    for (const delta of [{ attempt_count: 1 }, { attempt_count: 3 }, { execution_id: "killed-execution" }, { status: "failed" }]) {
        assert.throws(() => verifyTerminationEvidence([{ ...jobs[0], ...delta }, ...jobs.slice(1)], fault, observations, true));
    }
    assert.throws(() => verifyTerminationEvidence([jobs[0], { ...jobs[1], attempt_count: 2 }, ...jobs.slice(2)], fault, observations, true));
});
test("capacity evidence must observe actual throttles at the unchanged eight-execution cap", () => {
    const throttles = { Datapoints: [{ Sum: 2 }] }, concurrency = { Datapoints: [{ Maximum: 8 }] };
    assert.equal(capacityMetricEvidence(throttles, concurrency).qualified, true);
    assert.equal(capacityMetricEvidence({ Datapoints: [] }, concurrency).qualified, false);
    assert.equal(capacityMetricEvidence(throttles, { Datapoints: [] }).qualified, false);
    assert.equal(capacityMetricEvidence({ Datapoints: [{ Sum: 0 }] }, concurrency).qualified, false);
    assert.throws(() => capacityMetricEvidence(throttles, { Datapoints: [{ Maximum: 9 }] }));
    assert.throws(() => capacityMetricEvidence({ Datapoints: [{ Sum: NaN }] }, concurrency));
});
test("durable admission requires waiting jobs with no consumed attempts and zero throttles", () => {
    const admission = { version: 1, limit: 8, running: 8, waiting: 4, waitingAttempts: 0 };
    const concurrency = { Datapoints: [{ Maximum: 8 }] };
    const throttles = { Datapoints: [{ Sum: 0 }] };
    assert.equal(capacityMetricEvidence(throttles, concurrency, admission).qualified, true);
    for (const delta of [{ running: 0 }, { running: 9 }, { waiting: 0 }, { waitingAttempts: 1 }, { limit: 16 }, { version: 2 }]) {
        assert.equal(capacityMetricEvidence(throttles, concurrency, { ...admission, ...delta }).qualified, false);
    }
    assert.equal(capacityMetricEvidence({ Datapoints: [{ Sum: 1 }] }, concurrency, admission).qualified, false);
    assert.equal(capacityMetricEvidence(throttles, { Datapoints: [] }, admission).qualified, false);
});
test("serial completion requires distinct versioned records from every stage of the same pair", () => {
    const stages = ["families", "exhaustion", "faults", "termination", "load"].map(name => ({ name, releaseId: "native-123", sourceCommit: "a".repeat(40),
        imageDigest: `sha256:${"b".repeat(64)}`, evidence: { key: `source/releases/native-456/qualification-${name}.json`, version: "version", sha256: "c".repeat(64) } }));
    const summary = completeQualificationSummary(stages, "native-123");
    assert.equal(summary.cloudQualificationComplete, true);
    assert.equal(summary.realMobilePlaybackVerified, false);
    assert.equal(summary.productionPromotionPerformed, false);
    assert.throws(() => completeQualificationSummary(stages.slice(1), "native-123"));
    for (const delta of [{ sourceCommit: "d".repeat(40) }, { imageDigest: `sha256:${"d".repeat(64)}` }, { releaseId: "native-999" },
        { evidence: { ...stages[0].evidence, version: "null" } }, { evidence: stages[1].evidence }]) {
        assert.throws(() => completeQualificationSummary([{ ...stages[0], ...delta }, ...stages.slice(1)], "native-123"));
    }
});
test("family qualification waits for both print products and stops polling a ready product", async () => {
    let currentTime = 0;
    const calls = [];
    const report = await awaitFamilyPrintReadiness(async (productId) => {
        calls.push(productId);
        return Response.json({ ready: productId === "shirt" || currentTime >= 2000 });
    }, ["shirt", "tote"], { now: () => currentTime, wait: async (ms) => { currentTime += ms; } });
    assert.deepEqual(report, { readyProducts: 2, waitMs: 2000 });
    assert.deepEqual(calls, ["shirt", "tote", "tote", "tote"]);
});
test("family qualification rejects unfinished or invalid print artwork despite ready videos", async () => {
    let currentTime = 0;
    await assert.rejects(awaitFamilyPrintReadiness(async (productId) => Response.json({ ready: productId === "shirt" }), ["shirt", "tote"], { now: () => currentTime, timeoutMs: 2000, wait: async (ms) => { currentTime += ms; } }), /print artwork did not become ready/);
    assert.equal(currentTime, 2000);
    for (const response of [new Response(null, { status: 503 }), Response.json({ ready: "true" }), Response.json(null)]) {
        await assert.rejects(awaitFamilyPrintReadiness(async () => response.clone(), ["shirt", "tote"]));
    }
    await assert.rejects(awaitFamilyPrintReadiness(async () => Response.json({ ready: true }), ["shirt", "shirt"]));
});
test("the qualification API guard admits the exact readiness route without opening other operations", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.doesNotThrow(() => assertQualificationApiPath(`/v2/internal/configured-products/${id}/purchase-readiness`));
    for (const path of [`/v2/internal/configured-products/${id}/delete`,
        `/v2/internal/configured-products/${id}/purchase-readiness?other=1`,
        `https://example.com/v2/internal/configured-products/${id}/purchase-readiness`]) {
        assert.throws(() => assertQualificationApiPath(path), /fixture API route/);
    }
});
test("print qualification begins at confirmation and finishes without waiting for any video", async () => {
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const requests = [];
    const fixture = { designId: "33333333-3333-4333-8333-333333333333", ownerId: "owner" };
    const print = beginFamilyPrintQualification(async (path, owner, options) => {
        requests.push(path);
        assert.equal(owner, fixture.ownerId);
        assert.ok(options.signal instanceof AbortSignal);
        if (path === "/v2/configured-product-families")
            return Response.json({ products: ids.map(id => ({ id })) }, { status: 201 });
        return Response.json({ ready: true });
    }, fixture);
    const products = await print.confirmation;
    assert.deepEqual(products.map(product => product.id), ids);
    const report = await print.printObservation;
    assert.equal(report.passed, true);
    assert.deepEqual(requests, ["/v2/configured-product-families", ...ids.map(id => `/v2/internal/configured-products/${id}/purchase-readiness`)]);
    assert.equal(report.observations[0].products.length, 2);
});
test("confirmation passes the exact five-second deadline to the caller and settles observation on expiry", async (t) => {
    const controller = new AbortController();
    const deadlines = [];
    t.mock.method(AbortSignal, "timeout", milliseconds => {
        deadlines.push(milliseconds);
        return controller.signal;
    });
    const print = beginFamilyPrintQualification(async (path, _owner, options) => {
        assert.equal(path, "/v2/configured-product-families");
        assert.equal(options.signal, controller.signal);
        return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
    }, { designId: "fixture", ownerId: "owner" });
    assert.deepEqual(deadlines, [5000, 5000]);
    const failed = assert.rejects(print.confirmation, { name: "TimeoutError" });
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await failed;
    const report = await print.printObservation;
    assert.equal(report.passed, false);
    assert.equal(report.completedFamilies, 0);
    assert.deepEqual(report.observations[0].products, []);
});
test("failed confirmations settle their print observers before cleanup", async () => {
    const print = beginFamilyPrintQualification(async () => Response.json({ error: { code: "FAILED" } }, { status: 503 }), { designId: "fixture", ownerId: "owner" });
    await assert.rejects(print.confirmation, /real family confirmation/u);
    assert.equal((await print.printObservation).passed, false);
});
test("print provider evidence comes from the validated live binding", () => {
    assert.equal(qualificationPrintProvider({ bindings: [] }), "queue");
    assert.equal(qualificationPrintProvider({ bindings: [{ name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "durable-object" }] }), "durable-object");
    assert.throws(() => qualificationPrintProvider({ bindings: [{ name: "PRINT_EXECUTION_MODE", type: "secret_text", text: "durable-object" }] }));
    assert.throws(() => qualificationPrintProvider({ bindings: [{ name: "PRINT_EXECUTION_MODE", type: "plain_text", text: "unknown" }] }));
});
const printIdentity = { sourceCommit: "a".repeat(40), provider: "durable-object" };
const committedJobs = () => ["shirt", "tote"].map(configured_product_id => ({ configured_product_id,
    status: "ready", lease_id: null, attempt_count: 1, created_at: 1000, updated_at: 9000 }));
test("committed print gate uses actual job timestamps rather than observation or product clocks", () => {
    const report = summarizeCommittedPrintLatency(committedJobs().map(job => ({ ...job, product_created_at: 1, observedAt: 999999 })), ["shirt", "tote"], printIdentity);
    assert.equal(report.passed, true);
    assert.equal(report.samples[0].recordToReadyMs, 8000);
    assert.equal(report.sourceCommit, printIdentity.sourceCommit);
    assert.equal(report.provider, "durable-object");
});
test("three-family baseline final product would fail the 12-second committed readiness gate", () => {
    const jobs = committedJobs();
    jobs[1].updated_at = jobs[1].created_at + 24036;
    const report = summarizeCommittedPrintLatency(jobs, ["shirt", "tote"], printIdentity);
    assert.equal(report.passed, false);
    assert.equal(report.samples[1].recordToReadyMs, 24036);
});
test("readiness alone cannot pass without both completed fenced print jobs", () => {
    assert.equal(summarizeCommittedPrintLatency(committedJobs().slice(0, 1), ["shirt", "tote"], printIdentity).passed, false);
    for (const changes of [{ status: "pending" }, { lease_id: "active-lease" }, { attempt_count: 0 }, { updated_at: 500 }, { created_at: undefined }]) {
        const jobs = committedJobs();
        jobs[0] = { ...jobs[0], ...changes };
        assert.equal(summarizeCommittedPrintLatency(jobs, ["shirt", "tote"], printIdentity).passed, false);
    }
    assert.throws(() => summarizeCommittedPrintLatency(committedJobs(), ["shirt", "foreign"], printIdentity));
});
test("retry elapsed time is preserved in the committed print readiness gate", () => {
    const jobs = committedJobs();
    jobs[0].attempt_count = 2;
    jobs[0].updated_at = 21000;
    const report = summarizeCommittedPrintLatency(jobs, ["shirt", "tote"], printIdentity);
    assert.equal(report.passed, false);
    assert.equal(report.samples[0].recordToReadyMs, 20000);
});
