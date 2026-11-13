import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { check, digest, sha256, same, pathName } from './data.mjs';
import { validateInventory, closurePolicy } from './scoped-inputs.mjs';

const execute = promisify(execFile);
export async function assertNoIgnoredBuildInputs(root) {
  const roots = ['src', 'products/shop/apps/storefront/src', 'products/shop/apps/web/src', 'products/shop/apps/web/public',
    'products/shop/workers/api/src', 'products/shop/workers/video-renderer/src', 'products/shop/workers/video-renderer/aws-lambda',
    'products/shop/packages/contracts/src', 'products/shop/packages/product-image-renderer/src', 'products/shop/packages/product-image-renderer/assets',
    'packages/ui/src', 'packages/design-tokens/src'];
  const { stdout } = await execute('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...roots],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const unexpected = stdout.split('\0').filter(path => path && path !== 'products/shop/apps/storefront/src/routeTree.gen.ts');
  check(unexpected.length === 0, 'Ignored build input requires clean source qualification');
}
const gitPaths = async root => {
  const { stdout } = await execute('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return [...new Set(stdout.split('\0').filter(Boolean))].sort();
};

export async function sourceInventory(directory) {
  const root = await realpath(directory); await assertNoIgnoredBuildInputs(root);
  const before = await gitPaths(root), files = [];
  check(before.length > 0 && before.length <= 16384, 'Root source inventory exceeds bounds');
  for (const path of before) {
    pathName(path);
    const target = resolve(root, path);
    check(target.startsWith(`${root}${sep}`) && await realpath(target) === target, 'Source symlink or escaped input requires migration admission');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const start = await handle.stat();
      check(start.isFile(), 'Only materialized regular source files are supported');
      const bytes = await handle.readFile(), end = await handle.stat();
      check(start.size === end.size && start.mtimeMs === end.mtimeMs && start.ctimeMs === end.ctimeMs && start.mode === end.mode && start.nlink === end.nlink,
        'Source changed during inventory');
      files.push({ path, sha256: sha256(bytes), mode: start.mode & 0o111 ? '100755' : '100644' });
    } finally { await handle.close(); }
  }
  check(same(before, await gitPaths(root)), 'Source paths changed during inventory');
  await assertNoIgnoredBuildInputs(root);
  validateInventory(files);
  return { schema: 'shop.root-source-inventory/v1', files, digest: digest(files) };
}

export function shopClosurePolicy(runtime) {
  const components = ['business', 'native', 'storefront'];
  const rules = [];
  const rule = (path, build, proof = build, subtree = true) => rules.push({ path, subtree, build, proof });
  // New directories outside these reviewed roots remain conservative full
  // inputs. All additions inside an owned root participate in its closure.
  rule('products/shop/apps/storefront', ['storefront']);
  rule('products/shop/apps/web', ['storefront']);
  rule('products/shop/apps/web/public', ['native', 'storefront']);
  rule('products/shop/workers/api', ['business']);
  rule('products/shop/workers/video-renderer', ['native']);
  rule('products/shop/packages/product-image-renderer', ['native']);
  rule('products/shop/packages/contracts', components);
  rule('packages/ui', ['storefront']); rule('packages/design-tokens', ['storefront']);
  // Tests remain conservative build inputs here. Separating a proof-only
  // file requires reviewed builder read evidence; a filename cannot prove
  // that runtime code never imports it. Unknown workspace imports fan out.
  const policy = { schema: 'shop.scoped-input-policy/v1', components, rules, runtime,
    workspaces: { business: ['products/shop/workers/api'], native: ['products/shop/packages/product-image-renderer', 'products/shop/workers/video-renderer'],
      storefront: ['products/shop/apps/storefront', 'products/shop/apps/web', 'packages/ui', 'packages/design-tokens'] } };
  return closurePolicy(policy, components);
}
