import { canonical,parseJSON,check, digest, same } from './data.mjs';

export const nativeProbeFamilies = Object.freeze(['startup', 'v5', 'v4', 'video', 'callback', 'failure', 'concurrency']);
const fields = (value, names) => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), names.sort()), 'Exact native qualification policy fields required');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const runtimeJsonNames=new Set(['SHOP_NATIVE_RUNTIME_PROFILE_JSON','SHOP_PRODUCT_IMAGE_V5_BINDING_JSON']);
const runtimeJsonTemplate=(name,value)=>runtimeJsonNames.has(name)&&typeof value==='string'&&value.includes('\"$buildId\"');
const variables = new Set(['$imageDigest', '$sourceDigest', '$secretVersionsDigest', '$operationId','$buildId']);
export function materializeNativeTemplate(value, bindings) {
  if (typeof value === 'string' && variables.has(value)) { const key = value.slice(1), result = bindings[key]; check(key === 'operationId' ? typeof result === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(result) : hash(result), 'Exact native template binding required'); return result; }
  if (Array.isArray(value)) return value.map(item => materializeNativeTemplate(item, bindings));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,runtimeJsonTemplate(key,item)?canonical(materializeNativeTemplate(parseJSON(Buffer.from(item),16384),bindings)):materializeNativeTemplate(item, bindings)]));
  return value;
}
export function matchNativeTemplate(template, actual) {
  const bindings = {};
  const visit = (left,right) => {
    if (typeof left === 'string' && variables.has(left)) { const key = left.slice(1); check(!Object.hasOwn(bindings,key) || bindings[key] === right, 'Native template binding repeated with different value'); bindings[key] = right; materializeNativeTemplate(left,bindings); return; }
    if (Array.isArray(left)) { check(Array.isArray(right) && left.length === right.length, 'Native template array differs'); left.forEach((item,index) => visit(item,right[index])); return; }
    if (left && typeof left === 'object') { check(right && typeof right === 'object' && !Array.isArray(right) && same(Object.keys(left).sort(),Object.keys(right).sort()), 'Native template object differs'); Object.keys(left).forEach(key => {if(runtimeJsonTemplate(key,left[key])){check(typeof right[key]==='string','Exact serialized native runtime binding required');const parsed=parseJSON(Buffer.from(right[key]),16384);check(canonical(parsed)===right[key],'Canonical materialized runtime binding required');visit(parseJSON(Buffer.from(left[key]),16384),parsed);}else visit(left[key],right[key]);}); return; }
    check(same(left,right), 'Native template literal differs');
  }; visit(template,actual); return bindings;
}
export function validateNativeQualificationPolicy(value, policy) {
  fields(value, ['schema', 'resources', 'probes',...(Object.hasOwn(value,'fixtureLifecycle')?['fixtureLifecycle']:[]),...(Object.hasOwn(value,'executionScope')?['executionScope']:[])]);
  check(value.executionScope===undefined||['fixture/provider-loopback','aws/provider'].includes(value.executionScope),'Exact native execution scope required');
  if(value.fixtureLifecycle){const fixture=value.fixtureLifecycle;fields(fixture,['schema','databaseId','artworkBucket','videoBucket','templateDigest','grantKey',...(Object.hasOwn(fixture,'bootstrapWorker')?['bootstrapWorker']:[])]);fields(fixture.grantKey,['id','version','secretSha256']);check(fixture.schema==='shop.native-fixture-policy/v1'&&/^[a-f0-9-]{36}$/.test(fixture.databaseId)&&[fixture.artworkBucket,fixture.videoBucket].every(bucket=>/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket))&&hash(fixture.templateDigest)&&hash(fixture.grantKey.secretSha256)&&typeof fixture.grantKey.id==='string'&&typeof fixture.grantKey.version==='string','Pinned real native fixture database/media/grant key required');if(fixture.bootstrapWorker){fields(fixture.bootstrapWorker,['name','metadataDigest','restoreVersion']);check(policy.workers.some(item=>item.name===fixture.bootstrapWorker.name&&item.metadataDigest===fixture.bootstrapWorker.metadataDigest&&item.versionContentApi==='workers-beta/v1')&&/^[a-f0-9-]{36}$/.test(fixture.bootstrapWorker.restoreVersion),'Pinned isolated bootstrap Worker required');}}
  check(value.schema === 'shop.native-qualification-policy/v1' && Array.isArray(value.resources) && value.resources.length >= 2 && value.resources.length <= 4 && new Set(value.resources.map(item => item.name)).size === value.resources.length, 'Independently installed isolated renderer and failure resources required');
  for (const resource of value.resources) {
    fields(resource, ['name', 'bindingDigest', 'concurrency', 'eventInvokeConfig', 'eventSourceMapping', ...(Object.hasOwn(resource,'bindingTemplate') ? ['bindingTemplate'] : [])]);
    if (Object.hasOwn(resource,'bindingTemplate')) check(digest(resource.bindingTemplate) === resource.bindingDigest, 'Pinned native binding template digest differs');
    check(policy.functions.some(item => item.name === resource.name) && hash(resource.bindingDigest) && Number.isSafeInteger(resource.concurrency) && resource.concurrency >= 1 && resource.concurrency <= 8, 'Bounded isolated native function binding required');
    const config = resource.eventInvokeConfig;
    fields(config, ['MaximumEventAgeInSeconds', 'MaximumRetryAttempts', 'DestinationConfig']);
    check(config.MaximumEventAgeInSeconds === 60 && config.MaximumRetryAttempts === 0 && config.DestinationConfig && typeof config.DestinationConfig === 'object', 'Bounded native asynchronous delivery required');
    if (resource.eventSourceMapping !== null) { fields(resource.eventSourceMapping, ['id', 'digest',...(Object.hasOwn(resource.eventSourceMapping,'restoreFunctionArn')?['restoreFunctionArn']:[])]);if(resource.eventSourceMapping.restoreFunctionArn)check(new RegExp(`^arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${resource.name}(?::[1-9][0-9]{0,15})?$`).test(resource.eventSourceMapping.restoreFunctionArn),'Exact isolated mapping restore function required'); check(/^[a-f0-9-]{36}$/.test(resource.eventSourceMapping.id) && hash(resource.eventSourceMapping.digest), 'Exact isolated failure mapping required'); }
  }
  check(Array.isArray(value.probes) && value.probes.length >= nativeProbeFamilies.length && value.probes.length <= 32 && new Set(value.probes.map(probe => probe.id)).size === value.probes.length && nativeProbeFamilies.every(family => value.probes.some(probe => probe.family === family)), 'Complete native startup, v5, v4, video, callback, failure and concurrency probes required');
  for (const probe of value.probes) {
    fields(probe, ['id', 'family', 'resource', 'invocationType', 'payloadDigest', 'observation', ...(Object.hasOwn(probe,'payloadTemplate') ? ['payloadTemplate'] : []),...(Object.hasOwn(probe,'fixtureKind')?['fixtureKind']:[])]);
    check(/^[a-z][a-z0-9-]{0,63}$/.test(probe.id) && nativeProbeFamilies.includes(probe.family) && value.resources.some(resource => resource.name === probe.resource) && ['RequestResponse', 'Event'].includes(probe.invocationType) && hash(probe.payloadDigest), 'Exact admitted native invocation required');
    if(probe.fixtureKind){check(value.fixtureLifecycle&&['v5','v4','video','failure'].includes(probe.fixtureKind)&&probe.observation===null,'Builtin real fixture proof policy required');continue;}
    const observation = probe.observation; fields(observation, ['databaseId', 'sql', 'params', 'expectedRows']);
    if (Object.hasOwn(probe,'payloadTemplate')) check(digest(probe.payloadTemplate) === probe.payloadDigest, 'Pinned native invocation template digest differs');
    check(/^[a-f0-9-]{36}$/.test(observation.databaseId) && typeof observation.sql === 'string' && observation.sql.length <= 16384 && /^SELECT\s/i.test(observation.sql) && !/;|--|\/\*|\*\/|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|load_extension|writefile|readfile|eval|LIMIT)\b/i.test(observation.sql) && /\bFROM\s+[A-Za-z_][A-Za-z0-9_]*/i.test(observation.sql), 'Exact complete read-only native observation SELECT required');
    check(Array.isArray(observation.params) && observation.params.length <= 32 && observation.params.every(item => item === null || typeof item === 'string' && item.length <= 4096 || Number.isSafeInteger(item)) && Array.isArray(observation.expectedRows) && observation.expectedRows.length > 0 && observation.expectedRows.length <= 128, 'Bounded nonempty native proof observations required');
    check(digest(observation.expectedRows).length === 64, 'Native observation data required');
  }
  return value;
}

export function nativeMappingProjection(value){check(value&&typeof value==='object'&&!Array.isArray(value)&&typeof value.UUID==='string'&&typeof value.FunctionArn==='string'&&typeof value.EventSourceArn==='string','Complete isolated event mapping required');return Object.fromEntries(Object.entries(value).filter(([key])=>!['FunctionArn','LastModified','State','StateTransitionReason','LastProcessingResult'].includes(key)));}
