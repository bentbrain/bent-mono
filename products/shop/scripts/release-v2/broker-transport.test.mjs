import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical } from './data.mjs';
import { createBrokerTransport, requestBrokerIdentity } from './broker-transport.mjs';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';

test('OIDC client requests its installed audience once and rejects another invocation or issuer endpoint', async () => {
  const f = await authorityFixture(), time = Date.now(), seconds = Math.floor(time / 1000);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: f.payload.head, GITHUB_WORKFLOW_SHA: f.payload.head, GITHUB_WORKFLOW_REF: f.identity.workflowRef,
    GITHUB_REPOSITORY: f.root.repositoryName, GITHUB_REPOSITORY_ID: String(f.root.repository.repositoryId),
    GITHUB_REPOSITORY_OWNER_ID: String(f.root.repository.ownerId), GITHUB_RUN_ID: String(f.payload.runId), GITHUB_RUN_ATTEMPT: String(f.payload.attempt),
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.actions.githubusercontent.com/identity?api-version=2', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: f.root.credentialBroker.audience, sub: f.root.credentialBroker.subject,
    repository: f.root.repositoryName, repository_id: String(f.root.repository.repositoryId), repository_owner_id: String(f.root.repository.ownerId),
    sha: f.payload.head, workflow_ref: f.identity.workflowRef, run_id: String(f.payload.runId), run_attempt: String(f.payload.attempt), nbf: seconds - 1, exp: seconds + 300 };
  const encode = value => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(canonical(value)).toString('base64url')}.signature`;
  const calls = [];
  const request = async (...args) => { calls.push(args); return { value: encode(claims) }; };
  assert.equal(await requestBrokerIdentity({ root: f.root, env, request, now: time }), encode(claims));
  assert.equal(calls.length, 1); assert.equal(calls[0][0].searchParams.get('audience'), f.root.credentialBroker.audience);
  assert.equal(calls[0][1], 'GET');
  for (const change of [{ run_attempt: '2' }, { aud: 'other' }, { sub: 'other' }, { exp: seconds }, { sha: 'f'.repeat(40) }]) {
    await assert.rejects(requestBrokerIdentity({ root: f.root, env, now: time, request: async () => ({ value: encode({ ...claims, ...change }) }) }));
  }
  const before = calls.length;
  await assert.rejects(requestBrokerIdentity({ root: f.root, env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.invalid/identity' }, request, now: time }));
  assert.equal(calls.length, before);
  const transport = createBrokerTransport({ root: f.root, token: encode(claims), request: async (...args) => { calls.push(args); throw Error('lost acknowledgement'); } });
  await assert.rejects(transport({ action: 'dispatch' }), /lost acknowledgement/);
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)[0].href, `${f.root.credentialBroker.origin}/v1/invocations`);
});

test('one root-scoped client renews its short-lived identity, retains its TLS agent and closes without another send', async () => {
  const f = await authorityFixture(); let at = Date.now(), renewals = 0; const calls = [];
  const token = () => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(canonical({ exp: Math.floor(at / 1000) + 120 })).toString('base64url')}.signature`;
  const transport = createBrokerTransport({ root: f.root, now: () => at, tokenProvider: async () => { renewals++; return token(); },
    request: async (...args) => { calls.push(args); return { accepted: true }; } });
  await transport({ action: 'read' }); await transport({ action: 'read' });
  assert.equal(renewals, 1); assert.equal(calls[0][5], calls[1][5]); assert.equal(calls[0][5].keepAlive, true);
  at += 100000; await transport({ action: 'read' }); assert.equal(renewals, 2); assert.notEqual(calls[0][2], calls[2][2]);
  assert.deepEqual(transport.measurements(), { requests: 3, sockets: 0, reusedSockets: 0, tlsHandshakes: 0 });
  transport.close(); await assert.rejects(transport({ action: 'read' }), /closed/); assert.equal(calls.length, 3);
});
