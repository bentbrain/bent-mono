import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './data.mjs';
import { recordProofBoundary } from './testing/proof-observations.mjs';
import { journey } from './journey.mjs';
import { scopedFixture } from './testing/scoped-fixtures.mjs';
import { createWorkflowJourneyFixture, privateProofDirectory, recordedProcess, syntheticRetainedRunner, workflowApiBridge, workflowFixtureBoundaries } from './testing/workflow-journey-fixture.mjs';
import { runWorkflowJourney, runWorkflowUpdate, workflowInvocation } from './testing/workflow-journey.mjs';

async function privateRoot(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'shop-workflow-journey-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('fresh executable proof retains original failure streams and exact invocation', async t => {
  const output = await privateRoot(t);
  const result = await recordedProcess({ output, name: 'original-failure', args: ['--input-type=module', '-e',
    'process.stdout.write("accepted-intent\\n"); process.stderr.write("original-uncertain-ack\\n"); process.exitCode = 23;'] });
  assert.equal(result.exitCode, 23);
  assert.equal(result.stdoutText, 'accepted-intent\n');
  assert.equal(result.stderrText, 'original-uncertain-ack\n');
  assert.equal(sha256(await readFile(join(output, result.stderr.path))), result.stderr.sha256);
  const record = JSON.parse(await readFile(join(output, 'original-failure-invocation.private.json')));
  assert.deepEqual(record.args, result.args);
  assert.equal(record.executableSha256, sha256(await readFile(process.execPath)));
  await assert.rejects(() => recordedProcess({ output, name: '../escape', args: [] }), /process identity/);
  await assert.rejects(() => privateProofDirectory(process.cwd()), /outside the checkout/);
});

test('a timed-out proof process exits and retains its original diagnostic', async t => {
  const output = await privateRoot(t);
  const result = await recordedProcess({ output, name: 'deadline', timeoutMs: 750, args: ['--input-type=module', '-e',
    'process.stderr.write("pending-write\\n"); setInterval(() => {}, 1000);'] });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stderrText, 'pending-write\n');
});

test('synthetic source probe executes retained bytes through the default hosted journey sandbox', async t => {
  const root = await privateRoot(t), f = await scopedFixture({ root: join(root, 'fixture') });
  const payload = await f.scopedPayload(f.trust.intentCommits[1]);
  for (const component of payload.components) {
    const artifact = JSON.parse(await readFile(join(f.bundle, component.artifact.path)));
    const source = `export const component = '${component.id}'; export const exercise = phase => component + ':' + phase;`;
    await writeFile(join(f.bundle, artifact.entrypoint), source, { mode: 0o600 });
    artifact.files = [{ ...artifact.files[0], bytes: Buffer.byteLength(source), sha256: sha256(source) }];
    component.artifact = await f.put(component.artifact.path, artifact);
  }
  const script = await f.put('synthetic-hosted-runner.mjs', syntheticRetainedRunner());
  const directory = join(root, 'evidence'); await mkdir(directory, { mode: 0o700 });
  const trust = { ...f.trust, schema: 'shop.hosted-composition-policy/v1', scope: 'isolated-qualification',
    runner: { id: 'synthetic-source-workflow-probe', script, executableDigest: sha256(await readFile(process.execPath)), timeoutMs: 5000,
      origins: ['https://synthetic-workflow.example.invalid'], requiredObservations: ['synthetic-retained-code-execution'] } };
  const admission = { trust, payload, compositionDigest: 'a'.repeat(64) };
  const result = await journey({ bundle: f.bundle, directory, admission, origin: trust.runner.origins[0], phase: 'candidate' });
  assert.equal(result.scope, 'isolated-qualification'); assert.equal(result.exitCode, 0);
  const evidence = JSON.parse(await readFile(join(result.evidenceRoot, result.observations[0].evidence.path)));
  assert.equal(evidence.customerJourney, false); assert.equal(evidence.awsImageQualified, false);
  assert.deepEqual(evidence.observations.map(item => item.component), payload.components.map(item => item.id));
  const component = payload.components[0], artifact = JSON.parse(await readFile(join(f.bundle, component.artifact.path)));
  await writeFile(join(f.bundle, artifact.entrypoint), 'export const component = "forged";', { mode: 0o600 });
  await assert.rejects(() => journey({ bundle: f.bundle, directory, admission, origin: trust.runner.origins[0], phase: 'active' }), /Journey executable failed/);
});

