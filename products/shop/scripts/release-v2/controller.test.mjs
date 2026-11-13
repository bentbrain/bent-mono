import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './testing/fixtures.mjs';
import { simulator } from './testing/provider-fixtures.mjs';
import { cli } from './testing/cli.mjs';
import { readHead } from './journal.mjs';
import { admit, compatible, activationOrder } from './composition.mjs';
import { parseJSON, canonical, digest, sha256, pathName, readRef } from './data.mjs';

const proofRoot = process.env.SHOP_RELEASE_V2_PROOF_DIR ?? tmpdir();
await mkdir(proofRoot, { recursive: true, mode: 0o700 });
const makeFixture = async options => fixture({ root: await mkdtemp(join(proofRoot, 'controller-')), ...options });
const head = async fixture => (await readHead(fixture.journal))?.state;
const ok = result => assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);

test('referenced objects require regular files, rejects symlinks and verifies exact pinned bytes', async () => {
  const root = await mkdtemp(join(proofRoot, 'reference-'));
  const bytes = Buffer.from('signed artifact');
  await writeFile(join(root, 'artifact'), bytes);
  const ref = { path: 'artifact', bytes: bytes.length, sha256: sha256(bytes) };
  assert.deepEqual(await readRef(root, ref), bytes);
  await symlink(join(root, 'artifact'), join(root, 'alias'));
  await assert.rejects(readRef(root, { ...ref, path: 'alias' }), /Symlinks/);
  await mkdir(join(root, 'directory'));
  await assert.rejects(readRef(root, { ...ref, path: 'directory' }), /regular file/);
  await writeFile(join(root, 'artifact'), 'replaced bytes');
  await assert.rejects(readRef(root, ref), /Referenced bytes differ/);
});

test('actual CLI retains the original admission failure in a private diagnostic', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await writeFile(join(f.bundle, f.payload.components[0].artifact.path), '{}');
  const result = await cli(f, p.origin);
  assert.equal(result.code, 1);
  const files = (await readdir(f.journal)).filter(name => /^failure-[a-f0-9-]+\.json$/.test(name));
  assert.equal(files.length, 1);
  const path = join(f.journal, files[0]), bytes = await readFile(path);
  const diagnostic = JSON.parse(bytes);
  assert.equal(diagnostic.schema, 'shop.local-controller-failure/v1');
  assert.equal(diagnostic.error.message, 'Referenced bytes differ');
  assert.match(diagnostic.error.stack, /readRef/);
  assert.equal(diagnostic.observedPhase, null);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.match(result.stderr, new RegExp(sha256(bytes)));
  assert.doesNotMatch(result.stderr, /Referenced bytes differ|readRef/);
  assert.equal(p.state.operations.length, 0);
  assert.equal(await head(f), undefined);
});
async function until(fixture, provider, phase, max = 40) {
  for (let count = 0; count < max; count++) {
    if ((await head(fixture))?.phase === phase) return;
    const result = await cli(fixture, provider.origin); ok(result);
  }
  assert.fail(`Did not reach ${phase}, current ${(await head(fixture))?.phase}`);
}
async function recover(fixture, provider) {
  const lockDigest = sha256(await readFile(join(fixture.journal, 'writer.json')));
  ok(await cli(fixture, provider.origin, { command: 'recover-writer', extra: ['--lock-digest', lockDigest] }));
}
const mutationCalls = provider => provider.state.calls.filter(call => call.method === 'POST');

test('strict JSON rejects duplicates, escaped duplicate keys, unsafe numbers and nested duplicates', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"n":9007199254740993}', '{"n":1.0}', '{"n":-0}', '{"n":1e0}', '{"x":{"a":1,"a":1}}', '{"__proto__":1}', '"\\ud800"']) {
    assert.throws(() => parseJSON(Buffer.from(text)));
  }
  assert.deepEqual(parseJSON(Buffer.from('{"x":["a",2,true,null]}')), { x: ['a', 2, true, null] });
});

test('relative paths support existing route filenames and reject traversal, control bytes and URI ambiguity', () => {
  for (const path of ['products/shop/apps/web/src/app/[productId]/page.tsx', 'src/routes/api.$productId.ts', 'assets/fixture portrait.png']) assert.equal(pathName(path), path);
  for (const path of ['../key', '/absolute', 'x/../key', 'x//key', 'x/./key', 'C:\\key', 'x%2fkey', 'x?key', 'x\u0000key']) assert.throws(() => pathName(path));
});

