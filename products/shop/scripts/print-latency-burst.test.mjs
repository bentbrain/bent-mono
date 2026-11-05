import assert from 'node:assert/strict';
import test from 'node:test';
import { observePrintLatencyBurst } from './print-latency-burst.mjs';

test('launches all families before any confirmation finishes and observes both products immediately', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [], reads = [];
  const reportPromise = observePrintLatencyBurst([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
    confirmFamily: async (fixture, signal) => {
      assert.ok(signal instanceof AbortSignal);
      started.push(fixture.id);
      if (started.length === 3) release();
      await gate;
      return [`${fixture.id}-shirt`, `${fixture.id}-tote`];
    },
    readProductReadiness: async (fixture, productId) => { reads.push([fixture.id, productId]); return true; },
  });
  const report = await reportPromise;
  assert.equal(report.passed, true);
  assert.equal(report.completedFamilies, 3);
  assert.equal(reads.length, 6);
  assert.ok(report.observations.every(family => family.products.every(product => product.readinessFirstObservedAtMs !== null)));
});

test('retains successful products and all started families when one confirmation fails', async () => {
  const report = await observePrintLatencyBurst([{ id: 'a' }, { id: 'b' }], {
    confirmFamily: async fixture => { if (fixture.id === 'a') throw new Error('private provider details'); return ['shirt', 'tote']; },
    readProductReadiness: async () => true,
  });
  assert.equal(report.passed, false);
  assert.equal(report.completedFamilies, 1);
  assert.equal(report.observations.length, 2);
  assert.ok(!JSON.stringify(report).includes('private provider details'));
});

test('stops polling ready products, preserves deadline failures, and does not fake completion', async () => {
  let clock = 1000;
  const reads = [];
  const report = await observePrintLatencyBurst([{ id: 'a' }], {
    confirmFamily: async () => ['shirt', 'tote'],
    readProductReadiness: async (_fixture, id) => { reads.push(id); return id === 'shirt'; },
    now: () => clock, wait: async delay => { clock += delay; }, timeoutMs: 500,
  });
  assert.equal(report.passed, false);
  assert.equal(reads.filter(id => id === 'shirt').length, 1);
  assert.equal(report.finishedAtMs, 1500);
  assert.equal(report.observations[0].products[1].readinessFirstObservedAtMs, null);
});

test('requires bounded fixtures and a complete two-product confirmation', async () => {
  const callbacks = { confirmFamily: async () => ['shirt'], readProductReadiness: async () => true };
  await assert.rejects(observePrintLatencyBurst(Array.from({ length: 11 }, (_, i) => ({ id: String(i) })), callbacks), /1-10/u);
  const report = await observePrintLatencyBurst([{ id: 'a' }], callbacks);
  assert.equal(report.passed, false);
});

test('rejects reused products across supposedly independent families', async () => {
  const report = await observePrintLatencyBurst([{ id: 'a' }, { id: 'b' }], {
    confirmFamily: async () => ['same-shirt', 'same-tote'], readProductReadiness: async () => true,
  });
  assert.equal(report.passed, false);
  assert.equal(report.isolatedProducts, false);
});
