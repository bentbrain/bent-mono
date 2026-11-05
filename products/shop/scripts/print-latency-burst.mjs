import { setTimeout } from 'node:timers/promises';

/**
 * Bounded, simultaneous configuration arrivals. Cloud callers must provision and
 * journal fixtures before entering, honor each supplied AbortSignal, and clean
 * every fixture in their existing guarded finally block. This helper has no
 * credentials and does not create resources or dispatch a workflow itself.
 */
export async function observePrintLatencyBurst(fixtures, {
  confirmFamily, readProductReadiness, now = Date.now, wait = setTimeout,
  timeoutMs = 60000, pollMs = 250,
}) {
  if (!Array.isArray(fixtures) || fixtures.length < 1 || fixtures.length > 10 ||
    fixtures.some(fixture => typeof fixture.id !== 'string' || !fixture.id) ||
    new Set(fixtures.map(fixture => fixture.id)).size !== fixtures.length)
    throw new Error('A bounded cohort requires 1-10 distinct pre-journaled fixtures.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
    !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 1000)
    throw new Error('Use a timeout up to 120 seconds and polling between 100 and 1000 milliseconds.');
  const startedAtMs = now();
  const observations = fixtures.map(fixture => ({ fixtureId: fixture.id,
    configurationStartedAtMs: null, configurationConfirmedAtMs: null, products: [], complete: false }));
  const outcomes = await Promise.allSettled(fixtures.map(async (fixture, index) => {
    const observation = observations[index];
    observation.configurationStartedAtMs = now();
    const deadline = observation.configurationStartedAtMs + timeoutMs;
    const requestSignal = () => {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error('Print burst exceeded its observation deadline.');
      return AbortSignal.timeout(Math.min(5000, remaining));
    };
    const productIds = await confirmFamily(fixture, requestSignal());
    observation.configurationConfirmedAtMs = now();
    if (!Array.isArray(productIds) || productIds.length !== 2 || new Set(productIds).size !== 2 ||
      productIds.some(id => typeof id !== 'string' || !id))
      throw new Error('A confirmed family must identify its two distinct products.');
    observation.products = productIds.map(productId => ({ productId, readinessFirstObservedAtMs: null }));
    while (observation.products.some(product => product.readinessFirstObservedAtMs === null)) {
      // Wait for all started observations, including when one fails. Callers may
      // only clean their fixture inventory after this helper has settled.
      const checks = await Promise.allSettled(observation.products.filter(product => product.readinessFirstObservedAtMs === null)
        .map(async product => {
          const ready = await readProductReadiness(fixture, product.productId, requestSignal());
          if (typeof ready !== 'boolean') throw new Error('Readiness must be a validated boolean.');
          if (ready) product.readinessFirstObservedAtMs = now();
        }));
      if (checks.some(check => check.status === 'rejected')) throw new Error('Print readiness observation failed.');
      if (now() > deadline) throw new Error('Print burst exceeded its observation deadline.');
      if (observation.products.every(product => product.readinessFirstObservedAtMs !== null)) break;
      await wait(Math.min(pollMs, Math.max(0, deadline - now())));
    }
    observation.complete = true;
  }));
  const starts = observations.map(observation => observation.configurationStartedAtMs);
  const productIds = observations.flatMap(observation => observation.products.map(product => product.productId));
  const isolatedProducts = new Set(productIds).size === productIds.length;
  return { schemaVersion: 1, startedAtMs, finishedAtMs: now(),
    configurationLaunchSpreadMs: Math.max(...starts) - Math.min(...starts),
    completedFamilies: observations.filter(observation => observation.complete).length,
    passed: outcomes.every(outcome => outcome.status === 'fulfilled') && isolatedProducts,
    isolatedProducts,
    observations,
    note: 'Readiness times are first successful API observations, not backend completion timestamps. Configuration calls launch independently of earlier completions. Backend phase events are required for queue and execution latency.' };
}