test('signed manifest has truthful mixed origins, full closures, strict subject admission and directed activation order', async () => {
  const f = await makeFixture();
  const admitted = await admit({ bundle: f.bundle, manifest: f.manifest, trustPath: f.trustPath });
  assert.notEqual(admitted.payload.components[0].originSourceCommit, admitted.payload.intentSourceCommit);
  assert.deepEqual(activationOrder(admitted.payload), ['consumer', 'producer']);
  assert.deepEqual(compatible(admitted.payload, null, { complete: true, jobs: [] }), ['consumer', 'producer']);
  const envelope = parseJSON(await readFile(f.manifest)); envelope.payload.unknown = true;
  await writeFile(f.manifest, canonical(envelope));
  await assert.rejects(admit({ bundle: f.bundle, manifest: f.manifest, trustPath: f.trustPath }), /Unknown field/);
});

test('signed but malformed paths, digests, duplicate identities, cycles and narrowed proof policy are refused', async t => {
  const cases = [
    payload => { payload.components[0].artifact.path = '../artifact'; },
    payload => { payload.components[0].artifact.sha256 = 'bad-digest'; },
    payload => { payload.components.push(structuredClone(payload.components[0])); },
    payload => { payload.dependencies.unshift({ producer: 'consumer', consumer: 'producer', formats: ['protocol-n'], capabilities: [] }); },
    payload => { payload.components[0].contract.accepts = ['protocol-n']; },
    payload => { payload.components[0].originSourceCommit = 'd'.repeat(40); }
  ];
  for (const mutate of cases) {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    mutate(f.payload); await f.seal();
    assert.equal((await cli(f, p.origin)).code, 1); assert.equal(mutationCalls(p).length, 0);
  }
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  f.payload.proofRefs.pop(); await f.signManifest(f.payload);
  assert.equal((await cli(f, p.origin)).code, 1);
});

test('actual default Node CLI stages, runs pinned executable, activates consumers first and atomically records verified plus outbox', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'reporting-pending');
  const state = await head(f);
  assert.equal(state.lastVerified.schema, 'shop.release-composition/v1');
  assert.equal(state.report.verificationDigest, digest(state.verification));
  assert.equal(state.verification.activeJourney.exitCode, 0);
  assert.equal(state.verification.activeJourney.observations.length, 1);
  assert.deepEqual(p.state.operations.filter(item => item.kind === 'activate').map(item => item.result.component), ['consumer', 'producer']);
  assert.equal(state.budget.productionDeliveryMeasured, false);
  await until(f, p, 'complete');
  const before = p.state.calls.length; ok(await cli(f, p.origin));
  assert.equal(p.state.calls.length, before);
  assert.equal(p.state.physicalEffects, 0);
});

test('two actual concurrent CLI processes permit one writer while mutation is pending and reject live recovery', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'stage-intent');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  p.controls.beforeMutation = async kind => {
    assert.equal(kind, 'stage');
    entered.resolve();
    await release.promise;
  };
  const first = cli(f, p.origin);
  let firstResult;
  try {
    assert.equal(await Promise.race([entered.promise.then(() => true), first.then(() => false)]), true,
      'The first CLI must reach the pending mutation before a competing writer starts');
    const lockDigest = sha256(await readFile(join(f.journal, 'writer.json')));
    const [second, recovery] = await Promise.all([
      cli(f, p.origin),
      cli(f, p.origin, { command: 'recover-writer', extra: ['--lock-digest', lockDigest] })
    ]);
    assert.equal(second.code, 1);
    assert.equal(recovery.code, 1);
    assert.equal(p.state.operations.length, 0, 'The first mutation remains pending during both rejection checks');
  } finally {
    release.resolve();
    firstResult = await first;
  }
  ok(firstResult);
  assert.equal(mutationCalls(p).length, 1);
});

for (const kind of ['stage', 'activate', 'reports']) {
  for (const boundary of ['before-post', 'after-post']) test(`actual process crash ${kind}:${boundary} preserves uncertain intent and never repeats POST`, async t => {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    const phase = kind === 'reports' ? 'report-intent' : `${kind}-intent`;
    await until(f, p, phase);
    const prior = mutationCalls(p).length;
    const result = await cli(f, p.origin, { extra: ['--crash-at', `${kind}:${boundary}`] }); assert.equal(result.code, 86);
    assert.equal((await cli(f, p.origin)).code, 1);
    await recover(f, p);
    const count = mutationCalls(p).length;
    assert.equal(count - prior, boundary === 'before-post' ? 0 : 1);
    ok(await cli(f, p.origin)); ok(await cli(f, p.origin));
    assert.equal(mutationCalls(p).length, count);
    if (boundary === 'before-post') assert.ok((await head(f)).phase.endsWith('-reconcile'));
  });
}

