import { createHash } from 'node:crypto';
import {
  prepareReleaseBundle,
  releaseBundle,
  releaseFiles,
  releaseAssetPaths,
  verifyReleaseArtifacts,
  retrieveReleaseArtifacts,
} from '../scripts/release-artifacts.js';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { retainActiveAssets, verifyPublishedAssets } from '../scripts/release-assets.js';

void test('asset publication retains the running Worker release across interrupted deployments and rejects missing or incorrect assets', async (t) => {
  const active = '1'.repeat(40);
  const failedActivation = '2'.repeat(40);
  const next = '3'.repeat(40);
  const files = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
  const published = new Map(
    files.map((file) => [`/assets/${active}/${file}`, `${active}:${file}`]),
  );
  let health = 200;
  const app = new Hono();
  app.get('/health', (c) =>
    health === 200
      ? c.json({ ok: true, assetVersion: active })
      : new Response('', { status: health }),
  );
  app.get('/assets/*', (c) => {
    const asset = published.get(c.req.path);
    return asset === undefined ? c.notFound() : c.text(asset);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => {
    server.close();
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing.');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'feedback-release-'));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const retrieve = async (version: string, destination: string) => {
    assert.equal(version, active);
    for (const file of files) await writeFile(`${destination}/${file}`, `${active}:${file}`);
  };
  await retainActiveAssets(directory, origin, failedActivation, retrieve);
  for (const file of files)
    assert.equal(await readFile(`${directory}/${active}/${file}`, 'utf8'), `${active}:${file}`);
  await mkdir(`${directory}/${next}`);
  for (const file of files) await writeFile(`${directory}/${next}/${file}`, `${next}:${file}`);
  await assert.rejects(verifyPublishedAssets(directory, origin), /unavailable/);
  for (const file of files) published.set(`/assets/${next}/${file}`, `${next}:${file}`);
  await verifyPublishedAssets(directory, origin);
  published.set(`/assets/${next}/toolbar.js`, 'corrupted');
  await assert.rejects(verifyPublishedAssets(directory, origin), /differs/);
  // Even after an asset-only deployment, the Worker still reports the active release.
  await retainActiveAssets(directory, origin, next, retrieve);
  assert.equal(await readFile(`${directory}/${active}/toolbar.js`, 'utf8'), `${active}:toolbar.js`);
  health = 503;
  await assert.rejects(retainActiveAssets(directory, origin, next, retrieve), /active release/);
  health = 404;
  await retainActiveAssets(directory, origin, next, retrieve);
});

void test('legacy archive fallback is explicit, authenticated and verifies bytes before extraction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-legacy-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = 'a'.repeat(40);
  const files = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
  const bundle = JSON.stringify({
    version: 1,
    files: files.map((path) => ({
      path,
      contents: Buffer.from(`archived:${path}`).toString('base64'),
    })),
  });
  const metadata = {
    tag_name: `assets-${version}`,
    target_commitish: version,
    assets: [
      {
        name: releaseBundle,
        size: Buffer.byteLength(bundle),
        digest: `sha256:${createHash('sha256').update(bundle).digest('hex')}`,
      },
    ],
  };
  const calls: { args: string[]; token: string | undefined }[] = [];
  const command = async (args: string[], token?: string) => {
    calls.push({ args, token });
    if (args[0] === 'api') {
      if (args[1]?.startsWith('repos/fixture/mono/'))
        throw Object.assign(new Error('Synthetic missing current archive'), { stderr: 'HTTP 404' });
      assert.ok(args[1]?.startsWith('repos/fixture/legacy/'));
      assert.equal(token, 'synthetic-legacy-read-token');
      return JSON.stringify(metadata);
    }
    assert.equal(args[args.indexOf('--repo') + 1], 'fixture/legacy');
    assert.equal(token, 'synthetic-legacy-read-token');
    const destination = args[args.indexOf('--dir') + 1];
    if (!destination) throw new Error('Missing temporary download directory');
    await writeFile(join(destination, releaseBundle), bundle);
    return '';
  };
  const environment = {
    GITHUB_REPOSITORY: 'fixture/mono',
    TOOLBAR_LEGACY_ARCHIVE_REPOSITORY: 'fixture/legacy',
    TOOLBAR_LEGACY_ARCHIVE_TOKEN: 'synthetic-legacy-read-token',
  };
  await retrieveReleaseArtifacts(version, join(directory, 'verified'), { environment, command });
  assert.equal(calls.length, 3);
  for (const file of files)
    assert.equal(await readFile(join(directory, 'verified', file), 'utf8'), `archived:${file}`);
  calls.length = 0;
  await assert.rejects(
    retrieveReleaseArtifacts(version, join(directory, 'missing-token'), {
      environment: {
        GITHUB_REPOSITORY: 'fixture/mono',
        TOOLBAR_LEGACY_ARCHIVE_REPOSITORY: 'fixture/legacy',
      },
      command,
    }),
    /protected read credential/,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    retrieveReleaseArtifacts(version, join(directory, 'denied'), {
      environment,
      command: () => Promise.reject(Object.assign(new Error('Denied'), { stderr: 'HTTP 403' })),
    }),
    /Could not read/,
  );
  await retrieveReleaseArtifacts(version, join(directory, 'current'), {
    environment: { ...environment, TOOLBAR_MIGRATED_ARCHIVE_JSON: 'unused legacy receipt' },
    command: async (args, token) => {
      assert.equal(token, undefined, 'Normal current archives never use the legacy credential');
      if (args[0] === 'api') {
        assert.ok(args[1]?.startsWith('repos/fixture/mono/'));
        return JSON.stringify(metadata);
      }
      assert.equal(args[args.indexOf('--repo') + 1], 'fixture/mono');
      const destination = args[args.indexOf('--dir') + 1];
      if (!destination) throw new Error('Missing temporary download directory');
      await writeFile(join(destination, releaseBundle), bundle);
      return '';
    },
  });
});

void test('a protected migrated receipt binds the legacy version to real new-repository release metadata and bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-migrated-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = 'b'.repeat(40);
  const target = 'c'.repeat(40);
  const bundle = JSON.stringify({
    version: 1,
    files: releaseFiles.map((path) => ({
      path,
      contents: Buffer.from(`migrated:${path}`).toString('base64'),
    })),
  });
  const digest = createHash('sha256').update(bundle).digest('hex');
  const receipt = {
    version: 1,
    legacyAssetSha: legacy,
    archiveSha256: digest,
    newRepository: 'fixture/mono',
    releaseTag: 'toolbar-imported-assets-synthetic',
    targetCommitish: target,
    assets: [{ name: releaseBundle, size: Buffer.byteLength(bundle), digest: `sha256:${digest}` }],
  };
  let corrupt = false;
  let downloads = 0;
  let extraAsset = false;
  const command = async (args: string[], token?: string) => {
    assert.equal(
      token,
      undefined,
      'Migrated archives use the existing current-repository credential',
    );
    if (args[0] === 'api') {
      if (args[1]?.endsWith(`/assets-${legacy}`))
        throw Object.assign(new Error('Synthetic absent normal archive'), { stderr: 'HTTP 404' });
      assert.equal(args[1], `repos/fixture/mono/releases/tags/${receipt.releaseTag}`);
      return JSON.stringify({
        tag_name: receipt.releaseTag,
        target_commitish: target,
        assets: extraAsset
          ? [...receipt.assets, { name: 'private.txt', size: 1, digest: `sha256:${digest}` }]
          : receipt.assets,
      });
    }
    downloads++;
    assert.equal(args[2], receipt.releaseTag);
    assert.equal(args[args.indexOf('--repo') + 1], receipt.newRepository);
    const destination = args[args.indexOf('--dir') + 1];
    if (!destination) throw new Error('Missing temporary download directory');
    await writeFile(join(destination, releaseBundle), corrupt ? 'corrupted' : bundle);
    return '';
  };
  const options = (value: unknown) => ({
    environment: {
      GITHUB_REPOSITORY: 'fixture/mono',
      TOOLBAR_MIGRATED_ARCHIVE_JSON: JSON.stringify(value),
    },
    command,
  });
  await retrieveReleaseArtifacts(legacy, join(directory, 'verified'), options(receipt));
  assert.equal(downloads, 1);
  assert.equal(
    await readFile(join(directory, 'verified/toolbar.js'), 'utf8'),
    'migrated:toolbar.js',
  );
  for (const changed of [
    { ...receipt, legacyAssetSha: 'd'.repeat(40) },
    { ...receipt, archiveSha256: '0'.repeat(64) },
    { ...receipt, newRepository: 'fixture/other' },
    { ...receipt, targetCommitish: 'e'.repeat(40) },
    { ...receipt, releaseTag: '../unsafe' },
    { ...receipt, assets: [] },
    { ...receipt, version: 2 },
    { ...receipt, unreviewed: true },
  ]) {
    await assert.rejects(
      retrieveReleaseArtifacts(legacy, join(directory, 'rejected'), options(changed)),
    );
    assert.equal(downloads, 1, 'Altered receipts must fail before downloading bytes');
  }
  extraAsset = true;
  await assert.rejects(
    retrieveReleaseArtifacts(legacy, join(directory, 'extra'), options(receipt)),
    /metadata differs/,
  );
  assert.equal(downloads, 1);
  extraAsset = false;
  corrupt = true;
  await assert.rejects(
    retrieveReleaseArtifacts(legacy, join(directory, 'corrupt'), options(receipt)),
    /digest differs/,
  );
  await assert.rejects(readFile(join(directory, 'corrupt/toolbar.js')), /ENOENT/);
});

