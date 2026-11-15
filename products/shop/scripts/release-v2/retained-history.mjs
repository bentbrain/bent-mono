import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonical, check, confined, digest, parseJSON, pathName, readRef, readRegularFile, same, sha256 } from './data.mjs';
import { importHostedCompositionArchive, assertHostedCompositionArchive } from './artifact-intake.mjs';
import { verifyNativeQualificationReceipt } from './native-qualification.mjs';
import { materializePortableBundle, verifyPortableBundle } from './portable-bundle.mjs';

const qualificationImports = new WeakMap();
const imports = new WeakMap(), maximumFile = 512 * 1024 * 1024, maximumTotal = 4 * 1024 ** 3 - 1;
const manifestName = 'history-package.private.json';
const fields = (value, keys) => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()), 'Historical package fields differ');
const hash = value => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Exact historical content digest required');
const order = files => files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

async function file(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); check(before.isFile() && before.nlink === 1 && before.size <= maximumFile && [0o600, 0o700].includes(before.mode & 0o777), 'Bounded private historical file required');
    const bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(path);
    check(['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => before[key] === after[key] && after[key] === current[key]) && bytes.length === after.size, 'Historical file changed during inspection');
    return { bytes, mode: before.mode & 0o111 ? '0700' : '0600' };
  } finally { await handle.close(); }
}
async function inventory(root, prefix = '', result = { files: [], bytes: 0 }) {
  const names = (await readdir(join(root, prefix))).sort();
  for (const name of names) {
    const path = prefix ? `${prefix}/${name}` : name; pathName(path);
    const absolute = await confined(root, path), info = await lstat(absolute);
    if (info.isDirectory()) { check((info.mode & 0o777) === 0o700, 'Private history directory mode differs'); await inventory(root, path, result); }
    else {
      const value = await file(absolute); result.bytes += value.bytes.length;
      check(result.bytes <= maximumTotal && result.files.length < 32768, 'Historical package exceeds bounds');
      result.files.push({ path, bytes: value.bytes.length, sha256: sha256(value.bytes), mode: value.mode });
    }
  }
  check(same(names, (await readdir(join(root, prefix))).sort()), 'History directory changed during inspection'); return order(result.files);
}
async function put(root, path, bytes, mode = '0600') {
  pathName(path); check(Buffer.isBuffer(bytes) && bytes.length <= maximumFile && ['0600', '0700'].includes(mode), 'Bounded historical output bytes required');
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), bytes, { flag: 'wx', mode: parseInt(mode, 8) });
}
function references(value, result = [], allowExternal = false) {
  if (Array.isArray(value)) value.forEach(item => references(item, result, allowExternal));
  else if (value && typeof value === 'object') {
    if (same(Object.keys(value).sort(), ['bytes', 'path', 'sha256']) && typeof value.path === 'string' && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
      if (value.path.startsWith('/')) { check(allowExternal, 'Signed composition reference must be bundle relative'); return result; }
      pathName(value.path); check(value.bytes <= maximumFile, 'Historical referenced file exceeds bound'); result.push(value);
    } else Object.values(value).forEach(item => references(item, result, allowExternal));
  }
  return result;
}
function retainedReferences(envelope, authority) {
  const runner = authority.payload?.policy?.runner?.script, refs = references(runner);
  check(refs.length === 1 && same(refs[0], runner) && runner.bytes > 0,
    'Retain the original signed journey runner with historical release evidence');
  return [...references(envelope.payload), runner];
}
async function expectedPortable(root, authority) {
  const bytes = await readRegularFile(await confined(root, 'portable-bundle.json'), 16 * 1024 ** 2, true), manifest = parseJSON(bytes, 16 * 1024 ** 2);
  const subjects = authority.payload.portableManifests;
  check(Array.isArray(subjects) && subjects.length > 0 && subjects.every(item => item.manifestSha256 === sha256(bytes) && item.lineageDigest === digest(manifest.lineage)), 'Historical portable bytes differ from original authority');
  return verifyPortableBundle(root, { manifestSha256: sha256(bytes), originSourceCommit: manifest.originSourceCommit, lineage: manifest.lineage, requireHostedLineage: true });
}
function validateRetained(retained) {
  fields(retained, ['schema', 'options', 'eventDigest', 'compositionDigest']);
  const options = retained.options, allowed = ['bundle', 'portable', 'manifest', 'authority', 'trustRoot', 'rootDigest', 'targetPlan', 'fence', 'evidenceDirectory', 'sourceEvidence'];
  check(options && typeof options === 'object' && !Array.isArray(options) && ['bundle', 'portable', 'manifest', 'authority', 'rootDigest'].every(key => Object.hasOwn(options, key)) &&
    Object.keys(options).every(key => allowed.includes(key)), 'Historical descriptor contains unsupported protected fields');
  for (const [key, value] of Object.entries(options)) if (key !== 'rootDigest') check(typeof value === 'string' && value.startsWith('/') && value === resolve(value), 'Historical descriptor requires absolute locator paths');
  hash(options.rootDigest);
}
function requireComplete(result, retained, identity) {
  validateRetained(retained);
  const controller = result?.controller;
  check(retained.schema === 'shop.verified-workflow-release/v1' && controller?.phase === 'complete' && controller.lastVerified && controller.report?.status === 'confirmed' && controller.report.eventDigest === retained.eventDigest &&
    controller.compositionDigest === retained.compositionDigest && digest(controller.lastVerified) === retained.compositionDigest && controller.lastVerified.intentSourceCommit === identity.head,
  'Only a complete matching runtime-verified release can be retained for rollback');
  hash(retained.eventDigest); hash(retained.compositionDigest); hash(retained.options?.rootDigest);
}