for (const boundary of ['before-event', 'after-event', 'before-head', 'after-head']) test(`actual journal crash ${boundary} retains atomic head and immutable orphan evidence`, async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  const result = await cli(f, p.origin, { extra: ['--crash-at', `prepared:${boundary}`] }); assert.equal(result.code, 86);
  const state = await head(f);
  assert.equal(state?.phase ?? null, boundary === 'after-head' ? 'prepared' : null);
  await recover(f, p); ok(await cli(f, p.origin));
  assert.equal(mutationCalls(p).length, 0);
});

for (const kind of ['stage', 'activate', 'reports']) {
  for (const boundary of ['before-event', 'after-event', 'before-head', 'after-head']) test(`crash during ${kind} dispatch journal ${boundary} preserves the POST fence`, async t => {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    const intentPhase = kind === 'reports' ? 'report-intent' : `${kind}-intent`;
    const reconcilePhase = kind === 'reports' ? 'report-reconcile' : `${kind}-reconcile`;
    await until(f, p, intentPhase);
    const prior = mutationCalls(p).length;
    assert.equal((await cli(f, p.origin, { extra: ['--crash-at', `${reconcilePhase}:${boundary}`] })).code, 86);
    assert.equal(mutationCalls(p).length, prior);
    await recover(f, p); ok(await cli(f, p.origin));
    assert.equal(mutationCalls(p).length, prior + (boundary === 'after-head' ? 0 : 1));
  });
}

for (const boundary of ['before-event', 'after-event', 'before-head', 'after-head']) test(`verification/outbox crash ${boundary} never splits verified state from reporting debt`, async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'activating');
  // First activation is the consumer; finish the producer activation too.
  while ((await head(f)).observed.length < 2) ok(await cli(f, p.origin));
  const posts = mutationCalls(p).length;
  assert.equal((await cli(f, p.origin, { extra: ['--crash-at', `reporting-pending:${boundary}`] })).code, 86);
  const state = await head(f);
  assert.equal(Boolean(state.lastVerified), Boolean(state.report));
  if (boundary === 'after-head') assert.equal(state.phase, 'reporting-pending');
  else assert.equal(state.phase, 'activating');
  await recover(f, p); ok(await cli(f, p.origin));
  assert.equal(mutationCalls(p).length, posts);
});

test('lost HTTP acknowledgement resolves only one exact operation; empty, duplicate and truncated discovery never replay', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'stage-intent'); p.controls.dropAfter = 'stage';
  assert.equal((await cli(f, p.origin)).code, 1);
  const writes = mutationCalls(p).length;
  p.controls.hideOperations = true; ok(await cli(f, p.origin));
  p.controls.hideOperations = false; p.controls.duplicateOperations = true;
  assert.equal((await cli(f, p.origin)).code, 1);
  p.controls.duplicateOperations = false; p.controls.truncatedOperations = true;
  assert.equal((await cli(f, p.origin)).code, 1);
  p.controls.truncatedOperations = false; ok(await cli(f, p.origin));
  assert.equal((await head(f)).phase, 'staging');
  assert.equal(mutationCalls(p).length, writes);
});

test('HTTP rejection and lost acknowledgement with no visible record remain GET-only', async t => {
  for (const fault of ['httpError', 'dropBefore']) {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    await until(f, p, 'stage-intent');
    if (fault === 'httpError') { p.controls.httpError = true; p.controls.errorPath = '/stage'; }
    else p.controls.dropBefore = 'stage';
    assert.equal((await cli(f, p.origin)).code, 1);
    const diagnosticFile = (await readdir(f.journal)).find(name => /^failure-[a-f0-9-]+\.json$/.test(name));
    assert(diagnosticFile, 'The failed HTTP boundary must retain private evidence');
    const diagnostic = JSON.parse(await readFile(join(f.journal, diagnosticFile), 'utf8'));
    assert.equal(diagnostic.observedPhase, 'stage-reconcile');
    assert.match(diagnostic.error.message, fault === 'httpError' ? /Fixture HTTP 503/ : /socket|connection/i);
    p.controls.httpError = false; p.controls.dropBefore = null;
    ok(await cli(f, p.origin)); ok(await cli(f, p.origin));
    assert.equal((await head(f)).phase, 'stage-reconcile'); assert.equal(mutationCalls(p).length, 1);
  }
});

