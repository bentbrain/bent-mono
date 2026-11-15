import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createCredentialCustody} from './custody-service.mjs';
import {canonical,sha256} from './data.mjs';
import {requestBuilders} from './provider-protocol-builders.mjs';
import {credentialBrokerBoundary,createHostedWriter} from './hosted-writer.mjs';
import {protocolFixture} from './testing/provider-protocol-transcript.mjs';
import {hostedProtocolFixture} from './testing/hosted-protocol-service.mjs';
import {custodyJournalSnapshot,custodyReadMany} from './custody-batches.mjs';

async function fixture(){const policy=protocolFixture().policy,service=await hostedProtocolFixture({policy,targets:[]}),broker=service.broker,writer=createHostedWriter({policy,broker,fenceAdmission:service.fenceAdmission});return {policy,service,broker,writer,builders:requestBuilders(policy),close:()=>service.close()};}
const providerWrites=f=>f.service.transcript.filter(item=>item.method==='PUT').length;

test('actual paired append returns fresh event/head readbacks and the bounded snapshot retains verified cache provenance',async()=>{
 const f=await fixture();try{
  await f.writer.withWriter(async({commit})=>{await commit({phase:'one'});await commit({phase:'two'});});
  const snapshot=await f.broker.journalSnapshot();assert.equal(snapshot.events.length,2);assert.equal(snapshot.head.provenance.kind,'authenticated-provider');assert(snapshot.events.every(item=>item.provenance.kind==='custody-verified-immutable-event'));
  snapshot.events[0].bodyBase64=Buffer.from('{}').toString('base64');const intact=await f.broker.journalSnapshot();assert.notEqual(intact.events[0].bodyBase64,snapshot.events[0].bodyBase64);
  const batches=f.service.brokerCalls.filter(item=>item.action==='journal-append');assert.equal(batches.length,2);assert.equal(f.service.brokerCalls.filter(item=>item.action==='journal').length,0);
  const requests=(await f.service.executor.readState()).requests;assert.equal(requests.filter(item=>item.action==='journal').length,4);assert(requests.filter(item=>item.action==='journal').every(item=>item.status==='acknowledged'));
 }finally{await f.close();}
});

test('read-many validates every member and rejects mutation, duplicates, foreign resources and oversized lists before any cloud read',async()=>{
 const f=await fixture();try{
  const read=f.builders.workerVersions(f.policy.workers[0].name),other=f.builders.lambdaVersions(f.policy.functions[0].name),before=f.service.transcript.length;
  await assert.rejects(f.broker.readMany([read,read]),/unique/);await assert.rejects(f.broker.readMany(Array(33).fill(read)),/Bounded/);await assert.rejects(f.broker.readMany([read,f.builders.workerActivate(f.policy.workers[0].name,'00000000-0000-4000-8000-000000000000')]),/read batch/);
  const forged=structuredClone(other);forged.url=forged.url.replace(f.policy.functions[0].name,'foreign-function');await assert.rejects(f.broker.readMany([read,forged]),/outside|reconstruction|allowlist/);assert.equal(f.service.transcript.length,before);
 }finally{await f.close();}
});

test('a signed truncated read batch is rejected by the real client',async()=>{
 const f=await fixture();try{
  const broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:async input=>{const answer=await f.service.boundary(input);if(input.action==='read-many')answer.payload.result.results.pop();return f.service.signRoot(answer.payload);}});
  await assert.rejects(broker.readMany([f.builders.workerVersions(f.policy.workers[0].name),f.builders.workerDeployments(f.policy.workers[0].name)]),/Complete signed read batch/);
 }finally{await f.close();}
});

for(const key of['event','head'])for(const when of['before','after'])test(`unknown ${key} acknowledgement ${when} send reconciles only actual readbacks and never repeats PUT`,async()=>{
 const f=await fixture();try{
  f.service.faults.journalFault={key,when};let error;
  try{await f.writer.withWriter(({commit})=>commit({phase:'one'}));}catch(value){error=value;}
  if(when==='after'){assert.equal(error,undefined);assert.equal((await f.writer.readHead()).state.phase,'one');}
  else{assert(error);const before=providerWrites(f);await assert.rejects(f.writer.withWriter(({commit})=>commit({phase:'one'})),/active|held|writer/i);assert.equal(providerWrites(f),before);}
  const state=await f.service.executor.readState(),claims=state.requests.filter(item=>item.action==='journal');assert.equal(claims.length,2);assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.includes('/release-v2/')&&item.url.endsWith('/head.json')).length,key==='event'&&when==='before'?0:1);
 }finally{await f.close();}
});

