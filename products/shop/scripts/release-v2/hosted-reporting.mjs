import { check, digest, parseJSON, readRegularFile, same, sha256 } from './data.mjs';
import { actionsIdentity, assertInvocationOptions, readInstalledRoot, verifyAuthoritySeal } from './hosted-admission.mjs';
import { exactFields, protocolPageLimit, protocolPolicy, requestBuilders } from './provider-protocol-builders.mjs';
import { responseBytes } from './provider-protocol.mjs';
import { admitCredentialFence, createHostedWriter, credentialBrokerBoundary } from './hosted-writer.mjs';
import { createBrokerTransport, requestBrokerIdentity } from './broker-transport.mjs';
import { requestDigest } from './signing.mjs';

export function verifyReportingAuthority(envelope, { root, identity, now = Date.now() }) {
  const admitted = verifyAuthoritySeal(envelope, root), value = admitted.payload;
  exactFields(value, ['schema', 'scope', 'repository', 'repositoryName', 'environment', 'workflowPath', 'head', 'runId', 'attempt',
    'issuedAt', 'expiresAt', 'providerPolicy', 'writerFenceDigest', 'eventDigest', 'compositionDigest', 'deploymentId']);
  check(value.schema === 'shop.hosted-reporting-authority/v1' && value.scope === root.scope && value.environment === root.environment &&
    same(value.repository, root.repository) && value.repositoryName === root.repositoryName && value.workflowPath === root.workflowPath &&
    same(identity.repository, value.repository) && identity.repositoryName === value.repositoryName && identity.head === value.head &&
    identity.workflowCommit === value.head && identity.runId === value.runId && identity.attempt === value.attempt &&
    identity.workflowRef === `${root.repositoryName}/${root.workflowPath}@refs/heads/main`, 'Reporting authority invocation differs');
  check(Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt <= now && value.expiresAt > now &&
    value.expiresAt - value.issuedAt <= root.maximumLifetimeMs, 'Reporting authority expired');
  for (const field of ['writerFenceDigest', 'eventDigest', 'compositionDigest']) check(/^[a-f0-9]{64}$/.test(value[field]), 'Exact reporting subject required');
  const policy = protocolPolicy(value.providerPolicy);
  check(digest(policy) === root.providerPolicyDigest && policy.github.repository === root.repositoryName &&
    policy.github.environment === root.environment && (policy.github.reporting === 'per-release' ? value.deploymentId === null || /^[1-9][0-9]{0,19}$/.test(value.deploymentId) : policy.github.deploymentIds.includes(value.deploymentId)), 'Reporting target differs from installed policy');
  return { ...admitted, policy };
}

export async function ensureHostedDeployment({ writer, broker, policy, release, eventDigest }) {
  check(policy.github.reporting === 'per-release' && release && /^[a-f0-9]{40}$/.test(release.head) && /^[a-f0-9]{64}$/.test(release.compositionDigest), 'Exact durable release reporting subject required');
  const verified = await writer.readVerification(eventDigest); check(digest(verified.lastVerified) === release.compositionDigest, 'Deployment composition differs from immutable runtime verification');
  const builders = requestBuilders(policy), payload = { schema: 'shop.release-deployment/v1', compositionDigest: release.compositionDigest, eventDigest };
  const saved = (await writer.readProviderState()).reports.filter(item => item.kind === 'deployment' && item.eventDigest === eventDigest); check(saved.length <= 1 && (!saved[0] || same(saved[0].release, release)), 'Ambiguous durable release deployment');
  const matches = [];
  for (let page = 1; page <= protocolPageLimit; page++) {
    const response = await broker.read(builders.deploymentInventory(release.head, page)); check(response.status === 200, 'Deployment inventory read failed');
    const values = parseJSON(responseBytes(response)); check(Array.isArray(values) && values.length <= 100, 'Complete deployment inventory required');
    for (const item of values) { const subject = typeof item.payload === 'string' ? parseJSON(Buffer.from(item.payload)) : item.payload; if (item.sha === release.head && item.environment === policy.github.environment && same(subject, payload)) { check(Number.isSafeInteger(item.id) && item.id > 0, 'Exact deployment provider ID required'); matches.push(String(item.id)); } }
    check(matches.length <= 1, 'Ambiguous deployment creation acknowledgement');
    const link = response.headers.link; if (!link) { check(values.length < 100, 'Deployment continuation evidence missing'); break; }
    const next = [...link.matchAll(/<([^>]+)>; rel="next"/g)]; check(next.length <= 1, 'Ambiguous deployment continuation'); if (!next.length) break;
    check(page < protocolPageLimit && next[0][1] === builders.deploymentInventory(release.head, page + 1).url, 'Deployment continuation resource differs');
  }
  if (matches.length) {
    check(!saved[0]?.deploymentId || saved[0].deploymentId === matches[0], 'Durable deployment ID changed');
    if (!saved[0] || saved[0].status !== 'acknowledged') await writer.recordProvider(state => { const item = state.reports.find(row => row.kind === 'deployment' && row.eventDigest === eventDigest); if (item) { item.deploymentId = matches[0]; item.status = 'acknowledged'; } else state.reports.push({ kind: 'deployment', eventDigest, release, deploymentId: matches[0], status: 'acknowledged' }); });
    return matches[0];
  }
  check(!saved.length, 'Deployment acknowledgement unknown; GET-only reconciliation required');
  const request = builders.deploymentCreate({ ...release, eventDigest });
  const intent = await writer.recordProvider(state => state.reports.push({ kind: 'deployment', eventDigest, release, requestDigest: requestDigest(request), status: 'intent' }));
  const response = await writer.dispatch(request, intent); check(response.status === 201, 'Deployment acknowledgement failed; reconcile saved intent');
  const created = parseJSON(responseBytes(response)); check(Number.isSafeInteger(created.id) && created.id > 0 && created.sha === release.head && created.environment === policy.github.environment && same(created.payload, payload), 'Deployment acknowledgement subject differs');
  await writer.recordProvider(state => { const item = state.reports.find(row => row.kind === 'deployment' && row.eventDigest === eventDigest); item.deploymentId = String(created.id); item.status = 'acknowledged'; });
  return String(created.id);
}