/** Retain original bytes once. This transports evidence and grants no rollback authority. */
export async function packageHostedReleaseHistory({ verifiedReleaseFile, result, identity, destination }) {
  const descriptorBytes = await readRegularFile(verifiedReleaseFile, 1024 * 1024, true), retained = parseJSON(descriptorBytes, 1024 * 1024);
  requireComplete(result, retained, identity);
  const options = retained.options, bundle = await realpath(options.bundle);
  check(options.bundle === bundle && options.manifest === join(bundle, 'release-composition.json') && options.authority === join(bundle, 'release-authority.json'), 'Exact original assembled history paths required');
  const authorityBytes = await readRegularFile(await confined(bundle, 'release-authority.json'), 16 * 1024 ** 2, true), authority = parseJSON(authorityBytes, 16 * 1024 ** 2);
  const envelopeBytes = await readRegularFile(await confined(bundle, 'release-composition.json'), 16 * 1024 ** 2, true), envelope = parseJSON(envelopeBytes, 16 * 1024 ** 2);
  check(digest(envelope.payload) === retained.compositionDigest && same(controllerPayload(result), envelope.payload) && authority.payload.head === identity.head && authority.payload.workflowCommit === identity.workflowCommit &&
    authority.payload.runId === identity.runId && authority.payload.attempt === identity.attempt && same(authority.payload.repository, identity.repository), 'Original signed release identity differs');
  const portable = await expectedPortable(options.portable, authority);
  check(typeof destination === 'string' && destination === resolve(destination) && await realpath(dirname(destination)) === dirname(destination) && destination !== bundle && !destination.startsWith(`${bundle}/`) && destination !== portable.root && !destination.startsWith(`${portable.root}/`), 'Separate canonical history destination required');
  await mkdir(destination, { mode: 0o700 }); check(await realpath(destination) === destination, 'History package parent must be canonical');
  for (const ref of [...portable.manifest.files, { path: 'portable-bundle.json', bytes: (await file(join(portable.root, 'portable-bundle.json'))).bytes.length, sha256: portable.manifestSha256, mode: '0600' }])
    await put(destination, `portable/${ref.path}`, await readRef(portable.root, ref), ref.mode);
  const included = new Map(portable.manifest.files.map(ref => [ref.path, ref]));
  included.set('portable-bundle.json', { path: 'portable-bundle.json', bytes: (await file(join(portable.root, 'portable-bundle.json'))).bytes.length, sha256: portable.manifestSha256 });
  const pending = retainedReferences(envelope, authority), visited = new Map(); let discoveredBytes = 0;
  for (let index = 0; index < pending.length; index++) {
    check(pending.length <= 32768, 'Historical reference closure exceeds bound'); const ref = pending[index];
    if (visited.has(ref.path)) { check(same(visited.get(ref.path), ref), 'Conflicting historical reference'); continue; }
    visited.set(ref.path, ref); const bytes = await readRef(bundle, ref); discoveredBytes += bytes.length; check(discoveredBytes <= maximumTotal, 'Historical reference bytes exceed bound');
    if (included.has(ref.path)) { const original = included.get(ref.path); check(ref.bytes === original.bytes && ref.sha256 === original.sha256, 'Assembly changed original portable bytes'); }
    else { const info = await file(await confined(bundle, ref.path)); await put(destination, `assembly-extra/${ref.path}`, bytes, info.mode); }
    if (bytes.length <= 16 * 1024 ** 2 && ['{', '['].includes(bytes.subarray(0, 1).toString())) {
      let document; try { document = parseJSON(bytes, 16 * 1024 ** 2); } catch { continue; }
      pending.push(...references(document, [], true));
    }
  }
  await put(destination, 'assembly-extra/release-composition.json', envelopeBytes);
  await put(destination, 'assembly-extra/release-authority.json', authorityBytes);
  await put(destination, 'metadata/original-verified-release.private.json', descriptorBytes);
  const files = await inventory(destination), history = { schema: 'shop.retained-release-history/v1', identity, eventDigest: retained.eventDigest, compositionDigest: retained.compositionDigest,
    rootDigest: options.rootDigest, portable: portable.expected, authoritySha256: sha256(authorityBytes), compositionSha256: sha256(envelopeBytes),
    originalVerifiedSha256: sha256(descriptorBytes), files, filesDigest: digest(files), remoteVerificationRequired: true };
  await put(destination, manifestName, Buffer.from(canonical(history)));
  return { directory: destination, history, manifestSha256: sha256(canonical(history)), remoteVerificationRequired: true };
}
const controllerPayload = result => result.controller.lastVerified;