test('stale owner and controller CAS head cannot dispatch a paired append',async()=>{
 const f=await fixture();try{
  const owner=await f.broker.open();await f.broker.close(owner);const event={schema:'shop.protected-journal-event/v1',generation:1,previous:null,state:{phase:'one'}},bytes=Buffer.from(canonical(event)),head=Buffer.from(canonical({schema:'shop.protected-journal-head/v1',generation:1,eventDigest:sha256(bytes)})),requests=[f.builders.storePut(`events/${sha256(bytes)}.json`,bytes,null),f.builders.storePut('head.json',head,null)];
  const before=providerWrites(f);await assert.rejects(f.broker.journalAppend(owner,requests),/Stale/);assert.equal(providerWrites(f),before);
  await f.writer.withWriter(({commit})=>commit({phase:'one'}));const next=await f.broker.open();const count=providerWrites(f);await assert.rejects(f.broker.journalAppend(next,requests),/CAS predecessor/);assert.equal(providerWrites(f),count);await f.broker.close(next);
 }finally{await f.close();}
});

test('snapshot cached and freshly supplied corrupt event bytes fail before admission',async()=>{
 const bytes=Buffer.from(canonical({schema:'shop.protected-journal-event/v1',generation:1,previous:null,state:{phase:'one'}})),identity=sha256(bytes),head=Buffer.from(canonical({schema:'shop.protected-journal-head/v1',generation:1,eventDigest:identity}));
 for(const kind of['authenticated-provider','process-verified-immutable-event']){
  const store={get:async key=>key==='head.json'?{bytes:head,etag:'"one"',versionId:'v1',provenance:{kind:'authenticated-provider'}}:{bytes:Buffer.from('{}'),provenance:{kind}}};
  await assert.rejects(custodyJournalSnapshot({owner:null,request:null,intent:{journalNamespace:null,anchor:null,before:null}},{policy:protocolFixture().policy,assertInstallation:async()=>{},storeFor:()=>store}),/digest differs/);
 }
});

test('complete journal snapshot pages bind each continuation and reject truncation',async()=>{
 const f=await fixture();try{
  await f.writer.withWriter(async({commit})=>{for(let index=0;index<65;index++)await commit({phase:'page',index});});
  const before=f.service.brokerCalls.length,snapshot=await f.broker.journalSnapshot();assert.equal(snapshot.events.length,65);assert.equal(f.service.brokerCalls.slice(before).filter(item=>item.action==='journal-snapshot').length,2);
  const broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:async input=>{const answer=await f.service.boundary(input);if(input.action==='journal-snapshot'){answer.payload.result.next=null;answer.payload.result.complete=true;}return f.service.signRoot(answer.payload);}});
  await assert.rejects(broker.journalSnapshot(),/Truncated/);
 }finally{await f.close();}
});


test('replacement after an uncertain second journal send retains both claims and permits GET-only reconciliation',async()=>{
 const f=await fixture();try{
  const owner=await f.broker.open(),value={schema:'shop.protected-journal-event/v1',generation:1,previous:null,state:{phase:'one'}},bytes=Buffer.from(canonical(value)),head=Buffer.from(canonical({schema:'shop.protected-journal-head/v1',generation:1,eventDigest:sha256(bytes)})),requests=[f.builders.storePut(`events/${sha256(bytes)}.json`,bytes,null),f.builders.storePut('head.json',head,null)];
  f.service.faults.journalFault={key:'head',when:'before'};await assert.rejects(f.broker.journalAppend(owner,requests),/outcome absent/);
  const installation=f.service.signRoot({...f.service.installation.payload,installationId:randomUUID(),credentialEpoch:'batch-replacement'}),replacement=f.service.signRoot({schema:'shop.custody-installation-replacement/v1',fenceDigest:f.service.fenceAdmission.digest,previousInstallationId:f.service.installation.payload.installationId,previousCredentialEpoch:f.service.installation.payload.credentialEpoch,newInstallationId:installation.payload.installationId,credentialsRevoked:true,stopped:true,drained:true,issuedAt:Date.now(),expiresAt:Date.now()+60000}),next=await createCredentialCustody({...f.service.factoryOptions,installation,replacement}),broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:input=>next.handle(input,{authorization:'Bearer synthetic-loopback-controller'})});
  const retained=(await next.readState()).requests.filter(item=>item.action==='journal');assert.equal(retained.length,2);assert(retained.every(item=>item.status==='sending'));
  const nextOwner=await broker.open(),before=providerWrites(f);await assert.rejects(broker.journalAppend(nextOwner,requests),/outcome absent/);assert.equal(providerWrites(f),before);await broker.close(nextOwner);
 }finally{await f.close();}
});