test('delayed active version waits, wrong runtime stops and truncated inventory blocks qualification', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  p.controls.truncated = true; assert.equal((await cli(f, p.origin)).code, 1); assert.equal(await head(f), undefined);
  p.controls.truncated = false; await until(f, p, 'activate-intent'); p.controls.delayedActivation = true;
  ok(await cli(f, p.origin)); ok(await cli(f, p.origin)); assert.equal((await head(f)).phase, 'activate-reconcile');
  p.state.active = [p.state.operations.find(item => item.kind === 'activate').result];
  p.controls.wrongRuntime = []; assert.equal((await cli(f, p.origin)).code, 1);
  p.controls.wrongRuntime = null; p.controls.delayedActivation = false; ok(await cli(f, p.origin));
  await until(f, p, 'complete');
});

test('reporting outage retains verified runtime; recovery uses zero runtime GET or POST calls', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'report-intent'); p.controls.reportOutage = true;
  assert.equal((await cli(f, p.origin, { command: 'recover-report' })).code, 1);
  const runtimeBefore = p.state.calls.filter(call => !call.path.startsWith('/reports')).length;
  p.controls.reportOutage = false;
  ok(await cli(f, p.origin, { command: 'recover-report' }));
  // Rejected POST has unknown delivery. An independently discovered exact
  // report resolves it; simply clearing an outage never grants replay.
  const state = await head(f); assert.equal(state.phase, 'report-reconcile');
  p.state.reports.push(state.operation.body);
  ok(await cli(f, p.origin, { command: 'recover-report' }));
  assert.equal((await head(f)).phase, 'complete');
  assert.equal(p.state.calls.filter(call => !call.path.startsWith('/reports')).length, runtimeBefore);
  assert.equal(mutationCalls(p).filter(call => call.path === '/reports').length, 1);
});

test('actual reporting lost acknowledgement and GET outage recover through HTTP without runtime calls', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'report-intent'); p.controls.dropAfter = 'reports';
  assert.equal((await cli(f, p.origin, { command: 'recover-report' })).code, 1);
  assert.equal(p.state.reports.length, 1);
  const state = await head(f), runtimeBefore = p.state.calls.filter(call => !call.path.startsWith('/reports')).length;
  p.controls.httpError = true; p.controls.errorPath = `/reports/${state.report.eventId}`;
  assert.equal((await cli(f, p.origin, { command: 'recover-report' })).code, 1);
  p.controls.httpError = false;
  ok(await cli(f, p.origin, { command: 'recover-report' }));
  assert.equal((await head(f)).phase, 'complete');
  assert.equal(p.state.calls.filter(call => !call.path.startsWith('/reports')).length, runtimeBefore);
  assert.equal(mutationCalls(p).filter(call => call.path === '/reports').length, 1);
});

test('artifact, config, source, root lock, signature and proof swaps fail before runtime writes', async t => {
  for (const kind of ['artifact', 'config', 'source', 'lock', 'signature', 'proof']) {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    if (kind === 'signature') {
      const envelope = parseJSON(await readFile(f.manifest)); envelope.signature.signature = Buffer.alloc(70).toString('base64'); await writeFile(f.manifest, canonical(envelope));
    } else {
      const path = kind === 'artifact' ? 'artifacts/consumer/index.mjs' : kind === 'config' ? f.payload.components[0].config.path :
        kind === 'proof' ? f.payload.proofRefs[0].receipt.path : `snapshots/${f.payload.intentSourceCommit}/${kind === 'lock' ? 'bun.lock' : 'src/consumer.mjs'}`;
      await writeFile(join(f.bundle, path), 'swapped');
    }
    assert.equal((await cli(f, p.origin)).code, 1, kind); assert.equal(mutationCalls(p).length, 0);
  }
});

test('unknown source paths and omitted artifact files invalidate complete closures', async t => {
  for (const path of ['snapshots/' + 'b'.repeat(40) + '/unknown-new-source.mjs', 'artifacts/consumer/unknown-new-module.wasm']) {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    await f.put(path, 'new-unlisted-bytes');
    assert.equal((await cli(f, p.origin)).code, 1); assert.equal(mutationCalls(p).length, 0);
  }
});

