import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPortableFixture } from '../release-v2/testing/portable-fixture.mjs';
import { packagePortableBundle, verifyPortableBundle } from '../release-v2/portable-bundle.mjs';
import { createNativeOciFixture } from './native-v5-oci-fixture.mjs';
import { createNativeV5Oci, writeNativeV5Oci } from './native-v5-oci.mjs';

test('actual OCI producer bytes pass complete portable retention/import with source and runtime identity', async t => {
  const original = await createPortableFixture(t), result = await createNativeV5Oci(createNativeOciFixture());
  const native = join(original.root, 'native-oci'); await writeNativeV5Oci(result, native);
  const components = original.components.map(component => component.id === 'native' ? { ...component, directory: native, format: 'oci-layout', entrypoint: 'index.json',
    runtime: { kind: 'linux-native-oci-candidate', imageDigest: result.graph.imageDigest, nativeOciReceipt: result.receipt, awsImageQualified: false } } : component);
  const verified = await packagePortableBundle({ destination: join(original.root, 'oci-portable'), originSourceCommit: original.verified.manifest.originSourceCommit,
    lineage: original.verified.lineage, sourceInventory: original.verified.sourceInventory, sourceDirectory: original.source, components });
  const imported = await verifyPortableBundle(verified.root, verified.expected), retained = imported.components.get('native');
  assert.equal(retained.artifact.format, 'oci-layout'); assert.equal(retained.oci.imageDigest, result.graph.imageDigest); assert.equal(retained.oci.runtimeQualified, false);
  assert.equal(retained.runtime.definition.nativeOciReceipt.inventorySha256, result.receipt.inventorySha256);
  assert.equal(imported.components.get('business').artifact.codeDigest, original.verified.components.get('business').artifact.codeDigest);
  assert.deepEqual(imported.sourceInventory.files, original.verified.sourceInventory.files);
});

test('hosted producer canonical source retains exact authority and encryption boundaries', async () => {
  const workflow = await readFile(new URL('../../../../.github/workflows/shop-native-oci-producer.yml', import.meta.url), 'utf8');
  assert.equal(workflow, await readFile(new URL('../../.github/workflows/shop-native-oci-producer.yml', import.meta.url), 'utf8'));
  assert.match(workflow, /name: Built native OCI candidate/); assert.match(workflow, /contents: read/); assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(workflow, /id-token|secrets\.|environment:|SHOP_EVIDENCE_ENCRYPTION_KEY/);
  assert.match(workflow, /native-v5-hosted\.mjs/); assert.match(workflow, /linux-hosted-validation\.mjs seal/);
  assert.match(workflow, /name: shop-native-oci-private-/);
});


test('native producer selects its runtime, assets, packaging and dependencies while storefront changes use general J01', async () => {
  const workflow = await readFile(new URL('../../../../.github/workflows/shop-native-oci-producer.yml', import.meta.url), 'utf8');
  const general = await readFile(new URL('../../../../.github/workflows/shop-linux-journey.yml', import.meta.url), 'utf8');
  // The workflow uses exact paths and subtree filters. Fail if a new filter
  // grammar requires different GitHub path-matching semantics.
  const filters = source => {
    const block = source.match(/    paths:\n([\s\S]*?)  workflow_dispatch:/)?.[1];
    assert.ok(block); const patterns = [...block.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]);
    assert.ok(patterns.length > 0 && patterns.every(pattern => /^[a-zA-Z0-9_.\/-]+(?:\/\*\*)?$/.test(pattern)));
    return patterns;
  };
  const selected = (patterns, changes) => changes.some(path => patterns.some(pattern => pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern));
  const native = filters(workflow), j01 = filters(general);
  for (const path of [
    'products/shop/workers/video-renderer/aws-lambda/native-v5-runtime.mjs',
    'products/shop/workers/video-renderer/src/renderer.mjs',
    'products/shop/packages/product-image-renderer/src/index.mjs',
    'products/shop/packages/product-image-renderer/assets/displacement.wasm',
    'products/shop/packages/contracts/src/limits.ts',
    'products/shop/assets/lifestyle/featured.json',
    'products/shop/apps/web/public/mockups/lifestyle-v4/new-mask.svg',
    'products/shop/scripts/testing/linux-candidate-recipe.json',
    'products/shop/scripts/testing/native-v5-base.mjs',
    'products/shop/scripts/release-v2/oci-layout.mjs',
    'products/shop/apps/storefront/scripts/local-proof.mjs',
    'products/shop/workers/video-renderer/aws-lambda/package-lock.json',
    'products/shop/package.json', 'bun.lock', 'bunfig.toml', 'package.json',
    '.github/workflows/shop-native-oci-producer.yml',
    'products/shop/.github/workflows/shop-native-oci-producer.yml',
  ]) assert.equal(selected(native, [path]), true, `Native input must select OCI producer: ${path}`);
  for (const path of [
    'products/shop/apps/storefront/src/routes/index.tsx',
    'products/shop/apps/storefront/src/components/editor.tsx',
    'products/shop/apps/storefront/src/styles.css',
    'products/shop/apps/storefront/package.json',
    'products/shop/apps/web/src/components/editor.tsx',
    'packages/ui/src/button.tsx', 'packages/design-tokens/src/tokens.css',
  ]) {
    assert.equal(selected(native, [path]), false, `Storefront input must avoid the OCI producer: ${path}`);
    assert.equal(selected(j01, [path]), true, `Storefront input must keep general J01: ${path}`);
  }
  assert.equal(selected(native, ['products/shop/apps/storefront/src/routes/index.tsx', 'products/shop/workers/video-renderer/src/renderer.mjs']), true);
});
