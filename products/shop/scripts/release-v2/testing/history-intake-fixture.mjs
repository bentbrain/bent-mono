// Synthetic workflow/API records exercise transport only; they grant no cloud authority.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonical, digest, sha256 } from '../data.mjs';
import { materializePortableBundle } from '../portable-bundle.mjs';
import { packageHostedReleaseHistory } from '../retained-history.mjs';
import { createArtifactIntakeFixture } from './artifact-intake-fixture.mjs';
import { createPortableFixture } from './portable-fixture.mjs';

export async function createHistoryIntakeFixture(t, { root, sourceCommit = '1'.repeat(40), runId = 123, runAttempt = 1, artifactId = 789, ...options } = {}) {
  const identity = { repository: { ownerId: 102, repositoryId: 101 }, repositoryName: 'bentbrain/bent-mono', head: sourceCommit, workflowCommit: sourceCommit,
    workflowRef: 'bentbrain/bent-mono/.github/workflows/shop-composition-qualification.yml@refs/heads/main', runId, attempt: runAttempt };
  const lineage = { kind: 'github-actions', repository: identity.repositoryName, sourceCommit, runId: '999', runAttempt: '1',
    workflowRef: 'bentbrain/bent-mono/.github/workflows/shop-linux-journey.yml@refs/heads/main', jobId: 'journey' };
  const fixture = await createPortableFixture(t, { lineage, ...(root ? { rootDirectory: root } : {}) });
  const assembly = await materializePortableBundle(fixture.verified, join(fixture.root, 'assembly'));
  // External transport locators remain exact evidence bytes; no external protected file is imported.
  const artifactEvidence = Buffer.from(canonical({ schema: 'synthetic.artifact-evidence/v1', archive: { path: '/synthetic/external/original-actions-artifact.zip', bytes: 5, sha256: 'c'.repeat(64) } }));
  await mkdir(join(assembly.root, 'release-evidence'), { mode: 0o700 });
  await writeFile(join(assembly.root, 'release-evidence/artifact.json'), artifactEvidence, { mode: 0o600 });
  const payload = { intentSourceCommit: sourceCommit, components: [...fixture.verified.components.values()].map(item => item.component), proofRefs: [{ kind: 'artifact', receipt: { path: 'release-evidence/artifact.json', bytes: artifactEvidence.length, sha256: sha256(artifactEvidence) } }] };
  const runnerBytes = Buffer.from('export default async () => ({ syntheticHistoryRunner: true });\n');
  const runnerRef = { path: 'release-runner/journey.mjs', bytes: runnerBytes.length, sha256: sha256(runnerBytes) };
  await mkdir(join(assembly.root, 'release-runner'), { mode: 0o700 });
  await writeFile(join(assembly.root, runnerRef.path), runnerBytes, { mode: 0o600 });
  const authority = { payload: { policy: { runner: { script: runnerRef } }, head: sourceCommit, workflowCommit: sourceCommit, runId, attempt: runAttempt, repository: identity.repository,
    portableManifests: [...fixture.verified.components].map(([component]) => ({ component, manifestSha256: fixture.verified.manifestSha256, lineageDigest: digest(lineage) })) }, signature: { synthetic: true } };
  const manifest = join(assembly.root, 'release-composition.json'), authorityPath = join(assembly.root, 'release-authority.json');
  await writeFile(manifest, canonical({ payload, signature: { synthetic: true } }), { mode: 0o600 });
  await writeFile(authorityPath, canonical(authority), { mode: 0o600 });
  const originalOptions = { bundle: assembly.root, portable: fixture.verified.root, manifest, authority: authorityPath, rootDigest: 'a'.repeat(64),
    trustRoot: '/synthetic/external/root.json', targetPlan: '/synthetic/external/plan.json', fence: '/synthetic/external/fence.json' };
  const descriptor = { schema: 'shop.verified-workflow-release/v1', options: originalOptions, eventDigest: 'b'.repeat(64), compositionDigest: digest(payload) };
  const verifiedReleaseFile = join(fixture.root, 'verified-release.private.json'); await writeFile(verifiedReleaseFile, canonical(descriptor), { mode: 0o600 });
  const result = { controller: { phase: 'complete', lastVerified: payload, compositionDigest: descriptor.compositionDigest, report: { status: 'confirmed', eventDigest: descriptor.eventDigest } }, paths: originalOptions };
  const original = join(fixture.root, 'workflow-evidence'); await mkdir(original, { mode: 0o700 });
  const packaged = await packageHostedReleaseHistory({ verifiedReleaseFile, result, identity, destination: join(original, 'release-history') });
  await writeFile(join(original, 'result.private.json'), canonical(result), { mode: 0o600 });
  const intake = await createArtifactIntakeFixture(t, { portableFixture: fixture, originalDirectory: original, producer: 'composition-history', historyIdentity: identity,
    sourceCommit, runId, runAttempt, artifactId, ...options });
  return { ...intake, identity, result, originalOptions, descriptor, verifiedReleaseFile, packaged, original, authorityBytes: await readFile(authorityPath), envelopeBytes: await readFile(manifest),
    authoritySha256: sha256(await readFile(authorityPath)) };
}

/** Wrap an actually completed local default-path release in synthetic GitHub transport. */
export async function createCompletedHistoryArtifactFixture(t, { verifiedReleaseFile, result, identity, portableFixture, recipientPrivateKeyFile, workflowId, originalDirectory, artifactId = 789, jobId = 987 }) {
  await mkdir(originalDirectory, { mode: 0o700 });
  const packaged = await packageHostedReleaseHistory({ verifiedReleaseFile, result, identity, destination: join(originalDirectory, 'release-history') });
  await writeFile(join(originalDirectory, 'result.private.json'), canonical(result), { mode: 0o600 });
  const transportRoot = join(dirname(originalDirectory), `${basename(originalDirectory)}-transport`); await mkdir(transportRoot, { mode: 0o700 });
  const fixture = await createArtifactIntakeFixture(t, { portableFixture: { ...portableFixture, root: transportRoot }, originalDirectory, producer: 'composition-history', historyIdentity: identity,
    sourceCommit: identity.head, runId: identity.runId, runAttempt: identity.attempt, recipientPrivateKeyFile, workflowId, artifactId, jobId });
  return { ...fixture, packaged };
}


/** Retain exact bootstrap result bytes in synthetic original-format transport for tests. */
export async function createNativeQualificationArtifactFixture(t, { result, identity, portableFixture, recipientPrivateKeyFile, workflowId, originalDirectory, artifactId = 789, jobId = 987 }) {
  await mkdir(originalDirectory, { mode: 0o700 });
  await writeFile(join(originalDirectory, 'result.private.json'), canonical(result), { mode: 0o600 });
  const transportRoot = join(dirname(originalDirectory), `${basename(originalDirectory)}-transport`); await mkdir(transportRoot, { mode: 0o700 });
  return createArtifactIntakeFixture(t, { portableFixture: { ...portableFixture, root: transportRoot }, originalDirectory, producer: 'composition-history', historyIdentity: identity,
    sourceCommit: identity.head, runId: identity.runId, runAttempt: identity.attempt, recipientPrivateKeyFile, workflowId, artifactId, jobId });
}
