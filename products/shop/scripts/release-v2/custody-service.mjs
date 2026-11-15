import {custodyReadMany,custodyJournalSnapshot,custodyJournalAppend} from './custody-batches.mjs';
import { verifyHostedWorkerCandidate } from './hosted-provider.mjs';
import { verifyHostedAuthority } from './hosted-admission.mjs';
import { assertServingSelection, nativeServingTarget } from './serving-provider.mjs';
import { verifyLambdaQualified, lambdaBindingProjection } from './provider-protocol.mjs';
import { selectedVersion } from './component-identity.mjs';
import { nativeMappingProjection } from './native-qualification-policy.mjs';
import { randomUUID, verify } from 'node:crypto';
import { canonical, check, digest, parseJSON, same,sha256 } from './data.mjs';
import { assertPolicy, exactFields, isReadRequest, requestBuilders } from './provider-protocol-builders.mjs';
import { appendProtectedJournal, protectedStore, readProtectedJournal } from './protected-store.mjs';
import { protocolClient, ProtocolFailure, responseBytes } from './provider-protocol.mjs';
import { assertCredentialFence } from './hosted-writer.mjs';
import { requestDigest } from './signing.mjs';
import { createProviderSigner } from './provider-credentials.mjs';
import { createHttpsTransport } from './https-transport.mjs';
import { createWorkObserver, createRetainedAssetResolver } from './custody-observations.mjs';
import { createActionsAuthenticator } from './actions-authentication.mjs';
import { rehydrateProviderRequest, materializeProviderCapabilities } from './request-rehydration.mjs';
import { admitNativeBootstrap,verifyNativeQualificationReceipt } from './native-qualification.mjs';
import { createNativeFixtureGrant, nativeFixtureEvent, nativeFixtureStageQueries, nativeFixtureCleanupQueries } from './native-fixture-protocol.mjs';

function rootReceipt(envelope, admission) {
  exactFields(envelope, ['keyId', 'payload', 'signature']); const key = admission.keys.find(item => item.id === envelope.keyId);
  check(key && typeof envelope.signature === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature) && verify(null, Buffer.from(canonical(envelope.payload)), key.publicKey, Buffer.from(envelope.signature, 'base64')), 'Custody root signature differs'); return envelope.payload;
}
function installationReceipt(receipt, admission, custodyPolicy) {
  const value = rootReceipt(receipt, admission);
  exactFields(value, ['schema', 'fenceDigest', 'environmentId', 'installationId', 'credentialEpoch', 'custodyPolicyDigest', 'issuedAt', 'expiresAt']);
  check(value.schema === 'shop.credential-installation/v1' && value.fenceDigest === admission.digest && value.environmentId === admission.payload.environmentId &&
    /^[a-f0-9-]{36}$/.test(value.installationId) && /^[a-z0-9-]{1,128}$/.test(value.credentialEpoch) && value.custodyPolicyDigest === digest(custodyPolicy) &&
    Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.issuedAt <= Date.now() && value.expiresAt > Date.now(), 'Pinned credential installation receipt required'); return value;
}

export async function preflightCustodyRequests({ policy, custodyPolicy, fenceAdmission, installation, assetCatalog }) {
  assertPolicy(policy); assertPolicy(custodyPolicy); assertCredentialFence(fenceAdmission);
  check(fenceAdmission.payload.policyDigest === digest(policy) && (custodyPolicy.store.bucket !== policy.store.bucket || custodyPolicy.store.prefix !== policy.store.prefix), 'Independently pinned custody request graph required');
  const installed = installationReceipt(installation, fenceAdmission, custodyPolicy), main = requestBuilders(policy), custody = requestBuilders(custodyPolicy), requests = [], eventDigest = '0'.repeat(64);
  for (const builders of [main, custody]) {
    requests.push({ request: builders.storeGet('head.json'), deferred: [] }, { request: builders.storeGet(`events/${eventDigest}.json`), deferred: ['eventDigest'] },
      { request: builders.storePut('head.json', Buffer.from(canonical({ schema: 'shop.protected-journal-head/v1', generation: 1, eventDigest })), null), deferred: ['generation', 'eventDigest', 'if-match'] },
      { request: builders.storePut(`events/${eventDigest}.json`, Buffer.from(canonical({ schema: 'shop.protected-journal-event/v1', generation: 1, previous: null, state: { installation: installed } })), null), deferred: ['journalState', 'eventDigest'] });
  }
  if (policy.workInventory) for (let index = 0; index < policy.workInventory.queries.length; index++) requests.push({ request: main.workQuery(index), deferred: [] });
  const manifests = [];
  if (assetCatalog) {
    const resolve = createRetainedAssetResolver(assetCatalog);
    for (const entry of assetCatalog.entries) { check(policy.workers.some(worker => worker.name === entry.resource), 'Custody asset resource differs from admitted policy'); const assets = await resolve({ resource: entry.resource, manifestDigest: entry.manifestDigest }); const session = main.assetSession(entry.resource, assets); requests.push({ request: session, deferred: [] }); manifests.push({ resource: entry.resource, manifestDigest: entry.manifestDigest }); }
  }
  return Object.freeze({ schema: 'shop.custody-request-graph/v1', policyDigest: digest(policy), custodyPolicyDigest: digest(custodyPolicy), fenceDigest: fenceAdmission.digest, installationId: installed.installationId, credentialEpoch: installed.credentialEpoch, requests, assetManifests: manifests, digest: digest({ requests, manifests }), providerWrites: 0 });
}

