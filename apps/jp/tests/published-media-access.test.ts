import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import type { D1Database } from '@cloudflare/workers-types';
import { publishedMediaAccess } from '../src/lib/published-media-access';

let directory: string;
let platform: PlatformProxy<{ DB: D1Database }>;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sample-media-access-'));
  await writeFile(
    join(directory, 'worker.js'),
    'export default {fetch(){return new Response("sample")}}',
  );
  const configPath = join(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'sample-media-access',
      main: 'worker.js',
      compatibility_date: '2026-10-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'sample-media-access',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
    }),
  );
  platform = await getPlatformProxy<{ DB: D1Database }>({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const { DB } = platform.env;
  await DB.batch([
    DB.prepare('CREATE TABLE media(id TEXT PRIMARY KEY, storage_key TEXT)'),
    DB.prepare(
      'CREATE TABLE ec_media_items(id TEXT PRIMARY KEY, asset TEXT, poster TEXT, status TEXT, deleted_at TEXT, draft_revision_id TEXT)',
    ),
    DB.prepare(
      'CREATE TABLE ec_posts(id TEXT PRIMARY KEY, content TEXT, status TEXT, deleted_at TEXT, draft_revision_id TEXT)',
    ),
    DB.prepare(
      "INSERT INTO media VALUES ('photo','trip/sample/photo.jpg'), ('poster','trip/sample/poster.jpg'), ('private','trip/sample/private.jpg')",
    ),
    DB.prepare('INSERT INTO ec_media_items VALUES (?,?,?,?,NULL,?)').bind(
      'sample',
      '{"id":"photo"}',
      '{"id":"poster"}',
      'published',
      'sample-private-revision',
    ),
  ]);
});
after(async () => {
  await platform.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

void test('public access checks live asset and poster references and revoke immediately', async () => {
  const { DB } = platform.env;
  for (const [id, key] of [
    ['photo', 'trip/sample/photo.jpg'],
    ['poster', 'trip/sample/poster.jpg'],
  ]) {
    assert.ok(id && key);
    assert.equal(await publishedMediaAccess(DB, 'asset', id), true);
    assert.equal(await publishedMediaAccess(DB, 'file', key), true);
  }
  assert.equal(await publishedMediaAccess(DB, 'asset', 'private'), false);
  assert.equal(
    await publishedMediaAccess(DB, 'file', 'trip/sample/private.jpg'),
    false,
  );
  assert.equal(await publishedMediaAccess(DB, 'asset', 'missing'), false);
  await DB.prepare("UPDATE ec_media_items SET status='draft'").run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'photo'), false);
  assert.equal(
    await publishedMediaAccess(DB, 'file', 'trip/sample/poster.jpg'),
    false,
  );
  await DB.prepare(
    "UPDATE ec_media_items SET status='published', deleted_at='2099-10-16'",
  ).run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'photo'), false);
  await DB.prepare(
    "UPDATE ec_media_items SET deleted_at=NULL,asset='invalid json',poster=NULL",
  ).run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'photo'), false);
});

void test('post-only image access follows live post references, never drafts or deleted posts', async () => {
  const { DB } = platform.env;
  const key = 'trip-inline/sample/post-inline-sample.jpg';
  await DB.prepare('INSERT INTO media VALUES (?,?)').bind('inline', key).run();
  const content = JSON.stringify([
    { _type: 'block', children: [{ _type: 'span', text: 'sample story' }] },
    { _type: 'image', asset: { _ref: 'inline' } },
  ]);
  await DB.prepare('INSERT INTO ec_posts VALUES (?,?,?,NULL,NULL)')
    .bind('post', content, 'draft')
    .run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'inline'), false);
  await DB.prepare(
    "UPDATE ec_posts SET status='published', draft_revision_id='private-staged-revision'",
  ).run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'inline'), true);
  assert.equal(await publishedMediaAccess(DB, 'file', key), true);
  assert.equal(await publishedMediaAccess(DB, 'asset', 'private'), false);
  await DB.prepare("UPDATE ec_posts SET content='[]'").run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'inline'), false);
  await DB.prepare("UPDATE ec_posts SET content=?, deleted_at='2099-10-16'")
    .bind(content)
    .run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'inline'), false);
  await DB.prepare(
    "UPDATE ec_posts SET deleted_at=NULL, content='invalid json'",
  ).run();
  assert.equal(await publishedMediaAccess(DB, 'asset', 'inline'), false);
});