test('recording workflow APIs transport the original archive bytes with bounded loopback download', async t => {
  const output = await privateRoot(t), original = Buffer.from('original encrypted artifact zip bytes');
  const bridge = await workflowApiBridge({ output, intakeApi: {
    getJSON: async endpoint => ({ endpoint, originalIdentity: true }),
    downloadArtifact: async ({ destination }) => writeFile(destination, original, { flag: 'wx', mode: 0o600 }),
  }, qualityApi: async endpoint => ({ endpoint, currentMain: true }) });
  t.after(() => bridge.close());
  const boundaries = workflowFixtureBoundaries({ apiOrigin: bridge.origin });
  const endpoint = '/repos/bentbrain/bent-mono/actions/artifacts/17';
  assert.equal((await boundaries.intakeApi.getJSON(endpoint)).originalIdentity, true);
  assert.equal((await boundaries.qualityApi('/repos/bentbrain/bent-mono/git/ref/heads/main')).currentMain, true);
  const destination = join(output, 'received.zip');
  await boundaries.intakeApi.downloadArtifact({ endpoint: `${endpoint}/zip`, destination, maxBytes: 100 });
  assert.deepEqual(await readFile(destination), original);
  assert.equal(bridge.calls.filter(item => item.kind === 'download').length, 1);
  await assert.rejects(() => boundaries.intakeApi.downloadArtifact({ endpoint: `${endpoint}/zip`, destination: join(output, 'too-small.zip'), maxBytes: 2 }), /transport failed/);
  assert.throws(() => workflowFixtureBoundaries({ apiOrigin: 'https://api.github.com' }), /literal loopback/);
});

test('complete source entrypoint rejects a malformed native target after a valid Worker before opening custody', async t => {
  const output = await privateRoot(t);
  const fixture = await createWorkflowJourneyFixture(t, { output, malformedNative: true });
  assert.equal(fixture.plan.targets[0].kind, 'worker');
  const calls = fixture.service.transcript.length;
  const result = await workflowInvocation({ output, name: 'malformed-native-preflight', configuration: fixture.configuration });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderrText, /Lambda target binding contract required/);
  assert.equal(fixture.service.brokerCalls.length, 0);
  assert.equal(fixture.service.transcript.length, calls);
});

test('fresh source entrypoints complete an initial release and update only storefront while retaining accepted work', { timeout: 180000 }, async t => {
  const base = process.env.SHOP_WORKFLOW_PROOF_ROOT ?? tmpdir();
  await mkdir(base, { recursive:true,mode:0o700 });
  const output = await realpath(await mkdtemp(join(base, 'source-integration-')));
  let passed = false;
  const activeProofs = [];
  const track = promise => { activeProofs.push(promise); return promise; };
  const onAbort=()=>{if(!passed)recordProofBoundary(output,'outer-cancelled');};
  recordProofBoundary(output,'fixture-start');
  t.signal.addEventListener('abort',onAbort,{once:true});
  const fixture = await createWorkflowJourneyFixture({ after() {} }, { output });
  recordProofBoundary(output,'fixture-complete');
  t.after(async () => { t.signal.removeEventListener('abort',onAbort); await Promise.allSettled(activeProofs); await fixture.bridge.close(); await fixture.service.close(); if (passed && !process.env.SHOP_WORKFLOW_PROOF_ROOT) await rm(output, { recursive: true }); });
  const configuration = { ...fixture.configuration, options: { ...fixture.configuration.options, command: 'deliver' } };
  recordProofBoundary(output,'source-a-start');
  const first = await track(runWorkflowJourney({ output, configuration, service: fixture.service, apiBridge: fixture.bridge, timeoutMs: 90000, signal:t.signal }));
  recordProofBoundary(output,'source-a-complete');
  assert.equal(first.summary.complete, true, first.summary.failure?.message);
  assert.equal(first.invocations.length, 1);
  assert(first.final.transitions.some(item => item.phase === 'runtime-verified'));
  assert(first.final.transitions.some(item => item.phase === 'staged-verified'));
  assert(first.final.transitions.length > 10);
  recordProofBoundary(output,'source-b-start');
  const updated = await track(runWorkflowUpdate({ fixture, first, output, signal:t.signal }));
  recordProofBoundary(output,'source-b-complete');
  assert(updated.update.invocations.every(item => item.pid !== first.invocations[0].pid));
  assert.equal(new Set(updated.update.invocations.map(item => item.pid)).size, updated.update.invocations.length);
  assert.equal(updated.evidence.nativeAndBusinessMutations, 0);
  assert.equal(updated.evidence.storefrontMutations, 2);
  assert.equal(updated.evidence.acceptedWork.length, 2);
  assert.equal(fixture.service.functions.values().next().value.active, '1');
  assert.equal(fixture.service.workers.get('synthetic-workflow-business').versions.length, 1);
  assert.equal(fixture.service.workers.get('synthetic-workflow-storefront').versions.length, 2);
  assert.equal(fixture.service.reports.length, 2);
  assert.equal(updated.evidence.realAwsQualified, false);
  passed = true;
});
