import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical,digest,sha256 } from './data.mjs';
import { protocolPolicy,requestBuilders } from './provider-protocol-builders.mjs';
import { nativeMappingProjection,nativeProbeFamilies } from './native-qualification-policy.mjs';
import { lambdaBindingProjection } from './provider-protocol.mjs';
import { selectedVersion,codeIdentity } from './component-identity.mjs';
import { nativeServingTarget,materializeServingMetadata } from './serving-provider.mjs';
import { rehydrateProviderRequest } from './request-rehydration.mjs';
import { createHostedProvider,retainedCandidateLoader,preflightHostedTargets } from './hosted-provider.mjs';
import { verifyHostedAuthority } from './hosted-admission.mjs';
import { createHostedWriter } from './hosted-writer.mjs';
import { fixture } from './testing/fixtures.mjs';
import { authorityFixture } from './testing/hosted-authority-fixture.mjs';
import { protocolFixture } from './testing/provider-protocol-transcript.mjs';
import { hostedProtocolFixture } from './testing/hosted-protocol-service.mjs';

async function servingFixture(){
 const f=await fixture(),authority=await authorityFixture(),base=protocolFixture().policy,main=base.functions[0].name,failure='protocol-serving-failure';
 const binding=lambdaBindingProjection({Architectures:['x86_64'],MemorySize:3008,Timeout:120,Role:`arn:aws:iam::${base.awsAccountId}:role/protocol-serving`,EphemeralStorage:{Size:1024},Environment:{Variables:{STORY_BUILD_ID:sha256('new-build')}}});
 const isolatedNames=['isolated-main','isolated-failure'],qualificationPolicy={schema:'shop.native-qualification-policy/v1',executionScope:'aws/provider',resources:isolatedNames.map(name=>({name,bindingDigest:digest(binding),concurrency:2,eventInvokeConfig:{MaximumEventAgeInSeconds:60,MaximumRetryAttempts:0,DestinationConfig:{}},eventSourceMapping:null})),probes:nativeProbeFamilies.map(family=>({id:`probe-${family}`,family,resource:isolatedNames[0],invocationType:'Event',payloadDigest:sha256('probe'),observation:{databaseId:'00000000-0000-4000-8000-000000000009',sql:'SELECT outcome FROM serving_protocol_proofs',params:[],expectedRows:[{ok:true}]}}))};
 const mapping={UUID:'00000000-0000-4000-8000-000000000005',EventSourceArn:`arn:aws:sqs:${base.region}:${base.awsAccountId}:serving-failures`,FunctionArn:`arn:aws:lambda:${base.region}:${base.awsAccountId}:function:${failure}:9`,State:'Enabled',BatchSize:10,LastModified:100};
 const components=[],targets=[];let nativeArtifact;
 for(const [index,id]of ['business','native'].entries()){
  const component=structuredClone(f.payload.components[index]),old=JSON.parse(await readFile(join(f.bundle,component.artifact.path)));component.id=id;
  const config={schema:'shop.binding-installation/v1',scope:'isolated-qualification',component:id,bindings:[]};component.config=await f.put(`metadata/${id}-config.json`,config);
  const provenance=JSON.parse(await readFile(join(f.bundle,component.provenance.path)));provenance.schema='shop.build-provenance/v1';provenance.component=id;
  let artifact={...old,component:id,configDigest:component.config.sha256};
  if(id==='native'){
   const files=[],blob=async(mediaType,value)=>{const bytes=Buffer.from(canonical(value)),hash=sha256(bytes);files.push({...await f.put(`${old.root}/blobs/sha256/${hash}`,bytes),mediaType:'application/octet-stream'});return {mediaType,digest:`sha256:${hash}`,size:bytes.length};};
   const configuration=await blob('application/vnd.oci.image.config.v1+json',{architecture:'amd64',os:'linux',rootfs:{type:'layers',diff_ids:[]}}),image=await blob('application/vnd.oci.image.manifest.v1+json',{schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:configuration,layers:[]});
   files.push({...await f.put(`${old.root}/oci-layout`,{imageLayoutVersion:'1.0.0'}),mediaType:'application/json'},{...await f.put(`${old.root}/index.json`,{schemaVersion:2,manifests:[{...image,platform:{architecture:'amd64',os:'linux'}}]}),mediaType:'application/json'});
   artifact={schema:'shop.artifact/v2',component:id,format:'oci-layout',root:old.root,entrypoint:`${old.root}/index.json`,files,originSourceCommit:old.originSourceCommit,inputsDigest:old.inputsDigest,runtimeDigest:sha256('synthetic-native-runtime')};artifact.codeDigest=codeIdentity(artifact);component.codeDigest=artifact.codeDigest;component.inputsDigest=old.inputsDigest;nativeArtifact={artifact,imageDigest:image.digest.slice(7)};
  }
  provenance.artifactFilesDigest=digest(artifact.files);component.provenance=await f.put(`metadata/${id}-provenance.json`,provenance);if(id==='business')artifact.provenanceDigest=component.provenance.sha256;component.artifact=await f.put(`metadata/${id}-artifact.json`,artifact);components.push(component);
  if(id==='business')targets.push({component:id,kind:'worker',resource:'protocol-business',entrypoint:'index.mjs',metadata:{main_module:'index.mjs',compatibility_date:'2026-11-01',compatibility_flags:[],bindings:[{name:'SHOP_NATIVE_SERVING_TARGET_JSON',type:'plain_text',text:'$nativeServingTarget'}]},modules:[{name:'index.mjs',path:artifact.entrypoint,type:'application/javascript+module'}],assets:[]});
 }
 const native=components[1],selection={schema:'shop.native-serving-selection/v1',environment:'development',mainResource:main,failureResource:failure,imageDigest:nativeArtifact.imageDigest,codeDigest:native.codeDigest,inputsDigest:native.inputsDigest,buildId:sha256('new-build'),qualificationDigest:sha256('separately-protected-protocol-fixture'),grantKeyId:'fixture-key'};
 const receipt=authority.seal({schema:'shop.native-qualification-receipt/v1',scope:'aws/provider',awsImageQualified:true,environmentId:'synthetic-qualification',sourceDigest:native.codeDigest,imageDigest:selection.imageDigest,recipeDigest:sha256('recipe'),secretVersionsDigest:digest(authority.payload.secretInstallations),planDigest:sha256('plan'),requestGraphDigest:sha256('graph'),policyDigest:sha256('qualification-policy'),qualificationPolicyDigest:digest(qualificationPolicy),artifactDigest:native.artifact.sha256,codeDigest:native.codeDigest,runtimeDigest:nativeArtifact.artifact.runtimeDigest,operationId:`native-${sha256('operation')}`,authorityDigest:sha256('bootstrap-authority'),evidenceDigest:sha256('synthetic-evidence'),cleanupDigest:sha256('synthetic-cleanup'),resources:[{name:'isolated-main',version:'1',bindingDigest:digest(binding)},{name:'isolated-failure',version:'1',bindingDigest:digest(binding)}],issuedAt:Date.now()});selection.qualificationDigest=digest(receipt);
 const business=components[0],businessArtifact=JSON.parse(await readFile(join(f.bundle,business.artifact.path)));business.config=await f.put(business.config.path,{schema:'shop.binding-installation/v1',scope:'isolated-qualification',component:'business',bindings:[{name:'native-serving-selection',valueDigest:digest(selection)}]});businessArtifact.configDigest=business.config.sha256;business.artifact=await f.put(business.artifact.path,businessArtifact);
 const target={component:'native',kind:'lambda',resource:main,alias:'active',imageDigest:selection.imageDigest,expectedBinding:binding,failure:{resource:failure,expectedBinding:binding},serving:selection,qualification:{awsImageQualified:true,artifactDigest:native.artifact.sha256,codeDigest:native.codeDigest,runtimeDigest:nativeArtifact.artifact.runtimeDigest,imageDigest:selection.imageDigest,receiptDigest:selection.qualificationDigest}};targets.push(target);
 const policy=protocolPolicy({...base,functions:[...base.functions,{...base.functions[0],name:failure},...isolatedNames.map(name=>({...base.functions[0],name}))],nativeQualification:qualificationPolicy,workers:[{name:'protocol-business',metadataDigest:digest(targets[0].metadata),versionContentApi:'workers-beta/v1',nativeServingMetadata:'native-serving/v1'}],nativeServing:{schema:'shop.native-serving-policy/v1',component:'native',businessComponent:'business',environment:'development',mainResource:main,failureResource:failure,failureMapping:{id:mapping.UUID,eventSourceArn:mapping.EventSourceArn,configuration:nativeMappingProjection(mapping),initialFunctionArn:mapping.FunctionArn},grantKeyId:'fixture-key'}});
 authority.root.providerPolicyDigest=digest(policy);authority.root.credentialBroker.environmentId='synthetic-qualification';
 let source=authority.seal({...authority.payload,schema:'shop.hosted-source-authority/v3',providerPolicyDigest:digest(policy),portableManifests:components.map(component=>({...authority.payload.portableManifests[0],component:component.id,codeDigest:component.codeDigest??component.artifact.sha256,configDigest:component.config.sha256})),nativeQualifications:[receipt],nativeServingSelection:selection,nativeServingTargetDigest:digest(target),operationAuthorization:{scopeDigest:sha256('installed-operation'),commands:['advance','begin','deliver','rollback'],expiresAt:authority.payload.expiresAt},recovery:null});
 const initialBinding={...binding,Environment:{Variables:{STORY_BUILD_ID:sha256('old-build')}}};
 const service=await hostedProtocolFixture({policy,targets:[{...target,expectedBinding:initialBinding},{kind:'lambda',resource:failure,alias:'active',imageDigest:selection.imageDigest,expectedBinding:initialBinding}],nativeBootstrapRoot:authority.root,invocation:authority.identity,mappingFixtures:[mapping]});
 const manifest=await readFile(join(f.bundle,nativeArtifact.artifact.files.find(item=>item.path.endsWith(`/blobs/sha256/${selection.imageDigest}`)).path),'utf8'),repository=policy.functions[0].imageRepository.split('.amazonaws.com/')[1];service.ecrImages.set(`${repository}/sha256:${selection.imageDigest}`,{registryId:policy.awsAccountId,repositoryName:repository,imageId:{imageDigest:`sha256:${selection.imageDigest}`},imageManifest:manifest});
 source=authority.seal({...source.payload,writerFenceDigest:service.fenceAdmission.digest});
 const writer=createHostedWriter({policy,broker:service.broker,fenceAdmission:service.fenceAdmission}),load=retainedCandidateLoader({bundle:f.bundle,targets});
 await preflightHostedTargets({policy,components,targets,load});
 const provider=createHostedProvider({policy,writer,broker:service.broker,components,targets,load,deploymentId:'123',nativeServingAuthority:source});
 const operation=async(kind,component,expectedActiveVersion=null)=>writer.withWriter(async({commit})=>{const selected=selectedVersion(component),body={id:`operation-${kind}-${component.id}`,component:component.id,version:selected.version,artifactDigest:selected.artifactDigest,configDigest:selected.configDigest,expectedActiveVersion};await commit({phase:`${kind}-reconcile`,operation:{id:body.id,bodyDigest:digest(body)},desired:{components},history:[]});await provider.write(kind,body);return body;});
 return {bundle:f.bundle,policy,selection,targets,service,writer,provider,operation,components,source,authority,close:async()=>{await service.close();await rm(f.directory,{recursive:true,force:true});await rm(authority.directory,{recursive:true,force:true});}};
}

