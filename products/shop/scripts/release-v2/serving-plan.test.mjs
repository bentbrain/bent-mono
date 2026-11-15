import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { materializeNativeTemplate } from './native-qualification-policy.mjs';
import { verifyHostedAuthority } from './hosted-admission.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from './data.mjs';
import { selectedVersion } from './component-identity.mjs';
import { nativeRecipeDigest } from './native-qualification.mjs';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';
import { resolveServingPlan, assertServingPlanAuthority, materializeServingConfig } from './serving-plan.mjs';

// Source-signature protocol fixtures only. These tests execute no AWS image.
async function fixture() {
  const authority = await authorityFixture(), buildId = digest('packaged-capsule');
  const runtime = { definition: { kind: 'linux-native-oci-candidate', imageDigest: digest('image'),
    nativeOciReceipt: { identity: { capsuleManifestSha256: buildId } } } };
  const artifact = { runtimeDigest: digest(runtime), codeDigest: digest('code'), inputsDigest: digest('inputs') };
  const component = { id: 'native', codeDigest: artifact.codeDigest, inputsDigest: digest('inputs'), artifact: { sha256: digest(artifact) } };
  const base = protocolFixture().policy;
  const pin = { schema: 'shop.native-serving-policy/v1', component: 'native', businessComponent: 'business',
    environment: 'development', mainResource: 'serving-main', failureResource: 'serving-failure', grantKeyId: 'synthetic-key',
    failureMapping: { eventSourceArn: `arn:aws:sqs:${base.region}:${base.awsAccountId}:serving-failures` } };
  const mainArn = `arn:aws:lambda:${base.region}:${base.awsAccountId}:function:${pin.mainResource}`;
  const profile = { schemaVersion: 1, environment: pin.environment, apiOrigin: 'https://example.invalid', mainFunctionArn: mainArn,
    failureFunctionArn: `${mainArn.replace(pin.mainResource, pin.failureResource)}`, failureQueueArn: pin.failureMapping.eventSourceArn, buildId: '$buildId' };
  const binding = label => ({ Environment: { Variables: { LABEL: label, STORY_BUILD_ID: '$buildId', STORY_IMAGE_BUILD_ID: '$buildId',
    SHOP_NATIVE_RUNTIME_PROFILE_JSON: JSON.stringify(profile), SHOP_PRODUCT_IMAGE_V5_BINDING_JSON: JSON.stringify({ schemaVersion: 2,
      environment: pin.environment, apiOrigin: profile.apiOrigin, functionArn: mainArn, buildId: '$buildId', invocationMode: 'aws-numbered-version' }) } } });
  const qualificationPolicy = { resources: [{ name: 'isolated-main' }, { name: 'isolated-failure' }] };
  const policy = { nativeServing: pin, nativeQualification: qualificationPolicy, region: base.region, awsAccountId: base.awsAccountId };
  const target = { component: 'native', kind: 'lambda', resource: pin.mainResource, imageDigest: null,
    expectedBinding: binding('main'), failure: { resource: pin.failureResource, expectedBinding: binding('failure') },
    qualification: { mode: 'attested-native', policyDigest: digest(qualificationPolicy) } };
  const plan = { targets: [target] }, image = { imageDigest: runtime.definition.imageDigest };
  const portable = { components: new Map([['native', { artifact, artifactRef: component.artifact, component, runtime, oci: image }]]) };
  const resolvedBinding = label => materializeNativeTemplate(binding(label), { buildId });
  const payload = { schema: 'shop.native-qualification-receipt/v1', scope: 'aws/provider', awsImageQualified: true,
    environmentId: authority.root.credentialBroker.environmentId,
    sourceDigest: component.codeDigest, imageDigest: image.imageDigest, recipeDigest: nativeRecipeDigest(image, component.codeDigest),
    secretVersionsDigest: digest('secrets'), planDigest: digest('probe-plan'), requestGraphDigest: digest('requests'), policyDigest: digest('provider-policy'),
    qualificationPolicyDigest: digest(qualificationPolicy), artifactDigest: component.artifact.sha256, codeDigest: component.codeDigest,
    runtimeDigest: artifact.runtimeDigest, operationId: 'synthetic-probe', authorityDigest: digest('bootstrap-authority'),
    evidenceDigest: digest('evidence'), cleanupDigest: digest('cleanup'), issuedAt: authority.now,
    resources: ['main', 'failure'].map(label => ({ name: `isolated-${label}`, bindingDigest: digest(resolvedBinding(label)), version: '1' })) };
  const receipt = authority.seal(payload);
  const nativeQualification = { root: authority.root, receipts: [receipt], environmentId: payload.environmentId,
    policyDigest: digest(qualificationPolicy), qualificationPolicy, secretVersionsDigest: payload.secretVersionsDigest };
  return { plan, policy, components: [component], portable, nativeQualification, authority, receipt, buildId };
}

