import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { jpegDimensions, serveMapPhoto } from '../src/lib/map-image';
import { mapPhoto, displayPreviewReference } from '../src/lib/responsive-image';

let directory: string;
let platform: PlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>;
const folder = '00000000-0000-4000-8000-000000000001';
const photo = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const poster = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const key = `trip/${folder}/photo.jpg`;
const sourceUrl = `/_emdash/api/media/file/${key}`;
const source = new Uint8Array([
  255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 6, 64, 4, 176, 0, 255, 218,
]);
async function mapImage(
  id: string,
  source: string,
  env: Parameters<typeof serveMapPhoto>[2],
) {
  const path = `/map-photo/${id}/${displayPreviewReference(source) || ''}`;
  const response = await serveMapPhoto(
    new Request(`https://synthetic.invalid${path}`),
    path,
    env,
    false,
  );
  const dimensions: unknown = response.ok ? await response.json() : null;
  if (
    typeof dimensions === 'object' &&
    dimensions &&
    'width' in dimensions &&
    'height' in dimensions &&
    typeof dimensions.width === 'number' &&
    typeof dimensions.height === 'number'
  )
    return mapPhoto(source, {
      width: dimensions.width,
      height: dimensions.height,
    });
  return mapPhoto(source);
}
const sizes = async (...args: Parameters<typeof mapImage>) =>
  (await mapImage(...args)).sizes || horizontal;
const horizontal = '(min-width: 672px) 614px, calc(100vw - 58px)';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'synthetic-map-image-'));
  await writeFile(
    join(directory, 'worker.js'),
    'export default {fetch(){return new Response("synthetic")}}',
  );
  const configPath = join(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'synthetic-responsive-image',
      main: 'worker.js',
      compatibility_date: '2026-10-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'synthetic',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
      r2_buckets: [{ binding: 'MEDIA', bucket_name: 'synthetic' }],
    }),
  );
  platform = await getPlatformProxy({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  const { DB, MEDIA } = platform.env;
  await DB.batch([
    DB.prepare(
      'CREATE TABLE media(id TEXT PRIMARY KEY, storage_key TEXT, mime_type TEXT, width INTEGER, height INTEGER)',
    ),
    DB.prepare(
      'CREATE TABLE ec_media_items(id TEXT PRIMARY KEY, kind TEXT, asset TEXT, poster TEXT, status TEXT, deleted_at TEXT, draft_revision_id TEXT)',
    ),
    DB.prepare(
      'INSERT INTO media(id,storage_key,mime_type) VALUES (?, ?, ?), (?, ?, ?)',
    ).bind(
      photo,
      key,
      'image/jpeg',
      poster,
      `trip/${folder}/poster.jpg`,
      'image/jpeg',
    ),
    DB.prepare(
      'INSERT INTO ec_media_items VALUES (?, ?, ?, ?, ?, NULL, ?)',
    ).bind(
      photo,
      'photo',
      JSON.stringify({ id: photo }),
      JSON.stringify({ id: poster }),
      'published',
      'private-draft-revision',
    ),
  ]);
  for (const filename of ['photo.jpg', 'poster.jpg'])
    await MEDIA.put(`trip/${folder}/${filename}`, source, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
});

beforeEach(async () => {
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='published', deleted_at=NULL",
  ).run();
  await platform.env.DB.prepare(
    'UPDATE media SET width=NULL,height=NULL,storage_key=? WHERE id=?',
  )
    .bind(key, photo)
    .run();
  await platform.env.MEDIA.put(key, source, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
});
after(async () => {
  await platform.dispose();
  await rm(directory, { recursive: true, force: true });
});

void test('JPEG frame parsing handles baseline/progressive frames and rejects truncated or invalid headers', () => {
  assert.deepEqual(jpegDimensions(source), { width: 1200, height: 1600 });
  const progressive = source.slice();
  progressive[9] = 194;
  assert.deepEqual(jpegDimensions(progressive), { width: 1200, height: 1600 });
  for (let length = 0; length < 18; length++)
    assert.equal(jpegDimensions(source.slice(0, length)), undefined);
  const zero = source.slice();
  zero[15] = 0;
  zero[16] = 0;
  assert.equal(jpegDimensions(zero), undefined);
  assert.equal(
    jpegDimensions(new Uint8Array([255, 216, 255, 218, 0, 2])),
    undefined,
  );
});

void test('map sizes use a bounded live display header and existing metadata without reading originals', async () => {
  const reads: unknown[] = [];
  const MEDIA = {
    async get(
      key: string,
      options: { range: { offset: number; length: number } },
    ) {
      reads.push({ key, options });
      return platform.env.MEDIA.get(key, options);
    },
  };
  const env = { ...platform.env, MEDIA };
  assert.equal(
    await sizes(photo, sourceUrl, env),
    '(min-width: 672px) min(614px, 41.25dvh), min(calc(100vw - 58px), 41.25dvh)',
  );
  assert.deepEqual(reads, [
    { key, options: { range: { offset: 0, length: 65536 } } },
  ]);
  const mapPhoto = await mapImage(photo, sourceUrl, env);
  assert.match(mapPhoto.srcSet || '', /1600\/auto 1200w$/);
  assert.equal((mapPhoto.srcSet || '').split(',').length, 5);
  reads.length = 0;
  await platform.env.DB.prepare(
    'UPDATE media SET width=1600,height=1200 WHERE id=?',
  )
    .bind(photo)
    .run();
  assert.match(await sizes(photo, sourceUrl, env), /73.33333333333333dvh/);
  assert.equal(reads.length, 0);
});

void test('drafts, deletion, wrong references and private/original sources never initiate header reads', async () => {
  let reads = 0;
  const env = {
    ...platform.env,
    MEDIA: {
      get() {
        reads++;
        return Promise.resolve(null);
      },
    },
  };
  for (const source of [
    '/demo/japan.jpg',
    'https://external.invalid/photo.jpg',
    '/_emdash/api/media/file/trip-private/originals/synthetic',
    '/_emdash/api/media/asset/01CCCCCCCCCCCCCCCCCCCCCCCC/photo.jpg',
  ])
    assert.equal(await sizes(photo, source, env), horizontal);
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='draft'",
  ).run();
  assert.equal(await sizes(photo, sourceUrl, env), horizontal);
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='published',deleted_at='synthetic'",
  ).run();
  assert.equal(await sizes(photo, sourceUrl, env), horizontal);
  assert.equal(reads, 0);
});