// The protected journal is the source of runtime verification. This route reads
// no component artifact, journey proof, runtime resource or accepted-job table.
export async function reconcileHostedReport({ writer, broker, policy, authority }) {
  const builders = requestBuilders(policy), { eventDigest, compositionDigest } = authority;
  return writer.withWriter(async ({ initial, commit }) => {
    const verified = await writer.readVerification(eventDigest);
    check(digest(verified.lastVerified) === compositionDigest && verified.report?.verificationDigest === digest(verified.verification), 'Immutable reporting subject differs');
    const deploymentId = policy.github.reporting === 'per-release' ? await ensureHostedDeployment({ writer, broker, policy, release: { head: authority.head, compositionDigest }, eventDigest }) : authority.deploymentId;
    check(authority.deploymentId == null || authority.deploymentId === deploymentId, 'Reporting authority deployment differs from durable mapping');
    const request = builders.reportSuccess(deploymentId, eventDigest), requestIdentity = requestDigest(request);
    const provider = await writer.readProviderState();
    const existing = provider.reports.filter(item => item.kind !== 'deployment' && item.eventDigest === eventDigest);
    check(existing.length <= 1 && (!existing[0] || existing[0].deploymentId === undefined || existing[0].deploymentId === deploymentId), 'Ambiguous reporting intent');
    const matches = [];
    for (let page = 1; page <= protocolPageLimit; page++) {
      const response = await broker.read(builders.reportStatuses(deploymentId, page));
      check(response.status === 200, 'Reporting inventory read failed');
      const values = parseJSON(responseBytes(response));
      check(Array.isArray(values) && values.length <= 100, 'Incomplete reporting inventory');
      matches.push(...values.filter(item => item.state === 'success' && item.environment === policy.github.environment && item.description === `Verified release event ${eventDigest}`));
      check(matches.length <= 1, 'Duplicate reporting acknowledgement');
      const link = response.headers.link;
      if (!link) { check(values.length < 100, 'Reporting continuation evidence missing'); break; }
      const next = [...link.matchAll(/<([^>]+)>; rel="next"/g)];
      check(next.length <= 1, 'Ambiguous reporting continuation');
      if (!next.length) break;
      check(page < protocolPageLimit && values.length > 0 && next[0][1] === builders.reportStatuses(deploymentId, page + 1).url, 'Reporting continuation differs');
    }
    if (matches.length) {
      if (initial && digest(initial.lastVerified) === compositionDigest && same(initial.verification, verified.verification) &&
        ['runtime-verified', 'reporting-pending', 'report-intent', 'report-reconcile'].includes(initial.phase)) {
        initial.report = { ...initial.report, eventDigest, compositionDigest, status: 'confirmed' };
        initial.phase = 'complete'; initial.operation = null; await commit(initial);
      }
      return { phase: 'report-confirmed', eventDigest, compositionDigest, runtimeCalls: 0 };
    }
    if (existing.length) return { phase: 'report-held', eventDigest, compositionDigest, waiting: 'unknown-report-acknowledgement', runtimeCalls: 0 };
    const intent = await writer.recordProvider(state => state.reports.push({ eventDigest, deploymentId, requestDigest: requestIdentity,
      body: { eventId: verified.report.eventId, compositionDigest, verificationDigest: digest(verified.verification), status: 'success', eventDigest } }));
    const response = await writer.dispatch(request, intent);
    check(response.status >= 200 && response.status < 300, 'Reporting acknowledgement failed; reconcile its saved intent');
    responseBytes(response);
    return { phase: 'report-reconcile', eventDigest, compositionDigest, runtimeCalls: 0 };
  });
}

export async function hostedReporting(options, env = process.env, boundaries = {}) {
  assertInvocationOptions(options);
  env = Object.freeze({ ...env });
  const root = await readInstalledRoot(options.trustRoot, options.rootDigest);
  const envelope = parseJSON(await readRegularFile(options.authority, 1024 * 1024, true));
  const admitted = verifyReportingAuthority(envelope, { root, identity: actionsIdentity(env) });
  const fenceBytes = await readRegularFile(options.fence, 65536, true);
  check(sha256(fenceBytes) === admitted.payload.writerFenceDigest, 'Reporting custody receipt differs');
  const installed = root.credentialBroker;
  const fence = admitCredentialFence(parseJSON(fenceBytes, 65536), { keys: installed.keys, policy: admitted.policy,
    environmentId: installed.environmentId, brokerId: installed.id, implementationDigest: installed.implementationDigest });
  const transport = boundaries.broker ?? createBrokerTransport({ root,
    token: await requestBrokerIdentity({ root, env }) });
  const broker = credentialBrokerBoundary({ fenceAdmission: fence, boundary: transport });
  const writer = createHostedWriter({ policy: admitted.policy, broker, fenceAdmission: fence,
    ...(options.evidenceDirectory ? { eventCacheDirectory: join(options.evidenceDirectory, 'immutable-journal-cache') } : {}) });
  try { return await reconcileHostedReport({ writer, broker, policy: admitted.policy, authority: admitted.payload }); }
  finally { if(!boundaries.broker && typeof transport.close==='function') transport.close(); }
}
import { join } from 'node:path';
