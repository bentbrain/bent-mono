import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { check, canonical, digest, sha256, same, pathName, readRef, parseJSON, confined } from './data.mjs';
import { codeIdentity } from './component-identity.mjs';
import { componentClosure, parseLock, validateInventory } from './scoped-inputs.mjs';
import { shopClosurePolicy } from './source-inventory.mjs';

const manifestName = 'portable-bundle.json';
const exact = (value, keys) => check(value && typeof value === 'object' && !Array.isArray(value) && same(Object.keys(value).sort(), [...keys].sort()), 'Unexpected portable bundle fields');
const commit = value => check(/^[a-f0-9]{40}$/.test(value ?? '') && value !== '0'.repeat(40), 'Exact portable artifact origin required');
const sort = values => values.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const bound = { files: 16384, fileBytes: 512 * 1024 * 1024, totalBytes: 3 * 1024 * 1024 * 1024 };

function lineageIdentity(value, origin, hosted) {
  commit(origin); check(value?.sourceCommit === origin, 'Portable CI source differs');
  if (value.kind === 'github-actions') {
    exact(value, ['kind', 'repository', 'sourceCommit', 'runId', 'runAttempt', 'workflowRef', 'jobId']);
    check(value.repository === 'bentbrain/bent-mono' && /^[1-9][0-9]*$/.test(value.runId) && /^[1-9][0-9]*$/.test(value.runAttempt) &&
      /^bentbrain\/bent-mono\/\.github\/workflows\/[a-z0-9-]+\.yml@refs\//.test(value.workflowRef) && /^[a-zA-Z0-9_-]+$/.test(value.jobId), 'Complete exact GitHub artifact lineage required');
  } else {
    check(!hosted, 'Authenticated hosted artifact lineage required');
    exact(value, ['kind', 'sourceCommit', 'dirtySnapshot']);
    check(value.kind === 'local-source-build' && typeof value.dirtySnapshot === 'boolean', 'Explicit local source lineage required');
  }
  return value;
}

async function fileBytes(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    check(before.isFile() && before.size <= bound.fileBytes, 'Bounded regular portable file required');
    const bytes = await handle.readFile(), after = await handle.stat(), current = await lstat(path);
    check(['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => before[key] === after[key] && after[key] === current[key]), 'Portable file changed during inspection');
    check(bytes.length === after.size, 'Portable file framing differs');
    return { bytes, mode: before.mode & 0o111 ? '0700' : '0600', permissions: before.mode & 0o777 };
  } finally { await handle.close(); }
}

async function tree(root, prefix = '', result = { files: [], directories: [] }, privateOnly = false) {
  const names = (await readdir(join(root, prefix))).sort();
  for (const name of names) {
    const path = prefix ? `${prefix}/${name}` : name; pathName(path);
    const target = await confined(root, path), info = await lstat(target);
    if (info.isDirectory()) { check(!privateOnly || (info.mode & 0o777) === 0o700, 'Portable directory mode differs'); result.directories.push(path); await tree(root, path, result, privateOnly); }
    else {
      const file = await fileBytes(target);
      check(!privateOnly || file.permissions === parseInt(file.mode, 8), 'Portable file mode differs');
      result.files.push({ path, bytes: file.bytes.length, sha256: sha256(file.bytes), mode: file.mode });
      result.bytes = (result.bytes ?? 0) + file.bytes.length;
      check(result.bytes <= bound.totalBytes && result.files.length <= bound.files, 'Portable inventory exceeds byte or file bound');
    }
  }
  check(same(names, (await readdir(join(root, prefix))).sort()), 'Portable path list changed during inspection');
  return result;
}

async function put(root, path, bytes, mode = '0600') {
  pathName(path); await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), bytes, { flag: 'wx', mode: mode === '0700' ? 0o700 : 0o600 });
  return { path, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
}
const document = (root, path, value) => put(root, path, Buffer.from(canonical(value)));
const mediaType = path => path.endsWith('.wasm') ? 'application/wasm' : /\.[cm]?js$/.test(path) ? 'application/javascript' : /\.(json|map)$/.test(path) ? 'application/json' : 'application/octet-stream';

async function copyPayload(from, to, prefix, identityFiles = [], identityRoot) {
  const source = await realpath(from), before = await tree(source);
  check(before.files.length > 0, 'Portable component payload is empty');
  check(new Set(identityFiles).size === identityFiles.length && identityFiles.every(path => { pathName(path); return before.files.some(file => file.path === path); }), 'Portable identity sidecar differs');
  if (identityFiles.length) pathName(identityRoot);
  for (const file of before.files) {
    const actual = await fileBytes(await confined(source, file.path));
    check(sha256(actual.bytes) === file.sha256 && actual.mode === file.mode, 'Build output changed during retention');
    await put(to, `${identityFiles.includes(file.path) ? identityRoot : prefix}/${file.path}`, actual.bytes, file.mode);
  }
  check(same(before, await tree(source)), 'Build output inventory changed during retention');
  return before.files.filter(file => !identityFiles.includes(file.path));
}

/** Retain already built bytes. This function invokes no builder or deployment. */
export async function packagePortableBundle({ destination, originSourceCommit, lineage, sourceInventory, sourceDirectory,
    components, sources = [], closurePolicy: suppliedPolicy }) {
  commit(originSourceCommit); lineageIdentity(lineage, originSourceCommit, false);
  check(Array.isArray(components) && same(components.map(item => item.id).sort(), ['business', 'native', 'storefront']), 'Complete Shop component set required');
  const root = resolve(destination); await mkdir(root, { mode: 0o700 });
  const origins = sources.length ? sources : [{ originSourceCommit, inventory: sourceInventory, directory: sourceDirectory }];
  const snapshots = new Map();
  for (const source of origins) {
    commit(source.originSourceCommit); check(!snapshots.has(source.originSourceCommit), 'Duplicate portable source origin');
    const files = validateInventory(source.inventory.files.map(({ path, sha256, mode }) => ({ path, sha256, mode })));
    const prefix = `snapshots/${source.originSourceCommit}`;
    for (const file of files) {
      const loaded = source.readSource ? { bytes: await source.readSource(file.path), mode: file.mode === '100755' ? '0700' : '0600' }
        : await fileBytes(await confined(source.directory, file.path));
      check(sha256(loaded.bytes) === file.sha256 && loaded.mode === (file.mode === '100755' ? '0700' : '0600'), 'Portable origin source bytes or mode differ');
      await put(root, `${prefix}/${file.path}`, loaded.bytes, loaded.mode);
    }
    const inputsRef = await document(root, `metadata/${source.originSourceCommit}-inputs.json`, { schema: 'shop.root-inputs/v2', files });
    const lock = await fileBytes(join(root, prefix, 'bun.lock'));
    snapshots.set(source.originSourceCommit, { originSourceCommit: source.originSourceCommit, root: prefix, files, inputsRef, treeDigest: digest(files), lock: parseLock(lock.bytes) });
  }
  check(snapshots.has(originSourceCommit), 'Bundle intent source snapshot is missing');
  const retained = [], runtimes = {};
  for (const component of [...components].sort((a, b) => a.id < b.id ? -1 : 1)) {
    commit(component.originSourceCommit); check(snapshots.has(component.originSourceCommit), 'Component origin snapshot missing'); pathName(component.entrypoint);
    if (component.identityFiles?.length) check(component.runtime.identityDirectory === `metadata/${component.id}-candidate`, 'Portable identity metadata root differs');
    const prefix = `payload/${component.id}`, files = await copyPayload(component.directory, root, prefix, component.identityFiles, component.runtime.identityDirectory);
    check(files.some(file => file.path === component.entrypoint), 'Portable component entrypoint missing');
    const runtime = { schema: 'shop.portable-runtime/v1', definition: component.runtime, modes: files.map(({ path, mode }) => ({ path, mode })), awsImageQualified: false };
    check(component.runtime && component.runtime.awsImageQualified !== true, 'Guarded AWS image qualification is required separately');
    const runtimeRef = await document(root, `metadata/${component.id}-runtime.json`, runtime);
    runtimes[component.id] = digest(runtime);
    retained.push({ input: component, prefix, files, runtimeRef, runtime });
  }
  const policy = suppliedPolicy ?? shopClosurePolicy(runtimes);
  check(same(policy.runtime, runtimes), 'Portable runtime and reviewed closure policy differ');
  const policyRef = await document(root, 'metadata/closure-policy.json', policy), records = [];
  for (const { input, prefix, files, runtimeRef } of retained) {
    const snapshot = snapshots.get(input.originSourceCommit);
    const closure = componentClosure({ files: snapshot.files, lock: snapshot.lock, policy, component: input.id });
    const closureRef = await document(root, `metadata/${input.id}-closure.json`, closure);
    const artifact = { schema: 'shop.artifact/v2', component: input.id, format: 'module-bundle', root: prefix, entrypoint: `${prefix}/${input.entrypoint}`,
      files: files.map(file => ({ path: `${prefix}/${file.path}`, bytes: file.bytes, sha256: file.sha256, mediaType: mediaType(file.path) })),
      originSourceCommit: input.originSourceCommit, inputsDigest: closure.buildDigest, runtimeDigest: runtimes[input.id] };
    artifact.codeDigest = codeIdentity(artifact);
    const artifactRef = await document(root, `metadata/${input.id}-artifact.json`, artifact);
    const provenance = { schema: 'shop.build-provenance/v1', component: input.id, originSourceCommit: input.originSourceCommit,
      sourceTreeDigest: snapshot.treeDigest, inputsDigest: closure.buildDigest, artifactFilesDigest: digest(artifact.files), recipeDigest: digest({ policy, runtimeRef }),
      toolchainDigest: runtimes[input.id], dependencyLockDigest: closure.lockDigest };
    const provenanceRef = await document(root, `metadata/${input.id}-provenance.json`, provenance);
    records.push({ id: input.id, originSourceCommit: input.originSourceCommit, artifactRef, provenanceRef, runtimeRef, closureRef });
  }
  const inventory = await tree(root); sort(inventory.files);
  const manifest = { schema: 'shop.portable-bundle/v1', originSourceCommit, lineage, awsImageQualified: false, policyRef,
    snapshots: [...snapshots.values()].map(({ lock, ...snapshot }) => snapshot), components: records,
    files: inventory.files, filesDigest: digest(inventory.files) };
  const manifestRef = await document(root, manifestName, manifest);
  return verifyPortableBundle(root, { manifestSha256: manifestRef.sha256, originSourceCommit, lineage, requireHostedLineage: false });
}

/** The expected SHA and lineage must come from authenticated CI artifact admission. */
export async function verifyPortableBundle(directory, expected) {
  check(expected && /^[a-f0-9]{64}$/.test(expected.manifestSha256 ?? ''), 'Externally authenticated portable manifest SHA required');
  check(!(await lstat(directory)).isSymbolicLink(), 'Portable root symlink is forbidden');
  const root = await realpath(directory), bytes = (await fileBytes(await confined(root, manifestName))).bytes;
  check(((await lstat(root)).mode & 0o777) === 0o700, 'Private portable root required');
  check(sha256(bytes) === expected.manifestSha256, 'Portable manifest identity differs');
  const manifest = parseJSON(bytes, 16 * 1024 * 1024);
  exact(manifest, ['schema', 'originSourceCommit', 'lineage', 'awsImageQualified', 'policyRef', 'snapshots', 'components', 'files', 'filesDigest']);
  check(manifest.schema === 'shop.portable-bundle/v1' && manifest.originSourceCommit === expected.originSourceCommit && manifest.awsImageQualified === false && same(manifest.lineage, expected.lineage), 'Portable artifact origin or authenticated lineage differs');
  lineageIdentity(manifest.lineage, expected.originSourceCommit, expected.requireHostedLineage !== false);
  const actual = await tree(root, '', { files: [], directories: [] }, true), actualFiles = sort(actual.files.filter(file => file.path !== manifestName));
  check(same(actualFiles, manifest.files) && digest(actualFiles) === manifest.filesDigest, 'Portable complete inventory, mode or bytes differ');
  check(actualFiles.reduce((sum, file) => sum + file.bytes, 0) <= bound.totalBytes, 'Portable total byte bound exceeded');
  const directories = new Set(); for (const file of actual.files) { let path = dirname(file.path); while (path !== '.') { directories.add(path); path = dirname(path); } }
  check(same([...directories].sort(), actual.directories.sort()), 'Portable extra or empty directory differs');
  const policy = parseJSON(await readRef(root, manifest.policyRef), 16 * 1024 * 1024), snapshots = new Map();
  for (const snapshot of manifest.snapshots) {
    exact(snapshot, ['originSourceCommit', 'root', 'files', 'inputsRef', 'treeDigest']); commit(snapshot.originSourceCommit);
    check(!snapshots.has(snapshot.originSourceCommit) && snapshot.root === `snapshots/${snapshot.originSourceCommit}`, 'Portable snapshot origin differs');
    validateInventory(snapshot.files); check(digest(snapshot.files) === snapshot.treeDigest, 'Portable source inventory digest differs');
    const inventory = await tree(await confined(root, snapshot.root));
    check(same(sort(inventory.files.map(file => ({ path: file.path, sha256: file.sha256, mode: file.mode === '0700' ? '100755' : '100644' }))), snapshot.files), 'Portable source snapshot is incomplete');
    const inputs = parseJSON(await readRef(root, snapshot.inputsRef), 16 * 1024 * 1024);
    check(inputs.schema === 'shop.root-inputs/v2' && same(inputs.files, snapshot.files), 'Portable source input reference differs');
    snapshots.set(snapshot.originSourceCommit, { ...snapshot, lock: parseLock((await fileBytes(join(root, snapshot.root, 'bun.lock'))).bytes) });
  }
  check(snapshots.has(manifest.originSourceCommit), 'Portable intent snapshot missing');
  check(same(manifest.components.map(item => item.id), ['business', 'native', 'storefront']), 'Portable component set differs');
  const components = new Map();
  for (const record of manifest.components) {
    exact(record, ['id', 'originSourceCommit', 'artifactRef', 'provenanceRef', 'runtimeRef', 'closureRef']);
    const artifact = parseJSON(await readRef(root, record.artifactRef)), provenance = parseJSON(await readRef(root, record.provenanceRef));
    const runtime = parseJSON(await readRef(root, record.runtimeRef)), closure = parseJSON(await readRef(root, record.closureRef), 16 * 1024 * 1024);
    const snapshot = snapshots.get(record.originSourceCommit); check(snapshot, 'Portable component source origin missing');
    const wanted = componentClosure({ files: snapshot.files, lock: snapshot.lock, policy, component: record.id });
    check(same(closure, wanted), 'Portable build/proof closure differs');
    check(artifact.schema === 'shop.artifact/v2' && artifact.component === record.id && artifact.originSourceCommit === record.originSourceCommit && artifact.root === `payload/${record.id}` && artifact.codeDigest === codeIdentity(artifact) && artifact.inputsDigest === closure.buildDigest, 'Portable code artifact identity differs');
    const payload = (await tree(await confined(root, artifact.root))).files;
    check(same(payload.map(file => ({ path: `${artifact.root}/${file.path}`, bytes: file.bytes, sha256: file.sha256, mediaType: mediaType(file.path) })), artifact.files), 'Portable component has extra or missing payload');
    check(payload.some(file => `${artifact.root}/${file.path}` === artifact.entrypoint) && same(payload.map(({ path, mode }) => ({ path, mode })), runtime.modes), 'Portable entrypoint or runtime modes differ');
    check(runtime.schema === 'shop.portable-runtime/v1' && runtime.awsImageQualified === false && runtime.definition?.awsImageQualified !== true && digest(runtime) === artifact.runtimeDigest && artifact.runtimeDigest === policy.runtime[record.id], 'Portable runtime identity differs');
    if (runtime.definition.identityDirectory !== undefined) check(runtime.definition.identityDirectory === `metadata/${record.id}-candidate` &&
      actualFiles.some(file => file.path.startsWith(`${runtime.definition.identityDirectory}/`)), 'Portable runtime identity directory differs');
    if (expected.runtimeDigests) check(expected.runtimeDigests[record.id] === artifact.runtimeDigest, 'Admitted target runtime differs');
    check(provenance.schema === 'shop.build-provenance/v1' && provenance.component === record.id && provenance.originSourceCommit === record.originSourceCommit && provenance.sourceTreeDigest === snapshot.treeDigest && provenance.inputsDigest === closure.buildDigest && provenance.artifactFilesDigest === digest(artifact.files) && provenance.toolchainDigest === artifact.runtimeDigest && provenance.dependencyLockDigest === closure.lockDigest && provenance.recipeDigest === digest({ policy, runtimeRef: record.runtimeRef }), 'Portable provenance identity differs');
    const intent = snapshots.get(manifest.originSourceCommit), intentClosure = componentClosure({ files: intent.files, lock: intent.lock, policy, component: record.id });
    const component = { id: record.id, originSourceCommit: record.originSourceCommit, sourceTreeDigest: snapshot.treeDigest,
      inputsDigest: closure.buildDigest, intentInputsDigest: intentClosure.buildDigest, proofInputsDigest: closure.proofDigest, intentProofInputsDigest: intentClosure.proofDigest,
      inputsRef: snapshot.inputsRef, intentInputsRef: intent.inputsRef, artifact: record.artifactRef, provenance: record.provenanceRef, codeDigest: artifact.codeDigest };
    components.set(record.id, { component, artifact, artifactRef: record.artifactRef, provenance, provenanceRef: record.provenanceRef, runtime, runtimeRef: record.runtimeRef, closure, snapshot });
  }
  return { root, manifest, manifestSha256: expected.manifestSha256, components, lineage: manifest.lineage,
    sourceInventory: snapshots.get(manifest.originSourceCommit), snapshots, closurePolicy: policy, expected };
}

export async function readPortableArtifact(verified, id) {
  const current = await verifyPortableBundle(verified.root, verified.expected), component = current.components.get(id);
  check(component, 'Unknown portable component');
  return { ...component, files: await Promise.all(component.artifact.files.map(async file => ({ ...file, data: await readRef(current.root, file) }))) };
}

/** Copy retained bytes into a separate composition assembly. No build occurs. */
export async function materializePortableBundle(verified, destination) {
  const current = await verifyPortableBundle(verified.root, verified.expected), root = resolve(destination);
  check(root !== current.root && !root.startsWith(`${current.root}/`), 'Assembly must be separate from the immutable portable root');
  await mkdir(root, { mode: 0o700 });
  for (const file of [...current.manifest.files, { path: manifestName, bytes: (await fileBytes(join(current.root, manifestName))).bytes.length,
    sha256: current.manifestSha256, mode: '0600' }]) {
    const bytes = await readRef(current.root, file); await put(root, file.path, bytes, file.mode);
  }
  const actual = await tree(root, '', { files: [], directories: [] }, true);
  check(same(sort(actual.files.filter(file => file.path !== manifestName)), current.manifest.files), 'Assembled artifact bytes or modes differ');
  await verifyPortableBundle(current.root, current.expected);
  return { kind: 'shop.portable-assembly/v1', root, originRoot: current.root, originManifestSha256: current.manifestSha256,
    components: current.components, snapshots: current.snapshots, sourceInventory: current.sourceInventory,
    closurePolicy: current.closurePolicy, lineage: current.lineage };
}