test('serving plan binds both exact templates to producer build and one signed qualification', async () => {
  const f = await fixture(), before = structuredClone(f.plan), result = resolveServingPlan(f);
  assert.deepEqual(f.plan, before);
  assert.equal(JSON.parse(result.plan.targets[0].expectedBinding.Environment.Variables.SHOP_NATIVE_RUNTIME_PROFILE_JSON).buildId, f.buildId);
  assert.equal(result.authorityFields.nativeServingTargetDigest, digest(result.plan.targets[0]));
  assert.equal(result.authorityFields.nativeServingSelection.qualificationDigest, digest(f.receipt));
  assert.equal(assertServingPlanAuthority(result, result.authorityFields), result.plan);
  assert.throws(() => assertServingPlanAuthority(result, {}), /Signed serving/);
  for (const field of ['buildId', 'imageDigest', 'inputsDigest']) {
    const changed = structuredClone(result.authorityFields); changed.nativeServingSelection[field] = digest('foreign');
    assert.throws(() => assertServingPlanAuthority(result, changed), /Signed serving/);
  }
});

test('missing, fixture-only and changed binding qualifications fail before provider admission', async () => {
  for (const change of [
    f => { f.nativeQualification.receipts = []; },
    f => { f.nativeQualification.receipts = [f.authority.seal({ ...f.receipt.payload, scope: 'fixture/provider-loopback', awsImageQualified: false })]; },
    f => { f.plan.targets[0].failure.expectedBinding.Environment.Variables.LABEL = 'foreign'; },
    f => { f.plan.targets[0].resource = 'isolated-main'; },
    f => { f.policy.nativeServing.failureMapping.eventSourceArn += '-foreign'; },
    f => { f.plan.targets[0].expectedBinding.Environment.Variables.STORY_BUILD_ID = digest('foreign-build'); },
    f => { f.portable.components.get('native').runtime.definition.nativeOciReceipt.identity.capsuleManifestSha256 = digest('foreign-build'); },
    f => { f.components[0].inputsDigest = digest('foreign-inputs'); }
  ]) {
    const f = await fixture(); change(f); assert.throws(() => resolveServingPlan(f));
  }
});

test('installations without serving policy retain their exact existing target plan', () => {
  const plan = { targets: [] }, result = resolveServingPlan({ plan, policy: {} });
  assert.equal(result.plan, plan); assert.deepEqual(result.authorityFields, {});
  assert.equal(assertServingPlanAuthority(result, {}), plan);
  assert.throws(() => assertServingPlanAuthority(result, { nativeServingTargetDigest: digest('foreign') }));
});

test('native promotion changes business logical configuration while code stays reusable', async () => {
  const f = await fixture(), first = resolveServingPlan(f).authorityFields.nativeServingSelection;
  const installed = { schema: 'shop.binding-installation/v1', component: 'business', scope: 'isolated-qualification',
    bindings: [{ name: 'existing', valueDigest: digest('fixed-config') }] };
  const a = materializeServingConfig(installed, f.policy, first);
  const b = materializeServingConfig(installed, f.policy, { ...first, imageDigest: digest('next-image'), buildId: digest('next-build') });
  assert.deepEqual(installed.bindings.map(item => item.name), ['existing']);
  assert.deepEqual(a.bindings.map(item => item.name), ['existing', 'native-serving-selection']);
  const business = config => ({ id: 'business', codeDigest: digest('unchanged-business-code'), config: { sha256: digest(config) } });
  assert.equal(selectedVersion(business(a)).artifactDigest, selectedVersion(business(b)).artifactDigest);
  assert.notEqual(selectedVersion(business(a)).version, selectedVersion(business(b)).version);
  assert.equal(selectedVersion(business(a)).version, selectedVersion(business(materializeServingConfig(installed, f.policy, first))).version);
  assert.throws(() => materializeServingConfig(a, f.policy, first), /derived serving/);
});

test('source v3 admits only a matching real-scope receipt and complete target pin', async () => {
  const f = await fixture(), serving = resolveServingPlan(f), original = f.authority.payload;
  const payload = { ...original, schema: 'shop.hosted-source-authority/v3', recovery: null,
    operationAuthorization: { scopeDigest: digest('installed-operation'), commands: ['advance', 'begin'], expiresAt: original.expiresAt },
    ...serving.authorityFields, nativeQualifications: [f.receipt] };
  assert.equal(verifyHostedAuthority(f.authority.seal(payload), f.authority).payload.nativeServingTargetDigest,
    serving.authorityFields.nativeServingTargetDigest);
  for (const change of [
    value => { delete value.nativeServingTargetDigest; },
    value => { delete value.nativeServingSelection; },
    value => { value.nativeServingSelection.environment = 'foreign'; },
    value => { value.nativeServingSelection.mainResource = value.nativeServingSelection.failureResource; },
    value => { value.nativeServingSelection.imageDigest = digest('foreign-image'); },
    value => {
      value.nativeQualifications = [f.authority.seal({ ...f.receipt.payload, scope: 'fixture/provider-loopback', awsImageQualified: false })];
      value.nativeServingSelection.qualificationDigest = digest(value.nativeQualifications[0]);
    }
  ]) {
    const changed = structuredClone(payload); change(changed);
    assert.throws(() => verifyHostedAuthority(f.authority.seal(changed), f.authority));
  }
});
