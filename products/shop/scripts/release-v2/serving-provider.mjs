import { check, canonical, digest, same } from './data.mjs';
import { parseNativeServingTarget, canonicalNativeServingTarget } from '../../packages/contracts/src/native-serving-target.js';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fields = (value, names) => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...names].sort()), 'Exact native serving fields required');
export function validateServingPolicy(value, policy) {
  fields(value, ['schema','component','businessComponent','environment','mainResource','failureResource','failureMapping','grantKeyId']);
  check(value.schema === 'shop.native-serving-policy/v1' && ['development','production'].includes(value.environment) && value.component === 'native' && value.businessComponent === 'business', 'Native serving policy subject differs');
  check(value.mainResource !== value.failureResource && [value.mainResource,value.failureResource].every(name => policy.functions.some(item => item.name === name)) && !policy.nativeQualification?.resources.some(item => [value.mainResource,value.failureResource].includes(item.name)), 'Serving pair must use distinct admitted serving functions');
  check(policy.nativeQualification&&policy.nativeQualification.executionScope!=='fixture/provider-loopback','Serving policy requires independently installed real AWS qualification');
  const repositories=[value.mainResource,value.failureResource,...(policy.nativeQualification?[policy.nativeQualification.resources[0].name]:[])].map(name=>policy.functions.find(item=>item.name===name).imageRepository);check(new Set(repositories).size===1,'Serving pair must reuse the exact qualified ECR repository');
  check(typeof value.grantKeyId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.grantKeyId), 'Native serving grant key identifier required');
  fields(value.failureMapping,['id','eventSourceArn','configuration','initialFunctionArn']);
  check(new RegExp(`^arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${value.failureResource}(?::[1-9][0-9]{0,15})?$`).test(value.failureMapping.initialFunctionArn),'Exact initial serving failure pointer required');
  check(/^[a-f0-9-]{36}$/.test(value.failureMapping.id) && new RegExp(`^arn:aws:sqs:${policy.region}:${policy.awsAccountId}:[A-Za-z0-9_-]+$`).test(value.failureMapping.eventSourceArn) && value.failureMapping.configuration && typeof value.failureMapping.configuration === 'object' && value.failureMapping.configuration.UUID === value.failureMapping.id && value.failureMapping.configuration.EventSourceArn === value.failureMapping.eventSourceArn && !Object.hasOwn(value.failureMapping.configuration,'FunctionArn'), 'Complete exact serving failure mapping required');
}
export function assertServingSelection(selection, policy) {
  fields(selection,['schema','environment','mainResource','failureResource','imageDigest','codeDigest','inputsDigest','buildId','qualificationDigest','grantKeyId']);
  const pin = policy.nativeServing;
  check(pin && selection.schema === 'shop.native-serving-selection/v1' && ['environment','mainResource','failureResource','grantKeyId'].every(key => selection[key] === pin[key]) && ['imageDigest','codeDigest','inputsDigest','buildId','qualificationDigest'].every(key => hash(selection[key])), 'Qualified serving selection differs from root policy');
  return selection;
}
export function nativeServingTarget(selection, pair, policy) {
  assertServingSelection(selection,policy);
  const arn = (name,version) => `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${name}${version === null ? '' : `:${version}`}`;
  const target = {schema:'shop.native-serving-target/v1',environment:selection.environment,functionArn:arn(selection.mainResource,pair.mainVersion),failureFunctionArn:arn(selection.failureResource,pair.failureVersion),...Object.fromEntries(['imageDigest','codeDigest','inputsDigest','buildId','qualificationDigest','grantKeyId'].map(key=>[key,selection[key]]))};
  const serialized = canonicalNativeServingTarget(target);
  check(parseNativeServingTarget(serialized,{environment:selection.environment,mainFunctionArn:arn(selection.mainResource,null),failureFunctionArn:arn(selection.failureResource,null)}), 'Numbered serving pair target required');
  return target;
}
export function normalizeServingMetadata(metadata, marker, resolved = false, policy = null) {
  const normalized = structuredClone(metadata), bindings = normalized.bindings;
  check(marker === 'native-serving/v1' && Array.isArray(bindings), 'Typed native serving Worker metadata required');
  const matches = bindings.filter(item => item.name === 'SHOP_NATIVE_SERVING_TARGET_JSON');
  check(matches.length === 1 && matches[0].type === 'plain_text' && same(Object.keys(matches[0]).sort(),['name','text','type']), 'One exact native serving binding required');
  check(resolved || matches[0].text === '$nativeServingTarget', 'Only literal protected native serving binding may be materialized');
  if (resolved) { const pin=policy?.nativeServing; check(pin,'Root native serving policy required'); parseNativeServingTarget(matches[0].text,{environment:pin.environment,mainFunctionArn:`arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${pin.mainResource}`,failureFunctionArn:`arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${pin.failureResource}`}); }
  matches[0].text = '$nativeServingTarget';
  const literals=canonical(normalized).match(/"\$nativeServingTarget"/g)??[];check(literals.length===1,'Native serving placeholder is ambiguous');
  return normalized;
}
export function materializeServingMetadata(metadata, target, policy, resource) {
  const worker = policy.workers.find(item=>item.name === resource);
  const normalized = normalizeServingMetadata(metadata,worker?.nativeServingMetadata);
  check(digest(normalized) === worker.metadataDigest, 'Native serving Worker metadata changed');
  const result = structuredClone(metadata);
  result.bindings.find(item=>item.name === 'SHOP_NATIVE_SERVING_TARGET_JSON').text = canonicalNativeServingTarget(target);
  return result;
}
