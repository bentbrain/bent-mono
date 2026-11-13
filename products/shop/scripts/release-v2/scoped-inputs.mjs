import { check, digest, same, pathName, parseJSON } from './data.mjs';

const sorted = values => [...values].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const exact = (value, keys) => check(value && same(Object.keys(value).sort(), [...keys].sort()), 'Unexpected closure fields');
const ids = values => Array.isArray(values) && values.length > 0 && values.every(value => /^[a-z][a-z0-9-]{0,63}$/.test(value)) && new Set(values).size === values.length;

export function closurePolicy(policy, components) {
  exact(policy, ['schema', 'components', 'rules', 'workspaces', 'runtime']);
  check(policy.schema === 'shop.scoped-input-policy/v1' && ids(policy.components) && same([...policy.components].sort(), [...components].sort()), 'Closure component policy differs');
  check(Array.isArray(policy.rules) && policy.rules.length > 0 && policy.rules.length <= 256, 'Closure rules required');
  for (const rule of policy.rules) {
    exact(rule, ['path', 'subtree', 'build', 'proof']); pathName(rule.path);
    check(typeof rule.subtree === 'boolean' && Array.isArray(rule.build) && Array.isArray(rule.proof) &&
      [...rule.build, ...rule.proof].every(id => components.includes(id)), 'Unknown rule component');
    check(new Set(rule.build).size === rule.build.length && new Set(rule.proof).size === rule.proof.length, 'Repeated rule component');
  }
  exact(policy.workspaces, components); exact(policy.runtime, components);
  for (const id of components) {
    check(Array.isArray(policy.workspaces[id]) && policy.workspaces[id].length > 0, 'Workspace roots required');
    policy.workspaces[id].forEach(pathName);
    check(/^[a-f0-9]{64}$/.test(policy.runtime[id]), 'Exact toolchain/runtime identity required');
  }
  return policy;
}

export function classifyPath(path, policy) {
  pathName(path);
  const matches = policy.rules.filter(rule => path === rule.path || rule.subtree && path.startsWith(`${rule.path}/`));
  const specificity = Math.max(0, ...matches.map(rule => rule.path.length));
  const rules = matches.filter(rule => rule.path.length === specificity);
  // Unknown files are full-admission inputs, including additions and deletions.
  // This default must never classify an unknown file as documentation.
  if (!rules.length) return { build: policy.components, proof: policy.components, unknown: true };
  return { build: [...new Set(rules.flatMap(rule => rule.build))].sort(), proof: [...new Set(rules.flatMap(rule => rule.proof))].sort(), unknown: false };
}

export function validateInventory(files) {
  check(Array.isArray(files) && files.length > 0 && files.length <= 16384, 'Complete bounded root inventory required');
  check(same(files, sorted(files)) && new Set(files.map(file => file.path)).size === files.length, 'Root inventory order or identity differs');
  for (const file of files) {
    exact(file, ['path', 'sha256', 'mode']); pathName(file.path);
    check(/^[a-f0-9]{64}$/.test(file.sha256) && ['100644', '100755'].includes(file.mode), 'Regular source file and exact mode required');
  }
  check(files.some(file => file.path === 'bun.lock') && files.some(file => file.path === 'package.json'), 'Root dependency inventory required');
  return files;
}

// Bun's text lock uses JSON plus trailing commas. Remove only commas outside
// strings immediately before ] or }; reject comments/duplicate keys normally.
export function parseLock(bytes) {
  const input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let text = '', quoted = false, escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      text += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else {
      if (character === '"') quoted = true;
      if (character === ',' && /^[\s]*[}\]]/.test(input.slice(index + 1))) continue;
      text += character;
    }
  }
  const lock = parseJSON(Buffer.from(text), 16 * 1024 * 1024);
  check(lock.lockfileVersion === 3 && lock.configVersion === 1 && lock.packages && lock.workspaces, 'Unsupported lock graph requires full dependency admission');
  check(Object.keys(lock).every(key => ['lockfileVersion', 'configVersion', 'workspaces', 'packages', 'trustedDependencies', 'patchedDependencies', 'overrides'].includes(key)), 'Unknown install policy requires full dependency admission');
  return lock;
}

