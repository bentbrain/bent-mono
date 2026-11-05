import { resolveProtectedTemplate } from "./protected-config.mjs";
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
const validMs = value => Number.isSafeInteger(value) && value >= 0;
const requireValue = (condition, message) => { if (!condition)
    throw new Error(message); };
const timestampFields = ['jobCreatedAtMs', 'executorEnteredAtMs', 'claimStartedAtMs',
    'claimedAtMs', 'preparationStartedAtMs', 'finishedAtMs'];
const evidenceFields = ['schemaVersion', 'event', 'provider', 'productId', 'attemptId', 'attempt', 'outcome',
    ...timestampFields, 'readyCommittedAtMs', 'queueMessageTimestampMs', 'deliveryId', 'triggerProductId'];
// Small bursts are judged by their worst observation. A handful of samples must
// not produce population percentile claims. Repeated cohorts retain their IDs.
export function printLatencyDistribution(values) {
    requireValue(values.every(validMs), 'Latency samples must be non-negative integer milliseconds.');
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = p => sorted[Math.ceil(sorted.length * p) - 1];
    return { count: sorted.length, minMs: sorted[0] ?? null, maxMs: sorted.at(-1) ?? null,
        medianMs: sorted.length ? percentile(0.5) : null,
        p95Ms: sorted.length >= 100 ? percentile(0.95) : null,
        p99Ms: sorted.length >= 1000 ? percentile(0.99) : null };
}
export function printLatencyReport(manifest, events) {
    requireValue(manifest?.schemaVersion === 1 && typeof manifest.runId === 'string' && manifest.runId.length > 0, 'A versioned run manifest is required.');
    requireValue(['queue', 'durable-object'].includes(manifest.provider), 'Unknown execution provider.');
    requireValue(typeof manifest.source === 'string' && /^[a-f0-9]{40}$/u.test(manifest.source), 'Manifest must bind the measured source commit.');
    requireValue(validMs(manifest.startedAtMs) && validMs(manifest.finishedAtMs) &&
        manifest.finishedAtMs >= manifest.startedAtMs, 'Invalid run interval.');
    requireValue(Array.isArray(manifest.productIds) && manifest.productIds.length >= 1 &&
        manifest.productIds.length <= 200 && manifest.productIds.every(id => typeof id === 'string' && id.length > 0) &&
        new Set(manifest.productIds).size === manifest.productIds.length, 'Expected 1-200 distinct product IDs.');
    requireValue(validMs(manifest.limits?.startMs) && validMs(manifest.limits?.readyMs), 'Explicit latency limits are required.');
    requireValue(Array.isArray(events), 'Expected timing events.');
    const expected = new Set(manifest.productIds), attempts = new Map();
    let ignoredEvents = 0;
    for (const event of events) {
        if (!expected.has(event?.productId)) {
            ignoredEvents++;
            continue;
        }
        requireValue(event.schemaVersion === 1 && event.event === 'print_job_timing', 'Unsupported timing event schema.');
        requireValue(event.provider === manifest.provider, 'Execution providers cannot be mixed in a cohort.');
        requireValue(typeof event.attemptId === 'string' && event.attemptId.length > 0 &&
            Number.isInteger(event.attempt) && event.attempt >= 1, 'An explicit attempt identity is required.');
        requireValue(['ready', 'failed', 'superseded', 'inactive', 'deferred'].includes(event.outcome), 'Unknown execution outcome.');
        requireValue(timestampFields.every(field => validMs(event[field])), 'Missing authoritative operation timestamps.');
        requireValue(event.jobCreatedAtMs >= manifest.startedAtMs && event.finishedAtMs <= manifest.finishedAtMs, 'Timing event falls outside the measured run.');
        requireValue(event.jobCreatedAtMs <= event.claimStartedAtMs &&
            event.executorEnteredAtMs <= event.claimStartedAtMs && event.claimStartedAtMs <= event.claimedAtMs &&
            event.claimedAtMs <= event.preparationStartedAtMs && event.preparationStartedAtMs <= event.finishedAtMs, 'Operation timestamps are out of order.');
        // A sibling may be created after its executor enters. This is legal, but
        // executor entry cannot then measure that sibling's processing-start delay.
        if (event.readyCommittedAtMs !== undefined)
            requireValue(validMs(event.readyCommittedAtMs) &&
                event.readyCommittedAtMs >= event.preparationStartedAtMs && event.readyCommittedAtMs <= event.finishedAtMs &&
                event.outcome === 'ready', 'Invalid committed-ready timestamp.');
        requireValue(event.outcome !== 'ready' || event.readyCommittedAtMs !== undefined, 'A ready outcome requires the fenced commit timestamp.');
        if (event.queueMessageTimestampMs !== undefined)
            requireValue(validMs(event.queueMessageTimestampMs) &&
                event.queueMessageTimestampMs <= event.executorEnteredAtMs && event.provider === 'queue', 'Invalid queue message timestamp.');
        const key = `${event.productId}/${event.attemptId}`, previous = attempts.get(key);
        if (previous) {
            requireValue(evidenceFields.every(field => previous[field] === event[field]), 'Conflicting timing evidence for one attempt.');
            continue;
        }
        attempts.set(key, event);
    }
    const samples = manifest.productIds.map(productId => {
        const productAttempts = [...attempts.values()].filter(event => event.productId === productId)
            .sort((a, b) => a.claimedAtMs - b.claimedAtMs);
        const created = new Set(productAttempts.map(event => event.jobCreatedAtMs));
        requireValue(created.size <= 1, 'Job creation timestamp changed between attempts.');
        const first = productAttempts[0], processing = productAttempts.find(event => event.outcome !== 'deferred'), ready = productAttempts.find(event => event.outcome === 'ready');
        return { productId, attempts: productAttempts.length,
            admissionDeferrals: productAttempts.filter(event => event.outcome === 'deferred').length, complete: Boolean(ready),
            firstOutcome: first?.outcome ?? null,
            recordToExecutorMs: first && first.executorEnteredAtMs >= first.jobCreatedAtMs
                ? first.executorEnteredAtMs - first.jobCreatedAtMs : null,
            recordToClaimMs: first ? first.claimedAtMs - first.jobCreatedAtMs : null,
            claimMs: first ? first.claimedAtMs - first.claimStartedAtMs : null,
            recordToPreparationMs: processing ? processing.preparationStartedAtMs - processing.jobCreatedAtMs : null,
            queueMessageToExecutorMs: first?.queueMessageTimestampMs !== undefined
                ? first.executorEnteredAtMs - first.queueMessageTimestampMs : null,
            recordToReadyMs: ready ? ready.readyCommittedAtMs - ready.jobCreatedAtMs : null,
            preparationToReadyMs: ready ? ready.readyCommittedAtMs - ready.preparationStartedAtMs : null };
    });
    const violations = samples.flatMap(sample => {
        const failures = [];
        if (!sample.complete)
            failures.push({ productId: sample.productId, reason: 'missing_committed_ready' });
        if (sample.recordToPreparationMs !== null && sample.recordToPreparationMs > manifest.limits.startMs)
            failures.push({ productId: sample.productId, reason: 'processing_start_limit', observedMs: sample.recordToPreparationMs });
        if (sample.recordToReadyMs !== null && sample.recordToReadyMs > manifest.limits.readyMs)
            failures.push({ productId: sample.productId, reason: 'committed_ready_limit', observedMs: sample.recordToReadyMs });
        return failures;
    });
    const distribution = field => printLatencyDistribution(samples.map(sample => sample[field]).filter(value => value !== null));
    return { schemaVersion: 1, runId: manifest.runId, source: manifest.source, provider: manifest.provider,
        scope: 'bounded product burst; not sustained throughput or browser checkout latency',
        samples, ignoredEvents, limits: manifest.limits, passed: violations.length === 0, violations,
        distributions: { recordToPreparation: distribution('recordToPreparationMs'), recordToReady: distribution('recordToReadyMs'),
            recordToExecutor: distribution('recordToExecutorMs'), queueMessageToExecutor: distribution('queueMessageToExecutorMs') },
        note: 'Missing attempts fail the run. Retries remain included in record-to-ready. p95 requires 100 comparable products and p99 requires 1000; this bounded report cannot certify p99.' };
}
/** Legacy waitMs is record-to-claim, not internal queue time or executor start. */
export function legacyPrintLatencyReport(samples, startLimitMs = 1000) {
    requireValue(Array.isArray(samples) && samples.length > 0 && validMs(startLimitMs) &&
        samples.every(sample => typeof sample.productId === 'string' && validMs(sample.queueWaitMs)), 'Invalid legacy samples.');
    return { schemaVersion: 1, evidenceKind: 'legacy_record_to_claim',
        samples: samples.map(sample => ({ productId: sample.productId, recordToClaimMs: sample.queueWaitMs })),
        distribution: printLatencyDistribution(samples.map(sample => sample.queueWaitMs)),
        passed: samples.every(sample => sample.queueWaitMs <= startLimitMs), startLimitMs,
        queueInternalDelayMs: null, committedReadyMs: null,
        note: 'Legacy waits include outbox dispatch and claim. Collector observation times and product creation times are not operation timestamps.' };
}
if (import.meta.main) {
    const { values } = parseArgs({ options: { manifest: { type: 'string' }, events: { type: 'string' },
            legacy: { type: 'string' }, cohort: { type: 'string' }, strict: { type: 'boolean', default: false } } });
    let report;
    if (values.legacy) {
        requireValue(values.cohort && !values.manifest && !values.events, 'Legacy mode requires --cohort and no current manifest/events.');
        const evidence = JSON.parse(resolveProtectedTemplate(await readFile(values.legacy, 'utf8')));
        report = legacyPrintLatencyReport(evidence[values.cohort]?.samples);
    }
    else {
        requireValue(values.manifest && values.events && !values.cohort, 'Supply --manifest and --events JSONL.');
        report = printLatencyReport(JSON.parse(resolveProtectedTemplate(await readFile(values.manifest, 'utf8'))), (await readFile(values.events, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
    }
    console.info(JSON.stringify(report, null, 2));
    if (values.strict && !report.passed)
        process.exitCode = 1;
}