async function referenceClosure(root, envelope, portable, authority) {
  const original = new Map(portable.manifest.files.map(ref => [ref.path, ref]));
  original.set('portable-bundle.json', { path: 'portable-bundle.json', bytes: (await file(join(portable.root, 'portable-bundle.json'))).bytes.length, sha256: portable.manifestSha256 });
  const pending = retainedReferences(envelope, authority), visited = new Map(), extra = new Set(['release-composition.json', 'release-authority.json']);
  for (let index = 0; index < pending.length; index++) {
    check(pending.length <= 32768, 'Historical reference closure exceeds bound'); const ref = pending[index];
    if (visited.has(ref.path)) { check(same(visited.get(ref.path), ref), 'Conflicting historical reference'); continue; }
    visited.set(ref.path, ref); let bytes;
    if (original.has(ref.path)) { const retained = original.get(ref.path); check(ref.sha256 === retained.sha256 && ref.bytes === retained.bytes, 'Historical portable reference differs'); bytes = await readRef(portable.root, ref); }
    else { extra.add(ref.path); bytes = await readRef(join(root, 'assembly-extra'), ref); }
    if (bytes.length <= 16 * 1024 ** 2 && ['{', '['].includes(bytes.subarray(0, 1).toString())) {
      let document; try { document = parseJSON(bytes, 16 * 1024 ** 2); } catch { continue; } pending.push(...references(document, [], true));
    }
  }
  return [...extra].sort();
}

async function inspectPackage(root, identity) {
  const bytes = await readRegularFile(await confined(root, manifestName), 32 * 1024 ** 2, true), history = parseJSON(bytes, 32 * 1024 ** 2);
  fields(history, ['schema', 'identity', 'eventDigest', 'compositionDigest', 'rootDigest', 'portable', 'authoritySha256', 'compositionSha256', 'originalVerifiedSha256', 'files', 'filesDigest', 'remoteVerificationRequired']);
  check(history.schema === 'shop.retained-release-history/v1' && same(history.identity, identity) && history.remoteVerificationRequired === true, 'Original historical package identity differs');
  for (const key of ['eventDigest', 'compositionDigest', 'rootDigest', 'authoritySha256', 'compositionSha256', 'originalVerifiedSha256', 'filesDigest']) hash(history[key]);
  check(Array.isArray(history.files) && same((await inventory(root)).filter(ref => ref.path !== manifestName), history.files) && digest(history.files) === history.filesDigest, 'Historical package complete inventory differs');
  check(history.files.every(ref => ref.path.startsWith('portable/') || ref.path.startsWith('assembly-extra/') || ref.path === 'metadata/original-verified-release.private.json'), 'Historical package includes an external protected file');
  const portable = await verifyPortableBundle(join(root, 'portable'), history.portable);
  const authorityBytes = await readRegularFile(await confined(root, 'assembly-extra/release-authority.json'), 16 * 1024 ** 2, true), compositionBytes = await readRegularFile(await confined(root, 'assembly-extra/release-composition.json'), 16 * 1024 ** 2, true);
  const authority = parseJSON(authorityBytes, 16 * 1024 ** 2), envelope = parseJSON(compositionBytes, 16 * 1024 ** 2);
  const originalBytes = await readRegularFile(await confined(root, 'metadata/original-verified-release.private.json'), 1024 * 1024, true), original = parseJSON(originalBytes, 1024 * 1024);
  validateRetained(original);
  check(sha256(authorityBytes) === history.authoritySha256 && sha256(compositionBytes) === history.compositionSha256 && sha256(originalBytes) === history.originalVerifiedSha256 &&
    original.schema === 'shop.verified-workflow-release/v1' && original.eventDigest === history.eventDigest && original.compositionDigest === history.compositionDigest && original.options.rootDigest === history.rootDigest &&
    digest(envelope.payload) === history.compositionDigest && authority.payload.head === identity.head && authority.payload.runId === identity.runId && authority.payload.attempt === identity.attempt &&
    authority.payload.workflowCommit === identity.workflowCommit && same(authority.payload.repository, identity.repository), 'Historical signed bytes or verification locator differ');
  await expectedPortable(portable.root, authority);
  check(same(await referenceClosure(root, envelope, portable, authority), history.files.filter(ref => ref.path.startsWith('assembly-extra/')).map(ref => ref.path.slice('assembly-extra/'.length)).sort()), 'Historical package contains unreferenced assembly bytes');
  return { history, portable, manifestSha256: sha256(bytes) };
}