void test('revocation during a header read discards dimensions and errors retain photo availability', async () => {
  const env = {
    ...platform.env,
    MEDIA: {
      async get() {
        await platform.env.DB.prepare(
          "UPDATE ec_media_items SET status='draft'",
        ).run();
        return {
          httpMetadata: { contentType: 'image/jpeg' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(source);
              controller.close();
            },
          }),
        };
      },
    },
  };
  assert.equal(await sizes(photo, sourceUrl, env), horizontal);
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='published'",
  ).run();
  assert.equal(
    await sizes(photo, sourceUrl, {
      ...platform.env,
      MEDIA: {
        get() {
          return Promise.reject(new Error('synthetic'));
        },
      },
    }),
    horizontal,
  );
});

const endpoint = `/map-photo/${photo}/file/${key.replace('trip/', '')}`;
function selected(
  env: Parameters<typeof serveMapPhoto>[2] = platform.env,
  options: {
    path?: string;
    method?: string;
    privateRender?: boolean;
    signal?: AbortSignal;
    search?: string;
  } = {},
) {
  const path = options.path || endpoint;
  return serveMapPhoto(
    new Request(`https://synthetic.invalid${path}${options.search || ''}`, {
      method: options.method,
      signal: options.signal,
    }),
    path,
    env,
    options.privateRender || false,
  );
}
function noStore(response: Response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(
    response.headers.get('Cloudflare-CDN-Cache-Control'),
    'no-store',
  );
}
void test('selected endpoint rejects arbitrary/private/original/preview paths and methods without storage reads', async () => {
  let reads = 0;
  const env = {
    ...platform.env,
    MEDIA: {
      get() {
        reads++;
        return Promise.resolve(null);
      },
    },
  };
  for (const options of [
    { path: `/map-photo/${photo}/https://external.invalid/photo.jpg` },
    { path: `/map-photo/${photo}/file/trip-private/originals/photo.jpg` },
    { path: `/map-photo/${photo}/file/${key}/extra` },
    { path: `/map-photo/${photo}/asset/${photo}/extra` },
    { path: `/map-photo/invalid/file/${key.replace('trip/', '')}` },
    { search: '?_preview=synthetic' },
    { search: '?source=synthetic' },
    { method: 'POST' },
    { method: 'HEAD' },
    { privateRender: true },
  ]) {
    const response = await selected(env, options);
    assert.equal(response.status, 404);
    noStore(response);
  }
  assert.equal(reads, 0);
});