void test('framework release bundles verify all chunks and reject unsafe or duplicate paths', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-framework-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '6'.repeat(40);
  const paths = [
    'toolbar.js',
    'embed.js',
    'embed-module.js',
    'styles.css',
    'dashboard-assets/entry-HASH.js',
    'dashboard-assets/feedback-HASH.js',
    'dashboard-assets/styles-HASH.css',
    'dashboard-assets/geist-HASH.woff2',
  ];
  await mkdir(`${directory}/dashboard/client/dashboard-assets`, { recursive: true });
  await writeFile(`${directory}/browser-assets.json`, JSON.stringify(paths));
  for (const path of paths)
    await writeFile(
      path.startsWith('dashboard-assets/')
        ? `${directory}/dashboard/client/${path}`
        : `${directory}/${path}`,
      path,
    );
  await prepareReleaseBundle(directory);
  const metadataFor = async () => {
    const contents = await readFile(`${directory}/${releaseBundle}`);
    return {
      tag_name: `assets-${version}`,
      target_commitish: version,
      assets: [
        {
          name: releaseBundle,
          size: contents.length,
          digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
        },
      ],
    };
  };
  const metadata = await metadataFor();
  await verifyReleaseArtifacts(directory, version, metadata);
  await writeFile(`${directory}/${releaseBundle}`, '{}');
  await assert.rejects(verifyReleaseArtifacts(directory, version, metadata), /digest differs/);
  for (const extra of ['../escape.js', paths[0]]) {
    await writeFile(
      `${directory}/${releaseBundle}`,
      JSON.stringify({
        version: 1,
        files: [...paths, extra].map((path) => ({
          path,
          contents: Buffer.from('asset').toString('base64'),
        })),
      }),
    );
    await assert.rejects(verifyReleaseArtifacts(directory, version, await metadataFor()));
  }
  await rm(`${directory}/dashboard/client/dashboard-assets/feedback-HASH.js`);
  await assert.rejects(prepareReleaseBundle(directory), /ENOENT/);
});

