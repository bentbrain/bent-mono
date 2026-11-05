import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SchemaRegistry, UserRepository } from 'emdash';
import { sqlite } from 'emdash/db';
import { createDialect } from 'emdash/db/sqlite';
import { z } from 'zod';
import { saveBeerCount } from '../src/lib/save-beer-count';

// Use the real CMS handlers and SQLite uniqueness, supplying only Vite's config.
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
let cms: Awaited<ReturnType<typeof EmDashRuntime.create>>;
let actor: { id: string; role: number };
const entrySchema = z.object({
  item: z.object({
    id: z.string(),
    status: z.string(),
    data: z.object({ day: z.string(), count: z.number() }),
  }),
});
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sample-beer-count-'));
  const url = `file:${join(directory, 'cms.sqlite')}`;
  cms = await EmDashRuntime.create({
    config: { database: sqlite({ url }) },
    createDialect: () => createDialect({ url }),
    createStorage: null,
    plugins: [],
    sandboxEnabled: false,
    sandboxedPluginEntries: [],
    createSandboxRunner: null,
    siteInfo: { url: 'http://localhost', name: 'sample', locale: 'en' },
  });
  await new SchemaRegistry(cms.db).createSeedCollection(
    { slug: 'beers', label: 'sample beers', supports: ['revisions'] },
    [
      { slug: 'title', label: 'title', type: 'string', required: true },
      {
        slug: 'day',
        label: 'day',
        type: 'string',
        required: true,
        indexed: true,
      },
      { slug: 'count', label: 'count', type: 'integer', required: true },
    ],
  );
  const user = await new UserRepository(cms.db).create({
    email: 'sample@example.invalid',
    name: 'sample owner',
    role: 50,
  });
  actor = { id: user.id, role: user.role };
});
after(async () => {
  await cms.db.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
  hooks.deregister();
});

for (const trashCount of [0, 2]) {
  void test(`concurrent first saves preserve one daily count with ${String(trashCount)} reserved slugs`, async () => {
    const day = trashCount === 0 ? '2099-10-23' : '2099-10-24';
    const trashedIds: string[] = [];
    for (let index = 0; index < trashCount; index++) {
      const created = await cms.handleContentCreate('beers', {
        slug: index === 0 ? day : `${day}-${String(index)}`,
        data: { title: 'sample trashed beer day', day, count: 1 },
      });
      assert.ok(created.success);
      const id = entrySchema.parse(created.data).item.id;
      assert.ok((await cms.handleContentDelete('beers', id)).success);
      trashedIds.push(id);
    }
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const bothReachedCreate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstInserted = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let creations = 0;
    const racingCMS: Parameters<typeof saveBeerCount>[0] = {
      handleContentGet: cms.handleContentGet.bind(cms),
      handleContentGetIncludingTrashed:
        cms.handleContentGetIncludingTrashed.bind(cms),
      handleContentList: cms.handleContentList.bind(cms),
      handleContentUpdate: cms.handleContentUpdate.bind(cms),
      handleContentPublish: cms.handleContentPublish.bind(cms),
      async handleContentCreate(...args) {
        creations++;
        if (creations === 1) {
          await bothReachedCreate;
          try {
            return await cms.handleContentCreate(...args);
          } finally {
            releaseSecond?.();
          }
        }
        releaseFirst?.();
        await firstInserted;
        return cms.handleContentCreate(...args);
      },
    };
    // Both callers finish lookup before either inserts. The second creates only
    // after the first insert, exposing automatic slug allocation deterministically.
    const saves = await Promise.all([
      saveBeerCount(racingCMS, day, 3, actor),
      saveBeerCount(racingCMS, day, 3, actor),
    ]);
    assert.deepEqual(
      saves.map((response) => response.status).sort(),
      [200, 409],
    );
    const list = await cms.handleContentList('beers', {
      fieldFilters: { day },
    });
    assert.ok(list.success);
    assert.equal(list.data.items.length, 1);
    const id = list.data.items[0]?.id;
    const updated = await saveBeerCount(cms, day, 2, actor);
    assert.equal(updated.status, 200);
    const body = z.object({ data: entrySchema }).parse(await updated.json());
    assert.equal(body.data.item.id, id);
    assert.equal(body.data.item.status, 'published');
    assert.equal(body.data.item.data.count, 2);
    const published = await cms.handleContentList('beers', {
      status: 'published',
      fieldFilters: { day },
    });
    assert.ok(published.success);
    assert.equal(published.data.items.length, 1);
    for (const trashedId of trashedIds) {
      const original = await cms.handleContentGetIncludingTrashed(
        'beers',
        trashedId,
      );
      assert.ok(original.success);
      const record = entrySchema.parse(original.data).item;
      assert.equal(record.data.count, 1);
      assert.equal(
        (await cms.handleContentGet('beers', trashedId)).success,
        false,
      );
      const trash = await cms.handleContentListTrashed('beers');
      assert.ok(trash.success);
      assert.ok(
        trash.data.items.some(
          (item) => item.id === trashedId && item.deletedAt,
        ),
      );
    }
  });
}