for (const seam of ['get', 'body'])
  for (const mutation of ['draft', 'delete', 'key'])
    void test(`selected endpoint discards dimensions on ${mutation} across ${seam} wait`, async () => {
      const mutate = async () => {
        if (mutation === 'key')
          await platform.env.DB.prepare(
            'UPDATE media SET storage_key=? WHERE id=?',
          )
            .bind(`trip/${folder}/poster.jpg`, photo)
            .run();
        else if (mutation === 'delete')
          await platform.env.DB.prepare(
            "UPDATE ec_media_items SET deleted_at='synthetic'",
          ).run();
        else
          await platform.env.DB.prepare(
            "UPDATE ec_media_items SET status='draft'",
          ).run();
      };
      let cancelled = 0;
      const response = await selected({
        ...platform.env,
        MEDIA: {
          async get() {
            if (seam === 'get') await mutate();
            return {
              httpMetadata: { contentType: 'image/jpeg' },
              body: new ReadableStream<Uint8Array>({
                async pull(controller) {
                  if (seam === 'body') await mutate();
                  controller.enqueue(source);
                },
                cancel() {
                  cancelled++;
                },
              }),
            };
          },
        },
      });
      assert.equal(response.status, 404);
      noStore(response);
      assert.equal(cancelled, 1);
    });

