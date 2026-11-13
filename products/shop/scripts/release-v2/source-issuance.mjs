import { sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { requireReleaseChecks } from '../../../../scripts/require-release-checks.mjs';
import { canonical, check, digest, parseJSON, pathName, readRef, readRegularFile, same, sha256 } from './data.mjs';
import { activationOrder, admitComposition, allInputs, conforms, subject } from './composition.mjs';
import { verifyHostedAuthority } from './hosted-admission.mjs';
import { materializePortableBundle, verifyPortableBundle } from './portable-bundle.mjs';
import { assertHostedPortableImport } from './artifact-intake.mjs';
import { assertProtectedInstallation, installedSigningKey, refreshProtectedInstallation } from './protected-installation.mjs';
import { admitCredentialFence, createHostedWriter, credentialBrokerBoundary } from './hosted-writer.mjs';
import { preflightHostedTargets, retainedCandidateLoader } from './hosted-provider.mjs';
import { createBrokerTransport, requestBrokerIdentity } from './broker-transport.mjs';

const guardPath = new URL('../../../../scripts/require-release-checks.mjs', import.meta.url);
const prefix = '/repos/bentbrain/bent-mono';
const sourceAdmissions = new WeakMap(), assemblies = new WeakMap();
const validTime = (value, label) => check(Number.isSafeInteger(value) && value > 0, `Exact ${label} time required`);
const clone = value => structuredClone(value);
const deliveryTiming = (acceptedAt, observedAt, budgetMs) => ({ acceptedAt, observedAt, elapsedMs: observedAt - acceptedAt, budgetMs,
  exceeded: observedAt - acceptedAt >= budgetMs, productionDeliveryMeasured: false });

function identityMatches(root, identity) {
  check(identity && same(identity.repository, root.repository) && identity.repositoryName === root.repositoryName &&
    identity.workflowCommit === identity.head && identity.workflowRef === `${root.repositoryName}/${root.workflowPath}@refs/heads/main` &&
    /^[a-f0-9]{40}$/.test(identity.head) && Number.isSafeInteger(identity.runId) && identity.runId > 0 &&
    Number.isSafeInteger(identity.attempt) && identity.attempt > 0, 'Source issuance invocation differs from installation');
}

/** Retain the actual canonical release guard result and its read-only evidence. */
export async function qualifyHostedSource({ installation, identity, qualityApi, acceptedAt, now = Date.now }) {
  assertProtectedInstallation(installation);
  check(typeof qualityApi === 'function' && typeof now === 'function', 'Explicit authenticated source API and clock required');
  const started = now(); validTime(started, 'source qualification');
  const current = await refreshProtectedInstallation(installation, started), { root, template } = current;
  identityMatches(root, identity);
  const transcript = []; let transcriptBytes = 0;
  const read = async path => {
    check(typeof path === 'string' && (path === prefix || path.startsWith(`${prefix}/`)) && path.length <= 2048 && !/[\x00-\x20\x7f#]/.test(path) && transcript.length < 512,
      'Bounded canonical read-only source API path required');
    const bytes = Buffer.from(canonical(await qualityApi(path)));
    transcriptBytes += bytes.length;
    check(bytes.length <= 16 * 1024 * 1024 && transcriptBytes <= 32 * 1024 * 1024, 'Bounded source API response and aggregate transcript required');
    const captured = parseJSON(bytes, 16 * 1024 * 1024); transcript.push({ path, response: captured }); return clone(captured);
  };
  const repository = await read(prefix);
  check(repository.id === root.repository.repositoryId && repository.owner?.id === root.repository.ownerId && repository.full_name === root.repositoryName,
    'Canonical repository immutable identity differs');
  const commit = await read(`${prefix}/git/commits/${identity.head}`);
  check(commit.sha === identity.head && /^[a-f0-9]{40}$/.test(commit.tree?.sha ?? '') && Array.isArray(commit.parents) &&
    commit.parents.length > 0 && /^[a-f0-9]{40}$/.test(commit.parents[0].sha), 'Canonical source tree or base differs');
  const workflow = await read(`${prefix}/actions/workflows/${root.workflowPath.split('/').at(-1)}`);
  check(workflow.path === root.workflowPath && workflow.state === 'active' && Number.isSafeInteger(workflow.id) && workflow.id > 0,
    'Canonical executing workflow differs');
  const verifyInvocation = run => check(run.id === identity.runId && run.run_attempt === identity.attempt && run.workflow_id === workflow.id &&
    run.head_sha === identity.head && run.head_branch === 'main' && run.event === 'workflow_dispatch' && run.path === root.workflowPath &&
    run.repository?.id === root.repository.repositoryId && run.head_repository?.id === root.repository.repositoryId &&
    run.repository?.full_name === root.repositoryName && run.head_repository?.full_name === root.repositoryName &&
    ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status), 'Canonical current source invocation differs');
  const runPath = `${prefix}/actions/runs/${identity.runId}`;
  verifyInvocation(await read(runPath));
  await refreshProtectedInstallation(current, now());
  const admittedGuardDigest = sha256(await readFile(guardPath));
  const quality = await requireReleaseChecks(identity.head, read);
  verifyInvocation(await read(runPath));
  const pull = transcript.flatMap(item => item.path.startsWith(`${prefix}/commits/${identity.head}/pulls?`) ? item.response : [])
    .find(item => item.number === quality.pullRequest);
  const originalAcceptedAt = Date.parse(pull?.merged_at);
  validTime(originalAcceptedAt, 'canonical source acceptance');
  check(acceptedAt === undefined || acceptedAt === originalAcceptedAt, 'Accepted source time differs from canonical merged pull request');
  const completedAt = now(); validTime(completedAt, 'source qualification');
  check(completedAt >= started && originalAcceptedAt <= started, 'Canonical source acceptance or qualification clock differs');
  const guardImplementationSha256 = sha256(await readFile(guardPath));
  check(guardImplementationSha256 === admittedGuardDigest, 'Canonical source guard implementation changed during qualification');
  const evidence = { schema: 'shop.source-issuance-evidence/v1', repository: root.repository, source: identity.head,
    acceptedAt: originalAcceptedAt, startedAt: started, completedAt, guardImplementationSha256,
    timing: deliveryTiming(originalAcceptedAt, completedAt, template.budgetMs), result: quality, transcript: clone(transcript) };
  const admission = { identity: clone(identity), base: commit.parents[0].sha, tree: commit.tree.sha, quality, acceptedAt: originalAcceptedAt, evidence };
  sourceAdmissions.set(admission, { admissionDigest: digest(admission), installationDigest: digest(current.contract), read, verifyInvocation, runPath, identityDigest: digest(identity) });
  return admission;
}

function assertSource(admission, installation, identity) {
  const state = sourceAdmissions.get(admission);
  check(state && state.admissionDigest === digest(admission) && state.installationDigest === digest(installation.contract) && state.identityDigest === digest(identity), 'Actual exact-source release qualification required');
  return state;
}

async function put(root, path, value) {
  pathName(path); const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value));
  await mkdir(dirname(join(root, path)), { mode: 0o700, recursive: true });
  await writeFile(join(root, path), bytes, { mode: 0o600, flag: 'wx' });
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

