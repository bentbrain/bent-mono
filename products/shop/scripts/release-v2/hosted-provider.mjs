import { check, digest, parseJSON, readRef, same, sha256 } from './data.mjs';
import { conforms } from './composition.mjs';
import { selectedVersion, verifyCodeIdentity } from './component-identity.mjs';
import { verifyContent } from './artifact-transport.mjs';
import { assertPolicy, cloudflareVersion, numberedVersion, protocolPageLimit, protocolItemLimit, requestBuilders, sourceMapDataDigest, assetManifest } from './provider-protocol-builders.mjs';
import { ProtocolConflict, ProtocolFailure, UncertainWrite, responseBytes, verifyLambdaQualified, assertLambdaBinding, lambdaBindingProjection } from './provider-protocol.mjs';
import { requestDigest } from './signing.mjs';
import { assertCredentialBroker } from './hosted-writer.mjs';
import { verifyOciLayout } from './oci-layout.mjs';

const candidateLoaders = new WeakSet();
const cf = value => { check(value?.success === true && value.result && (!value.errors || value.errors.length === 0), 'Cloudflare provider response failed'); return value.result; };
async function checkedBrokerResponse(response, request) {
  responseBytes(response);
  if ([409, 412].includes(response.status)) throw new ProtocolConflict(request.operation);
  if (response.status < 200 || response.status >= 300) throw new ProtocolFailure(request.operation, response.status);
  return response;
}
function hostedStageRequest(_bundle, body) { return structuredClone(body); }

