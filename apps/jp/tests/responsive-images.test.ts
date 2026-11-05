import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import {
  serveResponsiveImage,
  type DisplayImagesBinding,
} from '../src/lib/serve-responsive-image';
import { responsiveImage } from '../src/lib/responsive-image';

let directory: string;
let platform: PlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>;
const folder = '00000000-0000-4000-8000-000000000001';
const photo = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const poster = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const key = `trip/${folder}/photo.jpg`;
const source = new Uint8Array([255, 216, 1, 2, 255, 217]);
let calls = 0;
let fail = false;
let revoke = false;
let options: unknown;
let output: unknown;
const images: DisplayImagesBinding = {
  input(stream) {
    calls++;
    return {
      transform(value) {
        options = value;
        return {
          async output(value) {
            output = value;
            await new Response(stream).arrayBuffer();
            if (revoke)
              await platform.env.DB.prepare(
                "UPDATE ec_media_items SET status='draft'",
              ).run();
            if (fail) throw new Error('Synthetic binding failure');
            return {
              response: () =>
                new Response(source, {
                  headers: { 'Content-Type': value.format },
                }),
            };
          },
        };
      },
    };
  },
};
function get(
  path = `/media-preview/asset/${photo}/480/auto`,
  init?: RequestInit,
  privateRender = false,
) {
  return serveResponsiveImage(
    new Request(`https://synthetic.invalid${path}`, init),
    path.split('?')[0] || '',
    { ...platform.env, IMAGES: images },
    privateRender,
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
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'synthetic-responsive-image-'));
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
      'CREATE TABLE media(id TEXT PRIMARY KEY, storage_key TEXT, mime_type TEXT)',
    ),
    DB.prepare(
      'CREATE TABLE ec_media_items(id TEXT PRIMARY KEY, kind TEXT, asset TEXT, poster TEXT, status TEXT, deleted_at TEXT, draft_revision_id TEXT)',
    ),
    DB.prepare('INSERT INTO media VALUES (?, ?, ?), (?, ?, ?)').bind(
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
      'synthetic',
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
  calls = 0;
  fail = false;
  revoke = false;
  await platform.env.DB.prepare(
    "UPDATE media SET storage_key=?,mime_type='image/jpeg' WHERE id=?",
  )
    .bind(key, photo)
    .run();
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET kind='photo',status='published',deleted_at=NULL,asset=?,poster=?",
  )
    .bind(JSON.stringify({ id: photo }), JSON.stringify({ id: poster }))
    .run();
});
after(async () => {
  await platform.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

void test('direct derivatives recheck live membership, scale down only, stream and keep every no-store header', async () => {
  const response = await get(undefined, {
    headers: { Accept: 'image/webp,image/jpeg' },
  });
  assert.equal(response.status, 200);
  noStore(response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source);
  assert.equal(response.headers.get('Content-Type'), 'image/webp');
  assert.equal(response.headers.get('Vary'), 'Accept');
  assert.deepEqual(options, { width: 480, height: 1600, fit: 'scale-down' });
  assert.deepEqual(output, { format: 'image/webp', quality: 75, anim: false });
  assert.equal(
    (await get(`/media-preview/file/${folder}/photo.jpg/320/jpeg`)).status,
    200,
  );
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='draft'",
  ).run();
  for (const path of [
    `/media-preview/asset/${photo}/480/auto`,
    `/media-preview/file/${folder}/photo.jpg/320/jpeg`,
  ]) {
    const denied = await get(path);
    assert.equal(denied.status, 404);
    noStore(denied);
  }
  assert.equal(calls, 2);
});

void test('draft, deleted, malformed references and private originals never reach R2 transforms', async () => {
  for (const change of [
    "status='draft'",
    "deleted_at='2099-10-15'",
    "asset='invalid json'",
    "asset='{}'",
  ]) {
    await platform.env.DB.prepare(
      `UPDATE ec_media_items SET status='published',deleted_at=NULL,asset=?,${change}`,
    )
      .bind(JSON.stringify({ id: photo }))
      .run();
    const response = await get();
    assert.equal(response.status, 404);
    noStore(response);
  }
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='published',deleted_at=NULL,asset=?",
  )
    .bind(JSON.stringify({ id: photo }))
    .run();
  for (const storageKey of [
    `trip-private/originals/${folder}`,
    'category-icons/private.jpg',
    'arbitrary.jpg',
    `trip/${folder}/video.mp4`,
  ]) {
    await platform.env.DB.prepare('UPDATE media SET storage_key=? WHERE id=?')
      .bind(storageKey, photo)
      .run();
    assert.equal((await get()).status, 404);
  }
  assert.equal(calls, 0);
});