test('serialized serving pair is configured, published and installed into the Worker through protected custody',async()=>{
 const f=await servingFixture();try{
  await f.operation('stage',f.components[1]);await f.operation('activate',f.components[1]);await f.operation('stage',f.components[0]);await f.operation('activate',f.components[0]);
  const version=f.service.workers.get('protocol-business').versions[0],binding=version.bindings.find(item=>item.name==='SHOP_NATIVE_SERVING_TARGET_JSON'),target=nativeServingTarget(f.selection,{mainVersion:'1',failureVersion:'1'},f.policy);
  assert.equal(binding.text,canonical(target));assert.equal(f.service.mappings.values().next().value.FunctionArn,target.failureFunctionArn);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/configuration')).length,2);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/code')).length,2);
  assert.deepEqual((await f.provider.runtime()).map(item=>item.component).sort(),['business','native']);
  assert.equal(f.service.cloudErrors.length,0);assert.equal(f.service.brokerErrors.length,0);
 }finally{await f.close();}
});

test('serving metadata and mapping builders reject expanded resources and binding changes before provider access',async()=>{
 const f=await servingFixture();try{
  const builders=requestBuilders(f.policy),target=nativeServingTarget(f.selection,{mainVersion:'4',failureVersion:'7'},f.policy),metadata=materializeServingMetadata(f.targets[0].metadata,target,f.policy,'protocol-business');
  const upload={entrypoint:'index.mjs',metadata,modules:[{name:'index.mjs',type:'application/javascript+module',bytes:Buffer.from('export default {};')}],expectedInventory:[{name:'index.mjs',type:'application/javascript+module',bytes:18,sha256:sha256('export default {};')}]};
  assert.equal((await rehydrateProviderRequest(builders.servingUpdateMapping('7'),{policy:f.policy})).operation,'lambda.serving-update-event-mapping');
  assert.throws(()=>builders.servingUpdateMapping('active'),/numbered/);assert.throws(()=>builders.servingConfigure('unowned',{},'revision'),/environment/);
  assert.throws(()=>materializeServingMetadata({...metadata,compatibility_date:'2027-01-01'},target,f.policy,'protocol-business'),/literal|metadata/);
  const before=f.service.transcript.length;assert.throws(()=>builders.workerUpload('protocol-business',{...upload,metadata:{...metadata,bindings:[...metadata.bindings,{name:'OTHER',type:'plain_text',text:'changed'}]}}),/metadata/);assert.equal(f.service.transcript.length,before);
 }finally{await f.close();}
});