// This default reader consumes admitted immutable refs. It never invokes a
// build. OCI qualification and image registration come from protected admission.
export function retainedCandidateLoader({ bundle, targets }) {
  const cache = new Map();
  const read = async component => {
    const target = targets.find(item => item.component === component.id); check(target, 'Hosted component target is missing');
    const artifactBytes = await readRef(bundle, component.artifact), configBytes = await readRef(bundle, component.config), provenanceBytes = await readRef(bundle, component.provenance);
    const artifact = parseJSON(artifactBytes), config = parseJSON(configBytes), provenance = parseJSON(provenanceBytes), files = [];
    conforms(artifact, 'artifact'); conforms(config, 'hostedConfig'); conforms(provenance, 'hostedProvenance'); verifyCodeIdentity(artifact, component);
    check(artifact.component === component.id && config.component === component.id && provenance.component === component.id && provenance.artifactFilesDigest === digest(artifact.files), 'Retained artifact/provenance subject differs');
    check(target.kind === 'worker' ? artifact.format === 'module-bundle' : artifact.format === 'oci-layout' && typeof component.codeDigest === 'string' && /^[a-f0-9]{64}$/.test(component.codeDigest) && typeof artifact.runtimeDigest === 'string' && /^[a-f0-9]{64}$/.test(artifact.runtimeDigest), 'Hosted artifact format or native runtime identity differs');
    if (target.kind === 'lambda') check(target.qualification?.awsImageQualified === true, 'Admitted AWS image qualification is required');
    for (const ref of artifact.files) { const bytes = await readRef(bundle, ref); if (target.kind === 'worker') files.push({ path: ref.path, data: bytes.toString('base64') }); }
    const candidate = { selected: selectedVersion(component), artifact, config, provenance, inventoryDigest: digest(artifact.files),
      refs: { artifact: component.artifact, config: component.config, provenance: component.provenance } };
    if (target.kind === 'worker') {
      candidate.upload = { artifact: artifactBytes.toString('base64'), config: configBytes.toString('base64'), provenance: provenanceBytes.toString('base64'), files };
      verifyContent(candidate.upload, component, 'isolated-qualification');
      const bytesFor = path => { const file = files.find(item => item.path === path); check(file, 'Worker part absent from retained artifact'); return Buffer.from(file.data, 'base64'); };
      const described = [...target.modules, ...target.assets];
      check(described.length === artifact.files.length && new Set(described.map(item => item.path)).size === artifact.files.length && artifact.files.every(file => described.some(item => item.path === file.path)), 'Hosted Worker module/asset accounting is incomplete');
      const modules = target.modules.map(part => ({ name: part.name, type: part.type, bytes: bytesFor(part.path) }));
      const assets = target.assets.map(part => ({ path: part.name, type: part.type, bytes: bytesFor(part.path) }));
      const expectedInventory = modules.map(part => ({ name: part.name, type: part.type, bytes: part.bytes.length, sha256: sha256(part.bytes), ...(part.name.endsWith('.map') ? { sourceMapDataSha256: sourceMapDataDigest(part.bytes) } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
      candidate.worker = { entrypoint: target.entrypoint, metadata: target.metadata, modules, assets, expectedInventory };
    } else {
      const image = await verifyOciLayout({ artifact, readFile: ref => readRef(bundle, ref) });
      check(image.imageDigest === target.imageDigest && same(target.expectedBinding?.Architectures, [image.architecture === 'amd64' ? 'x86_64' : 'arm64']), 'Retained OCI image digest or Lambda architecture differs');
      check(target.kind === 'lambda' && target.qualification?.awsImageQualified === true && target.qualification.artifactDigest === component.artifact.sha256 && target.qualification.codeDigest === component.codeDigest &&
        target.qualification.runtimeDigest === artifact.runtimeDigest && target.qualification.imageDigest === target.imageDigest && /^[a-f0-9]{64}$/.test(target.qualification.receiptDigest), 'Admitted AWS image qualification is required');
      candidate.native = { imageDigest: target.imageDigest, expectedBinding: target.expectedBinding, qualificationDigest: target.qualification.receiptDigest, awsImageQualified: true };
    }
    return candidate;
  };
  const loader = component => { const key = digest(component); if (!cache.has(key)) cache.set(key, read(component)); return cache.get(key); }; candidateLoaders.add(loader); return loader;
}
function namedBindings(bindings) {
  check(Array.isArray(bindings) && bindings.length <= 128 && bindings.every(binding => binding && typeof binding.name === 'string' && binding.name.length > 0) && new Set(bindings.map(binding => binding.name)).size === bindings.length, 'Unique named Worker bindings required');
  return [...bindings].sort((a, b) => a.name.localeCompare(b.name));
}
function verifyWorkerVersion(response, candidate, target, providerVersion) {
  const version = cf(response); check(cloudflareVersion(version.id) === providerVersion, 'Immutable Worker version response identity differs');
  check(Array.isArray(version.modules) && version.modules.length === candidate.worker.expectedInventory.length && version.main_module === candidate.worker.entrypoint, 'Complete immutable Worker version modules required');
  const actual = version.modules.map(part => {
    check(typeof part.content_base64 === 'string', 'Immutable Worker module bytes missing'); const bytes = Buffer.from(part.content_base64, 'base64');
    check(bytes.toString('base64') === part.content_base64, 'Ambiguous immutable Worker module bytes');
    return { name: part.name, type: part.content_type, bytes: bytes.length, sha256: sha256(bytes), ...(part.name.endsWith('.map') ? { sourceMapDataSha256: sourceMapDataDigest(bytes) } : {}) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  check(new Set(actual.map(part => part.name)).size === actual.length && actual.every((part, index) => {
    const expected = candidate.worker.expectedInventory[index];
    return part.name.endsWith('.map') ? part.name === expected.name && part.type === expected.type && part.sourceMapDataSha256 === expected.sourceMapDataSha256 : same(part, expected);
  }), 'Immutable Worker code/map inventory differs');
  const expectedMetadata = candidate.worker.metadata;
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (['main_module', 'bindings', 'assets', 'compatibility_flags'].includes(key)) continue;
    if (key === 'annotations') check(value && typeof value === 'object' && Object.entries(value).every(([name, entry]) => same(version.annotations?.[name], entry)) && Object.keys(version.annotations ?? {}).every(name => Object.hasOwn(value, name) || name === 'workers/triggered_by'), 'Immutable Worker annotations differ');
    else check(same(version[key], value), `Immutable Worker metadata differs: ${key}`);
  }
  check(same(namedBindings(version.bindings), namedBindings(expectedMetadata.bindings ?? [])) && version.compatibility_date === expectedMetadata.compatibility_date && same(version.compatibility_flags ?? [], expectedMetadata.compatibility_flags ?? []), 'Immutable Worker target bindings differ');
  if ((candidate.worker.assets?.length ?? candidate.worker.assetCount) > 0) {
    // The beta response exposes asset configuration, not every served byte or
    // retention obligation. Admission must provide a separate exact asset seal.
    check(target.assetQualification?.complete === true && target.assetQualification.manifestDigest === (candidate.worker.assetManifestDigest ?? digest(assetManifest(candidate.worker.assets).manifest)) && /^[a-f0-9]{64}$/.test(target.assetQualification.receiptDigest) && same(version.assets?.config, expectedMetadata.assets?.config), 'Admitted served asset qualification is required');
  }
  return { providerVersion: version.id, modulesDigest: digest(actual), bindingDigest: digest({ bindings: namedBindings(version.bindings), compatibility_date: version.compatibility_date, compatibility_flags: version.compatibility_flags ?? [], assets: version.assets?.config ?? null }) };
}

export async function preflightHostedTargets({ policy, components, targets, load }) {
  assertPolicy(policy); check(candidateLoaders.has(load), 'Verified retained candidate loader required');
  check(Array.isArray(components) && Array.isArray(targets) && components.length === targets.length && new Set(targets.map(target => target.component)).size === targets.length && same(components.map(component => component.id).sort(), targets.map(target => target.component).sort()), 'Complete hosted target component preflight required');
  const builders = requestBuilders(policy);
  for (const component of components) {
    const target = targets.find(item => item.component === component.id), candidate = await load(component);
    if (target.kind === 'worker') {
      check(policy.workers.some(item => item.name === target.resource && item.versionContentApi === 'workers-beta/v1'), 'Admitted immutable Worker content API required');
      builders.workerUpload(target.resource, candidate.worker);
      if (candidate.worker.assets.length) check(target.assetQualification?.complete === true && target.assetQualification.manifestDigest === digest(assetManifest(candidate.worker.assets).manifest) && /^[a-f0-9]{64}$/.test(target.assetQualification.receiptDigest), 'Admitted served asset qualification is required before any write');
    } else {
      check(target.kind === 'lambda' && policy.functions.some(item => item.name === target.resource && item.aliases.includes(target.alias)) && candidate.native?.awsImageQualified === true && /^[a-f0-9]{64}$/.test(candidate.native.imageDigest), 'Admitted qualified native target required before any write');
      assertLambdaBinding(candidate.native.expectedBinding, policy);
    }
  }
  return { schema: 'shop.hosted-target-preflight/v1', components: components.map(selectedVersion), targetsDigest: digest(targets), providerWrites: 0 };
}

export function createHostedProvider({ policy, writer, broker, components, targets, load, deploymentId, workInventory = () => broker.workInventory() }) {
  assertPolicy(policy); assertCredentialBroker(broker);
  check(Array.isArray(components) && components.length > 0 && Array.isArray(targets) && targets.length > 0 && candidateLoaders.has(load) && typeof workInventory === 'function', 'Admitted component/artifact/work inventory ports required');
  const builders = requestBuilders(policy), verifiedContents = new WeakSet();
  const targetFor = id => { const target = targets.find(item => item.component === id); check(target, 'Hosted component target missing');
    check(target.kind === 'worker' ? policy.workers.some(item => item.name === target.resource && item.versionContentApi === 'workers-beta/v1') : target.kind === 'lambda' && policy.functions.some(item => item.name === target.resource && item.aliases.includes(target.alias)), 'Hosted target is outside admitted provider policy'); return target; };
  targets.forEach(target => targetFor(target.component));
  const componentFor = (id, version) => { const value = components.find(item => item.id === id && selectedVersion(item).version === version); check(value, 'Logical artifact version is outside admitted retained components'); return value; };
  const candidateFor = async (id, version) => {
    let component = components.find(item => item.id === id && selectedVersion(item).version === version), candidate;
    if (component) candidate = await load(component);
    else {
      const stored = (await writer.readProviderState()).versions.find(item => item.selected.component === id && item.selected.version === version), head = await writer.readHead();
      check(stored?.component && stored.candidateSeal && head?.state.history.some(composition => composition.components.some(previous => same(previous, stored.component))), 'Retained version lacks immutable verified controller history');
      component = stored.component; candidate = stored.candidateSeal;
    }
    check(same(candidate.selected, selectedVersion(component)) && same(candidate.refs, { artifact: component.artifact, config: component.config, provenance: component.provenance }) && candidate.inventoryDigest === digest(candidate.artifact.files), 'Retained candidate identity differs'); return candidate;
  };
  const sealCandidate = candidate => ({ selected: candidate.selected, artifact: candidate.artifact, config: candidate.config, provenance: candidate.provenance, refs: candidate.refs, inventoryDigest: candidate.inventoryDigest,
    ...(candidate.worker ? { worker: { entrypoint: candidate.worker.entrypoint, metadata: candidate.worker.metadata, expectedInventory: candidate.worker.expectedInventory, assetCount: candidate.worker.assets.length, assetManifestDigest: digest(assetManifest(candidate.worker.assets).manifest) } } : { native: candidate.native }) });
  const read = async request => checkedBrokerResponse(await broker.read(request), request);
  const json = async request => parseJSON(responseBytes(await read(request)), 32 * 1024 * 1024);
  async function providerVersions(target) {
    const values = [], markers = new Set(); let marker = null;
    for (let page = 1; page <= protocolPageLimit; page++) {
      if (target.kind === 'worker') {
        const response = await json(builders.workerVersions(target.resource, page)), items = cf(response).items;
        check(Array.isArray(items) && items.length <= 100, 'Incomplete Worker version inventory');
        if (!items.length) return values;
        for (const item of items) { cloudflareVersion(item.id); check(!values.includes(item.id), 'Duplicate Worker inventory version'); values.push(item.id); }
      } else {
        const response = await json(builders.lambdaVersions(target.resource, marker)); check(Array.isArray(response.Versions) && response.Versions.length <= 100, 'Incomplete Lambda version inventory');
        for (const item of response.Versions) { if (item.Version === '$LATEST') continue; numberedVersion(item.Version); check(item.FunctionArn === `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${target.resource}:${item.Version}` && !values.includes(item.Version), 'Lambda inventory version identity differs'); values.push(item.Version); }
        if (!response.NextMarker) return values;
        check(typeof response.NextMarker === 'string' && !markers.has(response.NextMarker) && response.Versions.length > 0, 'Lambda version inventory is truncated or looping'); markers.add(response.NextMarker); marker = response.NextMarker;
      }
      check(values.length <= protocolItemLimit, 'Provider version inventory exceeds bound');
    }
    throw Error('Provider version inventory pagination exceeds bound');
  }
  async function readAlias(target) {
    let alias;
    try { alias = await json(builders.lambdaAlias(target.resource, target.alias)); }
    catch (error) { if (error instanceof ProtocolFailure && error.operation === 'lambda.alias' && error.status === 404) return null; throw error; }
    check(alias.Name === target.alias && alias.AliasArn === `arn:aws:lambda:${policy.region}:${policy.awsAccountId}:function:${target.resource}:${target.alias}` && (!alias.RoutingConfig || same(alias.RoutingConfig, { AdditionalVersionWeights: {} })), 'Lambda alias authority differs');
    numberedVersion(alias.FunctionVersion); return alias;
  }
  async function activeVersion(target) {
    if (target.kind === 'worker') {
      const deployments = cf(await json(builders.workerDeployments(target.resource))).deployments;
      check(Array.isArray(deployments) && deployments.length <= 4096, 'Incomplete Worker deployments'); if (!deployments.length) return null;
      const active = deployments[0].versions; check(Array.isArray(active) && active.length === 1 && active[0].percentage === 100, 'Worker deployment is not one exact active version'); return cloudflareVersion(active[0].version_id);
    }
    return (await readAlias(target))?.FunctionVersion ?? null;
  }
  async function verifyMapping(mapping) {
    const admittedTarget = targetFor(mapping.selected.component), target = mapping.targetSeal ?? admittedTarget; check(target.kind === admittedTarget.kind && target.resource === admittedTarget.resource && target.alias === admittedTarget.alias, 'Retained provider target moved outside admitted resource'); const candidate = await candidateFor(mapping.selected.component, mapping.selected.version);
    const observed = target.kind === 'worker' ? verifyWorkerVersion(await json(builders.workerVersionContent(target.resource, mapping.providerVersion)), candidate, target, mapping.providerVersion)
      : verifyLambdaQualified(await json(builders.lambdaFunction(target.resource, mapping.providerVersion)), { policy, name: target.resource, version: mapping.providerVersion, imageDigest: candidate.native?.imageDigest, expectedBinding: candidate.native?.expectedBinding });
    return { candidate, observed };
  }
  async function mappings() {
    const state = await writer.readProviderState(), result = [...state.versions];
    for (const operation of state.operations.filter(item => item.kind === 'stage' && !result.some(mapping => same(mapping.selected, item.selected)))) {
      const request = state.requests.findLast(item => item.operationId === operation.id && item.step === 'stage'); if (!request) continue;
      const target = targetFor(operation.selected.component), discovered = await providerVersions(target), before = request.precondition.versions;
      const candidates = discovered.filter(version => !before.includes(version)), matches = [];
      for (const providerVersion of candidates) {
        try { await verifyMapping({ selected: operation.selected, providerVersion }); matches.push(providerVersion); }
        catch (error) { if (error instanceof ProtocolFailure && error.status === 404) continue; throw error; }
      }
      check(matches.length <= 1, 'Ambiguous immutable provider acknowledgement');
      if (matches.length) result.push({ selected: operation.selected, providerVersion: matches[0], target: operation.target, component: operation.component, targetSeal: operation.targetSeal, candidateSeal: operation.candidateSeal, reconciled: true });
    }
    return result;
  }
  async function recordRequest(operation, step, request, precondition) {
    const state = await writer.readProviderState(); check(!state.requests.some(item => item.operationId === operation.id && item.step === step), 'Durable provider request exists; GET-only reconciliation required');
    const record = { operationId: operation.id, step, requestDigest: requestDigest(request), method: request.method, url: request.url, bodySha256: request.bodySha256, bytes: Buffer.from(request.bodyBase64, 'base64').length, headers: request.headers, target: operation.target, precondition, status: 'intent' };
    const eventDigest = await writer.recordProvider(provider => { provider.requests.push(record); });
    const response = await writer.dispatch(request, eventDigest);
    try { await checkedBrokerResponse(response, request); }
    catch (error) { if (error instanceof ProtocolConflict) throw error; throw new UncertainWrite(request, error); }
    const bytes = responseBytes(response); let value;
    try { value = bytes.length ? parseJSON(bytes, 32 * 1024 * 1024) : null; } catch (error) { throw new UncertainWrite(request, error); }
    await writer.recordProvider(provider => { const saved = provider.requests.find(item => item.operationId === operation.id && item.step === step); saved.status = 'acknowledged'; saved.responseDigest = digest(response); saved.response = value; });
    return value;
  }
  async function content(id, version) {
    const mapping = (await mappings()).find(item => item.selected.component === id && item.selected.version === version); check(mapping, 'Logical version has no immutable provider mapping');
    const verified = await verifyMapping(mapping);
    const evidence = Object.freeze({ schema: 'shop.hosted-content/v1', selected: Object.freeze(structuredClone(mapping.selected)), refs: Object.freeze(structuredClone(verified.candidate.refs)), inventoryDigest: verified.candidate.inventoryDigest,
      providerVersion: mapping.providerVersion, observation: Object.freeze(verified.observed) }); verifiedContents.add(evidence); return evidence;
  }
  const verifyHostedContent = (evidence, component) => {
    check(verifiedContents.has(evidence) && evidence?.schema === 'shop.hosted-content/v1' && same(evidence.selected, selectedVersion(component)) && same(evidence.refs, { artifact: component.artifact, config: component.config, provenance: component.provenance }) && evidence.observation && typeof evidence.providerVersion === 'string', 'Verified hosted content subject differs');
    return evidence;
  };
  async function inventory() {
    const known = await mappings(), active = [];
    for (const target of targets) {
      const versions = await providerVersions(target);
      for (const mapping of known.filter(item => item.selected.component === target.component)) { check(versions.includes(mapping.providerVersion), 'Mapped immutable provider version is missing'); await verifyMapping(mapping); }
      const providerVersion = await activeVersion(target);
      if (providerVersion !== null) { const mapping = known.find(item => item.selected.component === target.component && item.providerVersion === providerVersion); check(mapping, 'Active provider version lacks admitted artifact mapping'); active.push(mapping.selected); }
    }
    const work = await workInventory(); check(work?.complete === true && Array.isArray(work.jobs) && work.jobs.length <= 4096, 'Complete accepted-work inventory required');
    return { complete: true, active, versions: known.map(item => item.selected), jobs: work.jobs };
  }
  async function operations(id) {
    const state = await writer.readProviderState(), operation = state.operations.find(item => item.id === id); if (!operation) return [];
    const mapping = (await mappings()).find(item => same(item.selected, operation.selected)); if (!mapping) return [];
    await verifyMapping(mapping);
    if (operation.kind === 'activate' && await activeVersion(targetFor(mapping.selected.component)) !== mapping.providerVersion) return [];
    return [{ id, kind: operation.kind, bodyDigest: operation.bodyDigest, result: operation.selected }];
  }
  async function reports(id) {
    const state = await writer.readProviderState(), saved = state.reports.find(item => item.body.eventId === id); if (!saved) return [];
    const records = [];
    for (let page = 1; page <= protocolPageLimit; page++) {
      const response = await read(builders.reportStatuses(deploymentId, page)), items = parseJSON(responseBytes(response)); check(Array.isArray(items) && items.length <= 100, 'Incomplete reporting inventory'); records.push(...items);
      check(records.length <= 4096, 'Reporting inventory exceeds bound');
      const link = response.headers.link;
      if (!link) { check(items.length < 100, 'Reporting continuation evidence missing'); break; }
      const next = [...link.matchAll(/<([^>]+)>; rel="next"/g)]; check(next.length <= 1, 'Ambiguous reporting continuation');
      if (!next.length) break; check(page < protocolPageLimit && next[0][1] === builders.reportStatuses(deploymentId, page + 1).url, 'Reporting continuation resource differs');
    }
    const found = records.filter(item => item.state === 'success' && item.environment === policy.github.environment && item.description === `Verified release event ${saved.eventDigest}`);
    check(found.length <= 1, 'Duplicate reporting acknowledgement'); return found.length ? [saved.body] : [];
  }
  async function write(kind, body) {
    await writer.assertOwner();
    if (kind === 'reports') {
      const head = await writer.readHead(), eventDigest = await writer.verificationRef();
      check(head?.state.phase === 'report-reconcile' && same(head.state.operation?.body, body) && head.state.report?.eventDigest === eventDigest && head.state.report.verificationDigest === digest(head.state.verification), 'Durable verified reporting outbox required');
      await writer.recordProvider(provider => { check(!provider.reports.some(item => item.body.eventId === body.eventId), 'Saved reporting intent requires GET-only reconciliation'); provider.reports.push({ body, eventDigest }); });
      await recordRequest({ id: body.eventId, target: { kind: 'github', deploymentId } }, 'report', builders.reportSuccess(deploymentId, eventDigest), { eventDigest }); return;
    }
    check(['stage', 'activate'].includes(kind), 'Unsupported hosted provider mutation');
    const component = componentFor(body.component, body.version), selected = selectedVersion(component), target = targetFor(body.component), candidate = await candidateFor(body.component, body.version);
    check(body.artifactDigest === selected.artifactDigest && body.configDigest === selected.configDigest, 'Provider mutation logical identity differs');
    const head = await writer.readHead(); check(head?.state.phase === `${kind}-reconcile` && head.state.operation?.id === body.id && head.state.operation.bodyDigest === digest(body), 'Exact durable controller operation required');
    const currentMappings = await mappings(), active = await activeVersion(target), expected = currentMappings.find(item => item.selected.component === component.id && item.selected.version === body.expectedActiveVersion)?.providerVersion ?? null;
    check(active === expected, 'Provider active precondition differs');
    const operation = { id: body.id, kind, selected, bodyDigest: digest(body), component: structuredClone(component), targetSeal: structuredClone(target), candidateSeal: sealCandidate(candidate), target: { kind: target.kind, resource: target.resource, ...(target.alias ? { alias: target.alias } : {}) } };
    await writer.recordProvider(provider => { check(!provider.operations.some(item => item.id === body.id), 'Saved provider operation requires GET-only reconciliation'); provider.operations.push(operation); if (kind === 'activate') for (const mapping of currentMappings) if (!provider.versions.some(item => same(item.selected, mapping.selected))) provider.versions.push(mapping); });
    if (kind === 'stage') {
      const versions = await providerVersions(target); let providerVersion;
      if (target.kind === 'worker') {
        let metadata = structuredClone(candidate.worker.metadata);
        if (candidate.worker.assets.length) {
          const session = cf(await recordRequest(operation, 'asset-session', builders.assetSession(target.resource, candidate.worker.assets), { active, manifestDigest: digest(assetManifest(candidate.worker.assets).manifest) }));
          check(Array.isArray(session.buckets) && session.buckets.length <= 4096 && typeof session.jwt === 'string', 'Complete asset upload session required');
          let completion = session.buckets.length ? null : session.jwt;
          for (let index = 0; index < session.buckets.length; index++) { const value = cf(await recordRequest(operation, `asset-bucket-${index}`, builders.assetUpload(candidate.worker.assets, session.buckets[index], session.jwt), { manifestDigest: digest(assetManifest(candidate.worker.assets).manifest) })); if (value.jwt) completion = value.jwt; }
          check(completion, 'Completed static asset capability missing'); metadata = { ...metadata, assets: { ...metadata.assets, jwt: completion } };
        }
        const uploaded = cf(await recordRequest(operation, 'stage', builders.workerUpload(target.resource, { ...candidate.worker, metadata }), { active, versions })); providerVersion = cloudflareVersion(uploaded.id);
      } else {
        check(candidate.native?.awsImageQualified === true, 'Admitted AWS image qualification required');
        assertLambdaBinding(candidate.native.expectedBinding, policy);
        const latest = await json(builders.lambdaLatest(target.resource)); check(latest.Configuration?.RevisionId, 'Latest Lambda RevisionId missing');
        check(same(lambdaBindingProjection(latest.Configuration), candidate.native.expectedBinding), 'Latest Lambda target bindings differ before upload');
        const uploaded = await recordRequest(operation, 'stage', builders.lambdaUpload(target.resource, candidate.native.imageDigest, latest.Configuration.RevisionId), { active, versions, revisionId: latest.Configuration.RevisionId }); providerVersion = numberedVersion(uploaded.Version);
      }
      const mapping = { selected, providerVersion, target: operation.target, component: operation.component, targetSeal: operation.targetSeal, candidateSeal: operation.candidateSeal }; await verifyMapping(mapping);
      await writer.recordProvider(provider => { provider.versions.push(mapping); });
    } else {
      const mapping = currentMappings.find(item => same(item.selected, selected)); check(mapping, 'Admitted staged provider version missing'); await verifyMapping(mapping);
      if (target.kind === 'worker') await recordRequest(operation, 'activate', builders.workerActivate(target.resource, mapping.providerVersion), { active });
      else {
        const alias = await readAlias(target);
        check((alias?.FunctionVersion ?? null) === active, 'Lambda alias changed before activation');
        await recordRequest(operation, 'activate', alias === null ? builders.lambdaCreateAlias(target.resource, target.alias, mapping.providerVersion)
          : builders.lambdaActivate(target.resource, target.alias, mapping.providerVersion, alias.RevisionId), { active, revisionId: alias?.RevisionId ?? null });
      }
      if (!currentMappings.some(item => same(item, mapping))) await writer.recordProvider(provider => { provider.versions.push(mapping); });
    }
  }
  return Object.freeze({ inventory, content, runtime: async () => (await inventory()).active, operations, write, reports, verifyContent: verifyHostedContent, stageRequest: hostedStageRequest });
}
