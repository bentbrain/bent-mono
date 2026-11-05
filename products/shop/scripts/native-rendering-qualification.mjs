import { protectedConfig } from "./protected-config.mjs";
import { isDeepStrictEqual as equal } from 'node:util';
import { renderingInputManifest, rendererConfigurationDigest, rendererQualificationReusable, shippingOnlyPaths, commerceOnlyPaths, commerceBoundary } from './rendering-inputs.mjs';
import { inspectDevelopmentRuntime } from './native-ci-runtime.mjs';
import { verifyDevelopmentQualification } from './native-production-qualification.mjs';
import { readQualificationRun, rendererReference } from './native-qualification-reference.mjs';
import { gitChanges } from './deployment-plan.mjs';
const check = (value, reason) => { if (!value)
    throw Error(`Renderer qualification reuse unavailable: ${reason}`); };
async function configurationDigest(cf, identity, env) {
    const version = await cf.version(identity.workerVersionId);
    check(version.id === identity.workerVersionId && version.resources?.script_runtime && Array.isArray(version.resources.bindings), 'immutable Worker configuration');
    const { script, bindings, ...runtimeConfiguration } = version.resources;
    void script;
    return rendererConfigurationDigest({ ...runtimeConfiguration, ...runtimeConfiguration.script_runtime, bindings }, await inspectDevelopmentRuntime(env));
}
export async function captureRendererEvidence(env, cf, store, identity) {
    const manifest = renderingInputManifest(env.GITHUB_SHA);
    if (!manifest || identity.sourceCommit !== env.GITHUB_SHA)
        return null;
    const inputs = await store.save('qualification-rendering-inputs.json', Buffer.from(JSON.stringify(manifest)));
    return { schemaVersion: 1, inputs, inputsDigest: manifest.inputsDigest, nodeVersion: manifest.nodeVersion, boundary: manifest.boundary,
        configurationDigest: await configurationDigest(cf, identity, env) };
}
export async function verifyReusableRenderer({ value, env, cf, store, identity }) {
    const { reference, releaseId, runId } = rendererReference(value);
    const record = JSON.parse(await store.read(reference));
    check(record.expectedPair?.releaseId === releaseId && record.expectedPair.imageDigest === identity.imageDigest, 'same original renderer image');
    const githubRun = await readQualificationRun(env, runId);
    const verified = await verifyDevelopmentQualification({ reference, expectedPair: record.expectedPair, expectedQualificationCommit: githubRun.head_sha,
        githubRun, readObject: store.read, readRun: id => readQualificationRun(env, id) }, false);
    check(verified.qualificationKind === 'full' && verified.rendererEvidence?.schemaVersion === 1, 'full immutable renderer qualification with input evidence');
    const boundary = verified.rendererEvidence.boundary ?? 'isolated-printify-webhooks-v1';
    check((boundary === commerceBoundary ? commerceOnlyPaths : shippingOnlyPaths)(gitChanges(verified.sourceCommit, env.GITHUB_SHA)), 'only isolated fulfilment contracts, shipping, test or metadata changes');
    const evidence = verified.rendererEvidence;
    check(evidence.inputs.key === "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-rendering-inputs-" + (releaseId) + "-run-" + (verified.functionalRunId ?? runId) + ".json", 'original input manifest namespace');
    const before = JSON.parse(await store.read(evidence.inputs)), recomputed = renderingInputManifest(verified.sourceCommit, { boundary }), after = renderingInputManifest(env.GITHUB_SHA, { boundary });
    check(equal(before, recomputed) && rendererQualificationReusable(before, after), 'complete source, transitive dependencies, policy and toolchain match');
    const current = await configurationDigest(cf, identity, env);
    check(current === evidence.configurationDigest, 'live bindings or renderer runtime drift');
    return { schemaVersion: 1, boundary, reference, expectedPair: record.expectedPair, qualificationRunId: runId,
        expectedQualificationCommit: githubRun.head_sha, workerVersionId: verified.workerVersionId, inputsDigest: after.inputsDigest, configurationDigest: current };
}