test('missing and forged source qualification cannot send a serving provider mutation',async()=>{
 const f=await servingFixture();try{
  const before=f.service.transcript.filter(item=>item.method!=='GET'&&!item.url.includes('.s3.')&&!item.target?.endsWith('.BatchGetImage')).length;
  const original=f.source.signature.signature;f.source.signature.signature='A'.repeat(original.length-2)+'==';
  await assert.rejects(f.operation('stage',f.components[1]),/signature/);
  assert.equal(f.service.transcript.filter(item=>item.method!=='GET'&&!item.url.includes('.s3.')&&!item.target?.endsWith('.BatchGetImage')).length,before);
 }finally{await f.close();}
 const g=await servingFixture();try{
  const receipt=g.source.payload.nativeQualifications[0],unqualified=g.authority.seal({...receipt.payload,scope:'fixture/provider-loopback',awsImageQualified:false});
  const selection={...g.selection,qualificationDigest:digest(unqualified)},target={...g.targets[1],serving:selection,qualification:{...g.targets[1].qualification,receiptDigest:selection.qualificationDigest}};
  const replacement=g.authority.seal({...g.source.payload,nativeQualifications:[unqualified],nativeServingSelection:selection,nativeServingTargetDigest:digest(target)});assert.throws(()=>verifyHostedAuthority(replacement,{root:g.authority.root,identity:g.authority.identity}),/Real AWS|real provider/);Object.assign(g.source,replacement);
  await assert.rejects(g.operation('stage',g.components[1]),/selection differs|target binding|qualification/);
  assert.equal(g.service.transcript.filter(item=>item.method==='PUT'&&(item.url.endsWith('/code')||item.url.endsWith('/configuration'))).length,0);
 }finally{await g.close();}
});

