import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedMs, runTimings, timingDistribution } from './release-timings.mjs';
test('missing, unfinished and reversed timestamps are unknown, not zero', () => {
  for (const [a,b] of [[undefined,undefined],['bad','2026-09-11'],['2026-09-12','2026-09-11']]) assert.equal(elapsedMs(a,b), null);
  assert.equal(runTimings({status:'in_progress'}, []).elapsedMs, null);
});
test('parallel job time is distinguished from elapsed and billed time', () => {
  const start='2026-09-11T00:00:00Z', end='2026-09-11T00:01:00Z';
  const report=runTimings({status:'completed',created_at:start,run_started_at:start,updated_at:end}, [1,2].map(id => ({name:`job-${id}`,started_at:start,completed_at:end,steps:[{name:'Run tests',started_at:start,completed_at:end}]})));
  assert.equal(report.elapsedMs,60000); assert.equal(report.observedJobMs,120000);
  assert.equal(report.initialQueueMs,0); assert.equal(report.billedRunnerMinutes,null);
  assert.equal(report.steps[0].category,'checks');
});
test('distributions require ten comparable observed samples', () => {
  assert.equal(timingDistribution([null,undefined,-1,200,100]).medianMs,null);
  assert.deepEqual(timingDistribution(Array.from({length:10},(_,i)=>(i+1)*100)),{samples:10,medianMs:500,p95Ms:1000,minimumSamples:10});
});