test('a valid fixture signer cannot substitute a proof subject or component configuration', async t => {
  for (const kind of ['proof-subject', 'config-subject']) {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    if (kind === 'proof-subject') {
      const proof = f.payload.proofRefs[0], receipt = parseJSON(await readFile(join(f.bundle, proof.receipt.path)));
      receipt.subjectDigest = '0'.repeat(64); proof.receipt = await f.put(proof.receipt.path, receipt);
    } else f.payload.components[0].config = f.payload.components[1].config;
    await f.signManifest(f.payload);
    assert.equal((await cli(f, p.origin)).code, 1); assert.equal(mutationCalls(p).length, 0);
  }
});

test('provider executable/config corruption or truncated content never qualifies staged artifacts', async t => {
  for (const kind of ['executable', 'config', 'truncated']) {
    const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
    await until(f, p, 'stage-reconcile');
    const record = p.state.operations[0], upload = p.state.contents[`${record.result.component}/${record.result.version}`];
    if (kind === 'executable') upload.files[0].data = Buffer.from('corrupt-runtime').toString('base64');
    if (kind === 'config') upload.config = Buffer.from('{}').toString('base64');
    if (kind === 'truncated') upload.files = [];
    assert.equal((await cli(f, p.origin)).code, 1);
    assert.equal((await head(f)).staged.length, 0);
    assert.equal(p.state.operations.filter(item => item.kind === 'activate').length, 0);
  }
});

test('actual CLI stops incompatible outstanding work before any mutation', async t => {
  const f = await makeFixture(), p = await simulator({ state: { jobs: [{ component: 'consumer', format: 'job-future', artifactDigest: f.payload.components[0].artifact.sha256 }] } });
  t.after(() => p.close()); assert.equal((await cli(f, p.origin)).code, 1);
  assert.equal(mutationCalls(p).length, 0);
});

test('actual CLI rolls back only to compatible verified code and preserves business data and outstanding work', async t => {
  const f = await makeFixture(), p = await simulator({ state: { businessData: { orders: ['synthetic-order'], epochs: [1] } } }); t.after(() => p.close());
  const firstManifest = f.manifest, firstPayload = structuredClone(f.payload);
  await until(f, p, 'complete');
  const next = structuredClone(f.payload); next.parentCompositionDigest = digest(firstPayload); next.rollbackCompositionDigest = digest(firstPayload); next.createdAt = '2026-11-12T23:00:01.000Z';
  const component = next.components[0];
  const files = [{ ...await f.put('artifacts/consumer-v2/index.mjs', 'export const component = "consumer-v2";'), mediaType: 'application/javascript' }];
  const provenance = parseJSON(await readFile(join(f.bundle, component.provenance.path))); provenance.artifactFilesDigest = digest(files);
  component.provenance = await f.put('metadata/consumer-v2-provenance.json', provenance);
  const artifact = parseJSON(await readFile(join(f.bundle, component.artifact.path)));
  artifact.root = 'artifacts/consumer-v2'; artifact.entrypoint = files[0].path; artifact.files = files; artifact.provenanceDigest = component.provenance.sha256;
  component.artifact = await f.put('metadata/consumer-v2-artifact.json', artifact);
  f.manifest = await f.seal(next, 'next-composition.json');
  ok(await cli(f, p.origin, { command: 'begin' })); await until(f, p, 'complete');
  const activations = p.state.operations.filter(item => item.kind === 'activate').length;
  assert.equal(activations, 3);
  p.state.jobs = [{ component: 'consumer', format: 'job-v1', artifactDigest: component.artifact.sha256 }];
  const businessBefore = canonical(p.state.businessData), jobsBefore = canonical(p.state.jobs);
  f.manifest = firstManifest;
  ok(await cli(f, p.origin, { command: 'rollback' })); await until(f, p, 'complete');
  assert.equal(digest((await head(f)).lastVerified), digest(firstPayload));
  assert.equal(canonical(p.state.businessData), businessBefore); assert.equal(canonical(p.state.jobs), jobsBefore);
  assert.equal(p.state.versions.length, 3);
  assert.equal(p.state.operations.filter(item => item.kind === 'activate').length, 4);
  const unverified = structuredClone(next); unverified.createdAt = '2026-11-12T23:00:02.000Z';
  f.manifest = await f.seal(unverified, 'unverified.json');
  assert.equal((await cli(f, p.origin, { command: 'rollback' })).code, 1);
  assert.equal(p.state.physicalEffects, 0);
});

