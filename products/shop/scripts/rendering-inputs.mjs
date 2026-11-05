import { releaseTree, releaseBlob } from "./monorepo-source.mjs";
import { createHash } from 'node:crypto';
import { providerIdentityIsolated } from './provider-identity-isolation.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const leaf='workers/api/src/printify-webhooks.ts';
const identities=['workers/api/src/printify-order-identity.ts','workers/api/src/printify-product-identity.ts'];
export const commerceBoundary='isolated-printify-contracts-v2';
const identityImporters=new Set(['printify-production-client','printify-order-submission','printify-production-materialisation','paid-order-provider-recovery','paid-order-product-recovery']);
export function isolatedProviderIdentity(source) {
  return providerIdentityIsolated(source);
}
export function commerceOnlyPaths(paths) {
  return Array.isArray(paths) && paths.every(path=>identities.includes(path) || path!==leaf && shippingOnlyPaths([path]));
}
const receiptPaths=new Set(['infra/story-video-lambda/development-qualification.json','infra/story-video-lambda/production-promotion.json']);
function renderingInputPath(path,boundary) {
  if(boundary===commerceBoundary && identities.includes(path)) return false;
  if (path === leaf && boundary!==commerceBoundary || /^workers\/api\/src\/.*\.test\.ts$/.test(path)) return false;
  if (path.startsWith('docs/') || path === 'README.md' || receiptPaths.has(path) || path.startsWith('shopify/notifications/')) return false;
  if (path.startsWith('apps/web/') && !path.startsWith('apps/web/public/mockups/')) return false;
  return true;
}
// The legacy boundary admits one shipping leaf. The newer boundary also admits
// two pure Printify identity modules but keeps the shipping module as an input.
// Shared clients, scheduler, entrypoint, schema and dependencies remain inputs.
export function isolatedShippingLeaf(source) {
  if (/\b(?:globalThis|process|eval|Function)\b|\bimport\s*\(|\.exec\s*\(|\.dump\s*\(/.test(source)) return false;
  const imports=[...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map(match=>match[1]);
  if (imports.some(path=>!['effect','./integration-config','./shopify-admin-client'].includes(path))) return false;
  const prepares=[...source.matchAll(/\.prepare\s*\(/g)];
  const literal=[...source.matchAll(/\.prepare\(\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')\s*\)/g)];
  if (!prepares.length || prepares.length !== literal.length) return false;
  const tables=new Set(['fulfilment_exceptions','paid_order_lines','paid_orders','printify_fulfilment_order_lines',
    'printify_fulfilment_orders','printify_shipment_lines','printify_shipments','printify_webhook_inbox']);
  return literal.every(match=>{
    const sql=match[1] ?? match[2] ?? match[3];
    return !sql.includes('${') && !/\b(?:ATTACH|DETACH|PRAGMA|CREATE|DROP|ALTER)\b/i.test(sql) &&
      [...sql.replace(/\bDO\s+UPDATE\s+SET\b/gi, "DO SET").matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)/gi)].every(item=>tables.has(item[1].toLowerCase()));
  });
}
function gitTree(source) {
  const output=releaseTree(source);
  return output.split('\0').filter(Boolean).map(record=>{
    const [header,...path]=record.split('\t'),[mode,type,oid]=header.split(' ');
    return {path:path.join('\t'),mode,type,oid};
  });
}
const gitBlob=releaseBlob;
export function renderingInputManifest(source,{tree=gitTree,read=gitBlob,nodeVersion=process.version,boundary=commerceBoundary}={}) {
  if (!['isolated-printify-webhooks-v1',commerceBoundary].includes(boundary) || !/^[a-f0-9]{40}$/.test(source) || !/^v24\./.test(nodeVersion)) return null;
  const entries=tree(source);
  if (!entries.some(entry=>entry.path===leaf) || entries.some(entry=>entry.type!=='blob' || !['100644','100755'].includes(entry.mode))) return null;
  if (boundary!==commerceBoundary && !isolatedShippingLeaf(read(source,leaf))) return null;
  if(boundary===commerceBoundary && identities.some(path=>!entries.some(entry=>entry.path===path) || !isolatedProviderIdentity(read(source,path)))) return null;
  for (const entry of entries.filter(entry=>entry.path.startsWith('workers/api/src/') && entry.path.endsWith('.ts') && !entry.path.endsWith('.test.ts') && entry.path!==leaf)) {
    const text=read(source,entry.path);
    if (entry.path!=='workers/api/src/index.ts' && text.includes('printify-webhooks')) return null;
    if(boundary===commerceBoundary && identities.some(path=>text.includes(path.split('/').at(-1).slice(0,-3))) &&
      !identityImporters.has(entry.path.split('/').at(-1).slice(0,-3))) return null;
  }
  const files=entries.filter(entry=>renderingInputPath(entry.path,boundary)).map(({path,mode,oid})=>({path,mode,oid})).sort((a,b)=>a.path.localeCompare(b.path));
  const inputs={schemaVersion:1,boundary,nodeVersion,files};
  return {...inputs,sourceCommit:source,inputsDigest:hash(JSON.stringify(inputs))};
}
const canonical=value=>Array.isArray(value)?value.map(canonical):value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function rendererConfigurationDigest(settings,runtime) {
  if (!Array.isArray(settings?.bindings) || !settings.compatibility_date || runtime?.runtimeVerified !== true) throw Error('Verified renderer bindings and runtime required.');
  const bindings=settings.bindings.filter(binding=>!['STORY_VIDEO_RELEASE_ID','STORY_VIDEO_RELEASE_COMMIT'].includes(binding.name))
    .sort((a,b)=>a.name.localeCompare(b.name));
  const {modified_on,created_on,etag,...configuration}=settings;
  void modified_on;void created_on;void etag;
  return hash(JSON.stringify(canonical({configuration:{...configuration,bindings},runtime})));
}
export function rendererQualificationReusable(before,after) {
  return before?.schemaVersion===1 && after?.schemaVersion===1 && before.boundary===after.boundary &&
    /^[a-f0-9]{64}$/.test(before.inputsDigest ?? '') && before.inputsDigest===after.inputsDigest;
}

export function shippingOnlyPaths(paths) {
 return Array.isArray(paths) && paths.every(path=>path==='workers/api/src/printify-webhooks.ts' ||
  /^workers\/api\/src\/.*\.test\.ts$/.test(path) || path.startsWith('docs/') || path.startsWith('shopify/notifications/') ||
  ['README.md','infra/story-video-lambda/development-qualification.json','infra/story-video-lambda/production-promotion.json'].includes(path));
}