// Keep every possible resolution of each reachable package name. This is
// deliberately conservative about hoisting, peers and platform variants. It
// never guesses which optional/peer version the installer will choose.
export function dependencyProjection(lock, workspaceRoots) {
  const workspaces = new Map(Object.entries(lock.workspaces));
  const packages = new Map(Object.entries(lock.packages));
  const selectedWorkspaces = new Map(), selectedPackages = new Map(), unresolved = new Set();
  const workspaceNames = new Map();
  for (const [path, metadata] of workspaces) {
    check(metadata && typeof metadata.name === 'string', 'Malformed workspace graph');
    check(!workspaceNames.has(metadata.name), 'Ambiguous workspace name'); workspaceNames.set(metadata.name, path);
  }
  const pending = [], seenNames = new Set();
  const edges = metadata => {
    check(Object.keys(metadata).every(key => ['name', 'version', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
      'optionalPeers', 'os', 'cpu', 'libc', 'bin', 'bundled', 'hasInstallScript'].includes(key)), 'Unknown dependency metadata requires full admission');
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const values = metadata[kind] ?? {};
      check(values && typeof values === 'object' && !Array.isArray(values), 'Malformed dependency edges');
      for (const [name, range] of Object.entries(values)) {
        check(typeof range === 'string', 'Unsupported dependency edge'); pending.push({ name, range, kind });
      }
    }
  };
  const workspace = path => {
    check(workspaces.has(path), 'Workspace resolution unavailable');
    if (selectedWorkspaces.has(path)) return;
    const metadata = workspaces.get(path); selectedWorkspaces.set(path, metadata); edges(metadata);
  };
  workspace('');
  for (const root of workspaceRoots) workspace(root);
  while (pending.length) {
    const { name, range, kind } = pending.pop();
    if (range.startsWith('workspace:')) {
      check(workspaceNames.has(name), 'Unresolved workspace dependency'); workspace(workspaceNames.get(name)); continue;
    }
    check(!/^(file:|link:|git\+|https?:)/.test(range), 'Unsupported dependency resolution requires full admission');
    if (seenNames.has(name)) {
      check(!unresolved.has(name) || kind === 'optionalDependencies' || kind === 'peerDependencies', 'Unresolved required dependency');
      continue;
    }
    seenNames.add(name);
    const matches = [...packages].filter(([key]) => key === name || key.endsWith(`/${name}`));
    if (!matches.length) {
      check(kind === 'optionalDependencies' || kind === 'peerDependencies', 'Unresolved required dependency');
      unresolved.add(name); continue;
    }
    for (const [key, record] of matches) {
      check(Array.isArray(record) && typeof record[0] === 'string', 'Unsupported package record');
      selectedPackages.set(key, record);
      if (record[0].startsWith('workspace:')) { workspace(record[0].slice('workspace:'.length)); continue; }
      check(record.length === 4 && typeof record[1] === 'string' && typeof record[3] === 'string' && record[2] && typeof record[2] === 'object' && !Array.isArray(record[2]), 'Unsupported registry record');
      edges(record[2]);
    }
    check(selectedPackages.size <= 16384, 'Dependency graph exceeds bound');
  }
  const { packages: _packages, workspaces: _workspaces, ...installationPolicy } = lock;
  return { schema: 'shop.resolved-dependencies/v1', installationPolicy,
    workspaces: [...selectedWorkspaces].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
    packages: [...selectedPackages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), unresolvedOptionalOrPeer: [...unresolved].sort() };
}

export function componentClosure({ files, lock, policy, component, observedReads = [] }) {
  validateInventory(files); closurePolicy(policy, policy.components);
  check(policy.components.includes(component), 'Unknown closure component');
  const build = files.filter(file => file.path !== 'bun.lock' && classifyPath(file.path, policy).build.includes(component));
  const proof = files.filter(file => classifyPath(file.path, policy).proof.includes(component));
  const projection = dependencyProjection(lock, policy.workspaces[component]);
  const selected = new Set(build.map(file => file.path));
  // The complete lock is separately retained as provenance; its resolved
  // projection is an executable input. Every observed workspace read is owned.
  selected.add('bun.lock');
  check(Array.isArray(observedReads) && observedReads.every(path => selected.has(path)), 'Undeclared build read invalidates reuse');
  return { schema: 'shop.component-closure/v1', component, policyDigest: digest(policy), build,
    dependencies: projection, runtimeDigest: policy.runtime[component], proof,
    buildDigest: digest({ files: build, dependencies: projection, runtime: policy.runtime[component], policy: digest(policy) }), proofDigest: digest(proof),
    rootInventoryDigest: digest(files), lockDigest: files.find(file => file.path === 'bun.lock').sha256 };
}

export function reusePlan({ origin, intent, policy, originLock, intentLock, observedReads = {} }) {
  validateInventory(origin); validateInventory(intent); closurePolicy(policy, policy.components);
  const paths = [...new Set([...origin, ...intent].map(file => file.path))].sort();
  const before = new Map(origin.map(file => [file.path, file])), after = new Map(intent.map(file => [file.path, file]));
  const changes = paths.filter(path => !same(before.get(path) ?? null, after.get(path) ?? null)).map(path => ({ path, ...classifyPath(path, policy) }));
  const components = policy.components.map(component => {
    const a = componentClosure({ files: origin, lock: originLock, policy, component });
    const b = componentClosure({ files: intent, lock: intentLock, policy, component, observedReads: observedReads[component] ?? [] });
    return { component, reuseArtifact: a.buildDigest === b.buildDigest, reuseProof: a.buildDigest === b.buildDigest && a.proofDigest === b.proofDigest,
      originBuildDigest: a.buildDigest, intentBuildDigest: b.buildDigest, originProofDigest: a.proofDigest, intentProofDigest: b.proofDigest };
  });
  return { schema: 'shop.reuse-plan/v1', originInventoryDigest: digest(origin), intentInventoryDigest: digest(intent), changes, components,
    freshAdmission: ['source', 'security', 'review', 'compatibility', 'environment'], unknownChanges: changes.filter(change => change.unknown).map(change => change.path) };
}