void test('missing and malformed selected headers retain live photo fallback; failed lookups never disclose dimensions', async () => {
  for (const contentType of ['image/jpeg', 'image/png']) {
    let cancelled = 0;
    const response = await selected({
      ...platform.env,
      MEDIA: {
        get() {
          return Promise.resolve({
            httpMetadata: { contentType },
            body: new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array(65536));
              },
              cancel() {
                cancelled++;
              },
            }),
          });
        },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
    noStore(response);
    assert.equal(cancelled, 1);
  }
  const missing = await selected({
    ...platform.env,
    MEDIA: {
      get() {
        return Promise.resolve(null);
      },
    },
  });
  assert.equal(await missing.json(), null);
  noStore(missing);
  const failed = await selected({
    ...platform.env,
    MEDIA: {
      get() {
        return Promise.reject(new Error('synthetic read failure'));
      },
    },
  });
  assert.equal(await failed.json(), null);
  noStore(failed);
  const DB = new Proxy(platform.env.DB, {
    get(target, property, receiver) {
      if (property === 'prepare')
        return () => {
          throw new Error('synthetic query failure');
        };
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
  const denied = await selected({ ...platform.env, DB });
  assert.equal(denied.status, 503);
  noStore(denied);
});

for (const seam of ['get', 'body'])
  void test(`selected request cancellation at ${seam} cancels its source and returns no dimensions`, async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const response = await selected(
      {
        ...platform.env,
        MEDIA: {
          get() {
            if (seam === 'get') controller.abort();
            return Promise.resolve({
              httpMetadata: { contentType: 'image/jpeg' },
              body: new ReadableStream<Uint8Array>({
                pull(output) {
                  if (seam === 'body') controller.abort();
                  output.enqueue(source);
                },
                cancel() {
                  cancelled++;
                },
              }),
            });
          },
        },
      },
      { signal: controller.signal },
    );
    assert.equal(response.status, 404);
    assert.equal(cancelled, 1);
    noStore(response);
  });

void test('600 distinct selected native photos each stay within two queries and one 64KiB read independently of library size', async () => {
  const header = new Uint8Array(65536);
  header.set(source);
  const rows = Array.from({ length: 600 }, (_, index) => ({
    id: `02${String(index + 1).padStart(24, '0')}`,
    key: `trip/00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}/photo.jpg`,
  }));
  for (const row of rows) {
    await platform.env.DB.batch([
      platform.env.DB.prepare(
        'INSERT INTO media VALUES (?,?,?,NULL,NULL)',
      ).bind(row.id, row.key, 'image/jpeg'),
      platform.env.DB.prepare(
        "INSERT INTO ec_media_items VALUES (?,'photo',?,?,'published',NULL,NULL)",
      ).bind(
        row.id,
        JSON.stringify({ id: row.id }),
        JSON.stringify({ id: row.id }),
      ),
    ]);
    await platform.env.MEDIA.put(row.key, header, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
  }
  let totalQueries = 0,
    totalReads = 0,
    totalMs = 0;
  for (const row of rows) {
    let queries = 0,
      reads = 0;
    const DB = new Proxy(platform.env.DB, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => {
            queries++;
            if (queries > 2) throw new Error('selected query budget');
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, property, receiver);
        return value;
      },
    });
    const started = performance.now();
    const response = await selected(
      {
        DB,
        MEDIA: {
          get(key, options) {
            reads++;
            assert.deepEqual(options, { range: { offset: 0, length: 65536 } });
            return platform.env.MEDIA.get(key, options);
          },
        },
      },
      { path: `/map-photo/${row.id}/file/${row.key.replace('trip/', '')}` },
    );
    assert.equal(response.status, 200);
    noStore(response);
    assert.deepEqual(await response.json(), { width: 1200, height: 1600 });
    assert.equal(queries, 2);
    assert.equal(reads, 1);
    totalQueries += queries;
    totalReads += reads;
    totalMs += performance.now() - started;
  }
  console.log(
    JSON.stringify({
      selectedPhotos: rows.length,
      totalQueriesAcrossSeparateRequests: totalQueries,
      totalReadsAcrossSeparateRequests: totalReads,
      maxQueriesPerRequest: 2,
      maxHeaderBytesPerRequest: 65536,
      averageLocalSelectedMs: totalMs / rows.length,
      homepageDimensionQueries: 0,
      cmsBudget:
        'No added SSR queries; existing CMS/layout budget remains available. Endpoint has its own invocation budget.',
    }),
  );
});

for (const interruption of ['deadline', 'abort'])
  for (const seam of ['get', 'body'])
    void test(`selected header ${interruption} at ${seam} returns retryable failure without awaiting cancellation`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const controller = new AbortController();
      let entered = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let cancelled = 0;
      let settled: Response | undefined;
      const pending = selected(
        {
          ...platform.env,
          MEDIA: {
            async get() {
              if (seam === 'get') {
                entered();
                await held;
              }
              return {
                httpMetadata: { contentType: 'image/jpeg' },
                body: new ReadableStream<Uint8Array>({
                  async pull(output) {
                    if (seam === 'body') {
                      entered();
                      await held;
                    }
                    try {
                      output.enqueue(source);
                    } catch {
                      /* The consumer has already cancelled. */
                    }
                  },
                  cancel() {
                    cancelled++;
                    return new Promise<void>(() => {});
                  },
                }),
              };
            },
          },
        },
        { signal: controller.signal },
      ).then((response) => {
        settled = response;
        return response;
      });
      try {
        await started;
        if (interruption === 'deadline') {
          t.mock.timers.tick(3999);
          assert.equal(settled, undefined);
          t.mock.timers.tick(1);
        } else controller.abort();
        for (let turn = 0; turn < 10; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          settled?.status,
          interruption === 'deadline' ? 503 : 404,
          'a held header must finish without waiting on cancellation',
        );
        noStore(settled);
        assert.equal(cancelled, seam === 'body' ? 1 : 0);
        release();
        for (let turn = 0; turn < 10; turn++)
          await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
          cancelled,
          1,
          'late R2 object must be cancelled exactly once',
        );
        await pending;
      } finally {
        controller.abort();
        release();
        t.mock.timers.reset();
      }
    });
