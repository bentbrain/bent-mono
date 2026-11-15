import { canonical,check,digest,parseJSON,same,sha256 } from './data.mjs';
import { exactFields,isReadRequest,protocolItemLimit,requestBuilders } from './provider-protocol-builders.mjs';
import { rehydrateProviderRequest } from './request-rehydration.mjs';
import { requestDigest } from './signing.mjs';
import { responseBytes } from './provider-protocol.mjs';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const namespaceValid=(namespace,policy)=>namespace===null||policy.nativeQualification&&/^native-qualification\/[a-f0-9]{64}$/.test(namespace);
function event(bytes,identity,generation){check(sha256(bytes)===identity,'Custody immutable event digest differs');const value=parseJSON(bytes,16*1024*1024);exactFields(value,['schema','generation','previous','state']);check(value.schema==='shop.protected-journal-event/v1'&&value.generation===generation&&(value.previous===null||hash(value.previous))&&value.state&&Buffer.from(canonical(value)).equals(bytes),'Custody immutable event chain differs');return value;}
function object(value){return value?{bodyBase64:value.bytes.toString('base64'),etag:value.etag,versionId:value.versionId,provenance:value.provenance}:null;}
export async function custodyReadMany(input,ports){
 const {policy,assertInstallation,cloudResponse}=ports;
 check((input.owner===null||ports.getCurrent?.().state.owner?.id===input.owner&&ports.getCurrent().state.owner.principalDigest===ports.principal?.principalDigest)&&input.intent===null&&Array.isArray(input.request)&&input.request.length>0&&input.request.length<=32,'Bounded exact read batch required');
 const requests=await Promise.all(input.request.map(request=>rehydrateProviderRequest(request,{policy})));
 check(requests.every(isReadRequest)&&new Set(requests.map(requestDigest)).size===requests.length,'Read batch permits unique admitted read operations only');
 await assertInstallation();const results=[];
 for(const request of requests){const response=await cloudResponse(request);responseBytes(response);results.push({requestDigest:requestDigest(request),response,provenance:{kind:'authenticated-provider'}});}
 const result={schema:'shop.custody-read-batch/v1',complete:true,results};check(Buffer.byteLength(canonical(result))<=32*1024*1024,'Read batch exceeds complete wire bound');await assertInstallation();return result;
}
export async function custodyJournalSnapshot(input,ports){
 const {policy,assertInstallation,storeFor}=ports;
 exactFields(input.intent,['journalNamespace','anchor','before']);const {journalNamespace,anchor,before}=input.intent;
 check(input.owner===null&&input.request===null&&namespaceValid(journalNamespace,policy),'Exact read-only journal snapshot required');
 await assertInstallation();const store=storeFor(journalNamespace),found=await store.get('head.json');
 if(!found){check(anchor===null&&before===null,'Anchored journal disappeared');await assertInstallation();return {schema:'shop.custody-journal-page/v1',head:null,events:[],next:null,complete:true};}
 const head=parseJSON(found.bytes);exactFields(head,['schema','generation','eventDigest']);check(head.schema==='shop.protected-journal-head/v1'&&Number.isSafeInteger(head.generation)&&head.generation>0&&head.generation<=protocolItemLimit&&hash(head.eventDigest),'Complete journal snapshot head required');
 const identity={headDigest:sha256(found.bytes),etag:found.etag,versionId:found.versionId};
 if(anchor!==null)check(same(anchor,identity),'Journal snapshot head changed between pages');
 let next=before?.eventDigest??head.eventDigest,generation=before?.generation??head.generation;
 if(before!==null){exactFields(before,['eventDigest','generation']);check(anchor!==null&&hash(next)&&Number.isSafeInteger(generation)&&generation>0&&generation<head.generation,'Exact anchored snapshot continuation required');}
 const events=[];let bytes=0;
 while(next!==null&&events.length<64){const value=await store.get(`events/${next}.json`);check(value,'Journal snapshot event missing');const parsed=event(value.bytes,next,generation);check(['authenticated-provider','process-verified-immutable-event','local-immutable-event-cache'].includes(value.provenance?.kind),'Unverified custody snapshot provenance');const item={eventDigest:next,bodyBase64:value.bytes.toString('base64'),provenance:{kind:value.provenance.kind==='authenticated-provider'?'authenticated-provider':'custody-verified-immutable-event'}};const size=Buffer.byteLength(canonical(item));if(events.length&&bytes+size>32*1024*1024)break;check(size<=32*1024*1024,'Journal snapshot item exceeds wire bound');events.push(item);bytes+=size;next=parsed.previous;generation--;}
 check(next!==null||generation===0,'Journal snapshot terminates before complete history');const final=await store.get('head.json');check(final&&final.bytes.equals(found.bytes)&&final.etag===found.etag&&final.versionId===found.versionId,'Journal snapshot head changed during page');await assertInstallation();
 return {schema:'shop.custody-journal-page/v1',head:object(found),events,next:next===null?null:{eventDigest:next,generation},complete:next===null};
}
export async function custodyJournalAppend(input,ports){
 const {policy,assertInstallation,storeFor,cloudResponse,getCurrent,update,principal}=ports;
 check(Array.isArray(input.request)&&input.request.length===2&&input.intent===null,'Exact paired journal append required');
 const current=getCurrent(),namespace=current.state.owner?.journalNamespace??null;
 check(current.state.owner?.id===input.owner&&current.state.owner.principalDigest===principal.principalDigest,'Stale paired journal writer rejected');
 const requests=await Promise.all(input.request.map(request=>rehydrateProviderRequest(request,{policy}))),builders=requestBuilders(policy),eventBytes=Buffer.from(requests[0].bodyBase64,'base64'),headBytes=Buffer.from(requests[1].bodyBase64,'base64'),head=parseJSON(headBytes);
 check(requests.every(request=>request.service==='s3'&&request.operation==='store.put'&&request.method==='PUT'),'Journal pair permits exact S3 PUT only');
 exactFields(head,['schema','generation','eventDigest']);check(head.schema==='shop.protected-journal-head/v1'&&Number.isSafeInteger(head.generation)&&head.generation>0&&head.generation<=protocolItemLimit&&head.eventDigest===sha256(eventBytes)&&Buffer.from(canonical(head)).equals(headBytes),'Paired journal head differs');
 const parsed=event(eventBytes,head.eventDigest,head.generation);
 check(requestDigest(requests[0])===requestDigest(builders.storePut(`events/${head.eventDigest}.json`,eventBytes,null,namespace))&&requestDigest(requests[1])===requestDigest(builders.storePut('head.json',headBytes,requests[1].headers['if-match']??null,namespace)),'Journal append moved outside exact owner namespace');
 const store=storeFor(namespace),claimDigests=requests.map(request=>digest({action:'journal',requestDigest:requestDigest(request)})),readbacks=[];
 const observe=async(index)=>{const request=requests[index],key=index===0?`events/${head.eventDigest}.json`:'head.json',response=await cloudResponse(builders.storeGet(key,namespace));responseBytes(response);check(response.status===200&&Buffer.from(response.bodyBase64,'base64').equals(Buffer.from(request.bodyBase64,'base64')),'Journal append outcome absent or changed; GET-only reconciliation required');store.acceptReadback(key,response);return {requestDigest:requestDigest(request),response,provenance:{kind:'authenticated-provider'}};};
 if(claimDigests.some(claim=>getCurrent().state.requests.some(item=>item.claimDigest===claim))){check(claimDigests.every(claim=>getCurrent().state.requests.some(item=>item.claimDigest===claim)),'Partial durable journal claim set');await assertInstallation();for(let index=0;index<2;index++)readbacks.push(await observe(index));await assertInstallation();return {schema:'shop.custody-journal-append/v1',complete:true,acknowledgement:'reconciled',readbacks};}
 // This read-only CAS observation returns no capability. update() checks installation
 // before either durable claim is written, followed by each physical send guard.
 const previous=await store.get('head.json');check(previous?(requests[1].headers['if-match']===previous.etag&&parsed.previous===parseJSON(previous.bytes).eventDigest&&head.generation===parseJSON(previous.bytes).generation+1):(requests[1].headers['if-none-match']==='*'&&parsed.previous===null&&head.generation===1),'Fresh journal append CAS predecessor changed');
 const installationObservation=await update(state=>{for(let index=0;index<2;index++)state.requests.push({claimDigest:claimDigests[index],scope:{action:'journal',requestDigest:requestDigest(requests[index])},requestDigest:requestDigest(requests[index]),wireRequestDigest:requestDigest(requests[index]),action:'journal',owner:input.owner,controllerEventDigest:null,status:'sending'});});
 let reconciled=false;
 for(let index=0;index<2;index++){
  await assertInstallation(index===0?installationObservation:undefined);check(getCurrent().state.owner?.id===input.owner&&getCurrent().state.owner.principalDigest===principal.principalDigest,'Journal owner changed before paired send');let response;
  try{response=await cloudResponse(requests[index],claimDigests[index]);responseBytes(response);check(response.status>=200&&response.status<300,'Journal append provider rejected write');}catch{reconciled=true;}
  const observed=await observe(index);readbacks.push(observed);ports.pendingAcks.set(claimDigests[index],{status:'acknowledged',responseDigest:digest(observed.response),actualResponseDigest:digest(observed.response)});
 }
 // The final provider readback precedes no further send. This serialized in-flight scope
 // must drain before credential replacement; the next operation checks installation afresh.
 return {schema:'shop.custody-journal-append/v1',complete:true,acknowledgement:reconciled?'reconciled':'confirmed',readbacks};
}