function sourcePolicy(installation, portable, source) {
  const { contracts, dependencies, schemaState, ...template } = clone(installation.template);
  check(portable.manifest.originSourceCommit === source.identity.head, 'Portable intent differs from accepted canonical source');
  check(same(portable.closurePolicy, template.closurePolicy), 'Portable runtime or reviewed source closure policy differs');
  const policy = { ...template, schema: 'shop.hosted-composition-policy/v1', intentCommits: [source.identity.head], baseCommit: source.base,
    inputPaths: [...new Set([...portable.snapshots.values()].flatMap(snapshot => snapshot.files.map(file => file.path)))].sort(),
    snapshots: [...portable.snapshots.values()].map(snapshot => ({ commit: snapshot.originSourceCommit, root: snapshot.root,
      files: snapshot.files, treeDigest: snapshot.treeDigest })) };
  conforms(policy, 'hostedTrust'); return policy;
}

async function installedBaseline({ installation, payload, bundle, command, env, boundaries, now, evidenceDirectory }) {
  check(['plan', 'advance', 'begin'].includes(command), 'Historical rollback requires its separately admitted verified composition');
  if (command === 'plan') return { observed: false, parentCompositionDigest: null, rollbackCompositionDigest: null };
  // Validate all retained target bytes before obtaining even a read-only broker identity.
  await preflightHostedTargets({ policy: installation.providerPolicy, components: payload.components, targets: installation.plan.targets,
    load: retainedCandidateLoader({ bundle, targets: installation.plan.targets }) });
  const fenceBytes = await readRegularFile(installation.fencePath, 65536, true);
  check(sha256(fenceBytes) === installation.fenceDigest, 'Installed baseline credential fence bytes differ');
  const fence = admitCredentialFence(parseJSON(fenceBytes), {
    keys: installation.root.credentialBroker.keys, policy: installation.providerPolicy, environmentId: installation.root.credentialBroker.environmentId,
    brokerId: installation.root.credentialBroker.id, implementationDigest: installation.root.credentialBroker.implementationDigest, now: now() });
  const boundary = boundaries.broker ?? createBrokerTransport({ root: installation.root,
    token: await requestBrokerIdentity({ root: installation.root, env }) });
  const broker = credentialBrokerBoundary({ fenceAdmission: fence, boundary, now });
  const writer = createHostedWriter({ policy: installation.providerPolicy, broker, fenceAdmission: fence,
    eventCacheDirectory: join(evidenceDirectory, 'immutable-journal-cache') });
  const observed = await writer.readHead();
  if (!observed) return { observed: true, head: null, parentCompositionDigest: null, rollbackCompositionDigest: null };
  const state = observed.state, context = `protected-policy:${digest(installation.providerPolicy)}`;
  check(state.schema === 'shop.hosted-release/v1' && state.providerOrigin === context && state.phase === 'complete' && state.operation === null &&
    state.lastVerified && state.desired && same(state.lastVerified, state.desired) && digest(state.lastVerified) === state.compositionDigest &&
    state.policyDigest === state.lastVerified.policyDigest && state.report?.status === 'confirmed' && state.verification &&
    state.verification.schema === 'shop.hosted-verification/v1' && state.verification.scope === installation.root.scope &&
    state.verification.compositionDigest === state.compositionDigest && state.report.verificationDigest === digest(state.verification) &&
    Array.isArray(state.history) && state.history.some(item => same(item, state.lastVerified)), 'Existing protected release has unresolved or invalid verified state');
  conforms(state.lastVerified, 'hostedPayload');
  check(same(state.lastVerified.repository, installation.root.repository) && command === 'begin', 'Use begin for a subsequent verified release');
  const verified = await writer.readVerification(state.report.eventDigest);
  check(same(verified.lastVerified, state.lastVerified) && same(verified.verification, state.verification), 'Protected baseline lacks its exact immutable runtime verification');
  const final = await writer.readHead();
  check(same(final, observed), 'Protected baseline changed before composition signing');
  return { observed: true, head: observed.head, verificationEventDigest: state.report.eventDigest,
    parentCompositionDigest: digest(state.lastVerified), rollbackCompositionDigest: digest(state.lastVerified) };
}