void test('owner preview, direct path abuse, arbitrary keys/URLs, methods and unbounded widths/formats are refused', async () => {
  assert.equal((await get(undefined, undefined, true)).status, 404);
  for (const suffix of [
    '0/auto',
    '481/auto',
    '999999/auto',
    '0480/auto',
    '480/png',
    '480/avif',
    '480/auto/extra',
    '480/auto?width=9999',
    '480/auto?_preview=private',
  ]) {
    const response = await get(`/media-preview/asset/${photo}/${suffix}`);
    assert.equal(response.status, 404);
    noStore(response);
  }
  for (const path of [
    '/media-preview/https://private.invalid/photo.jpg/480/auto',
    '/media-preview/file/trip-private/originals/private/480/auto',
    '/media-preview/file/../../private/480/auto',
    '/media-preview/asset/%2500/480/auto',
  ])
    assert.equal((await get(path)).status, 404);
  assert.equal((await get(undefined, { method: 'POST' })).status, 404);
  const head = await get(undefined, { method: 'HEAD' });
  assert.equal(head.status, 200);
  noStore(head);
  assert.equal(await head.text(), '');
  assert.equal(calls, 0);
});

void test('only live video poster references qualify, videos and unrelated photo posters do not', async () => {
  assert.equal(
    (await get(`/media-preview/asset/${poster}/480/jpeg`)).status,
    404,
  );
  await platform.env.DB.prepare("UPDATE ec_media_items SET kind='video'").run();
  assert.equal(
    (await get(`/media-preview/asset/${poster}/480/jpeg`)).status,
    200,
  );
  assert.equal((await get()).status, 404);
});

void test('binding failure falls back to the eligible live preview, but revocation during transform fails closed', async () => {
  fail = true;
  const fallback = await get();
  assert.equal(fallback.status, 200);
  noStore(fallback);
  assert.deepEqual(new Uint8Array(await fallback.arrayBuffer()), source);
  revoke = true;
  const denied = await get();
  assert.equal(denied.status, 404);
  noStore(denied);
  fail = false;
  await platform.env.DB.prepare(
    "UPDATE ec_media_items SET status='published'",
  ).run();
  assert.equal((await get()).status, 404);
});

void test('JPEG negotiation and missing storage fail faithfully', async () => {
  const response = await get(undefined, {
    headers: { Accept: 'image/webp;q=0,image/jpeg' },
  });
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg');
  await platform.env.MEDIA.delete(key);
  const missing = await get();
  assert.equal(missing.status, 404);
  noStore(missing);
  await platform.env.MEDIA.put(key, source, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
});

void test('call-site helpers preserve external/demo URLs and only emit bounded native preview candidates', () => {
  for (const source of [
    'https://private.invalid/photo.jpg',
    '/demo/tokyo.jpg',
    '/_emdash/api/media/file/trip-private/originals/private',
    '/_emdash/api/media/file/trip/private/unknown.jpg',
  ])
    assert.deepEqual(responsiveImage(source, '100vw'), { src: source });
  for (const source of [
    `/_emdash/api/media/file/${key}`,
    `/_emdash/api/media/asset/${photo}/photo.jpg`,
  ]) {
    const attributes = responsiveImage(source, '100vw');
    assert.ok(attributes.srcSet?.includes('/480/auto 480w'));
    assert.equal(attributes.sizes, '100vw');
    assert.equal(attributes.src, source);
  }
});

void test('all allowed widths/formats remain bounded, invalid sources fail closed, oversized display previews stay available', async () => {
  for (const width of [320, 480, 800, 1120, 1600])
    for (const format of ['jpeg', 'webp']) {
      const response = await get(
        `/media-preview/asset/${photo}/${String(width)}/${format}`,
      );
      assert.equal(response.status, 200);
      noStore(response);
      assert.deepEqual(options, { width, height: 1600, fit: 'scale-down' });
    }
  await platform.env.DB.prepare(
    "UPDATE media SET mime_type='video/mp4' WHERE id=?",
  )
    .bind(photo)
    .run();
  assert.equal((await get()).status, 404);
  await platform.env.DB.prepare(
    "UPDATE media SET mime_type='image/jpeg' WHERE id=?",
  )
    .bind(photo)
    .run();
  const callsBefore = calls;
  for (const size of [0]) {
    const response = await serveResponsiveImage(
      new Request('https://synthetic.invalid/'),
      `/media-preview/asset/${photo}/480/auto`,
      {
        DB: platform.env.DB,
        IMAGES: images,
        MEDIA: {
          get() {
            return Promise.resolve({
              body: new ReadableStream<Uint8Array>(),
              size,
              httpMetadata: { contentType: 'image/jpeg' },
            });
          },
        },
      },
      false,
    );
    assert.equal(response.status, 422);
    noStore(response);
  }
  const oversized = await serveResponsiveImage(
    new Request('https://synthetic.invalid/'),
    `/media-preview/asset/${photo}/480/auto`,
    {
      DB: platform.env.DB,
      IMAGES: images,
      MEDIA: {
        get() {
          return Promise.resolve({
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(source);
                controller.close();
              },
            }),
            size: 16 * 1024 * 1024 + 1,
            httpMetadata: { contentType: 'image/jpeg' },
          });
        },
      },
    },
    false,
  );
  assert.equal(oversized.status, 200);
  noStore(oversized);
  assert.equal(oversized.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await oversized.arrayBuffer()), source);
  assert.equal(calls, callsBefore);
});