void test('framework publication verifies every route chunk and rejects unexpected release entries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-chunks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '7'.repeat(40);
  const paths = [
    'toolbar.js',
    'embed.js',
    'embed-module.js',
    'styles.css',
    'dashboard-assets/entry-HASH.js',
    'dashboard-assets/feedback-HASH.js',
    'dashboard-assets/styles-HASH.css',
    'dashboard-assets/geist-HASH.woff2',
  ];
  await mkdir(`${directory}/${version}/dashboard-assets`, { recursive: true });
  for (const path of paths) await writeFile(`${directory}/${version}/${path}`, path);
  const published = new Map(paths.map((path) => [`/assets/${version}/${path}`, path]));
  const app = new Hono();
  app.get('/assets/*', (c) => {
    const contents = published.get(c.req.path);
    return contents === undefined ? c.notFound() : c.text(contents);
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address missing.');
  const origin = `http://127.0.0.1:${address.port}`;
  await verifyPublishedAssets(directory, origin);
  const lazy = `/assets/${version}/dashboard-assets/feedback-HASH.js`;
  published.delete(lazy);
  await assert.rejects(verifyPublishedAssets(directory, origin), /unavailable/);
  published.set(lazy, 'corrupted');
  await assert.rejects(verifyPublishedAssets(directory, origin), /differs/);
  await writeFile(`${directory}/${version}/unexpected.json`, '{}');
  await assert.rejects(releaseAssetPaths(`${directory}/${version}`));
});

void test('archived release assets must match the commit, exact names, sizes and SHA-256 digests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = '4'.repeat(40);
  const files = ['app.js', 'toolbar.js', 'embed.js', 'embed-module.js', 'styles.css'];
  for (const file of files) await writeFile(`${directory}/${file}`, file);
  const metadata = {
    tag_name: `assets-${version}`,
    target_commitish: version,
    assets: files.map((name) => ({
      name,
      size: Buffer.byteLength(name),
      digest: `sha256:${createHash('sha256').update(name).digest('hex')}`,
    })),
  };
  await verifyReleaseArtifacts(directory, version, metadata);
  await assert.rejects(
    verifyReleaseArtifacts(directory, version, { ...metadata, target_commitish: '5'.repeat(40) }),
    /active commit/,
  );
  await assert.rejects(
    verifyReleaseArtifacts(directory, version, { ...metadata, assets: metadata.assets.slice(1) }),
    /missing/,
  );
  await writeFile(`${directory}/app.js`, 'corrupted');
  await assert.rejects(verifyReleaseArtifacts(directory, version, metadata), /digest differs/);
});
