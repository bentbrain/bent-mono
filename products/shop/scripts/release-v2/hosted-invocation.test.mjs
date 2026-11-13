import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonical, digest, sha256 } from './data.mjs';
import { allInputs, implementationDigest, subject } from './composition.mjs';
import { materializePortableBundle } from './portable-bundle.mjs';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';
import { createPortableFixture } from './testing/portable-fixture.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { protocolPolicy } from './provider-protocol-builders.mjs';
import { admitHostedInvocation, hostedController } from './hosted-controller.mjs';

test('actual hosted admission verifies root, signed authority, full portable assembly and component proofs before credentials', async t => {
  const f = await authorityFixture(), head = '1'.repeat(40);
  const portable = await createPortableFixture(t, { lineage: { kind: 'github-actions', repository: 'bentbrain/bent-mono', sourceCommit: head,
    runId: '10', runAttempt: '1', workflowRef: 'bentbrain/bent-mono/.github/workflows/shop-linux-journey.yml@refs/heads/main', jobId: 'journey' } });
  const rootDirectory = await realpath(portable.root), assembly = await materializePortableBundle(portable.verified, join(rootDirectory, 'assembly'));
  const put = async (path, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value));
    await mkdir(dirname(join(assembly.root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(assembly.root, path), bytes, { mode: 0o600 });
    return { path, bytes: bytes.length, sha256: sha256(bytes) };
  };
  const oldRunner = await readFile(join(f.bundle, f.trust.runner.script.path));
  const runner = await put('runner/qualification.mjs', oldRunner);
  const policy = { ...f.trust, schema: 'shop.hosted-composition-policy/v1', scope: 'isolated-qualification',
    intentCommits: [head], implementationDigest: await implementationDigest(), closurePolicy: assembly.closurePolicy,
    inputPaths: assembly.sourceInventory.files.map(file => file.path), snapshots: [...assembly.snapshots.values()].map(snapshot => ({
      commit: snapshot.originSourceCommit, root: snapshot.root, files: snapshot.files, treeDigest: snapshot.treeDigest })),
    runner: { ...f.trust.runner, script: runner, origins: ['https://qualification.example.invalid'] }, revokedReceipts: [] };
  const payload = { ...f.fixturePayload, schema: 'shop.release-composition/v2', target: 'isolated-qualification', intentSourceCommit: head,
    policyDigest: digest(policy), components: [], dependencies: [], proofRefs: [] };
  for (const imported of assembly.components.values()) {
    const component = { ...imported.component, contract: structuredClone(f.fixturePayload.components[0].contract), componentProofs: [] };
    component.config = await put(`bindings/${component.id}.json`, { schema: 'shop.binding-installation/v1', scope: 'isolated-qualification', component: component.id, bindings: [] });
    for (const kind of ['artifact', 'qualification']) {
      const evidence = await put(`evidence/${component.id}-${kind}.json`, { scope: 'synthetic-hosted-admission-test', kind });
      const receipt = f.signComponentProof({ schema: 'shop.component-proof/v1', scope: 'isolated-qualification', kind, component: component.id,
        originSourceCommit: component.originSourceCommit, codeDigest: component.codeDigest, inputsDigest: component.inputsDigest,
        proofInputsDigest: component.proofInputsDigest, runtimeDigest: imported.artifact.runtimeDigest, bindingDigest: kind === 'qualification' ? component.config.sha256 : null,
        policyDigest: digest(policy.closurePolicy), verifierDigest: policy.implementationDigest, createdAt: Date.now(), expiresAt: Date.now() + 600000, evidence });
      component.componentProofs.push(await put(`proofs/${component.id}-${kind}.json`, receipt));
    }
    payload.components.push(component);
  }
  for (const kind of policy.requiredProofKinds) {
    const evidence = await put(`evidence/composition-${kind}.json`, { scope: 'synthetic-hosted-admission-test', kind });
    const receipt = await put(`proofs/composition-${kind}.json`, { schema: 'shop.hosted-receipt/v1', scope: 'isolated-qualification', kind,
      subjectDigest: subject(payload), inputsDigest: allInputs(payload), policyDigest: payload.policyDigest, verifierDigest: policy.implementationDigest, evidence });
    payload.proofRefs.push({ kind, receipt });
  }
  payload.proofRefs.sort((a, b) => a.kind.localeCompare(b.kind));
  const originalManifest = await f.signManifest(payload), envelope = JSON.parse(await readFile(originalManifest));
  envelope.signature.signer = 'protected-ci';
  const manifest = join(rootDirectory, 'composition.json'); await writeFile(manifest, canonical(envelope), { mode: 0o600 });
  const original = protocolFixture().policy;
  const providerPolicy = protocolPolicy({ ...original, github: { ...original.github, repository: 'bentbrain/bent-mono', environment: 'Preview' } });
  const root = { ...f.root, repositoryName: 'bentbrain/bent-mono', providerPolicyDigest: digest(providerPolicy), requiredSecrets: [] };
  const plan = { schema: 'shop.hosted-target-plan/v1', scope: 'isolated-qualification', providerPolicy, targets: ['business', 'native', 'storefront'].map(component => ({
    component, kind: component === 'native' ? 'lambda' : 'worker' })), deploymentId: providerPolicy.github.deploymentIds[0], journeyOrigin: policy.runner.origins[0] };
  const targetPlan = join(rootDirectory, 'targets.json'); await writeFile(targetPlan, canonical(plan), { mode: 0o600 });
  const signedPayload = { ...f.payload };
  // The independent source key binds this exact synthetic invocation.
  Object.assign(signedPayload, { head, workflowCommit: head, repositoryName: root.repositoryName, policy, secretInstallations: [],
    providerPolicyDigest: root.providerPolicyDigest, targetPlanDigest: digest(plan), quality: { ...f.payload.quality, head },
    portableManifests: payload.components.map(component => ({ component: component.id, manifestSha256: portable.verified.manifestSha256,
      originSourceCommit: component.originSourceCommit, lineageDigest: digest(portable.verified.lineage), codeDigest: component.codeDigest,
      configDigest: component.config.sha256, runtimeDigest: assembly.components.get(component.id).artifact.runtimeDigest,
      qualificationDigest: component.componentProofs[1].sha256, awsImageQualified: false })) });
  const authorityPath = join(rootDirectory, 'authority.json'), rootPath = join(rootDirectory, 'root.json');
  await writeFile(authorityPath, canonical(f.seal(signedPayload)), { mode: 0o600 }); await writeFile(rootPath, canonical(root), { mode: 0o600 });
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: head, GITHUB_WORKFLOW_SHA: head,
    GITHUB_REPOSITORY: root.repositoryName, GITHUB_REPOSITORY_ID: String(root.repository.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(root.repository.ownerId),
    GITHUB_RUN_ID: String(signedPayload.runId), GITHUB_RUN_ATTEMPT: String(signedPayload.attempt), GITHUB_WORKFLOW_REF: `${root.repositoryName}/${root.workflowPath}@refs/heads/main` };
  const options = { bundle: assembly.root, portable: portable.verified.root, manifest, authority: authorityPath, trustRoot: rootPath, rootDigest: digest(root), targetPlan, env };
  assert.equal((await admitHostedInvocation(options)).admission.payload.components.length, 3);
  assert.equal((await hostedController({ ...options, command: 'plan' })).readiness.awsImageQualified, false);
});