void test('storage failures return a noncacheable failure without private error details', async () => {
  const response = await serveResponsiveImage(
    new Request('https://synthetic.invalid/'),
    `/media-preview/asset/${photo}/480/auto`,
    {
      DB: platform.env.DB,
      IMAGES: images,
      MEDIA: {
        get() {
          return Promise.reject(new Error('Synthetic private storage detail'));
        },
      },
    },
    false,
  );
  assert.equal(response.status, 503);
  noStore(response);
  assert.equal(await response.text(), 'Image unavailable');
});

for (const change of [
  "UPDATE ec_media_items SET status='draft'",
  "UPDATE ec_media_items SET deleted_at='2099-10-15'",
  "UPDATE media SET storage_key=storage_key || '.changed'",
]) {
  void test(`fallback denies and cancels after pending R2 read: ${change}`, async () => {
    fail = true;
    let gets = 0;
    let cancelled = 0;
    const response = await serveResponsiveImage(
      new Request('https://synthetic.invalid/'),
      `/media-preview/asset/${photo}/480/auto`,
      {
        DB: platform.env.DB,
        IMAGES: images,
        MEDIA: {
          async get(storageKey) {
            gets++;
            const object = await platform.env.MEDIA.get(storageKey);
            if (!object) return null;
            if (gets === 2) await platform.env.DB.prepare(change).run();
            return {
              ...object,
              body: {
                getReader: () => object.body.getReader(),
                async cancel() {
                  cancelled++;
                  await object.body.cancel();
                },
              },
            };
          },
        },
      },
      false,
    );
    const payload = await response.text();
    assert.equal(gets, 2);
    assert.equal(response.status, 404);
    assert.equal(payload, 'Not found');
    assert.equal(cancelled, 1);
    noStore(response);
  });
}

void test('HEAD rechecks publication after its pending storage read', async () => {
  let cancelled = 0;
  const response = await serveResponsiveImage(
    new Request('https://synthetic.invalid/', { method: 'HEAD' }),
    `/media-preview/asset/${photo}/480/auto`,
    {
      DB: platform.env.DB,
      IMAGES: images,
      MEDIA: {
        async get(storageKey) {
          const object = await platform.env.MEDIA.get(storageKey);
          if (!object) return null;
          await platform.env.DB.prepare(
            "UPDATE ec_media_items SET status='draft'",
          ).run();
          return {
            ...object,
            body: {
              getReader: () => object.body.getReader(),
              async cancel() {
                cancelled++;
                await object.body.cancel();
              },
            },
          };
        },
      },
    },
    false,
  );
  assert.equal(response.status, 404);
  assert.equal(cancelled, 1);
  assert.equal(calls, 0);
  noStore(response);
});

for (const invalid of ['status', 'type', 'throw', 'locked']) {
  void test(`failed transform cleans unused input and output, retaining eligible fallback: ${invalid}`, async () => {
    let inputCancelled = 0;
    let outputCancelled = 0;
    let gets = 0;
    const response = await serveResponsiveImage(
      new Request('https://synthetic.invalid/'),
      `/media-preview/asset/${photo}/480/auto`,
      {
        DB: platform.env.DB,
        MEDIA: {
          async get(storageKey) {
            gets++;
            if (gets > 1) return platform.env.MEDIA.get(storageKey);
            return {
              body: new ReadableStream<Uint8Array>({
                cancel() {
                  inputCancelled++;
                },
              }),
              size: 6,
              httpMetadata: { contentType: 'image/jpeg' },
            };
          },
        },
        IMAGES: {
          input(stream) {
            if (invalid === 'locked') stream.getReader();
            return {
              transform() {
                return {
                  output() {
                    if (invalid === 'throw' || invalid === 'locked')
                      return Promise.reject(
                        new Error('Synthetic transform failure'),
                      );
                    return Promise.resolve({
                      response: () =>
                        new Response(
                          new ReadableStream<Uint8Array>({
                            cancel() {
                              outputCancelled++;
                            },
                          }),
                          {
                            status: invalid === 'status' ? 500 : 200,
                            headers: {
                              'Content-Type':
                                invalid === 'type'
                                  ? 'text/plain'
                                  : 'image/jpeg',
                            },
                          },
                        ),
                    });
                  },
                };
              },
            };
          },
        },
      },
      false,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), source);
    assert.equal(inputCancelled, 1);
    assert.equal(
      outputCancelled,
      invalid === 'throw' || invalid === 'locked' ? 0 : 1,
    );
    noStore(response);
  });
}
