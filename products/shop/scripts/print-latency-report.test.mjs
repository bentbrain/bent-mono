import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyPrintLatencyReport, printLatencyDistribution, printLatencyReport } from './print-latency-report.mjs';

const manifest = { schemaVersion: 1, runId: 'cold-burst-1', source: 'a'.repeat(40), provider: 'queue',
  startedAtMs: 1000, finishedAtMs: 60000, productIds: ['shirt', 'tote'], limits: { startMs: 1000, readyMs: 8000 } };
function timing(productId, changes = {}) {
  return { schemaVersion: 1, event: 'print_job_timing', provider: 'queue', productId,
    attemptId: 'lease-1', attempt: 1, outcome: 'ready', jobCreatedAtMs: 1100,
    executorEnteredAtMs: 1200, claimStartedAtMs: 1210, claimedAtMs: 1300, preparationStartedAtMs: 1310,
    readyCommittedAtMs: 5000, finishedAtMs: 5010, queueMessageTimestampMs: 1150, deliveryId: 'message-1', ...changes };
}

test('reports authoritative execution boundaries without using collector timestamps', () => {
  const report = printLatencyReport(manifest, [timing('shirt', { observedAt: '2050-01-01T00:00:00Z' }), timing('tote')]);
  assert.equal(report.passed, true);
  assert.deepEqual(report.samples[0], { productId: 'shirt', attempts: 1, admissionDeferrals: 0, complete: true, firstOutcome: 'ready',
    recordToExecutorMs: 100, recordToClaimMs: 200, claimMs: 90, recordToPreparationMs: 210,
    queueMessageToExecutorMs: 50, recordToReadyMs: 3900, preparationToReadyMs: 3690 });
  assert.equal(report.distributions.recordToReady.p95Ms, null);
});

test('incomplete expected products fail rather than dropping from the latency cohort', () => {
  const report = printLatencyReport(manifest, [timing('shirt')]);
  assert.equal(report.passed, false);
  assert.deepEqual(report.violations, [{ productId: 'tote', reason: 'missing_committed_ready' }]);
});

test('ready timing requires successful fenced publication, not completed preparation', () => {
  assert.throws(() => printLatencyReport(manifest, [timing('shirt', { readyCommittedAtMs: undefined })]), /fenced commit/u);
  const report = printLatencyReport(manifest, [timing('shirt', { outcome: 'superseded', readyCommittedAtMs: undefined }), timing('tote')]);
  assert.equal(report.passed, false);
});

test('retry delays remain in completion latency and failures remain visible', () => {
  const report = printLatencyReport(manifest, [timing('shirt', { outcome: 'failed', readyCommittedAtMs: undefined }),
    timing('shirt', { attemptId: 'lease-2', attempt: 2, executorEnteredAtMs: 20000, claimStartedAtMs: 20001,
      claimedAtMs: 20002, preparationStartedAtMs: 20003, readyCommittedAtMs: 23000, finishedAtMs: 23001 }), timing('tote')]);
  assert.equal(report.samples[0].recordToReadyMs, 21900);
  assert.equal(report.samples[0].attempts, 2);
  assert.equal(report.samples[0].firstOutcome, 'failed');
  assert.equal(report.passed, false);
  assert.equal(report.violations[0].reason, 'committed_ready_limit');
});

test('deduplicates identical tail deliveries but rejects conflicting attempt evidence', () => {
  assert.equal(printLatencyReport(manifest, [timing('shirt', { observedAt: 5000 }),
    timing('shirt', { observedAt: 6000 }), timing('tote')]).samples[0].attempts, 1);
  assert.throws(() => printLatencyReport(manifest, [timing('shirt'), timing('shirt', { finishedAtMs: 5100 })]), /Conflicting/u);
});

test('memory admission deferral stays visible even when it refunds the processing attempt', () => {
  const report = printLatencyReport(manifest, [timing('shirt', { outcome: 'deferred', readyCommittedAtMs: undefined }),
    timing('shirt', { attemptId: 'lease-2', attempt: 1, executorEnteredAtMs: 6000, claimStartedAtMs: 6010,
      claimedAtMs: 6020, preparationStartedAtMs: 6030, readyCommittedAtMs: 7000, finishedAtMs: 7010 }), timing('tote')]);
  assert.equal(report.samples[0].firstOutcome, 'deferred');
  assert.equal(report.samples[0].recordToReadyMs, 5900);
  assert.equal(report.samples[0].attempts, 2);
});