test('incompatible protocols, outstanding jobs, storage and rollback constraints stop admission', async () => {
  const f = await makeFixture();
  const candidate = structuredClone(f.payload), previous = structuredClone(f.payload);
  candidate.components[0].contract.accepts = ['future'];
  assert.throws(() => compatible(candidate, previous, { complete: true, jobs: [] }), /protocol/);
  assert.throws(() => compatible(f.payload, null, { complete: true, jobs: [{ component: 'consumer', format: 'job-future', artifactDigest: f.payload.components[0].artifact.sha256 }] }), /Outstanding job/);
  const storage = structuredClone(f.payload); storage.components[0].contract.storageReads = [];
  assert.throws(() => compatible(storage, previous, { complete: true, jobs: [] }), /Stored data/);
  const rollback = structuredClone(f.payload); rollback.components[0].contract.rollbackRequirements = ['unavailable'];
  assert.throws(() => compatible(rollback, previous, { complete: true, jobs: [] }), /Rollback requirement/);
});

test('failed pinned journey and forged success boolean cannot complete or activate', async t => {
  for (const runnerSource of ['process.exit(23);', 'process.stdout.write(JSON.stringify({ready:true}));']) {
    const f = await makeFixture({ runnerSource }), p = await simulator(); t.after(() => p.close());
    await until(f, p, 'staging');
    // Finish the second stage before the failing candidate journey.
    for (let count = 0; count < 6 && (await head(f)).staged.length < 2; count++) ok(await cli(f, p.origin));
    assert.equal((await cli(f, p.origin)).code, 1);
    assert.equal(p.state.operations.filter(item => item.kind === 'activate').length, 0);
    assert.equal((await head(f)).lastVerified, null);
  }
});

test('failed active journey leaves truthful active code without verified or reporting state', async t => {
  const source = await readFile(new URL('./testing/fixture-journey.mjs', import.meta.url), 'utf8');
  const runnerSource = source.replace("if (request.schema", 'if (request.phase === "active") process.exit(24);\nif (request.schema');
  const f = await makeFixture({ runnerSource }), p = await simulator(); t.after(() => p.close());
  await until(f, p, 'activating');
  while ((await head(f)).observed.length < 2) ok(await cli(f, p.origin));
  assert.equal((await cli(f, p.origin)).code, 1);
  const state = await head(f);
  assert.equal(state.phase, 'activating'); assert.equal(state.observed.length, 2);
  assert.equal(state.lastVerified, null); assert.equal(state.report, null);
  assert.equal(p.state.reports.length, 0); assert.equal(p.state.active.length, 2);
});

test('external origins, redirects, credential configuration and runner egress fail closed', async t => {
  const f = await makeFixture(), p = await simulator(); t.after(() => p.close());
  for (const origin of ['https://api.cloudflare.com', 'http://localhost:1234', `${p.origin}/`, 'http://127.0.0.1:1@api.example.invalid']) {
    assert.equal((await cli(f, origin)).code, 1);
  }
  assert.equal((await cli(f, p.origin, { env: { AWS_ACCESS_KEY_ID: 'synthetic-prohibited-live-shaped-config' } })).code, 1);
  p.controls.redirect = true; assert.equal((await cli(f, p.origin)).code, 1);
  assert.equal(mutationCalls(p).length, 0);
  const denied = await makeFixture({ runnerSource: 'await fetch("https://example.invalid/forbidden");' });
  p.controls.redirect = false; await until(denied, p, 'staging');
  for (let count = 0; count < 6 && (await head(denied)).staged.length < 2; count++) ok(await cli(denied, p.origin));
  assert.equal((await cli(denied, p.origin)).code, 1);
  assert.equal(p.state.physicalEffects, 0);
});

test('inclusive local budget records command gaps and misses without a Production timing claim', async t => {
  const f = await makeFixture({ budgetMs: 1 }), p = await simulator(); t.after(() => p.close());
  ok(await cli(f, p.origin)); await new Promise(accept => setTimeout(accept, 20)); ok(await cli(f, p.origin));
  const state = await head(f);
  assert.ok(state.budget.elapsedMs >= 20); assert.equal(state.budget.exceeded, true); assert.equal(state.budget.productionDeliveryMeasured, false);
});