test('snapshot rejects changed anchored heads and forged duplicate or oversized signed event pages',async()=>{
 const f=await fixture();try{
  await f.writer.withWriter(async({commit})=>{await commit({phase:'one'});await commit({phase:'two'});});
  const snapshot=await f.broker.journalSnapshot(),anchor={headDigest:sha256(Buffer.from(snapshot.head.bodyBase64,'base64')),etag:snapshot.head.etag,versionId:snapshot.head.versionId};
  await f.writer.withWriter(({commit})=>commit({phase:'three'}));
  await assert.rejects(f.service.executor.handle({schema:'shop.credential-broker-call/v1',action:'journal-snapshot',nonce:randomUUID(),fenceDigest:f.service.fenceAdmission.digest,environmentId:'synthetic-qualification',owner:null,request:null,intent:{journalNamespace:null,anchor,before:{eventDigest:sha256('old'),generation:1}}},{authorization:'Bearer synthetic-loopback-controller'}),/head changed between pages/);
  for(const mode of['duplicate','oversized','first-link']){
   const broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:async input=>{const answer=await f.service.boundary(input);if(input.action==='journal-snapshot'){const page=answer.payload.result;if(mode==='duplicate')page.events[1]=page.events[0];else if(mode==='oversized')page.events=Array(65).fill(page.events[0]);else page.events.shift();}return f.service.signRoot(answer.payload);}});
   await assert.rejects(broker.journalSnapshot(),/chain changed|anchored journal page/);
  }
 }finally{await f.close();}
});


test('read batches require fresh installation both before and after actual reads',async()=>{
 const policy=protocolFixture().policy,request=requestBuilders(policy).workerVersions(policy.workers[0].name);let fresh=0,reads=0;
 await assert.rejects(custodyReadMany({owner:null,intent:null,request:[request]},{policy,assertInstallation:async()=>{fresh++;if(fresh===2)throw Error('installation changed');},cloudResponse:async()=>{reads++;return {status:200,complete:true,headers:{},bodyBase64:Buffer.from('{}').toString('base64')};}}),/installation changed/);
 assert.equal(fresh,2);assert.equal(reads,1);
});

test('owner recovery waits until the entire read batch has drained',async()=>{
 const f=await fixture();try{
  const installation=f.service.signRoot({...f.service.installation.payload,installationId:randomUUID(),credentialEpoch:'batch-drain'}),replacement=f.service.signRoot({schema:'shop.custody-installation-replacement/v1',fenceDigest:f.service.fenceAdmission.digest,previousInstallationId:f.service.installation.payload.installationId,previousCredentialEpoch:f.service.installation.payload.credentialEpoch,newInstallationId:installation.payload.installationId,credentialsRevoked:true,stopped:true,drained:true,issuedAt:Date.now(),expiresAt:Date.now()+60000});let begin,release;
  const began=new Promise(resolve=>{begin=resolve;}),gate=new Promise(resolve=>{release=resolve;}),transport=async(...args)=>{const response=await f.service.factoryOptions.transport(...args);if(args[0].operation==='worker.versions'){begin();await gate;}return response;},next=await createCredentialCustody({...f.service.factoryOptions,installation,replacement,transport}),broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:input=>next.handle(input,{authorization:'Bearer synthetic-loopback-controller'})}),owner=await broker.open();
  const read=broker.readMany([f.builders.workerVersions(f.policy.workers[0].name)]);await began;let recovered=false;
  const recovery=next.recoverOwner(f.service.signRoot({schema:'shop.custody-owner-recovery/v1',fenceDigest:f.service.fenceAdmission.digest,installationId:installation.payload.installationId,owner,controllerStopped:true,issuedAt:Date.now(),expiresAt:Date.now()+60000})).then(value=>{recovered=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(recovered,false);release();await read;assert.equal((await recovery).status,'owner-revoked');
 }finally{await f.close();}
});

