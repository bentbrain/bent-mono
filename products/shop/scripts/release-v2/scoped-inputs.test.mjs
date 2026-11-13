import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, sha256 } from './data.mjs';
import { reusePlan, componentClosure, parseLock, dependencyProjection } from './scoped-inputs.mjs';

const components = ['native', 'storefront'];
const policy = {
  schema: 'shop.scoped-input-policy/v1', components,
  rules: [
    { path: 'native', subtree: true, build: ['native'], proof: ['native'] },
    { path: 'storefront', subtree: true, build: ['storefront'], proof: ['storefront'] },
    { path: 'native/parity.test.mjs', subtree: false, build: [], proof: ['native'] },
    { path: 'assets', subtree: true, build: components, proof: components },
    { path: 'packages/ui', subtree: true, build: ['storefront'], proof: ['storefront'] },
    { path: 'packages/contracts', subtree: true, build: components, proof: components },
  ], workspaces: { native: ['native'], storefront: ['storefront'] },
  runtime: { native: sha256('linux/x64/node24/abi137/sharp0.35.5/base-pinned'), storefront: sha256('workerd-pinned') },
};
const lock = {
  lockfileVersion: 3, configVersion: 1,
  workspaces: { '': { name: 'root' }, native: { name: '@test/native', dependencies: { sharp: '0.35.5' } }, storefront: { name: '@test/storefront', dependencies: { react: '19.3.1' } } },
  packages: { sharp: ['sharp@0.35.5', '', { optionalDependencies: { '@img/linux': '1.0.0' } }, 'sha512-sharp'],
    '@img/linux': ['@img/linux@1.0.0', '', { os: 'linux', cpu: 'x64' }, 'sha512-linux'], react: ['react@19.3.1', '', {}, 'sha512-react'] },
};
const inventory = (content = {}) => Object.entries({ 'bun.lock': digest(lock), 'package.json': '{}', 'native/entry.mjs': 'v5',
  'native/parity.test.mjs': 'full50MP', 'storefront/routes.tsx': 'upload-v1', 'assets/font.woff': 'font', 'packages/contracts/source.ts': 'protocol-v5', ...content })
  .filter(([, value]) => value !== null).map(([path, value]) => ({ path, sha256: sha256(value), mode: '100644' })).sort((a, b) => a.path < b.path ? -1 : 1);
const plan = (intent, options = {}) => reusePlan({ origin: inventory(), intent, policy, originLock: lock, intentLock: lock, ...options });
const component = (value, id) => value.components.find(item => item.component === id);

test('a real storefront edit retains native build/proof identity and requires fresh composition admission', () => {
  const value = plan(inventory({ 'storefront/routes.tsx': 'upload-v2' }));
  assert.equal(component(value, 'native').reuseArtifact, true);
  assert.equal(component(value, 'native').reuseProof, true);
  assert.equal(component(value, 'storefront').reuseArtifact, false);
  assert.deepEqual(value.freshAdmission, ['source', 'security', 'review', 'compatibility', 'environment']);
});

test('an alias-shadowing addition is an input even before an import graph reaches it', () => {
  const value = plan(inventory({ 'storefront/ports/existing-native-name.ts': 'shadow' }));
  assert.equal(component(value, 'storefront').reuseArtifact, false);
  assert.equal(component(value, 'native').reuseArtifact, true);
});

for (const [path, expected] of [['packages/ui/button.tsx', ['storefront']], ['packages/contracts/source.ts', components],
  ['assets/font.woff', components], ['assets/displacement.wasm', components], ['unknown/loader.mjs', components]]) {
  test(`changed or newly discovered ${path} invalidates its consumers`, () => {
    const value = plan(inventory({ [path]: 'changed' }));
    for (const id of expected) assert.equal(component(value, id).reuseArtifact, false);
  });
}

test('deleted native files, executable modes and native runtime changes invalidate reuse', () => {
  assert.equal(component(plan(inventory({ 'native/entry.mjs': null })), 'native').reuseArtifact, false);
  const files = inventory(); files.find(file => file.path === 'native/entry.mjs').mode = '100755';
  assert.equal(component(plan(files), 'native').reuseArtifact, false);
  const changed = structuredClone(policy); changed.runtime.native = sha256('different base/native ABI');
  const a = componentClosure({ files: inventory(), lock, policy, component: 'native' });
  const b = componentClosure({ files: inventory(), lock, policy: changed, component: 'native' });
  assert.notEqual(a.buildDigest, b.buildDigest);
});

test('test input changes preserve executable bytes but invalidate the corresponding proof', () => {
  const value = component(plan(inventory({ 'native/parity.test.mjs': 'changed-boundary' })), 'native');
  assert.equal(value.reuseArtifact, true); assert.equal(value.reuseProof, false);
});

test('undeclared reads and symlink/missing-root inventories fail closed', () => {
  assert.throws(() => plan(inventory(), { observedReads: { native: ['storefront/routes.tsx'] } }), /Undeclared/);
  const files = inventory(); files[0].mode = '120000';
  assert.throws(() => plan(files), /Regular source/);
  assert.throws(() => plan(inventory({ 'bun.lock': null })), /Root dependency/);
});

test('unrelated lock package changes preserve native resolution while native optional/platform and peer changes do not', () => {
  const changed = structuredClone(lock); changed.packages.react[3] = 'sha512-react-repaired';
  const value = plan(inventory({ 'bun.lock': digest(changed) }), { intentLock: changed });
  assert.equal(component(value, 'native').reuseArtifact, true);
  assert.equal(component(value, 'storefront').reuseArtifact, false);
  for (const alter of [value => { value.packages['@img/linux'][2].cpu = 'arm64'; },
    value => { value.packages.sharp[2].peerDependencies = { react: '*' }; },
    value => { value.packages['nested/@img/linux'] = ['@img/linux@2.0.0', '', {}, 'sha512-other']; },
    value => { value.trustedDependencies = ['new-install-script']; }]) {
    const nativeChange = structuredClone(lock); alter(nativeChange);
    assert.equal(component(plan(inventory({ 'bun.lock': digest(nativeChange) }), { intentLock: nativeChange }), 'native').reuseArtifact, false);
  }
});

test('missing optional peer resolution is retained as absence and cannot hide a required edge', () => {
  const changed = structuredClone(lock); changed.packages.sharp[2].peerDependencies = { absent: '*' };
  const projection = dependencyProjection(changed, ['native']);
  assert.deepEqual(projection.unresolvedOptionalOrPeer, ['absent']);
  changed.workspaces.native.dependencies.absent = '*';
  assert.throws(() => dependencyProjection(changed, ['native']), /Unresolved required/);
});

test('lock parser preserves comma strings and rejects duplicates or unsupported versions', () => {
  assert.deepEqual(parseLock(Buffer.from(JSON.stringify(lock).replace(/}$/, ',}'))), lock);
  assert.throws(() => parseLock(Buffer.from('{"lockfileVersion":3,"lockfileVersion":3}')), /Duplicate/);
  assert.throws(() => parseLock(Buffer.from(JSON.stringify({ ...lock, lockfileVersion: 4 }))), /Unsupported/);
});