/** Fetch an original encrypted workflow artifact on a fresh runner. No installed keys enter it. */
export async function importHostedReleaseHistory(options) {
  const imported = await importHostedCompositionArchive(options), root = join(imported.root, 'release-history');
  const inspected = await inspectPackage(root, imported.identity);
  const rollbackDirectory = join(options.destination, 'rollback'), bundle = join(rollbackDirectory, 'assembly'); await mkdir(rollbackDirectory, { mode: 0o700 });
  await materializePortableBundle(inspected.portable, bundle);
  for (const ref of inspected.history.files.filter(ref => ref.path.startsWith('assembly-extra/')))
    await put(bundle, ref.path.slice('assembly-extra/'.length), await readRef(root, ref), ref.mode);
  const descriptor = { schema: 'shop.verified-workflow-release/v1', options: { bundle, portable: inspected.portable.root, manifest: join(bundle, 'release-composition.json'),
    authority: join(bundle, 'release-authority.json'), rootDigest: inspected.history.rootDigest }, eventDigest: inspected.history.eventDigest, compositionDigest: inspected.history.compositionDigest };
  // This rebases unsigned locators only. Original signed bytes remain unchanged.
  await put(rollbackDirectory, 'verified-release.private.json', Buffer.from(canonical(descriptor)));
  const result = Object.freeze({ rollbackDirectory, history: inspected.history, evidence: imported.evidence, original: imported, remoteVerificationRequired: true });
  imports.set(result, { imported, root, inspected, descriptor, descriptorDigest: digest(descriptor), bundle });
  return result;
}

export async function assertHostedReleaseHistory(result) {
  const state = imports.get(result); check(state, 'Authenticated in-process historical release import required');
  await assertHostedCompositionArchive(state.imported);
  const inspected = await inspectPackage(state.root, state.imported.identity);
  check(same(inspected.history, result.history) && same(result.evidence, state.imported.evidence) && inspected.manifestSha256 === state.inspected.manifestSha256 && result.rollbackDirectory === dirname(state.bundle), 'Historical import subject changed');
  const retained = parseJSON(await readRegularFile(join(result.rollbackDirectory, 'verified-release.private.json'), 1024 * 1024, true));
  check(digest(retained) === state.descriptorDigest, 'Historical mapped locator changed');
  for (const ref of inspected.history.files) if (ref.path.startsWith('assembly-extra/')) await readRef(state.bundle, { ...ref, path: ref.path.slice('assembly-extra/'.length) });
  for (const ref of inspected.portable.manifest.files) await readRef(state.bundle, ref);
  return result;
}

/** Authenticate retained successful bootstrap evidence with the independently installed root. */
export async function importHostedNativeQualificationReceipt({ root, expected = {}, now = Date.now(), ...options }) {
  check(root && typeof root === 'object', 'Independently installed native receipt trust root required');
  const original = await importHostedCompositionArchive(options);
  const resultBytes = await readRegularFile(await confined(original.root, 'result.private.json'), 32 * 1024 ** 2, true);
  const result = parseJSON(resultBytes, 32 * 1024 ** 2);
  check(result.readiness?.nativeQualificationComplete === true && result.readiness.executionScope === 'aws/provider' && result.readiness.awsImageQualified === true,
    'Complete real-provider native qualification result required');
  const payload = verifyNativeQualificationReceipt(result.receipt, { root, expected, now });
  const imported = Object.freeze({ receipt: result.receipt, payload, evidence: original.evidence, original });
  qualificationImports.set(imported, { original, rootDigest: digest(root), expected: structuredClone(expected), resultSha256: sha256(resultBytes), receiptDigest: digest(result.receipt) });
  return imported;
}

export async function assertHostedNativeQualificationReceipt(result, { root, expected, now = Date.now() }) {
  const state = qualificationImports.get(result); check(state && digest(root) === state.rootDigest, 'Authenticated native receipt import and independently installed root required');
  await assertHostedCompositionArchive(state.original);
  const bytes = await readRegularFile(await confined(state.original.root, 'result.private.json'), 32 * 1024 ** 2, true);
  check(sha256(bytes) === state.resultSha256 && digest(result.receipt) === state.receiptDigest && same(result.evidence, state.original.evidence), 'Imported native qualification subject changed');
  const payload = verifyNativeQualificationReceipt(result.receipt, { root, expected: expected ?? state.expected, now });
  check(same(payload, result.payload), 'Imported native qualification payload changed'); return result;
}