test('replacement between event readback and the unsent head preserves both durable claims without any replay',async()=>{
 const f=await fixture();try{
  const replace=async(previous,epoch,transport)=>{
   const installation=f.service.signRoot({...previous.payload,installationId:randomUUID(),credentialEpoch:epoch}),replacement=f.service.signRoot({schema:'shop.custody-installation-replacement/v1',fenceDigest:f.service.fenceAdmission.digest,previousInstallationId:previous.payload.installationId,previousCredentialEpoch:previous.payload.credentialEpoch,newInstallationId:installation.payload.installationId,credentialsRevoked:true,stopped:true,drained:true,issuedAt:Date.now(),expiresAt:Date.now()+60000}),service=await createCredentialCustody({...f.service.factoryOptions,installation,replacement,...(transport?{transport}:{})}),broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:input=>service.handle(input,{authorization:'Bearer synthetic-loopback-controller'})});return {installation,service,broker};
  };
  const stopped=await replace(f.service.installation,'stopped-before-head',async(...args)=>{if(args[0].method==='PUT'&&args[0].url.endsWith(`/${f.policy.store.prefix}/head.json`))throw Error('service stopped before second send');return f.service.factoryOptions.transport(...args);}),owner=await stopped.broker.open(),value={schema:'shop.protected-journal-event/v1',generation:1,previous:null,state:{phase:'one'}},bytes=Buffer.from(canonical(value)),head=Buffer.from(canonical({schema:'shop.protected-journal-head/v1',generation:1,eventDigest:sha256(bytes)})),requests=[f.builders.storePut(`events/${sha256(bytes)}.json`,bytes,null),f.builders.storePut('head.json',head,null)];
  await assert.rejects(stopped.broker.journalAppend(owner,requests),/outcome absent/);assert.equal(f.service.transcript.filter(item=>item.method==='PUT'&&item.url.endsWith(`/${f.policy.store.prefix}/head.json`)).length,0);
  const next=await replace(stopped.installation,'after-stop'),claims=(await next.service.readState()).requests.filter(item=>item.action==='journal');assert.equal(claims.length,2);assert(claims.every(item=>item.status==='sending'));const nextOwner=await next.broker.open(),before=providerWrites(f);await assert.rejects(next.broker.journalAppend(nextOwner,requests),/outcome absent/);assert.equal(providerWrites(f),before);await next.broker.close(nextOwner);
 }finally{await f.close();}
});

test('owner-bound checkpoint rejects forged, changed-owner, replayed and intervened observations',async()=>{
 const f=await fixture();try{
  const owner=await f.broker.open(),requests=[f.builders.workerVersions(f.policy.workers[0].name)],observation=await f.broker.checkpoint(owner,requests),original=observation.responses[0].bodyBase64;observation.responses[0].bodyBase64='e30=';
  assert.throws(()=>f.broker.consumeCheckpoint({},owner),/checkpoint/);assert.throws(()=>f.broker.consumeCheckpoint(observation.token,'foreign-owner'),/checkpoint/);assert.equal(f.broker.consumeCheckpoint(observation.token,owner)[0].bodyBase64,original);assert.throws(()=>f.broker.consumeCheckpoint(observation.token,owner),/replayed/);
  const changed=await f.broker.checkpoint(owner,requests);await f.broker.read(requests[0]);assert.throws(()=>f.broker.consumeCheckpoint(changed.token,owner),/intervened/);await f.broker.close(owner);
 }finally{await f.close();}
});

test('fresh unchanged heads reuse the entire verified chain and return independent immutable copies',async()=>{
 const f=await fixture();try{
  await f.writer.withWriter(({commit})=>commit({phase:'prepared',value:1}));const before=f.service.brokerCalls.filter(item=>item.action==='journal-snapshot').length,first=await f.writer.readHead();first.state.value=99;assert.equal((await f.writer.readHead()).state.value,1);assert.equal(f.service.brokerCalls.filter(item=>item.action==='journal-snapshot').length,before);
  const head=f.service.objects.get('head.json');head.bytes=Buffer.from(canonical({schema:'shop.protected-journal-head/v1',generation:2,eventDigest:sha256('missing-event')}));head.etag='"changed"';head.versionId='changed';await assert.rejects(f.writer.readHead(),/event missing/);assert(f.service.brokerCalls.filter(item=>item.action==='journal-snapshot').length>before);
 }finally{await f.close();}
});

