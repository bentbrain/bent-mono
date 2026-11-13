import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, digest, sha256, check } from '../data.mjs';
import { parseLock, reusePlan } from '../scoped-inputs.mjs';
import { sourceInventory, shopClosurePolicy } from '../source-inventory.mjs';

const checkout = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const output = resolve(process.argv[2] ?? '');
check(process.argv.length === 3 && output !== checkout && !output.startsWith(`${checkout}/`), 'Provide a new private output directory outside source');
await mkdir(output, { mode: 0o700 });
const startedAt = Date.now(), execute = promisify(execFile);
const source = await sourceInventory(checkout), lockBytes = await readFile(join(checkout, 'bun.lock')), lock = parseLock(lockBytes);
const recipe = await readFile(join(checkout, 'products/shop/scripts/testing/linux-candidate-recipe.json'));
const policy = shopClosurePolicy({ business: sha256('proposed-business-workerd-v1'), native: sha256(recipe), storefront: sha256('proposed-start-workerd-v1') });
const { stdout: commit } = await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout });
const { stdout: dirty } = await execute('git', ['status', '--porcelain'], { cwd: checkout });
const frontend = 'products/shop/apps/storefront/src/routes/index.tsx';
const original = await readFile(join(checkout, frontend));
const modified = Buffer.concat([original, Buffer.from('\n// Source-snapshot mutation used by the offline reuse proof.\n')]);
const mutate = (path, bytes) => {
  const files = structuredClone(source.files), existing = files.find(file => file.path === path);
  if (existing) existing.sha256 = sha256(bytes);
  else files.push({ path, sha256: sha256(bytes), mode: '100644' });
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
};
const plan = (intent, intentLock = lock) => reusePlan({ origin: source.files, intent, policy, originLock: lock, intentLock });
const selected = (value, id) => value.components.find(component => component.component === id);
const storefrontOnly = plan(mutate(frontend, modified));
assert.equal(selected(storefrontOnly, 'native').reuseArtifact, true);
assert.equal(selected(storefrontOnly, 'business').reuseArtifact, true);
assert.equal(selected(storefrontOnly, 'storefront').reuseArtifact, false);
const mutations = {};
for (const [name, path, expected] of [
  ['alias-addition', 'products/shop/apps/storefront/src/ports/new-alias-candidate.tsx', ['storefront']],
  ['shared-control', 'packages/ui/src/button.tsx', ['storefront']],
  ['shared-token', 'packages/design-tokens/src/closure-probe.css', ['storefront']],
  ['contract', 'products/shop/packages/contracts/src/limits.ts', policy.components],
  ['native-code', 'products/shop/packages/product-image-renderer/src/index.mjs', ['native']],
  ['public-font', 'products/shop/apps/web/public/new-closure-font.woff2', ['native', 'storefront']],
  ['native-wasm', 'products/shop/packages/product-image-renderer/assets/displacement.wasm', ['native']],
  ['policy', 'products/shop/scripts/release-v2/new-policy.mjs', policy.components],
  ['unknown', 'new-unclassified-workspace/input.mjs', policy.components],
]) {
  const value = plan(mutate(path, Buffer.from(`closure mutation ${name}`)));
  for (const id of expected) assert.equal(selected(value, id).reuseArtifact, false, `${name}/${id}`);
  mutations[name] = value;
}
const changedLock = structuredClone(lock);
const sharp = Object.keys(changedLock.packages).find(key => key === 'sharp');
check(sharp, 'Actual native Sharp resolution required');
changedLock.packages[sharp][2].optionalDependencies['@img/unqualified-platform'] = '1.0.0';
const nativeLock = plan(mutate('bun.lock', Buffer.from(canonical(changedLock))), changedLock);
assert.equal(selected(nativeLock, 'native').reuseArtifact, false); mutations['native-lock-platform'] = nativeLock;
const after = await sourceInventory(checkout);
assert.equal(after.digest, source.digest, 'Current source changed during the offline proof');
const receipt = { schema: 'shop.actual-source-reuse-proof/v1', scope: 'offline-source-snapshot-mutations',
  sourceCommit: commit.trim(), dirtySnapshot: Boolean(dirty.trim()), intentCommit: null,
  patch: { path: frontend, originalSha256: sha256(original), mutatedSha256: sha256(modified), workingTreeEdited: false },
  sourceInventoryDigest: source.digest, wholeLockDigest: sha256(lockBytes), policyDigest: digest(policy),
  storefrontOnly, mutations, startedAt, finishedAt: Date.now(), productionQualified: false,
  buildExecuted: false, targetRuntimeQualified: false };
for (const [name, value] of [['source-inventory.private.json', source], ['policy.private.json', policy], ['reuse-proof.private.json', receipt]])
  await writeFile(join(output, name), canonical(value), { flag: 'wx', mode: 0o600 });
console.info(JSON.stringify({ sourceInventoryDigest: source.digest, storefrontRetainsNative: true, mutations: Object.keys(mutations).length,
  buildExecuted: false, productionQualified: false, receiptDigest: digest(receipt) }));
