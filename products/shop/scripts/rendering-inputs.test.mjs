import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isolatedShippingLeaf, renderingInputManifest, rendererConfigurationDigest, rendererQualificationReusable } from './rendering-inputs.mjs';
const source='a'.repeat(40),leaf='workers/api/src/printify-webhooks.ts';
const code=readFileSync(new URL('../workers/api/src/printify-webhooks.ts',import.meta.url),'utf8');
const base=[leaf,'workers/api/src/index.ts','workers/api/src/story-video-jobs.ts','workers/api/src/integration-config.ts','workers/api/src/schema.ts',
 'workers/api/src/shopify-admin-client.ts','packages/contracts/src/index.ts','scripts/native-ci-qualification.mjs','.github/workflows/native-development.yml',
 'bun.lock','apps/web/src/app/page.tsx','shopify/notifications/email.css','docs/acceptance.json'].map(path=>({path,mode:'100644',type:'blob',oid:'b'.repeat(40)}));
function manifest(path,options={}) {
 return renderingInputManifest(source,{tree:()=>base.map(entry=>({...entry,oid:entry.path===path?'c'.repeat(40):entry.oid})),
  read:(_source,path)=>path===leaf?code:'',nodeVersion:'v24.1.0',boundary:'isolated-printify-webhooks-v1',...options});
}
test('shipping leaf, email and web changes preserve renderer inputs; transitive shared and policy changes invalidate them',()=>{
 const before=manifest();assert.ok(before);
 for(const path of [leaf,'apps/web/src/app/page.tsx','shopify/notifications/email.css','docs/acceptance.json'])
  assert.equal(rendererQualificationReusable(before,manifest(path)),true,path);
 for(const path of base.map(item=>item.path).filter(path=>![leaf,'apps/web/src/app/page.tsx','shopify/notifications/email.css','docs/acceptance.json'].includes(path)))
  assert.equal(rendererQualificationReusable(before,manifest(path)),false,path);
 assert.equal(rendererQualificationReusable(before,manifest(undefined,{nodeVersion:'v24.2.0'})),false);
});
test('dynamic SQL, renderer table access and a new shared importer reject the narrow boundary',()=>{
 assert.equal(isolatedShippingLeaf(code),true);
 assert.equal(isolatedShippingLeaf(code.replace('FROM printify_shipments','FROM story_video_jobs')),false);
 assert.equal(isolatedShippingLeaf(`${code}\nenv.DB.prepare(query)`),false);
 assert.equal(isolatedShippingLeaf(`${code}\nimport('./unknown')`),false);
 assert.equal(manifest(undefined,{read:(_source,path)=>path===leaf?code:path.endsWith('story-video-jobs.ts')?'import "./printify-webhooks";':''}),null);
});
test('runtime and binding drift invalidate reuse while release labels do not',()=>{
 const runtime={runtimeVerified:true,renderer:{imageDigest:'image'},failure:{imageDigest:'image'}};
 const settings={compatibility_date:'2026-08-12',bindings:[{name:'DB',id:'development'},{name:'STORY_VIDEO_RELEASE_ID',text:'native-1'},{name:'STORY_VIDEO_RELEASE_COMMIT',text:'old'}]};
 const digest=rendererConfigurationDigest(settings,runtime);
 assert.equal(rendererConfigurationDigest({...settings,bindings:[settings.bindings[0],{name:'STORY_VIDEO_RELEASE_ID',text:'native-2'}]},runtime),digest);
 assert.notEqual(rendererConfigurationDigest({...settings,bindings:[{name:'DB',id:'different'}]},runtime),digest);
 assert.notEqual(rendererConfigurationDigest(settings,{...runtime,renderer:{imageDigest:'other'}}),digest);
 assert.throws(()=>rendererConfigurationDigest(settings,{}));
});

