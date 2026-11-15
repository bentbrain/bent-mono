import { check, digest, parseJSON, readRef, same } from './data.mjs';
import { materializeNativeTemplate } from './native-qualification-policy.mjs';
import { resolveNativeQualification } from './native-qualification.mjs';
import { assertServingSelection } from './serving-provider.mjs';

function assertServingRuntime(binding, { policy, buildId, main }) {
  const variables = binding?.Environment?.Variables, pin = policy.nativeServing;
  check(variables && typeof variables.SHOP_NATIVE_RUNTIME_PROFILE_JSON === 'string', 'Installed numbered runtime profile required');
  const profile = parseJSON(Buffer.from(variables.SHOP_NATIVE_RUNTIME_PROFILE_JSON), 16384);
  const functionArn = name => `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}`;
  check(profile.schemaVersion === 1 && profile.environment === pin.environment && profile.buildId === buildId &&
    profile.mainFunctionArn === functionArn(pin.mainResource) && profile.failureFunctionArn === functionArn(pin.failureResource) &&
    profile.failureQueueArn === pin.failureMapping.eventSourceArn && variables.STORY_BUILD_ID === buildId && variables.STORY_IMAGE_BUILD_ID === buildId,
  'Native runtime profile must match the selected serving pair, failure queue and packaged build');
  if (main) {
    check(typeof variables.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON === 'string', 'Installed numbered v5 binding required');
    const v5 = parseJSON(Buffer.from(variables.SHOP_PRODUCT_IMAGE_V5_BINDING_JSON), 16384);
    check(v5.schemaVersion === 2 && v5.environment === pin.environment && v5.functionArn === profile.mainFunctionArn &&
      v5.apiOrigin === profile.apiOrigin && v5.buildId === buildId && v5.invocationMode === 'aws-numbered-version',
    'Native v5 binding must use the same selected runtime profile');
  }
}

/** Resolve installed templates from an authenticated producer and real qualification. */
export function resolveServingPlan({ plan, policy, components, portable, nativeQualification }) {
  if (!policy.nativeServing) return { plan, authorityFields: {} };
  const pin = policy.nativeServing;
  const component = components.find(item => item.id === pin.component);
  const retained = portable.components.get(pin.component);
  check(component && retained && same(component.artifact, retained.artifactRef) &&
    component.codeDigest === retained.artifact.codeDigest && component.inputsDigest === retained.component.inputsDigest &&
    component.inputsDigest === retained.artifact.inputsDigest,
  'Serving plan requires the exact authenticated native component');
  const runtime = retained.runtime, image = retained.oci;
  check(image && runtime.definition?.kind === 'linux-native-oci-candidate' &&
    digest(runtime) === retained.artifact.runtimeDigest && runtime.definition.imageDigest === image.imageDigest,
  'Serving requires the verified portable Linux OCI producer');
  const buildId = runtime.definition.nativeOciReceipt?.identity?.capsuleManifestSha256;
  check(typeof buildId === 'string' && /^[a-f0-9]{64}$/.test(buildId), 'Packaged native build identity required');
  const resolved = structuredClone(plan), target = resolved.targets.find(item => item.component === pin.component);
  check(target?.kind === 'lambda' && target.resource === pin.mainResource && target.failure?.resource === pin.failureResource &&
    target.imageDigest === null && target.qualification?.mode === 'attested-native' && nativeQualification &&
    target.qualification.policyDigest === nativeQualification.policyDigest,
  'Installed serving pair must require real native qualification');
  const bindings = { buildId, imageDigest: image.imageDigest, sourceDigest: component.codeDigest,
    secretVersionsDigest: nativeQualification.secretVersionsDigest };
  target.expectedBinding = materializeNativeTemplate(target.expectedBinding, bindings);
  target.failure.expectedBinding = materializeNativeTemplate(target.failure.expectedBinding, bindings);
  assertServingRuntime(target.expectedBinding, { policy, buildId, main: true });
  assertServingRuntime(target.failure.expectedBinding, { policy, buildId, main: false });
  const qualified = binding => resolveNativeQualification({ ...nativeQualification, artifact: retained.artifact,
    component, image, resource: binding.resource, expectedBinding: binding.expectedBinding });
  const main = qualified(target), failure = qualified(target.failure);
  check(main.receiptDigest === failure.receiptDigest, 'Both serving functions require one complete real qualification');
  const selection = { schema: 'shop.native-serving-selection/v1', environment: pin.environment,
    mainResource: pin.mainResource, failureResource: pin.failureResource, imageDigest: image.imageDigest,
    codeDigest: component.codeDigest, inputsDigest: component.inputsDigest, buildId,
    qualificationDigest: main.receiptDigest, grantKeyId: pin.grantKeyId };
  assertServingSelection(selection, policy); target.serving = selection;
  return { plan: resolved, authorityFields: { nativeServingSelection: selection, nativeServingTargetDigest: digest(target) } };
}

export function assertServingPlanAuthority(resolved, authority) {
  const expected = resolved.authorityFields;
  check(same(authority.nativeServingSelection ?? null, expected.nativeServingSelection ?? null) &&
    (authority.nativeServingTargetDigest ?? null) === (expected.nativeServingTargetDigest ?? null),
  'Signed serving selection or complete target differs from authenticated producer and qualification');
  return resolved.plan;
}

// Bind the business logical version to its selected native runtime dependency.
const servingBindingName = 'native-serving-selection';
export function materializeServingConfig(config, policy, selection) {
  if (!policy.nativeServing || config.component !== policy.nativeServing.businessComponent) return config;
  assertServingSelection(selection, policy);
  check(Array.isArray(config.bindings) && !config.bindings.some(binding => binding.name === servingBindingName),
    'Installed business configuration must leave the derived serving identity to assembly');
  return { ...config, bindings: [...config.bindings, { name: servingBindingName, valueDigest: digest(selection) }]
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}

export async function assertServingComponentBinding({ bundle, components, policy, selection }) {
  if (!policy.nativeServing) return;
  assertServingSelection(selection, policy);
  const business = components.find(component => component.id === policy.nativeServing.businessComponent);
  check(business, 'Serving requires its business component');
  const config = parseJSON(await readRef(bundle, business.config));
  const selected = config.bindings.filter(binding => binding.name === servingBindingName);
  check(selected.length === 1 && selected[0].valueDigest === digest(selection),
    'Business logical version must bind its exact selected native runtime');
}
