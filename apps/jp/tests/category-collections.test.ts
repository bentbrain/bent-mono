import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { UserRepository } from 'emdash';
import { sqlite } from 'emdash/db';
import { createDialect } from 'emdash/db/sqlite';
import { getPlatformProxy } from 'wrangler';
import type { PlatformProxy } from 'wrangler';
import { encode } from 'fast-png';
import {
  categoryCollection,
  registerCategory,
} from '../src/lib/category-collections';
import { iconHash, iconModel } from '../src/lib/category-icons';
import {
  runCategoryIconJobs,
  type IconEnvironment,
} from '../src/lib/category-icon-jobs';

// Supply only Vite's build-time configuration for the real native CMS runtime.
// Database migrations, native handlers, revision/trash rules and media inserts
// are unchanged. These hooks live in this Node test process only.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'virtual:emdash/config'
      ? { url: 'data:text/javascript,export default {}', shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url.includes('/dist/emdash-runtime-')
      ? {
          format: 'module',
          source: `import.meta.env = { DEV: false };\n${readFileSync(new URL(url), 'utf8')}`,
          shortCircuit: true,
        }
      : next(url, context);
  },
});
const { EmDashRuntime } = await import('emdash/internal/plugin-test-runtime');
let directory: string;
let platform: PlatformProxy<IconEnvironment> | undefined;
let migration: string;
function environment() {
  assert.ok(platform);
  return {
    ...platform.env,
    OPENAI_API_KEY: 'synthetic-test-key',
    CATEGORY_ICON_MODEL: iconModel,
  };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'native-category-collections-'));
  await writeFile(
    join(directory, 'worker.js'),
    'export default {fetch(){return new Response("synthetic fixture")}}',
  );
  const configPath = join(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'native-category-collections',
      main: 'worker.js',
      compatibility_date: '2026-10-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'native-category-collections',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
      r2_buckets: [
        { binding: 'MEDIA', bucket_name: 'native-category-collections' },
      ],
    }),
  );
  platform = await getPlatformProxy<IconEnvironment>({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const { DB } = environment();
  await DB.batch([
    DB.prepare(
      'CREATE TABLE ec_media_items(id TEXT PRIMARY KEY,categories TEXT,draft_revision_id TEXT,status TEXT,deleted_at TEXT)',
    ),
    DB.prepare('CREATE TABLE revisions(id TEXT PRIMARY KEY,data TEXT)'),
    DB.prepare('CREATE TABLE media(id TEXT PRIMARY KEY,storage_key TEXT)'),
  ]);
  migration = (
    await Promise.all(
      ['0001_category_icons.sql', '0002_icon_library.sql'].map((file) =>
        readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n--> statement-breakpoint\n');
  await DB.batch(
    migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim())
      .filter(Boolean)
      .map((statement) => DB.prepare(statement)),
  );
});
after(async () => {
  await native?.cms.db.destroy();
  await platform?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
  hooks.deregister();
});
let native: Awaited<ReturnType<typeof createNativeCMS>> | undefined;
async function nativeCMS() {
  native ??= await createNativeCMS();
  return native;
}
async function createNativeCMS() {
  const path = join(directory, `${crypto.randomUUID()}.sqlite`);
  const url = `file:${path}`;
  const cms = await EmDashRuntime.create({
    config: { database: sqlite({ url }) },
    createDialect: () => createDialect({ url }),
    createStorage: null,
    plugins: [],
    sandboxEnabled: false,
    sandboxedPluginEntries: [],
    createSandboxRunner: null,
    siteInfo: { url: 'http://localhost', name: 'synthetic', locale: 'en' },
  });
  // Apply the same feature-owned native-media guard as the production migration.
  const connection = new DatabaseSync(path);
  try {
    for (const statement of migration
      .split('--> statement-breakpoint')
      .filter((statement) =>
        statement.includes(
          'CREATE UNIQUE INDEX IF NOT EXISTS jp_icon_media_storage_key',
        ),
      ))
      connection.exec(statement);
  } finally {
    connection.close();
  }
  const user = await new UserRepository(cms.db).create({
    email: 'sample@example.invalid',
    name: 'sample owner',
    role: 50,
  });
  return { cms, user };
}
void test('native category trash keeps category reads and subsequent creation available without restoring content', async () => {
  const { cms, user } = await nativeCMS();
  const env = environment();
  await registerCategory(env, 'sample preserved category');
  await categoryCollection(env, cms, user);
  const current = await cms.handleContentGet(
    'categories',
    await iconHash('sample preserved category'),
  );
  assert.ok(current.success);
  const deleted = await cms.handleContentDelete(
    'categories',
    current.data.item.id,
  );
  assert.ok(deleted.success);
  await categoryCollection(env, cms, user);
  await registerCategory(env, 'sample following category');
  const result = await categoryCollection(env, cms, user);
  assert.ok(
    result.categories.some(
      (category) => category.normalized === 'sample following category',
    ),
  );
  const trashed = await cms.handleContentGetIncludingTrashed(
    'categories',
    current.data.item.id,
  );
  assert.ok(trashed.success);
  const trash = await cms.handleContentListTrashed('categories');
  assert.ok(trash.success);
  assert.ok(trash.data.items.some((item) => item.id === current.data.item.id));
  assert.equal(
    (await cms.handleContentGet('categories', current.data.item.id)).success,
    false,
  );
});

void test('concurrent collection synchronization registers one native media identity per generated icon', async () => {
  const { cms, user } = await nativeCMS();
  const env = environment();
  await categoryCollection(env, cms, user);
  await registerCategory(env, 'sample generated media');
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 12; y < 20; y++)
    for (let x = 12; x < 20; x++) data[(y * 32 + x) * 4 + 3] = 255;
  await runCategoryIconJobs(env, {
    generate: () =>
      Promise.resolve({
        status: 'ready',
        bytes: encode({ width: 32, height: 32, channels: 4, depth: 8, data }),
      }),
  });
  const asset = await env.DB.prepare(
    'SELECT storage_key FROM jp_icon_assets LIMIT 1',
  ).first<{ storage_key: string }>();
  assert.ok(asset);
  const original = cms.handleMediaCreate.bind(cms);
  let arrivals = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cms.handleMediaCreate = async (input) => {
    if (input.storageKey === asset.storage_key) {
      arrivals++;
      if (arrivals === 2) release();
      await gate;
    }
    return original(input);
  };
  const results = await Promise.all([
    categoryCollection(env, cms, user),
    categoryCollection(env, cms, user),
  ]);
  assert.equal(arrivals, 2);
  assert.equal(
    (
      await cms.db
        .selectFrom('media')
        .select('id')
        .where('storage_key', '=', asset.storage_key)
        .execute()
    ).length,
    1,
  );
  assert.equal(results[0].icons.length, 1);
  assert.equal(results[1].icons.length, 1);
  await categoryCollection(env, cms, user);
  assert.equal(
    (
      await cms.db
        .selectFrom('media')
        .select('id')
        .where('storage_key', '=', asset.storage_key)
        .execute()
    ).length,
    1,
  );
});