test('rejects legacy or mixed providers in current qualification and rejects invalid clocks', () => {
  assert.throws(() => printLatencyReport(manifest, [{ productId: 'shirt', waitMs: 100 }]), /schema/u);
  assert.throws(() => printLatencyReport(manifest, [timing('shirt', { provider: 'durable-object' })]), /mixed/u);
  assert.throws(() => printLatencyReport(manifest, [timing('shirt', { jobCreatedAtMs: undefined, productCreatedAtMs: 1100 })]), /authoritative/u);
  assert.throws(() => printLatencyReport(manifest, [timing('shirt', { claimedAtMs: 1190 })]), /out of order/u);
  assert.throws(() => printLatencyReport(manifest, [timing('shirt', { queueMessageTimestampMs: 1300 })]), /queue message/u);
});

test('durable-object execution needs no queue timestamps', () => {
  const report = printLatencyReport({ ...manifest, provider: 'durable-object' }, ['shirt', 'tote'].map(id =>
    timing(id, { provider: 'durable-object', queueMessageTimestampMs: undefined, deliveryId: undefined })));
  assert.equal(report.passed, true);
  assert.equal(report.samples[0].queueMessageToExecutorMs, null);
});

test('sibling created after executor entry has unknown record-to-executor instead of a negative delay', () => {
  const report = printLatencyReport(manifest, [timing('shirt'), timing('tote', { jobCreatedAtMs: 1205 })]);
  assert.equal(report.samples[1].recordToExecutorMs, null);
  assert.equal(report.samples[1].recordToPreparationMs, 105);
});

test('unknown products are ignored but expected products outside the run fail closed', () => {
  assert.equal(printLatencyReport(manifest, [timing('unrelated'), timing('shirt'), timing('tote')]).ignoredEvents, 1);
  assert.throws(() => printLatencyReport(manifest, [timing('shirt', { jobCreatedAtMs: 500 })]), /outside/u);
  assert.throws(() => printLatencyReport({ ...manifest, productIds: ['shirt', 'shirt'] }, []), /distinct/u);
});

test('small bursts never claim a measured p95 or p99', () => {
  assert.equal(printLatencyDistribution([2008, 9849, 18468]).p95Ms, null);
  assert.equal(printLatencyDistribution(Array.from({ length: 100 }, (_, i) => i)).p95Ms, 94);
  assert.equal(printLatencyDistribution(Array.from({ length: 100 }, (_, i) => i)).p99Ms, null);
});

test('recorded three-family baseline fails the one-second start limit', () => {
  // Existing e695ad5b qualification evidence, .data/scale/cloudflare-tail/timing-comparison.json afterLoad.
  const report = legacyPrintLatencyReport([
    { productId: '302b51ce-57fc-402b-9698-4a8090f5cb54', queueWaitMs: 2008 },
    { productId: '3168b886-bc2a-4293-9c76-8d8369cdffbe', queueWaitMs: 9849 },
    { productId: 'd5acc9e6-f3bb-4256-b09b-044ef3524061', queueWaitMs: 18468 },
  ]);
  assert.equal(report.passed, false);
  assert.equal(report.distribution.maxMs, 18468);
  assert.equal(report.distribution.p95Ms, null);
  assert.equal(report.queueInternalDelayMs, null);
  assert.equal(report.committedReadyMs, null);
});

test('admission refusal does not masquerade as prompt processing under load', () => {
  const report = printLatencyReport(manifest, [timing('shirt', { outcome: 'deferred', readyCommittedAtMs: undefined }),
    timing('shirt', { attemptId: 'lease-2', executorEnteredAtMs: 5000, claimStartedAtMs: 5001,
      claimedAtMs: 5002, preparationStartedAtMs: 5003, readyCommittedAtMs: 8000, finishedAtMs: 8010 }), timing('tote')]);
  assert.equal(report.samples[0].admissionDeferrals, 1);
  assert.equal(report.samples[0].recordToPreparationMs, 3903);
  assert.equal(report.samples[0].recordToExecutorMs, 100);
  assert.equal(report.samples[0].recordToReadyMs, 6900);
  assert.equal(report.passed, false);
  assert.equal(report.violations[0].reason, 'processing_start_limit');
});