// Run this executor inside the independently admitted credential installation.
// Its controller-facing boundary returns provider responses and signed receipts,
// never provider credential headers. Storage, identity verification and signing
// are explicit protected adapters. Missing adapters fail before installation.
export async function createCredentialCustody({ policy, custodyPolicy, custodyStore, fenceAdmission, installation, replacement = null,
  providerCredentials, signer = providerCredentials ? createProviderSigner({ policy, ...providerCredentials }) : undefined, trust, transport = createHttpsTransport({ policy }), attest, authenticate, authenticationRoot = null, nativeBootstrapRoot = authenticationRoot, nativeFixtureGrantKey = null, observeWork, assetCatalog, resolveAssets = assetCatalog ? createRetainedAssetResolver(assetCatalog) : undefined }) {
  assertPolicy(policy); assertPolicy(custodyPolicy); assertCredentialFence(fenceAdmission);
  check(fenceAdmission?.payload?.policyDigest === digest(policy) && (custodyPolicy.store.bucket !== policy.store.bucket || custodyPolicy.store.prefix !== policy.store.prefix), 'Independently pinned custody journal namespace required');
  let authenticatePrincipal = authenticate ?? (authenticationRoot ? createActionsAuthenticator({ root: authenticationRoot, policy, fenceAdmission }) : null);
  check(custodyStore && typeof authenticatePrincipal === 'function' && typeof attest === 'function' && (typeof observeWork === 'function' || policy.workInventory) && typeof signer === 'function', 'Protected custody storage, identity, attestation and provider signer adapters required');
  if (providerCredentials?.getCredentials) check(providerCredentials.credentialEpoch === installation.payload?.credentialEpoch, 'Renewable signer epoch differs from installed custody epoch');
  const requestGraph = await preflightCustodyRequests({ policy, custodyPolicy, fenceAdmission, installation, assetCatalog });
  let installed = installationReceipt(installation, fenceAdmission, custodyPolicy), client = protocolClient({ policy, signer, trust, transport }), controllerStore = protectedStore(client, policy);
  const controllerStores = new Map([[null,controllerStore]]);
  const storeFor = namespace => {
    if (!controllerStores.has(namespace)) { const builders = requestBuilders(policy); controllerStores.set(namespace,protectedStore({ send:client.send, builders:{ ...builders,storeGet:key=>builders.storeGet(key,namespace),storePut:(key,bytes,etag)=>builders.storePut(key,bytes,etag,namespace) } },policy,{eventCacheNamespace:digest({policy:digest(policy),namespace})})); }
    return controllerStores.get(namespace);
  };
  const observeAcceptedWork = observeWork ?? createWorkObserver({ policy, client });
  if(nativeFixtureGrantKey){const pin=policy.nativeQualification?.fixtureLifecycle?.grantKey;check(pin&&nativeFixtureGrantKey.id===pin.id&&nativeFixtureGrantKey.version===pin.version&&sha256(nativeFixtureGrantKey.secret)===pin.secretSha256,'Actual installed native fixture grant key/version differs');}
  let current = await readProtectedJournal(custodyStore), inflight = 0, queue = Promise.resolve(); const pendingJournalAcks = new Map(), installationReadbacks = new WeakSet();
  if (current) {
    check(replacement, 'Existing credential installation remains held; explicit stop/drain/credential revocation is required');
    const proof = rootReceipt(replacement, fenceAdmission);
    exactFields(proof, ['schema', 'fenceDigest', 'previousInstallationId', 'previousCredentialEpoch', 'newInstallationId', 'credentialsRevoked', 'stopped', 'drained', 'issuedAt', 'expiresAt']);
    check(proof.schema === 'shop.custody-installation-replacement/v1' && proof.fenceDigest === fenceAdmission.digest && proof.previousInstallationId === current.state.installation.installationId &&
      proof.previousCredentialEpoch === current.state.installation.credentialEpoch && proof.newInstallationId === installed.installationId && proof.credentialsRevoked === true && proof.stopped === true && proof.drained === true &&
      installed.credentialEpoch !== current.state.installation.credentialEpoch && proof.issuedAt <= Date.now() && proof.expiresAt > Date.now(), 'Stopped, drained and revoked previous credential epoch required');
  }
  const state = { schema: 'shop.credential-custody-state/v1', environmentId: fenceAdmission.payload.environmentId, installation: installed, owner: null,
    tokens: current?.state.tokens ?? [], requests: current?.state.requests ?? [], recoveries: current?.state.recoveries ?? [] };
  current = await appendProtectedJournal(custodyStore, current, state);
  const assertInstallation = async observation => {
    check(installed.expiresAt > Date.now() && fenceAdmission.payload.expiresAt > Date.now(), 'Credential installation authority expired');
    if(observation&&observation===current&&installationReadbacks.has(observation)){installationReadbacks.delete(observation);return;}
    const headObject = await custodyStore.get('head.json'), observed = headObject ? parseJSON(headObject.bytes) : null;
    check(observed && same(observed, current.head), 'Credential installation changed; stale service cannot dispatch');
  };
  const update = async mutate => {
    await assertInstallation(); const state = structuredClone(current.state); await mutate(state);
    for (const [claimDigest,ack] of pendingJournalAcks) { const record = state.requests.find(item => item.claimDigest === claimDigest); check(record?.status === 'sending' && record.action === 'journal', 'Pending journal outcome lost its durable claim'); Object.assign(record,ack); }
    check(state.requests.length <= 4096 && state.recoveries.length <= 128 && current.head.generation < 4096, 'Custody journal bounds exceeded');
    // Startup verifies the full immutable chain. This sole installation retains
    // each verified predecessor, then verifies fresh event/head readbacks and a
    // current ETag for every append. It does not download the same history for
    // every provider GET.
    const event = { schema: 'shop.protected-journal-event/v1', generation: current.head.generation + 1, previous: current.head.eventDigest, state }, eventDigest = digest(event);
    await custodyStore.put(`events/${eventDigest}.json`, Buffer.from(canonical(event)), null);
    const head = { schema: 'shop.protected-journal-head/v1', generation: event.generation, eventDigest }, saved = await custodyStore.put('head.json', Buffer.from(canonical(head)), current.etag);
    current = { head, state, etag: saved.etag, versionId: saved.versionId, events: [...current.events, { digest: eventDigest, event }] }; pendingJournalAcks.clear();installationReadbacks.add(current); return current;
  };
  const run = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  async function cloudResponse(request, intentDigest = null) {
    try { return await client.send(request, { intentDigest }); }
    catch (error) {
      if (error instanceof ProtocolFailure) return { status: error.status, complete: true, headers: {}, bodyBase64: Buffer.from('{}').toString('base64') };
      throw error;
    }
  }
  const service = {
    handle: (input, identityContext) => run(async () => {
      exactFields(input, ['schema', 'action', 'nonce', 'fenceDigest', 'environmentId', 'owner', 'request', 'intent']);
      check(input.schema === 'shop.credential-broker-call/v1' && input.fenceDigest === fenceAdmission.digest && input.environmentId === fenceAdmission.payload.environmentId && /^[a-f0-9-]{36}$/.test(input.nonce), 'Exact custody call identity required');
      const principal = await authenticatePrincipal(input, identityContext);
      check(principal && principal.environmentId === input.environmentId && principal.policyDigest === digest(policy) && principal.fenceDigest === fenceAdmission.digest && /^[a-f0-9]{64}$/.test(principal.principalDigest), 'Authenticated protected controller principal required');
      if (!['open','close','journal','dispatch','read-many','journal-snapshot','journal-append'].includes(input.action)) await assertInstallation(); let owner = input.owner, result;
      if(['read-many','journal-snapshot','journal-append'].includes(input.action)){inflight++;try{const ports={policy,assertInstallation,storeFor,cloudResponse,getCurrent:()=>current,update,principal,pendingAcks:pendingJournalAcks};result=input.action==='read-many'?await custodyReadMany(input,ports):input.action==='journal-snapshot'?await custodyJournalSnapshot(input,ports):await custodyJournalAppend(input,ports);}finally{inflight--;}}
      else if (input.action === 'open') {
        const namespace = input.intent?.journalNamespace ?? null;
        check(namespace === null || policy.nativeQualification && nativeBootstrapRoot && /^native-qualification\/[a-f0-9]{64}$/.test(namespace), 'Admitted isolated native journal namespace required');
        check(input.intent === null || same(input.intent,{journalNamespace:namespace}), 'Exact credential owner journal scope required');
        check(current.state.owner === null && inflight === 0, 'Credential writer is held; explicit stop/drain/revoke is required'); owner = randomUUID();
        await update(state => { state.owner = { id: owner, principalDigest: principal.principalDigest, journalNamespace:namespace }; }); result = { exclusive: true, outstanding: 0 };
      } else if (input.action === 'work-inventory') {
        check(input.owner === null && input.request === null, 'Work inventory is a read-only custody action');
        const observed = await observeAcceptedWork();
        check(observed?.complete === true && Array.isArray(observed.jobs) && observed.jobs.length <= 4096 && /^[a-f0-9]{64}$/.test(observed.queryDigest), 'Complete protected accepted-work readback required');
        result = { schema: 'shop.accepted-work-observation/v1', environmentId: input.environmentId, complete: true, queryDigest: observed.queryDigest, observedAt: Date.now(), jobs: observed.jobs };
      } else if (input.action === 'read') {
        const request = await rehydrateProviderRequest(input.request, { policy }); check(input.owner === null && isReadRequest(request), 'Custody read action permits GET only'); result = await cloudResponse(request);
      } else {
        check(current.state.owner?.id === input.owner && current.state.owner.principalDigest === principal.principalDigest, 'Stale credential writer rejected');
        if(input.action==='native-fixture-grant'){
          const namespace=current.state.owner.journalNamespace;check(namespace&&input.intent?.journalNamespace===namespace&&input.request===null&&nativeFixtureGrantKey&&nativeBootstrapRoot,'Protected owner-scoped native fixture grant installation required');
          const journal=await readProtectedJournal(storeFor(namespace)),bootstrap=journal?.state.controller.bootstrap,plan=bootstrap?.planBase64?parseJSON(Buffer.from(bootstrap.planBase64,'base64'),16*1024*1024,{finiteFractions:true}):null;
          check(journal?.head.eventDigest===input.intent.eventDigest&&plan&&digest(plan)===bootstrap.planDigest&&namespace===`native-qualification/${plan.imageDigest}`,'Native fixture grant differs from immutable scoped intent');
          const admitted=admitNativeBootstrap(bootstrap.authority,{root:nativeBootstrapRoot,policy,fenceDigest:fenceAdmission.digest,sourceDigest:plan.sourceDigest,executionScope:bootstrap.authority.payload.executionScope,identity:principal.invocation});
          const fixture=plan.fixtureLifecycle?.fixtures.find(item=>item.probeId===input.intent.probeId);check(fixture&&admitted.payload.planDigest===digest(plan)&&plan.fixtureLifecycle.templateDigest===policy.nativeQualification.fixtureLifecycle.templateDigest,'Exact root-admitted fixture recipe required');
          let token=current.state.tokens.find(item=>item.purpose==='native-fixture-grant'&&item.operationId===plan.operationId&&item.probeId===fixture.probeId&&item.namespace===namespace);
          if(token)check(token.expiresAt>Date.now(),'Original native fixture grant expired; retained intent cannot be re-signed');
          else{const granted=await createNativeFixtureGrant({fixture,key:nativeFixtureGrantKey}),handle=`custody_${randomUUID()}.grant`;token={handle,value:granted.grant,purpose:'native-fixture-grant',operationId:plan.operationId,probeId:fixture.probeId,jobId:fixture.jobId,namespace,expiresAt:granted.expiresAt};await update(state=>state.tokens.push(token));}
          result=token.handle;
        }
        else if (input.action === 'assert') result = { current: true };
        else if (input.action === 'close') { check(inflight === 0, 'Custody dispatch remains in flight'); await update(state => { state.owner = null; }); result = { closed: true, outstanding: 0 }; }
        else {
          check(['journal', 'dispatch'].includes(input.action), 'Unsupported custody operation');
          let assets = null;
          if (input.request.operation.startsWith('assets.')) {
            check(typeof resolveAssets === 'function', 'Retained custody asset resolver is required');
            const resource = input.request.operation === 'assets.session' ? policy.workers.find(worker => new URL(input.request.url).pathname.includes(`/${worker.name}/`))?.name : current.state.tokens.find(token => `Bearer ${token.handle}` === input.request.headers.authorization)?.resource;
            const manifestDigest = input.request.operation === 'assets.session' ? digest(parseJSON(Buffer.from(input.request.bodyBase64, 'base64')).manifest) : null;
            assets = await resolveAssets({ ...input, resource, manifestDigest });
          }
          let servingTarget=null;let request = await rehydrateProviderRequest(input.request, { policy, assets }); const logicalRequest=request,identity = requestDigest(request); let controllerRequest = null;
          const journalNamespace = current.state.owner.journalNamespace ?? null, activeControllerStore = storeFor(journalNamespace);
          if (input.action === 'journal') check(request.service === 's3' && request.operation === 'store.put' && new URL(request.url).pathname.startsWith(`/${policy.store.prefix}/${journalNamespace === null ? '' : `${journalNamespace}/`}`) && (journalNamespace !== null || !new URL(request.url).pathname.includes('/native-qualification/')), 'Custody journal action permits exact owner-scoped conditional S3 PUT only');
          else {
            check((input.intent?.journalNamespace ?? null) === journalNamespace, 'Provider intent journal namespace differs from credential owner');
            const headObject = await activeControllerStore.get('head.json'); check(headObject, 'Durable controller intent is missing'); const head = parseJSON(headObject.bytes);
            check(head.eventDigest === input.intent?.eventDigest && input.intent.requestDigest === identity, 'Durable provider request head differs');
            const eventObject = await activeControllerStore.get(`events/${head.eventDigest}.json`); check(eventObject && digest(parseJSON(eventObject.bytes)) === head.eventDigest, 'Immutable controller request event differs');
            const event = parseJSON(eventObject.bytes), saved = event.state.provider.requests.find(item => item.requestDigest === identity && item.status === 'intent' && item.operationId === event.state.controller.operation?.id);
            controllerRequest = saved;
            if(journalNamespace===null&&policy.nativeServing&&saved){
              const operation=event.state.provider.operations.find(item=>item.id===saved.operationId),admission=operation?.nativeServingAdmission;
              check(nativeBootstrapRoot&&admission,'Source-authenticated native serving operation required');
              const authority=verifyHostedAuthority(admission.authority,{root:nativeBootstrapRoot,identity:principal.invocation}).payload;
              check(authority.writerFenceDigest===fenceAdmission.digest&&authority.operationAuthorization?.commands.some(command=>['advance','deliver','begin','rollback'].includes(command)),'Serving writer requires exact installed source operation');
              check(same(authority.nativeServingSelection,admission.selection)&&authority.targetPlanDigest===admission.targetPlanDigest,'Signed native serving selection differs');assertServingSelection(admission.selection,policy);
              const native=event.state.controller.desired?.components.find(item=>item.id===policy.nativeServing.component);
              check(native&&native.codeDigest===admission.selection.codeDigest&&native.inputsDigest===admission.selection.inputsDigest,'Desired native composition differs from source serving selection');
              const business=event.state.controller.desired.components.find(item=>item.id===policy.nativeServing.businessComponent),businessSubject=authority.portableManifests.find(item=>item.component===policy.nativeServing.businessComponent);check(business&&businessSubject&&business.config.sha256===businessSubject.configDigest&&(business.codeDigest??business.artifact.sha256)===businessSubject.codeDigest,'Desired business logical identity differs from signed serving composition');
              const nativeMapping=event.state.provider.versions.find(item=>same(item.selected,selectedVersion(native))),nativeTarget=operation.target.kind==='lambda'?operation.targetSeal:nativeMapping?.targetSeal;
              if(operation.target.kind==='lambda')check(digest(nativeTarget)===authority.nativeServingTargetDigest,'Exact signed native target binding required');
              if(nativeTarget){const receipt=authority.nativeQualifications?.find(item=>digest(item)===admission.selection.qualificationDigest);check(receipt,'Signed real native qualification required');const qualified=verifyNativeQualificationReceipt(receipt,{root:nativeBootstrapRoot,expected:{environmentId:fenceAdmission.payload.environmentId,imageDigest:admission.selection.imageDigest,sourceDigest:admission.selection.codeDigest,codeDigest:admission.selection.codeDigest,qualificationPolicyDigest:digest(policy.nativeQualification),secretVersionsDigest:digest(authority.secretInstallations)}});for(const binding of[nativeTarget.expectedBinding,nativeTarget.failure?.expectedBinding])check(binding&&qualified.resources.some(item=>(!policy.nativeQualification||policy.nativeQualification.resources.some(pin=>pin.name===item.name))&&item.bindingDigest===digest(binding)),'Complete paired qualified bindings required');}
              if(request.operation==='lambda.upload'){const body=parseJSON(Buffer.from(request.bodyBase64,'base64')),resource=new URL(request.url).pathname.split('/').at(-2);check(nativeTarget&&[nativeTarget.resource,nativeTarget.failure.resource].includes(resource)&&body.ImageUri===`${policy.functions.find(item=>item.name===resource).imageRepository}@sha256:${admission.selection.imageDigest}`,'Native publication must use source-selected pair/image');const response=await cloudResponse(requestBuilders(policy).lambdaLatest(resource));check(response.status===200,'Fresh native publication revision required');const current=parseJSON(responseBytes(response)).Configuration,binding=resource===nativeTarget.resource?nativeTarget.expectedBinding:nativeTarget.failure.expectedBinding;check(current.RevisionId===body.RevisionId&&same(lambdaBindingProjection(current),binding),'Fresh publication binding/revision differs');}
              if(['lambda.activate','lambda.create-alias','lambda.serving-update-event-mapping'].includes(request.operation)){
                check(nativeMapping?.pair&&digest(nativeMapping.targetSeal)===authority.nativeServingTargetDigest,'Exact signed pair mapping required');
                for(const [name,version,binding]of [[nativeTarget.resource,nativeMapping.providerVersion,nativeTarget.expectedBinding],[nativeTarget.failure.resource,nativeMapping.pair.failureVersion,nativeTarget.failure.expectedBinding]]){const response=await cloudResponse(requestBuilders(policy).lambdaFunction(name,version));check(response.status===200,'Fresh activation pair verification unavailable');verifyLambdaQualified(parseJSON(responseBytes(response)),{policy,name,version,imageDigest:admission.selection.imageDigest,expectedBinding:binding});}
              }
              if(request.operation==='lambda.activate'||request.operation==='lambda.create-alias'){const body=parseJSON(Buffer.from(request.bodyBase64,'base64'));check(nativeMapping?.pair&&digest(nativeMapping.targetSeal)===authority.nativeServingTargetDigest&&body.FunctionVersion===nativeMapping.providerVersion&&new URL(request.url).pathname.startsWith(`/2015-03-31/functions/${nativeMapping.targetSeal.resource}/aliases`),'Main activation must use exact qualified desired pair mapping');}

              if(request.operation==='worker.activate'&&policy.workers.find(item=>new URL(request.url).pathname.includes(`/${item.name}/`))?.nativeServingMetadata){
                const business=event.state.controller.desired.components.find(item=>item.id===policy.nativeServing.businessComponent),mapping=event.state.provider.versions.find(item=>same(item.selected,selectedVersion(business))),body=parseJSON(Buffer.from(request.bodyBase64,'base64'));
                check(mapping?.candidateSeal?.worker&&body.versions?.length===1&&body.versions[0].version_id===mapping.providerVersion,'Worker activation requires exact desired immutable mapping');
                const response=await cloudResponse(requestBuilders(policy).workerVersionContent(mapping.targetSeal.resource,mapping.providerVersion));check(response.status===200,'Fresh serving Worker verification unavailable');verifyHostedWorkerCandidate(parseJSON(responseBytes(response)),mapping.candidateSeal,mapping.targetSeal,mapping.providerVersion);
                const expected=nativeServingTarget(admission.selection,{mainVersion:nativeMapping.providerVersion,failureVersion:nativeMapping.pair.failureVersion},policy),actual=mapping.candidateSeal.worker.metadata.bindings.find(item=>item.name==='SHOP_NATIVE_SERVING_TARGET_JSON');check(actual?.text===canonical(expected),'Activated Worker must retain exact desired numbered serving pair');
              }
              if(request.operation==='worker.upload'&&policy.workers.find(item=>new URL(request.url).pathname.includes(`/${item.name}/`))?.nativeServingMetadata){
                const mapping=event.state.provider.versions.find(item=>same(item.selected,selectedVersion(native)));
                check(mapping?.pair&&digest(mapping.targetSeal)===authority.nativeServingTargetDigest&&same(mapping.targetSeal.serving,admission.selection),'Source-authenticated immutable native pair mapping required');
                const target=mapping.targetSeal;
                for(const [name,version,binding]of [[target.resource,mapping.providerVersion,target.expectedBinding],[target.failure.resource,mapping.pair.failureVersion,target.failure.expectedBinding]]){
                  const response=await cloudResponse(requestBuilders(policy).lambdaFunction(name,version));check(response.status===200,'Serving pair verification unavailable');verifyLambdaQualified(parseJSON(responseBytes(response)),{policy,name,version,imageDigest:admission.selection.imageDigest,expectedBinding:binding});
                }
                servingTarget=nativeServingTarget(admission.selection,{mainVersion:mapping.providerVersion,failureVersion:mapping.pair.failureVersion},policy);
                const expected=operation.candidateSeal?.worker?.metadata?.bindings?.find(item=>item.name==='SHOP_NATIVE_SERVING_TARGET_JSON');check(expected?.text===canonical(servingTarget),'Worker mapping must retain exact resolved native target');
              }
              if(request.operation==='lambda.serving-configure'){
                const body=parseJSON(Buffer.from(request.bodyBase64,'base64')),resource=new URL(request.url).pathname.split('/').at(-2),target=operation.targetSeal,binding=resource===target.resource?target.expectedBinding:resource===target.failure?.resource?target.failure.expectedBinding:null;
                check(binding&&same(body.Environment,binding.Environment),'Serving environment must match exact signed binding');
                const actual=await cloudResponse(requestBuilders(policy).lambdaLatest(resource));check(actual.status===200,'Fresh serving configuration precondition unavailable');const latest=parseJSON(responseBytes(actual)).Configuration,projection=lambdaBindingProjection(latest);check(latest.RevisionId===body.RevisionId&&same({...projection,Environment:binding.Environment},binding),'Serving configuration can change only signed environment');
              }
              if(request.operation==='lambda.serving-update-event-mapping'){
                const mapping=event.state.provider.versions.find(item=>same(item.selected,selectedVersion(native))),body=parseJSON(Buffer.from(request.bodyBase64,'base64'));
                check(mapping?.pair&&body.FunctionName===`arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${policy.nativeServing.failureResource}:${mapping.pair.failureVersion}`,'Failure activation must use exact desired pair');
                const currentResponse=await cloudResponse(requestBuilders(policy).servingEventMapping());check(currentResponse.status===200,'Fresh serving mapping precondition unavailable');const observed=parseJSON(responseBytes(currentResponse));check(observed.FunctionArn===saved.precondition.functionArn&&same(nativeMappingProjection(observed),policy.nativeServing.failureMapping.configuration)&&digest(nativeMappingProjection(observed))===saved.precondition.configurationDigest,'Fresh serving failure mapping settings changed');
              }
            }
            if (journalNamespace !== null) {
              const bootstrap = event.state.controller.bootstrap, envelope = bootstrap?.authority, plan=bootstrap?.planBase64?parseJSON(Buffer.from(bootstrap.planBase64,'base64'),16*1024*1024,{finiteFractions:true}):null;
              check(nativeBootstrapRoot && envelope && plan && digest(plan) === bootstrap.planDigest && bootstrap.requestGraphDigest === envelope.payload.requestGraphDigest && journalNamespace === `native-qualification/${envelope.payload.imageDigest}`, 'Exact protected native bootstrap namespace/plan required');
              const admitted = admitNativeBootstrap(envelope,{root:nativeBootstrapRoot,policy,fenceDigest:fenceAdmission.digest,sourceDigest:plan.sourceDigest,executionScope:envelope.payload.executionScope,identity:principal.invocation});
              check(admitted.payload.planDigest === bootstrap.planDigest && event.state.controller.operation.id === plan.operationId && (request.service === 'ecr' || request.service === 'lambda' || request.service==='cloudflare'&&(request.operation.startsWith('native.fixture-')||request.operation.startsWith('worker.'))), 'Native credential scope permits only exact native construction');
              const url = new URL(request.url), body = request.bodyBase64&&!request.operation.startsWith('worker.')&&!request.operation.startsWith('native.fixture-object-') ? parseJSON(Buffer.from(request.bodyBase64,'base64'),32*1024*1024,{finiteFractions:request.operation==='lambda.native-invoke'}) : null;
              if(request.service==='ecr'){const repositories=new Set(plan.resources.map(item=>policy.functions.find(fn=>fn.name===item.name).imageRepository.split('.amazonaws.com/')[1]));check(repositories.has(body.repositoryName),'Native ECR registration must use exact isolated repository');if(request.operation==='ecr.put-image')check(body.imageDigest===`sha256:${admitted.payload.imageDigest}`,'Native ECR manifest must match admitted exact image');}
              if (request.service === 'lambda') {
                const resource = plan.resources.find(item => url.pathname === `/2015-03-31/functions/${item.name}` || url.pathname.startsWith(`/2015-03-31/functions/${item.name}/`)||url.pathname===`/2015-03-31/event-source-mappings/${policy.nativeQualification.resources.find(pin=>pin.name===item.name).eventSourceMapping?.id}`);
                check(resource && policy.nativeQualification.resources.some(item => item.name === resource.name), 'Native bootstrap cannot mutate a serving function');
                const owned = bootstrap.resources.find(item => item.name === resource.name);
                if (request.operation === 'lambda.upload') check(body.ImageUri.endsWith(`@sha256:${admitted.payload.imageDigest}`) && body.RevisionId === owned?.beforeRevision, 'Exact bootstrap image and revision required');
                else if (request.operation === 'lambda.native-restore') check(body.ImageUri.endsWith(`@sha256:${resource.restoreImageDigest}`), 'Exact admitted isolated restore image required');
                else if (request.operation === 'lambda.native-delete-version') check(url.searchParams.get('Qualifier') === owned?.version && !owned.beforeVersions.includes(owned.version), 'Native cleanup owns only its newly numbered version');
                else if(request.operation==='lambda.native-update-event-mapping'){const pin=policy.nativeQualification.resources.find(item=>item.name===resource.name).eventSourceMapping;check(pin?.restoreFunctionArn&&(body.FunctionName===pin.restoreFunctionArn||body.FunctionName===`arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${resource.name}:${owned?.version}`),'Only exact isolated owned numbered failure mapping/restore permitted');const observedResponse=await cloudResponse(requestBuilders(policy).nativeEventMapping(resource.name));check(observedResponse.status===200,'Fresh isolated mapping precondition unavailable');const observed=parseJSON(responseBytes(observedResponse),16*1024*1024,{finiteFractions:true});check(observed.FunctionArn===saved.precondition.functionArn&&digest(nativeMappingProjection(observed))===saved.precondition.configurationDigest&&same(nativeMappingProjection(observed),owned.mappingBaseline),'Fresh isolated mapping settings/target precondition differs');}
                else if (request.operation === 'lambda.native-invoke') {
                  const fixture=plan.fixtureLifecycle?.fixtures.find(item=>item.jobId===body.jobId),probe=fixture&&policy.nativeQualification.probes.find(item=>item.id===fixture.probeId),token=fixture&&current.state.tokens.find(item=>item.handle===body.grant&&item.operationId===plan.operationId&&item.jobId===fixture.jobId&&item.namespace===journalNamespace&&item.expiresAt>Date.now());
                  check(url.searchParams.get('Qualifier')===owned?.version&&(fixture?probe.resource===resource.name&&token&&same(nativeFixtureEvent(fixture,token.handle),body):plan.probes.some(probe=>same(probe.payload,body))),'Native probe must target exact admitted numbered image and owned job grant');
                  if(fixture)request=requestBuilders(policy).nativeInvoke(probe.id,owned.version,nativeFixtureEvent(fixture,token.value));
                }
                else throw Error('Native bootstrap operation outside isolated construction');
              }
              if(request.service==='cloudflare'){
                const fpolicy=policy.nativeQualification.fixtureLifecycle;
                if(request.operation.startsWith('worker.')){
                  const pin=fpolicy.bootstrapWorker;check(pin&&plan.bootstrapWorker?.target.resource===pin.name&&url.pathname.includes(`/scripts/${pin.name}/`)&&saved?.target.resource===pin.name,'Bootstrap cannot mutate a serving Worker');
                  if(request.operation==='worker.upload')request=await materializeProviderCapabilities(input.request,{policy,assets:null,resolve:async()=>{throw Error('Unexpected bootstrap asset capability');},bootstrap:{authorityDigest:admitted.authorityDigest,operationId:plan.operationId}});
                  else if(request.operation==='worker.activate'){const selected=parseJSON(Buffer.from(request.bodyBase64,'base64')).versions?.[0]?.version_id;check(selected===bootstrap.worker?.version||selected===pin.restoreVersion,'Only exact isolated bootstrap/restore Worker version permitted');}
                  else throw Error('Unexpected bootstrap Worker mutation');
                }else if(request.operation==='native.fixture-query'){check(plan.fixtureLifecycle?.templateDigest===fpolicy?.templateDigest,'Root-admitted real fixture lifecycle required');
                  const accepted=bootstrap.fixtureState?.flatMap(item=>{
                    const fixture=plan.fixtureLifecycle.fixtures.find(f=>f.probeId===item.probeId),pin=policy.nativeQualification.probes.find(probe=>probe.id===item.probeId),target=bootstrap.resources.find(resource=>resource.name===pin.resource),functionArn=`arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${pin.resource}`;
                    const args={fixture,operationId:plan.operationId,createdAt:item.createdAt,grant:item.handle,version:target.version,functionArn,sourceDigest:plan.sourceDigest,inputsDigest:plan.recipeDigest,authorityDigest:admitted.authorityDigest,grantKeyId:fpolicy.grantKey.id};
                    return [...nativeFixtureStageQueries(args).queries.map(query=>({query,args})),...nativeFixtureCleanupQueries(fixture,plan.operationId,admitted.authorityDigest).map(query=>({query,args}))];
                  }).find(({query})=>same({sql:query.sql,params:query.params},body));
                  check(accepted,'Fixture SQL must match exact admitted owned lifecycle');
                  if(accepted.query.action==='acceptance'){const token=current.state.tokens.find(token=>token.handle===accepted.args.grant&&token.operationId===plan.operationId&&token.jobId===accepted.args.fixture.jobId&&token.namespace===journalNamespace&&token.expiresAt>Date.now());check(token,'Private native fixture capability expired');const actual=nativeFixtureStageQueries({...accepted.args,grant:token.value}).queries.find(query=>query.action==='acceptance');request=requestBuilders(policy).nativeFixtureQuery(actual.action,actual.params);}
                }else{
                  check(plan.fixtureLifecycle?.templateDigest===fpolicy?.templateDigest,'Root-admitted real fixture lifecycle required');const fixture=plan.fixtureLifecycle.fixtures.find(f=>url.pathname.endsWith(`/${f.sourceKey}`)||url.pathname.endsWith(`/${f.outputKey}`));check(fixture,'Fixture media is outside owned cleanup inventory');
                  if(request.operation==='native.fixture-object-put')check(url.pathname.endsWith(`/${fixture.sourceKey}`)&&request.bodySha256===fixture.sourceSha256,'Fixture source bytes differ');
                }
              }
            } else check(!request.operation.startsWith('lambda.native-'), 'Native mutations require separately admitted isolated namespace');
            if (request.operation === 'report.create-deployment') {
              const report = event.state.provider.reports.find(item => item.kind === 'deployment' && item.requestDigest === identity && item.status === 'intent');
              check(report && report.eventDigest && same(report.release, { head: parseJSON(Buffer.from(request.bodyBase64, 'base64')).ref, compositionDigest: parseJSON(Buffer.from(request.bodyBase64, 'base64')).payload?.compositionDigest }), 'Exact immutable deployment creation intent required');
              const journal = await readProtectedJournal(controllerStore), verified = journal.events.find(item => item.digest === report.eventDigest)?.event.state.controller;
              check(verified?.phase === 'runtime-verified' && digest(verified.lastVerified) === report.release.compositionDigest && parseJSON(Buffer.from(request.bodyBase64, 'base64')).payload?.eventDigest === report.eventDigest, 'Deployment must reference immutable runtime verification');
            } else if (request.operation === 'report.success' && !saved) {
              const report = event.state.provider.reports.find(item => item.requestDigest === identity), deploymentId = new URL(request.url).pathname.split('/').at(-2);
              check(report && report.deploymentId === deploymentId && report.body?.eventDigest === report.eventDigest && report.body.status === 'success', 'Exact immutable reporting intent required');
              const journal = await readProtectedJournal(controllerStore), verified = journal.events.find(item => item.digest === report.eventDigest)?.event.state.controller;
              check(verified?.phase === 'runtime-verified' && digest(verified.lastVerified) === report.body.compositionDigest && digest(verified.verification) === report.body.verificationDigest && verified.report.eventId === report.body.eventId && parseJSON(Buffer.from(request.bodyBase64, 'base64')).description === `Verified release event ${report.eventDigest}`, 'Retained runtime verification reporting subject differs');
            } else check(saved && saved.operationId === event.state.controller.operation?.id && event.state.controller.phase.endsWith('-reconcile') && saved.method === logicalRequest.method && saved.url === logicalRequest.url && saved.bodySha256 === logicalRequest.bodySha256, 'Exact admitted controller request intent required');
          }
          if (request.operation === 'report.success' && policy.github.reporting === 'per-release') {
            const journal = await readProtectedJournal(controllerStore), deploymentId = new URL(request.url).pathname.split('/').at(-2), body = parseJSON(Buffer.from(request.bodyBase64, 'base64'));
            check(journal.state.provider.reports.some(item => item.kind === 'deployment' && item.status === 'acknowledged' && item.deploymentId === deploymentId && body.description === `Verified release event ${item.eventDigest}`), 'Reporting ID lacks exact durable release deployment mapping');
          }
          if (input.action === 'dispatch'&&journalNamespace===null) request = await materializeProviderCapabilities(input.request, { policy, assets,nativeServing:servingTarget, resolve: async (handle, purpose) => { const token = current.state.tokens.find(item => item.handle === handle && item.purpose === purpose && item.operationId === controllerRequest.operationId && item.resource === controllerRequest.target.resource && item.expiresAt > Date.now()); check(token, 'Private custody asset capability is missing, expired or belongs to another operation'); return token.value; } });
          const scope = input.action === 'journal' ? { action: 'journal', requestDigest: identity } : request.operation === 'report.success' || request.operation === 'report.create-deployment' ? { action: request.operation, eventDigest: request.operation === 'report.success' ? parseJSON(Buffer.from(request.bodyBase64, 'base64')).description.slice('Verified release event '.length) : parseJSON(Buffer.from(request.bodyBase64, 'base64')).payload.eventDigest } : { action: 'dispatch', ...(journalNamespace === null ? {} : {journalNamespace}), operationId: controllerRequest.operationId, step: controllerRequest.step ?? request.operation };
          const claimDigest = digest(scope);
          check(!current.state.requests.some(item => item.claimDigest ? item.claimDigest === claimDigest : item.requestDigest === identity), 'Durable custody no-replay fence rejected request');
          await update(state => { state.requests.push({ claimDigest, scope, requestDigest: identity, wireRequestDigest: requestDigest(request), action: input.action, owner: input.owner, controllerEventDigest: input.intent?.eventDigest ?? null, status: 'sending' }); });
          // This serialized executor keeps ownership until the socket has ended.
          // A crash retains the send claim. A new installation cannot acquire
          // credentials through timeout or journal CAS alone.
          inflight++;
          try {
            result = await cloudResponse(request, claimDigest); responseBytes(result);
            const actualResponseDigest = digest(result);
            if (['assets.session', 'assets.upload'].includes(request.operation) && result.status >= 200 && result.status < 300) {
              const body = parseJSON(responseBytes(result));
              if (body.result?.jwt) {
                const handle = `custody.${randomUUID()}.capability`, value = body.result.jwt, purpose = request.operation === 'assets.session' && body.result.buckets?.length ? 'asset-upload' : 'asset-completion';
                await update(state => { state.tokens.push({ handle, value, purpose, operationId: controllerRequest.operationId, resource: controllerRequest.target.resource, expiresAt: Date.now() + 3600000 }); });
                body.result.jwt = handle; const bytes = Buffer.from(canonical(body)); result = { ...result, headers: { ...result.headers, 'content-length': String(bytes.length) }, bodyBase64: bytes.toString('base64') };
              }
            }
            const acknowledgement = {status:'acknowledged',responseDigest:digest(result),actualResponseDigest};
            if (input.action === 'journal' && result.status >= 200 && result.status < 300) pendingJournalAcks.set(claimDigest,acknowledgement);
            else await update(state => { const record = state.requests.find(item => item.claimDigest === claimDigest); Object.assign(record,acknowledgement); });
          } finally { inflight--; }
        }
      }
      const payload = { schema: 'shop.credential-broker-result/v1', action: input.action, nonce: input.nonce, fenceDigest: fenceAdmission.digest, owner, issuedAt: Date.now(), callDigest: digest(input), result };
      const signed = await attest(payload); check(same(rootReceipt(signed, fenceAdmission), payload), 'Custody response attester changed payload'); return signed;
    }),
    recoverOwner: receipt => run(async () => {
      await assertInstallation(); const proof = rootReceipt(receipt, fenceAdmission);
      exactFields(proof, ['schema', 'fenceDigest', 'installationId', 'owner', 'controllerStopped', 'issuedAt', 'expiresAt']);
      check(proof.schema === 'shop.custody-owner-recovery/v1' && proof.fenceDigest === fenceAdmission.digest && proof.installationId === installed.installationId && proof.owner === current.state.owner?.id && proof.controllerStopped === true && proof.issuedAt <= Date.now() && proof.expiresAt > Date.now() && inflight === 0, 'Stopped controller and drained exclusive owner recovery required');
      await update(state => { state.recoveries.push({ receiptDigest: digest(receipt), owner: state.owner.id, at: Date.now() }); state.owner = null; });
      return { status: 'owner-revoked', pending: current.state.requests.filter(item => item.status === 'sending').map(item => item.requestDigest) };
    }),
    renewAuthority: ({ fenceAdmission: nextFence, installation: receipt }) => run(async () => {
      assertCredentialFence(nextFence); const next = installationReceipt(receipt, nextFence, custodyPolicy);
      check(next.installationId === installed.installationId && next.credentialEpoch === installed.credentialEpoch && next.environmentId === installed.environmentId && next.expiresAt > installed.expiresAt && nextFence.payload.policyDigest === fenceAdmission.payload.policyDigest && nextFence.payload.brokerId === fenceAdmission.payload.brokerId && nextFence.payload.implementationDigest === fenceAdmission.payload.implementationDigest && same(nextFence.keys.map(key => ({ id: key.id, pem: key.publicKey.export({ type: 'spki', format: 'pem' }) })), fenceAdmission.keys.map(key => ({ id: key.id, pem: key.publicKey.export({ type: 'spki', format: 'pem' }) }))), 'Renewal cannot replace credential installation, epoch or custody identity');
      const observed = await custodyStore.get('head.json'); check(observed && same(parseJSON(observed.bytes), current.head), 'Credential installation changed before renewal');
      const previous = installed, oldFence = fenceAdmission, oldAuthenticator = authenticatePrincipal; installed = next; fenceAdmission = nextFence;
      if (authenticationRoot && !authenticate) authenticatePrincipal = createActionsAuthenticator({ root: authenticationRoot, policy, fenceAdmission });
      try { await update(state => { state.installation = next; }); } catch (error) { installed = previous; fenceAdmission = oldFence; authenticatePrincipal = oldAuthenticator; throw error; }
      return { status: 'authority-renewed', owner: current.state.owner?.id ?? null, installationId: installed.installationId, credentialEpoch: installed.credentialEpoch };
    }),
    requestGraph,
    installationId: installed.installationId,
    readState: async () => { const state = structuredClone((await readProtectedJournal(custodyStore)).state); state.tokens = state.tokens.map(({ value, ...token }) => token); return state; }
  };
  return Object.freeze(service);
}