test('unknown environment acknowledgement is reconciled by GET and never repeats configuration',async()=>{
 const f=await servingFixture();try{
  f.service.faults.dropConfigureAfter=true;
  await assert.rejects(f.operation('stage',f.components[1]),/socket|hang up|acknowledgement|reset/i);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/configuration')).length,1);
  await f.service.stopDrainRevoke();
  const results=await f.writer.withWriter(()=>f.provider.operations('operation-stage-native'));
  assert.equal(results.length,1);assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/configuration')).length,2);
  const resources=f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/configuration')).map(item=>item.url);assert.equal(new Set(resources).size,2);
 }finally{await f.close();}
});

test('lost failure mapping acknowledgement completes the unsent main activation without repeating the map write',async()=>{
 const f=await servingFixture();try{
  await f.operation('stage',f.components[1]);f.service.faults.dropMappingAfter=true;
  await assert.rejects(f.operation('activate',f.components[1]),/socket|hang up|acknowledgement|reset/i);
  assert.equal(f.service.functions.get(f.targets[1].resource).active,null);
  await f.service.stopDrainRevoke();
  const result=await f.writer.withWriter(()=>f.provider.operations('operation-activate-native'));assert.equal(result.length,1);
  assert.equal(f.service.functions.get(f.targets[1].resource).active,'1');
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.includes('/event-source-mappings/')).length,1);
 }finally{await f.close();}
});

test('lost numbered failure publication is found by immutable readback and never published twice',async()=>{
 const f=await servingFixture();try{
  f.service.faults.dropLambdaUploadAfter=true;
  await assert.rejects(f.operation('stage',f.components[1]),/socket|hang up|acknowledgement|reset/i);
  await f.service.stopDrainRevoke();
  const result=await f.writer.withWriter(()=>f.provider.operations('operation-stage-native'));assert.equal(result.length,1);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/code')).length,2);
  assert.equal(f.service.functions.get(f.targets[1].failure.resource).versions.length,1);
  assert.equal(f.service.functions.get(f.targets[1].resource).versions.length,1);
 }finally{await f.close();}
});