test('provider identity changes can reuse rendering only within the explicit importer boundary',async()=>{
 const {commerceBoundary,commerceOnlyPaths,isolatedProviderIdentity}=await import('./rendering-inputs.mjs');
 const ids=['workers/api/src/printify-order-identity.ts','workers/api/src/printify-product-identity.ts'];
 const reads=new Map([[leaf,code],...ids.map(path=>[path,readFileSync(new URL(`../${path}`,import.meta.url),'utf8')])]);
 const entries=[...base,...ids.map(path=>({path,mode:'100644',type:'blob',oid:'b'.repeat(40)})),
  {path:'workers/api/src/printify-production-client.ts',mode:'100644',type:'blob',oid:'b'.repeat(40)}];
 const make=(changed,extra='')=>renderingInputManifest(source,{boundary:commerceBoundary,nodeVersion:'v24.1.0',
  tree:()=>entries.map(entry=>({...entry,oid:entry.path===changed?'c'.repeat(40):entry.oid})),
  read:(_sha,path)=>reads.get(path) ?? (path.endsWith('story-video-jobs.ts')?extra:'')});
 const before=make();assert.ok(before);
 for(const path of ids) {
  assert.equal(commerceOnlyPaths([path]),true);
  assert.equal(rendererQualificationReusable(before,make(path)),true);
  assert.equal(isolatedProviderIdentity(reads.get(path)),true);
  assert.equal(isolatedProviderIdentity(`${reads.get(path)}\nfetch('https://example.test')`),false);
 }
 for(const path of [leaf,'workers/api/src/index.ts','workers/api/src/printify-production-client.ts','bun.lock','.github/workflows/native-development.yml'])
  assert.equal(rendererQualificationReusable(before,make(path)),false,path);
 assert.equal(make(undefined,'import "./printify-order-identity";'),null);
 assert.equal(renderingInputManifest(source,{boundary:commerceBoundary,nodeVersion:'v24.1.0',tree:()=>entries,
  read:(_sha,path)=>reads.get(path) ?? (path.endsWith('/index.ts')?'import "./printify-order-identity";':'')}),null);
 assert.equal(commerceOnlyPaths(['workers/api/src/printify-order-identity.ts','workers/api/src/index.ts']),false);
 assert.equal(commerceOnlyPaths([leaf]),false);
 for(const addition of ['Date.now = () => 0;','import "./story-video-jobs";']) {
  const modified=renderingInputManifest(source,{boundary:commerceBoundary,nodeVersion:'v24.1.0',
   tree:()=>entries.map(entry=>({...entry,oid:entry.path===leaf?'c'.repeat(40):entry.oid})),
   read:(_sha,path)=>path===leaf?`${code}\n${addition}`:reads.get(path) ?? ''});
  assert.equal(rendererQualificationReusable(before,modified),false,addition);
 }
});

test('excluded identity modules reject unproved initialization, imports and nested side effects',async()=>{
 const {isolatedProviderIdentity,commerceBoundary}=await import('./rendering-inputs.mjs');
 const identity='workers/api/src/printify-order-identity.ts';
 const original=readFileSync(new URL(`../${identity}`,import.meta.url),'utf8');
 for(const addition of [
  'Date.now = () => 0;', 'import "./story-video-jobs";', 'export * from "./story-video-jobs";',
  'export function bad() { Date.now = () => 0; }', 'export function bad() { return Date.now(); }',
  'export function bad() { const clock = Date; return clock.parse("now"); }',
  'const Bad = Schema.String.pipe(Schema.filter(() => { Date.now = () => 0; return true; }));',
  'export function bad(input: string[]) { input.push("changed"); }',
  'export function bad() { return import("./story-video-jobs"); }',
  'const Bad = Schema.declare(() => true);', 'const Bad = Schema.String.pipe(Schema.transform(Schema.String, {}));',
  'const Bad = (() => { Date.now = () => 0; return Schema.String; })();',
  'export function bad() { return Object.defineProperty(Date, "now", {}); }',
  'export function bad(value: object) { return value["constructor"]; }',
  'const Bad = Bad.pipe(Schema.minLength(1));',
 ]) {
  const modified=`${original}\n${addition}`;
  assert.equal(isolatedProviderIdentity(modified),false,addition);
  const ids=[identity,'workers/api/src/printify-product-identity.ts'];
  assert.equal(renderingInputManifest(source,{boundary:commerceBoundary,nodeVersion:'v24.1.0',
   tree:()=>[...base,...ids.map(path=>({path,mode:'100644',type:'blob',oid:'c'.repeat(40)}))],
   read:(_sha,path)=>path===identity?modified:path===leaf?code:ids.includes(path)?readFileSync(new URL(`../${path}`,import.meta.url),'utf8'):''}),null,addition);
 }
 assert.equal(isolatedProviderIdentity(original.replace('expected.phone === undefined ||','expected.phone === undefined || false ||')),true);
});
