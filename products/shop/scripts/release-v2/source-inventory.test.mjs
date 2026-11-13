import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceInventory, shopClosurePolicy } from './source-inventory.mjs';
import { classifyPath } from './scoped-inputs.mjs';
import { sha256 } from './data.mjs';

const execute = promisify(execFile);
test('root collector discovers untracked source additions, exact executable mode, and rejects unresolved symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shop-source-inventory-'));
  await execute('git', ['init', root]);
  await writeFile(join(root, 'bun.lock'), '{}'); await writeFile(join(root, 'package.json'), '{}');
  await execute('git', ['-C', root, 'add', 'bun.lock', 'package.json']);
  const before = await sourceInventory(root);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/new-alias.mjs'), 'export const shadow = true;');
  const after = await sourceInventory(root);
  assert.notEqual(before.digest, after.digest); assert.equal(after.files.length, before.files.length + 1);
  await chmod(join(root, 'src/new-alias.mjs'), 0o700);
  const executable = await sourceInventory(root);
  assert.equal(executable.files.find(file => file.path === 'src/new-alias.mjs').mode, '100755');
  await symlink('new-alias.mjs', join(root, 'src/alias.mjs'));
  await assert.rejects(sourceInventory(root), /symlink/);
});

test('actual Shop policy owns alias candidates, all native assets, shared contracts and fail-closed unknown files', () => {
  const policy = shopClosurePolicy({ business: sha256('business-runtime'), native: sha256('linux-runtime'), storefront: sha256('start-runtime') });
  for (const path of ['products/shop/apps/storefront/src/ports/new.tsx', 'products/shop/apps/web/src/shared.tsx', 'packages/ui/button.tsx', 'packages/design-tokens/font.css'])
    assert.deepEqual(classifyPath(path, policy).build, ['storefront']);
  for (const path of ['products/shop/apps/web/public/font.woff', 'products/shop/apps/web/public/mockups/new.webp'])
    assert.deepEqual(classifyPath(path, policy).build, ['native', 'storefront']);
  assert.deepEqual(classifyPath('products/shop/packages/contracts/src/limits.ts', policy).build, policy.components);
  for (const path of ['unmapped/new-loader.mjs', 'apps/new-source.tsx', 'products/shop/scripts/testing/new-recipe.mjs'])
    assert.equal(classifyPath(path, policy).unknown, true);
  assert.deepEqual(classifyPath('products/shop/workers/video-renderer/render.test.mjs', policy).build, ['native']);
});

test('ignored alias source cannot silently alter a build with an unchanged Git inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shop-ignored-source-'));
  await execute('git', ['init', root]);
  await writeFile(join(root, 'bun.lock'), '{}'); await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, '.gitignore'), 'src/private-alias.tsx\n');
  await execute('git', ['-C', root, 'add', 'bun.lock', 'package.json', '.gitignore']);
  await sourceInventory(root);
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/private-alias.tsx'), 'export const shadow = true;');
  await assert.rejects(sourceInventory(root), /Ignored build input/);
});
