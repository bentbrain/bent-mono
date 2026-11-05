import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ContentRepository, SchemaRegistry } from 'emdash';
import { sqlite } from 'emdash/db';
import { createDialect } from 'emdash/db/sqlite';
import { z } from 'zod';
import { saveMediaEdit } from '../src/lib/save-media-edit';
import { ownerMedia } from '../src/lib/owner-media';

// Real native revisions/publication, with only Vite's build-time config supplied.
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
const actor = { id: 'sample-owner', role: 50 };
const result = z.object({
  success: z.literal(true),
  data: z.object({
    _rev: z.string(),
    item: z.object({
      id: z.string(),
      status: z.string(),
      data: z.record(z.string(), z.unknown()),
      liveData: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
});
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sample-media-edit-'));
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
    {
      slug: 'media_items',
      label: 'sample media',
      supports: ['drafts', 'revisions'],
      routable: false,
    },
    [
      { slug: 'title', label: 'title', type: 'string' },
      { slug: 'place', label: 'place', type: 'string' },
      { slug: 'categories', label: 'categories', type: 'json' },
      { slug: 'captured_at', label: 'captured', type: 'string' },
      { slug: 'latitude', label: 'latitude', type: 'number' },
      { slug: 'longitude', label: 'longitude', type: 'number' },
    ],
  );
});
after(async () => {
  await cms.db.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
  hooks.deregister();
});
async function published() {
  const created = result.parse(
    await cms.handleContentCreate('media_items', {
      data: {
        title: 'sample original',
        place: 'sample Kyoto',
        categories: ['food'],
        captured_at: '2099-10-15T01:23:45.678Z',
        latitude: 0,
        longitude: 139,
      },
    }),
  );
  return result.parse(
    await cms.handleContentPublish('media_items', created.data.item.id, {
      _rev: created.data._rev,
    }),
  ).data;
}

void test('a private save after bulk staging cannot be published by the bulk operation', async () => {
  const original = await published();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Applied to the native instance below and restored after fault injection.
  const stage = ContentRepository.prototype.replaceDraftRevision;
  let injected = false;
  ContentRepository.prototype.replaceDraftRevision = async function (...args) {
    const staged = await stage.apply(this, args);
    if (staged && args[1] === original.item.id && !injected) {
      injected = true;
      const current = result.parse(
        await cms.handleContentGet('media_items', original.item.id),
      );
      result.parse(
        await cms.handleContentUpdate('media_items', original.item.id, {
          _rev: current.data._rev,
          data: { title: 'sample private title' },
        }),
      );
    }
    return staged;
  };
  try {
    const response = await saveMediaEdit(cms, actor, {
      id: original.item.id,
      revision: original._rev,
      changes: { place: 'sample Tokyo' },
    });
    assert.equal(injected, true);
    assert.equal(response.status, 409);
    const after = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data.item;
    assert.equal(after.data.title, 'sample private title');
    assert.deepEqual(after.liveData, original.item.data);
  } finally {
    ContentRepository.prototype.replaceDraftRevision = stage;
  }
});

void test('a transient publish failure can retry its exact staged patch without publishing other edits', async () => {
  const original = await published();
  const publish = cms.handleContentPublish.bind(cms);
  let fail = true;
  cms.handleContentPublish = (...args) => {
    if (fail) {
      fail = false;
      return Promise.resolve({
        success: false,
        error: { code: 'TRANSIENT', message: 'sample transient failure' },
      });
    }
    return publish(...args);
  };
  try {
    const changes = { place: 'sample Tokyo' };
    const first = await saveMediaEdit(cms, actor, {
      id: original.item.id,
      revision: original._rev,
      changes,
    });
    assert.equal(first.status, 422);
    const staged = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data;
    assert.deepEqual(staged.item.liveData, original.item.data);
    const retry = await saveMediaEdit(cms, actor, {
      id: original.item.id,
      revision: staged._rev,
      changes,
    });
    assert.equal(retry.status, 200);
    const after = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data.item;
    assert.equal(after.liveData, undefined);
    assert.equal(after.status, 'published');
    assert.deepEqual(after.data, { ...original.item.data, ...changes });
  } finally {
    cms.handleContentPublish = publish;
  }
});

for (const change of [
  { title: 'sample private title' },
  { latitude: 1 },
  { slug: 'sample-private-slug' },
])
  void test(`retry refuses unrelated pending ${Object.keys(change).join()} changes`, async () => {
    const original = await published();
    const publish = cms.handleContentPublish.bind(cms);
    cms.handleContentPublish = () =>
      Promise.resolve({
        success: false,
        error: { code: 'TRANSIENT', message: 'sample failure' },
      });
    const changes = { place: 'sample Tokyo' };
    try {
      assert.equal(
        (
          await saveMediaEdit(cms, actor, {
            id: original.item.id,
            revision: original._rev,
            changes,
          })
        ).status,
        422,
      );
    } finally {
      cms.handleContentPublish = publish;
    }
    const staged = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data;
    const { slug, ...data } = z
      .object({
        title: z.string().optional(),
        latitude: z.number().optional(),
        slug: z.string().optional(),
      })
      .parse(change);
    result.parse(
      await cms.handleContentUpdate('media_items', original.item.id, {
        _rev: staged._rev,
        data,
        ...(slug ? { slug } : {}),
      }),
    );
    const pending = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data;
    assert.equal(
      (
        await saveMediaEdit(cms, actor, {
          id: original.item.id,
          revision: pending._rev,
          changes,
        })
      ).status,
      409,
    );
    const after = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data;
    assert.deepEqual(after, pending);
    assert.deepEqual(after.item.liveData, original.item.data);
  });

void test('native publication preconditions protect a private save after the update response', async () => {
  const original = await published();
  const publish = cms.handleContentPublish.bind(cms);
  cms.handleContentPublish = async (...args) => {
    const staged = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data;
    result.parse(
      await cms.handleContentUpdate('media_items', original.item.id, {
        _rev: staged._rev,
        data: { title: 'sample last-moment private title' },
      }),
    );
    return publish(...args);
  };
  try {
    assert.equal(
      (
        await saveMediaEdit(cms, actor, {
          id: original.item.id,
          revision: original._rev,
          changes: { place: 'sample Tokyo' },
        })
      ).status,
      422,
    );
    const after = result.parse(
      await cms.handleContentGet('media_items', original.item.id),
    ).data.item;
    assert.equal(after.data.title, 'sample last-moment private title');
    assert.deepEqual(after.liveData, original.item.data);
  } finally {
    cms.handleContentPublish = publish;
  }
});

void test('loading the owner library only rereads pending drafts and preserves native revision tokens', async () => {
  for (let i = 0; i < 110; i++) {
    result.parse(
      await cms.handleContentCreate('media_items', {
        data: {
          title: `sample library ${String(i)}`,
          place: 'sample Kyoto',
          categories: [],
        },
      }),
    );
  }
  let pending = 0;
  let cursor: string | undefined;
  do {
    const listed = await cms.handleContentList('media_items', {
      limit: 100,
      cursor,
    });
    assert.ok(listed.success && listed.data);
    pending += listed.data.items.filter((item) => item.draftRevisionId).length;
    cursor = listed.data.nextCursor ?? undefined;
  } while (cursor);
  const get = cms.handleContentGet.bind(cms);
  let reads = 0;
  cms.handleContentGet = (...args) => {
    reads++;
    return get(...args);
  };
  let library;
  try {
    library = await ownerMedia(cms);
    assert.equal(
      reads,
      pending,
      'ordinary rows already exist in the list response',
    );
  } finally {
    cms.handleContentGet = get;
  }
  for (const item of library.items) {
    const native = result.parse(await get('media_items', item.id)).data;
    assert.equal(item._rev, native._rev);
    assert.deepEqual(item.data, native.item.data);
    assert.equal(item.status, native.item.status);
  }
  const draft = library.items.find(
    (item) => item.data.title === 'sample library 0',
  );
  assert.ok(draft);
  assert.equal(
    (
      await saveMediaEdit(cms, actor, {
        id: draft.id,
        revision: draft._rev,
        changes: { place: 'sample Tokyo' },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await saveMediaEdit(cms, actor, {
        id: draft.id,
        revision: draft._rev,
        changes: { place: 'sample stale place' },
      })
    ).status,
    409,
  );
});
