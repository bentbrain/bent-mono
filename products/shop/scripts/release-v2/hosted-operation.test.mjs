import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { canonical, digest } from './data.mjs';
import { assembleHostedRelease, assembleHostedRollback } from './source-issuance.mjs';
import { createBootstrapFixture } from './testing/bootstrap-fixture.mjs';
import { createWorkflowJourneyFixture } from './testing/workflow-journey-fixture.mjs';

const proofRoot = process.env.SHOP_WORKFLOW_PROOF_ROOT ?? tmpdir();
await mkdir(proofRoot, { recursive: true, mode: 0o700 });

async function directCli(options, env, command) {
  const file = fileURLToPath(new URL('./hosted-controller.mjs', import.meta.url));
  const args = [file, command, '--bundle', options.bundle, '--portable', options.portable, '--manifest', options.manifest,
    '--authority', options.authority, '--root', options.trustRoot, '--root-digest', options.rootDigest, '--target-plan', options.targetPlan,
    '--fence', options.fence, '--evidence', options.evidenceDirectory];
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Direct hosted CLI deadline')); }, 20000);
    child.once('close', () => clearTimeout(deadline));
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume(); child.once('error', reject);
    child.once('close', code => accept({ code, stderr }));
  });
}

test('default plan authority cannot execute through the direct hosted CLI with qualified target inputs', async t => {
  const output = await mkdtemp(join(proofRoot, 'operation-cli-'));
  const f = await createWorkflowJourneyFixture(t, { output });
  const assembled = await assembleHostedRelease(f.bootstrap);
  assert.equal(assembled.authority.payload.schema, 'shop.hosted-source-authority/v3');
  assert.deepEqual(assembled.authority.payload.operationAuthorization.commands, []);
  for (const command of ['advance', 'begin', 'rollback']) {
    const before = f.service.transcript.length, calls = f.service.brokerCalls.length;
    const result = await directCli(assembled.options, f.bootstrap.env, command);
    assert.notEqual(result.code, 0); assert.equal(f.service.transcript.length, before); assert.equal(f.service.brokerCalls.length, calls);
  }
  const original = JSON.parse(await readFile(assembled.options.authority));
  for (const mutate of [payload => { payload.operationAuthorization.commands = ['begin']; }, payload => { payload.operationAuthorization.expiresAt = payload.issuedAt - 1; }]) {
    const payload = structuredClone(original.payload); mutate(payload);
    const authority = { payload, signature: { ...original.signature, payloadDigest: digest(payload),
      signature: sign('sha256', Buffer.from(canonical(payload)), f.bootstrap.keys.source.privateKey).toString('base64') } };
    await writeFile(assembled.options.authority, canonical(authority), { mode: 0o600 });
    const before = f.service.transcript.length, calls = f.service.brokerCalls.length;
    assert.notEqual((await directCli(assembled.options, f.bootstrap.env, 'begin')).code, 0);
    assert.equal(f.service.transcript.length, before); assert.equal(f.service.brokerCalls.length, calls);
  }
});

test('partial installed begin scope stops source assembly before source or credential calls', async t => {
  const f = await createBootstrapFixture(t, { root: process.env.SHOP_BOOTSTRAP_TEST_ROOT ?? tmpdir(), operationCommands: ['begin'] });
  let calls = 0;
  await assert.rejects(assembleHostedRelease({ ...f, command: 'begin', qualityApi: async () => { calls++; throw Error('unexpected'); } }), /does not admit/);
  assert.equal(calls, 0);
});


test('malformed historical signature and changed closure fail before credential reads', async t => {
  for (const mutation of ['signature', 'closure']) await t.test(mutation, async t => {
    const output = await mkdtemp(join(proofRoot, 'historic-preflight-'));
    const f = await createWorkflowJourneyFixture(t, { output }), assembled = await assembleHostedRelease(f.bootstrap);
    const envelope = JSON.parse(await readFile(assembled.options.manifest));
    await writeFile(join(f.bootstrap.directory, 'verified-release.private.json'), canonical({ schema: 'shop.verified-workflow-release/v1',
      eventDigest: '0'.repeat(64), compositionDigest: digest(envelope.payload), options: assembled.options }), { flag: 'wx', mode: 0o600 });
    if (mutation === 'signature') {
      const authority = JSON.parse(await readFile(assembled.options.authority)); authority.signature.signature = Buffer.alloc(64).toString('base64');
      await writeFile(assembled.options.authority, canonical(authority), { mode: 0o600 });
    } else {
      const authority = JSON.parse(await readFile(assembled.options.authority)), snapshot = authority.payload.policy.snapshots[0];
      const path = join(assembled.options.bundle, snapshot.root, snapshot.files[0].path);
      await writeFile(path, Buffer.concat([await readFile(path), Buffer.from('\n')]), { mode: 0o600 });
    }
    let brokerCalls = 0;
    await assert.rejects(assembleHostedRollback({ ...f.bootstrap, rollbackDirectory: f.bootstrap.directory,
      boundaries: { broker: async () => { brokerCalls++; throw Error('Unexpected credential access'); } } }), /signature differs|Source snapshot changed/);
    assert.equal(brokerCalls, 0);
  });
});