test('send checkpoint requires the exact actual head and cannot survive an intervening broker operation',async()=>{
 const f=await fixture();try{
  await f.writer.withWriter(async({commit})=>{await commit({phase:'stage-reconcile',operation:{id:'one'}});const checkpoint=await f.writer.readSendCheckpoint();checkpoint.state.operation.id='tampered';await f.writer.assertOwner();assert.equal((await f.writer.readHead()).state.operation.id,'one');});
  await assert.rejects(f.writer.withWriter(async({commit})=>{await commit({phase:'stage-reconcile',operation:{id:'two'}});await f.writer.readSendCheckpoint();await f.broker.read(f.builders.workerVersions(f.policy.workers[0].name));await f.writer.assertOwner();}),/intervened/);
 }finally{await f.close();}
});

test('changed remote send head fails before any runtime provider mutation',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.writer.withWriter(async({commit})=>{await commit({phase:'stage-reconcile',operation:{id:'one'}});const head=f.service.objects.get('head.json');head.etag='"external"';await f.writer.readSendCheckpoint();}),/checkpoint head changed/);assert.equal(f.service.transcript.filter(item=>item.method==='POST').length,0);
 }finally{await f.close();}
});

test('inventory observation batches a fresh exact head and reuses only its verified history inside one callback',async()=>{
 const f=await fixture();try{
  await f.writer.withWriter(({commit})=>commit({phase:'prepared',value:1}));const before=f.service.brokerCalls.length;
  await f.writer.withInventoryRead([f.builders.workerVersions(f.policy.workers[0].name)],async responses=>{assert.equal(responses.length,1);await f.writer.readProviderState();assert.equal((await f.writer.readVerifiedHistory()).state.value,1);await assert.rejects(f.writer.withInventoryRead([],async()=>{}),/Single complete/);});
  assert.deepEqual(f.service.brokerCalls.slice(before).map(item=>item.action),['read-many']);const head=f.service.objects.get('head.json');head.etag='"changed-inventory"';await assert.rejects(f.writer.withInventoryRead([f.builders.workerVersions(f.policy.workers[0].name)],async()=>{}),/Inventory baseline head changed/);
 }finally{await f.close();}
});

test('a concurrent broker operation prevents checkpoint creation and cannot acquire a reused sequence',async()=>{
 const f=await fixture();try{
  let entered,release;const began=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;}),broker=credentialBrokerBoundary({fenceAdmission:f.service.fenceAdmission,boundary:async input=>{if(input.action==='read-many'){entered();await gate;}return f.service.boundary(input);}}),owner=await broker.open(),request=f.builders.workerVersions(f.policy.workers[0].name),pending=broker.checkpoint(owner,[request]);await began;await broker.read(request);release();await assert.rejects(pending,/request intervened/);await broker.close(owner);
 }finally{await f.close();}
});

test('stale installation is rejected before either journal claim or provider mutation',async()=>{
 const f=await fixture();try{
  const owner=await f.broker.open(),installation=f.service.signRoot({...f.service.installation.payload,installationId:randomUUID(),credentialEpoch:'stale-append-test'}),replacement=f.service.signRoot({schema:'shop.custody-installation-replacement/v1',fenceDigest:f.service.fenceAdmission.digest,previousInstallationId:f.service.installation.payload.installationId,previousCredentialEpoch:f.service.installation.payload.credentialEpoch,newInstallationId:installation.payload.installationId,credentialsRevoked:true,stopped:true,drained:true,issuedAt:Date.now(),expiresAt:Date.now()+60000});await createCredentialCustody({...f.service.factoryOptions,installation,replacement});
  const bytes=Buffer.from(canonical({schema:'shop.protected-journal-event/v1',generation:1,previous:null,state:{phase:'one'}})),head=Buffer.from(canonical({schema:'shop.protected-journal-head/v1',generation:1,eventDigest:sha256(bytes)})),before=providerWrites(f);await assert.rejects(f.broker.journalAppend(owner,[f.builders.storePut(`events/${sha256(bytes)}.json`,bytes,null),f.builders.storePut('head.json',head,null)]),/installation changed/);assert.equal(providerWrites(f),before);assert.equal((await f.service.executor.readState()).requests.filter(item=>item.action==='journal').length,0);
 }finally{await f.close();}
});