test('unexpected role drift and initial failure pointer drift stop before native activation',async()=>{
 const f=await servingFixture();try{
  f.service.functions.get(f.targets[1].failure.resource).latestBinding.Role=`arn:aws:iam::${f.policy.awsAccountId}:role/foreign`;
  await assert.rejects(f.operation('stage',f.components[1]),/outside signed environment/);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&(item.url.endsWith('/configuration')||item.url.endsWith('/code'))).length,0);
 }finally{await f.close();}
 const g=await servingFixture();try{
  await g.operation('stage',g.components[1]);g.service.mappings.values().next().value.FunctionArn=`arn:aws:lambda:${g.policy.region}:${g.policy.awsAccountId}:function:${g.targets[1].failure.resource}:17`;
  await assert.rejects(g.operation('activate',g.components[1]),/outside verified predecessor/);
  assert.equal(g.service.transcript.filter(item=>item.method==='PUT'&&item.url.includes('/event-source-mappings/')).length,0);
  assert.equal(g.service.functions.get(g.targets[1].resource).active,null);
 }finally{await g.close();}
});

test('historical Worker verification retains its recorded numbered pair when current selection changes',async()=>{
 const f=await servingFixture();try{
  await f.operation('stage',f.components[1]);await f.operation('activate',f.components[1]);await f.operation('stage',f.components[0]);
  const old=selectedVersion(f.components[0]),selection={...f.selection,buildId:sha256('later-build')},target={...f.targets[1],serving:selection},targets=[f.targets[0],target],source=f.authority.seal({...f.source.payload,nativeServingSelection:selection,nativeServingTargetDigest:digest(target)});
  const provider=createHostedProvider({policy:f.policy,writer:f.writer,broker:f.service.broker,components:f.components,targets,load:retainedCandidateLoader({bundle:f.bundle,targets}),deploymentId:'123',nativeServingAuthority:source});
  const evidence=await provider.content('business',old.version);assert.equal(evidence.selected.version,old.version);
  const worker=f.service.workers.get('protocol-business').versions[0],original=worker.bindings.find(item=>item.name==='SHOP_NATIVE_SERVING_TARGET_JSON');assert.equal(JSON.parse(original.text).buildId,f.selection.buildId);
  original.text=canonical(nativeServingTarget(selection,{mainVersion:'1',failureVersion:'1'},f.policy));
  const fresh=createHostedProvider({policy:f.policy,writer:f.writer,broker:f.service.broker,components:f.components,targets,load:retainedCandidateLoader({bundle:f.bundle,targets}),deploymentId:'123',nativeServingAuthority:source});await assert.rejects(fresh.content('business',old.version),/target bindings differ/);
 }finally{await f.close();}
});

test('unapplied unknown configuration remains held without a second provider send',async()=>{
 const f=await servingFixture();try{
  f.service.faults.dropConfigureBefore=true;await assert.rejects(f.operation('stage',f.components[1]),/socket|hang up|acknowledgement|reset/i);await f.service.stopDrainRevoke();
  await assert.rejects(f.writer.withWriter(()=>f.provider.operations('operation-stage-native')),/GET-only observation/);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/configuration')).length,1);assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/code')).length,0);
 }finally{await f.close();}
});

test('immutable verification cache binds the failure version and its exact binding',async()=>{
 const f=await servingFixture();try{
  await f.operation('stage',f.components[1]);await f.provider.content('native',selectedVersion(f.components[1]).version);
  const functionState=f.service.functions.get(f.targets[1].failure.resource),previous=functionState.versions[0];functionState.versions.push({...previous,version:'2',revision:'fixture-revision-2',binding:{...previous.binding,Role:`arn:aws:iam::${f.policy.awsAccountId}:role/foreign`}});
  await f.writer.withWriter(()=>f.writer.recordProvider(state=>{state.versions.find(item=>item.selected.component==='native').pair.failureVersion='2';}));
  await assert.rejects(f.provider.content('native',selectedVersion(f.components[1]).version),/target bindings differ/);
 }finally{await f.close();}
});

test('provider Pending and Updating responses are observed to readiness without another mutation',async()=>{
 const f=await servingFixture();try{
  f.service.faults.lambdaPendingReads=2;await f.operation('stage',f.components[1]);f.service.faults.delayMappingAfter=2;await f.operation('activate',f.components[1]);
  assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith('/code')).length,2);assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.includes('/event-source-mappings/')).length,1);
  assert.equal((await f.provider.runtime()).length,1);
 }finally{await f.close();}
});