/** This signer accepts the exact payload prepared by the authenticated assembler. */
async function signInstalledComposition({ installation, payload, sourceAdmission, identity, now = Date.now() }) {
  assertProtectedInstallation(installation); assertSource(sourceAdmission, installation, identity);
  const prepared = assemblies.get(payload);
  check(prepared && prepared.installationDigest === digest(installation.contract) && prepared.payloadDigest === digest(payload), 'Authenticated composition assembly required before signing');
  conforms(payload, 'hostedPayload');
  const current = await refreshProtectedInstallation(installation, now);
  assertSource(sourceAdmission, current, identity);
  check(prepared.payloadDigest === digest(payload), 'Composition changed during signing admission');
  const key = await installedSigningKey(current, 'composition');
  return { payload, signature: { payloadType: payload.schema, payloadDigest: digest(payload), keyId: key.keyId,
    algorithm: 'ECDSA_SHA_256', signer: 'protected-ci', signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
}

/** Issue existing-schema authority from an admitted assembly and actual guard result. */
export async function issueHostedAuthority({ installation, identity, imported, composition, sourceAdmission, qualityApi, acceptedAt, now = Date.now }) {
  assertProtectedInstallation(installation); check(typeof now === 'function', 'Explicit source issuance clock required');
  const source = sourceAdmission ?? await qualifyHostedSource({ installation, identity, qualityApi, acceptedAt, now });
  const state = assertSource(source, installation, identity);
  const retainedImport = await assertHostedPortableImport(imported, { installation: installation.artifactIntake, sourceCommit: identity.head });
  const current = await refreshProtectedInstallation(installation, now(), [retainedImport.portable.root, dirname(retainedImport.evidence.path), composition.bundle]), { root } = current;
  identityMatches(root, identity);
  const retained = await verifyPortableBundle(retainedImport.portable.root, retainedImport.portable.expected);
  const envelope = parseJSON(await readRegularFile(composition.manifest, 16 * 1024 * 1024, true), 16 * 1024 * 1024);
  const policy = sourcePolicy(current, retained, source);
  check(envelope.payload.intentSourceCommit === identity.head && envelope.payload.policyDigest === digest(policy), 'Composition source or installed policy differs');
  const admission = await admitComposition({ ...composition, trust: policy, domain: root.scope });
  const portableManifests = [];
  for (const component of admission.payload.components) {
    const original = retained.components.get(component.id), config = current.contract.componentConfigurations.find(item => item.component === component.id);
    check(original && config && same(component.artifact, original.artifactRef) && same(component.provenance, original.provenanceRef) &&
      component.codeDigest === original.artifact.codeDigest && component.config.sha256 === config.config.sha256 &&
      component.originSourceCommit === original.component.originSourceCommit && same(component.contract, current.template.contracts[component.id]),
    'Authority component differs from retained source or protected installation');
    const qualifications = [];
    for (const reference of component.componentProofs) if (parseJSON(await readRef(composition.bundle, reference)).kind === 'qualification') qualifications.push(reference.sha256);
    check(qualifications.length === 1, 'Exact authenticated source qualification required');
    portableManifests.push({ component: component.id, manifestSha256: retained.manifestSha256, originSourceCommit: component.originSourceCommit,
      lineageDigest: digest(retained.lineage), codeDigest: component.codeDigest, configDigest: component.config.sha256,
      runtimeDigest: original.artifact.runtimeDigest, qualificationDigest: qualifications[0], awsImageQualified: false });
  }
  state.verifyInvocation(await state.read(state.runPath));
  check((await state.read(`${prefix}/git/ref/heads/main`)).object?.sha === identity.head, 'Canonical source changed before authority signing');
  const issuedAt = now(); validTime(issuedAt, 'source issuance');
  check(issuedAt >= source.evidence.completedAt, 'Source issuance clock moved backwards');
  const final = await refreshProtectedInstallation(current, issuedAt);
  check(same(final.contract, current.contract), 'Protected installation changed during issuance');
  assertSource(source, final, identity);
  const evidence = { ...clone(source.evidence), timing: deliveryTiming(source.acceptedAt, issuedAt, policy.budgetMs) };
  const payload = { schema: 'shop.hosted-source-authority/v1', scope: root.scope, repository: root.repository, repositoryName: root.repositoryName,
    environment: root.environment, head: identity.head, base: source.base, tree: source.tree, workflowPath: root.workflowPath,
    workflowCommit: identity.workflowCommit, runId: identity.runId, attempt: identity.attempt, issuedAt,
    expiresAt: issuedAt + root.maximumLifetimeMs, acceptedAt: source.acceptedAt, policy,
    providerPolicyDigest: root.providerPolicyDigest, targetPlanDigest: current.contract.targetPlan.sha256, writerFenceDigest: current.fenceDigest,
    portableManifests, secretInstallations: current.secretInstallations,
    quality: { head: identity.head, runId: source.quality.qualityRunId, attempt: source.quality.qualityAttempt, releaseGuardDigest: digest(evidence) } };
  const key = await installedSigningKey(final, 'source');
  const authority = { payload, signature: { algorithm: 'ECDSA_SHA_256', keyId: key.keyId, payloadDigest: digest(payload),
    signature: sign('sha256', Buffer.from(canonical(payload)), key.privateKey).toString('base64') } };
  verifyHostedAuthority(authority, { root: final.root, identity, now: issuedAt });
  return { authority, evidence, quality: source.quality, acceptedAt: source.acceptedAt };
}

/** Assemble existing retained bytes and derive fresh proofs from authenticated evidence. */
export async function assembleHostedRelease({ installation, identity, imported, destination, evidenceDirectory, qualityApi, acceptedAt,
  command = 'plan', env = process.env, boundaries = {}, now = Date.now }) {
  assertProtectedInstallation(installation); check(typeof now === 'function', 'Explicit assembly clock required');
  const authenticated = await assertHostedPortableImport(imported, { installation: installation.artifactIntake, sourceCommit: identity.head }), portable = authenticated.portable;
  const current = await refreshProtectedInstallation(installation, now(), [portable.root, dirname(authenticated.evidence.path), resolve(destination)]); identityMatches(current.root, identity);
  const source = await qualifyHostedSource({ installation: current, identity, qualityApi, acceptedAt, now });
  const policy = sourcePolicy(current, portable, source);
  const root = resolve(destination), assembly = await materializePortableBundle(portable, root);
  const sourceRef = await put(root, 'release-evidence/source.json', source.evidence);
  const artifactRef = await put(root, 'release-evidence/artifact.json', authenticated.evidence);
  const installationRef = await put(root, 'release-evidence/installation.json', { schema: 'shop.installed-release-evidence/v1',
    installationDigest: digest(current.contract), rootDigest: current.rootDigest, targetPlanDigest: current.contract.targetPlan.sha256,
    writerFenceDigest: current.fenceDigest, secretInstallations: current.secretInstallations });
  const runnerBytes = await readRegularFile(current.contract.runnerFile.path, 16 * 1024 * 1024, true);
  check(sha256(runnerBytes) === policy.runner.script.sha256, 'Installed runner changed before assembly');
  await put(root, policy.runner.script.path, runnerBytes);
  const createdAt = now(), payload = { schema: 'shop.release-composition/v2', repository: current.root.repository, target: current.root.scope,
    intentSourceCommit: identity.head, baseCommit: source.base, createdAt: new Date(createdAt).toISOString(), policyDigest: digest(policy),
    parentCompositionDigest: null, rollbackCompositionDigest: null, changeClass: 'compatible', schemaState: clone(current.template.schemaState),
    components: [], dependencies: clone(current.template.dependencies), proofRefs: [] };
  for (const importedComponent of assembly.components.values()) {
    const component = { ...clone(importedComponent.component), contract: clone(current.template.contracts[importedComponent.component.id]), componentProofs: [] };
    check(component.inputsDigest === component.intentInputsDigest && component.proofInputsDigest === component.intentProofInputsDigest,
      'Changed component source, dependency or proof requires fresh qualification before signing');
    const installedConfig = current.contract.componentConfigurations.find(item => item.component === component.id);
    const configBytes = await readRegularFile(installedConfig.config.path, 16 * 1024 * 1024, true);
    check(sha256(configBytes) === installedConfig.config.sha256, 'Installed component configuration changed');
    component.config = await put(root, `release-bindings/${component.id}.json`, configBytes);
    payload.components.push(component);
  }
  // Validate the complete unsigned component subjects before reading a signing key.
  conforms({ ...payload, components: payload.components.map(component => ({ ...component, componentProofs: [sourceRef, artifactRef] })),
    proofRefs: policy.requiredProofKinds.map(kind => ({ kind, receipt: sourceRef })) }, 'hostedPayload');
  activationOrder(payload);
  await installedSigningKey(current, 'source');
  const key = await installedSigningKey(current, 'composition');
  const baseline = await installedBaseline({ installation: current, payload, bundle: root, command, env, boundaries, now, evidenceDirectory });
  payload.parentCompositionDigest = baseline.parentCompositionDigest; payload.rollbackCompositionDigest = baseline.rollbackCompositionDigest;
  const baselineRef = await put(root, 'release-evidence/baseline.json', baseline);
  for (const component of payload.components) {
    const importedComponent = assembly.components.get(component.id);
    for (const kind of ['artifact', 'qualification']) {
      const evidence = await put(root, `release-evidence/${component.id}-${kind}.json`, { schema: 'shop.retained-source-proof-evidence/v1', kind,
        source: sourceRef, artifact: artifactRef, installation: installationRef, baseline: baselineRef, component: component.id, codeDigest: component.codeDigest,
        runtimeDigest: importedComponent.artifact.runtimeDigest, awsImageQualified: false });
      const proof = { schema: 'shop.component-proof/v1', scope: current.root.scope, kind, component: component.id,
        originSourceCommit: component.originSourceCommit, codeDigest: component.codeDigest, inputsDigest: component.inputsDigest,
        proofInputsDigest: component.proofInputsDigest, runtimeDigest: importedComponent.artifact.runtimeDigest,
        bindingDigest: kind === 'qualification' ? component.config.sha256 : null, policyDigest: digest(policy.closurePolicy),
        verifierDigest: policy.implementationDigest, createdAt, expiresAt: createdAt + current.root.maximumLifetimeMs, evidence };
      component.componentProofs.push(await put(root, `release-proofs/${component.id}-${kind}.json`, { ...proof,
        signature: sign('sha256', Buffer.from(canonical(proof)), key.privateKey).toString('base64') }));
    }
  }
  for (const kind of [...policy.requiredProofKinds].sort()) {
    const receipt = await put(root, `release-proofs/composition-${kind}.json`, { schema: 'shop.hosted-receipt/v1', scope: current.root.scope, kind,
      subjectDigest: subject(payload), inputsDigest: allInputs(payload), policyDigest: payload.policyDigest, verifierDigest: policy.implementationDigest,
      evidence: kind === 'artifact' || kind === 'qualification' ? artifactRef : kind === 'owner' ? installationRef : sourceRef });
    payload.proofRefs.push({ kind, receipt });
  }
  assemblies.set(payload, { installationDigest: digest(current.contract), payloadDigest: digest(payload) });
  const envelope = await signInstalledComposition({ installation: current, payload, sourceAdmission: source, identity, now: now() });
  const manifest = join(root, 'release-composition.json'); await writeFile(manifest, canonical(envelope), { mode: 0o600, flag: 'wx' });
  const issued = await issueHostedAuthority({ installation: current, identity, imported, composition: { bundle: root, manifest }, sourceAdmission: source, now });
  const authority = join(root, 'release-authority.json'); await writeFile(authority, canonical(issued.authority), { mode: 0o600, flag: 'wx' });
  await put(root, 'release-evidence/authority-issuance.json', issued.evidence);
  return { options: { bundle: root, portable: portable.root, manifest, authority, trustRoot: current.rootPath, rootDigest: current.rootDigest,
    targetPlan: current.planPath, fence: current.fencePath, evidenceDirectory }, ...issued,
    baseline, readiness: { operationalApproval: false, awsImageQualified: false, realProviderQualificationRequired: true, providerWrites: 0,
      baselineObserved: baseline.observed, timing: issued.evidence.timing } };
}
