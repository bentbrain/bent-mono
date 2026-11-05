import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { ContentAccess, MediaAccess } from 'emdash';
import {
  createNewsletterAssets,
  type NewsletterAssetContext,
} from '../src/lib/newsletter-assets';
import {
  newsletterJpeg,
  optimiseNewsletterImage,
  type NewsletterImagesBinding,
} from '../src/lib/newsletter-image';

type Item = NonNullable<Awaited<ReturnType<ContentAccess['get']>>>;
type Asset = NonNullable<Awaited<ReturnType<MediaAccess['get']>>>;
const jpeg = Uint8Array.from(
  Buffer.from(
    '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCbALsEv//Z',
    'base64',
  ),
);

function item(id: string, type: string, data: Record<string, unknown>): Item {
  return {
    id,
    type,
    data,
    slug: id,
    status: 'published',
    locale: null,
    createdAt: '',
    updatedAt: 'version-one',
    publishedAt: '',
  };
}
function fixture(beforeAsset: () => Promise<void> = () => Promise.resolve()) {
  const posts = new Map<string, Item>();
  const media = new Map<string, Item>();
  const assets = new Map<string, Asset>();
  for (let i = 0; i < 5; i++) {
    const id = `photo-${String(i)}`;
    const assetId = `asset-${String(i)}`;
    media.set(
      id,
      item(id, 'media_items', {
        title: id,
        kind: 'photo',
        captured_at: '2026-10-15T01:00:00Z',
        latitude: 35,
        longitude: 139,
        asset: { id: assetId },
        categories: [],
      }),
    );
    assets.set(assetId, {
      id: assetId,
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: jpeg.length,
      url: '',
      createdAt: '',
    });
  }
  const post = item('entry', 'posts', {
    title: 'day 1: synthetic',
    day: '2026-10-15',
    gallery: [...media.keys()],
    content: [],
  });
  posts.set(post.id, post);
  const reads: string[] = [];
  let shopAvailable = true;
  const ctx: NewsletterAssetContext = {
    content: {
      get(collection, id) {
        return Promise.resolve(
          (collection === 'posts' ? posts : media).get(id) ?? null,
        );
      },
      list(collection) {
        return Promise.resolve({
          items: [...(collection === 'posts' ? posts : media).values()],
          hasMore: false,
        });
      },
    },
    media: {
      async get(id) {
        await beforeAsset();
        return assets.get(id) ?? null;
      },
      readBytes(id) {
        reads.push(id);
        return Promise.resolve({
          bytes: jpeg,
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: jpeg.length,
        });
      },
    },
    http: {
      fetch(url) {
        assert.equal(new URL(url).origin, 'https://shop.bent.build');
        return Promise.resolve(
          new Response(Uint8Array.from(jpeg).buffer, {
            status: shopAvailable ? 200 : 404,
            headers: { 'Content-Type': 'image/webp' },
          }),
        );
      },
    },
  };
  const objects = new Map<
    string,
    { bytes: Uint8Array; metadata: Record<string, string> }
  >();
  const bucket: Parameters<typeof createNewsletterAssets>[1] = {
    get(key) {
      const value = objects.get(key);
      return Promise.resolve(
        value
          ? {
              size: value.bytes.length,
              customMetadata: value.metadata,
              arrayBuffer() {
                return Promise.resolve(Uint8Array.from(value.bytes).buffer);
              },
            }
          : null,
      );
    },
    put(key, bytes, options) {
      objects.set(key, {
        bytes: new Uint8Array(bytes),
        metadata: options.customMetadata,
      });
      return Promise.resolve();
    },
  };
  let transforms = 0;
  const service = createNewsletterAssets(ctx, bucket, () => {
    transforms++;
    return Promise.resolve(newsletterJpeg(jpeg));
  });
  return {
    post,
    media,
    assets,
    reads,
    service,
    objects,
    transforms: () => transforms,
    revokeShop: () => {
      shopAvailable = false;
    },
  };
}

void test('photo preparation overlaps a bounded batch and preserves gallery order', async () => {
  let active = 0;
  let peak = 0;
  const f = fixture(async () => {
    active++;
    peak = Math.max(peak, active);
    await setImmediate();
    active--;
  });
  const prepared = await f.service.prepare(f.post);
  assert.ok(peak > 1, 'Photo requests should overlap');
  assert.ok(peak <= 4, 'Photo requests should stay bounded');
  assert.deepEqual(
    prepared.images?.map((image) => image.alt),
    [...f.media.keys()],
  );
  assert.equal(f.transforms(), 5);
});

void test('all published inline and gallery photos keep order, reuse derivatives and revoke when publication changes', async () => {
  const f = fixture();
  f.post.data.content = [{ _type: 'image', asset: { _ref: 'asset-2' } }];
  const hidden = f.media.get('photo-4');
  assert.ok(hidden);
  hidden.status = 'draft';
  const prepared = await f.service.prepare(f.post);
  assert.deepEqual(
    prepared.images?.map((image) => image.alt),
    ['photo-2', 'photo-0', 'photo-1', 'photo-3'],
  );
  assert.equal(f.reads.length, 4);
  assert.ok(!f.reads.includes('asset-4'));
  await f.service.prepare(f.post);
  assert.equal(f.transforms(), 4);
  const image = prepared.images.find((image) => image.alt === 'photo-0');
  assert.ok(image);
  const key = new URL(image.src).searchParams.get('key');
  assert.ok(key);
  assert.deepEqual(await f.service.read(f.post.id, key), jpeg);
  const unchanged = f.media.get('photo-0');
  assert.ok(unchanged);
  unchanged.updatedAt = 'staged-revision-update';
  assert.deepEqual(await f.service.read(f.post.id, key), jpeg);
  f.post.status = 'draft';
  assert.equal(await f.service.read(f.post.id, key), null);
  f.post.status = 'published';
  const source = f.media.get('photo-0');
  assert.ok(source);
  source.status = 'draft';
  assert.equal(await f.service.read(f.post.id, key), null);
  source.status = 'published';
  f.assets.delete('asset-0');
  assert.equal(await f.service.read(f.post.id, key), null);
  f.post.data.gallery = [];
  assert.equal(await f.service.read(f.post.id, key), null);
});

void test('shirt variants use only approved shop products and stop serving after public shop access is revoked', async () => {
  const f = fixture();
  f.post.data.gallery = [];
  f.post.data.shop_design = {
    productUrl:
      'https://shop.bent.build/featured/3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc',
    color: 'black',
  };
  const prepared = await f.service.prepare(f.post);
  assert.ok(prepared.shopDesign);
  const key = new URL(prepared.shopDesign.image.src).searchParams.get('key');
  assert.ok(key);
  assert.deepEqual(await f.service.read(f.post.id, key), jpeg);
  f.revokeShop();
  await assert.rejects(
    f.service.read(f.post.id, key),
    /Published shirt image is unavailable/,
  );
  f.post.data.shop_design = {
    productUrl: 'https://unrelated.example/private',
    color: 'black',
  };
  await assert.rejects(
    f.service.prepare(f.post),
    /Published shirt design is invalid/,
  );
});

void test('JPEG optimisation strips hidden metadata, retries oversized output and never falls back to originals', async () => {
  const secret = new TextEncoder().encode(
    'Exif\0\0synthetic-gps-and-capture-time',
  );
  const segment = Uint8Array.from([
    0xff,
    0xe1,
    0,
    secret.length + 2,
    ...secret,
  ]);
  const annotated = Uint8Array.from([
    ...jpeg.subarray(0, 2),
    ...segment,
    ...jpeg.subarray(2),
  ]);
  assert.deepEqual(newsletterJpeg(annotated), {
    bytes: jpeg,
    width: 16,
    height: 8,
  });
  const afterScan = Uint8Array.from([
    ...jpeg.subarray(0, -2),
    ...segment,
    0xff,
    0xd9,
  ]);
  assert.deepEqual(newsletterJpeg(afterScan).bytes, jpeg);
  assert.throws(
    () => newsletterJpeg(jpeg.subarray(0, 50)),
    /Incomplete|Invalid/,
  );
  const qualities: number[] = [];
  const binding: NewsletterImagesBinding = {
    input() {
      return {
        transform(options) {
          assert.equal(options.width <= 1120 && options.height === 3360, true);
          return {
            output(options) {
              assert.equal(options.format, 'image/jpeg');
              qualities.push(options.quality);
              const bytes =
                qualities.length === 1
                  ? Uint8Array.from([
                      ...jpeg.subarray(0, -2),
                      ...new Uint8Array(151000),
                      0xff,
                      0xd9,
                    ])
                  : annotated;
              return Promise.resolve({
                response() {
                  return {
                    arrayBuffer() {
                      return Promise.resolve(bytes.buffer);
                    },
                  };
                },
              });
            },
          };
        },
      };
    },
  };
  assert.deepEqual((await optimiseNewsletterImage(binding, jpeg)).bytes, jpeg);
  assert.deepEqual(qualities, [75, 65]);
  await assert.rejects(
    optimiseNewsletterImage(binding, new Uint8Array(17 * 1024 * 1024)),
    /too large/,
  );
});

void test('post-only inline displays appear in email images without trip-library records and revoke with the reference', async () => {
  const f = fixture();
  const id = 'post-only-asset';
  f.assets.set(id, {
    id,
    filename: 'post-inline-12345678-1234-1234-1234-123456789abc.jpg',
    mimeType: 'image/jpeg',
    size: jpeg.length,
    url: '',
    createdAt: '',
  });
  f.post.data.gallery = [];
  f.post.data.content = [{ _type: 'image', asset: { _ref: id } }];
  const prepared = await f.service.prepare(f.post);
  assert.ok(prepared.images);
  assert.equal(prepared.images.length, 1);
  assert.deepEqual(f.reads, [id]);
  const url = new URL(prepared.images[0]?.src || '');
  const key = url.searchParams.get('key') || '';
  assert.ok(await f.service.read(f.post.id, key));
  f.post.data.content = [];
  assert.equal(await f.service.read(f.post.id, key), null);
});

void test('mixed inline photos retain document order before deduplicated gallery selections', async () => {
  const f = fixture();
  const id = 'post-only-first';
  f.assets.set(id, {
    id,
    filename: 'post-inline-12345678-1234-1234-1234-123456789abc.jpg',
    mimeType: 'image/jpeg',
    size: jpeg.length,
    url: '',
    createdAt: '',
    alt: 'post-only first',
  });
  f.post.data.content = [id, 'asset-0', id].map((ref) => ({
    _type: 'image',
    asset: { _ref: ref },
  }));
  f.post.data.gallery = ['photo-1', 'photo-0', 'photo-1'];
  const prepared = await f.service.prepare(f.post);
  assert.deepEqual(
    prepared.images?.map((image) => image.alt),
    ['post-only first', 'photo-0', 'photo-1'],
  );
  // Reads run in parallel; the images above must retain document order.
  // Check that each source is read once without depending on request timing.
  assert.deepEqual(f.reads.toSorted(), ['asset-0', 'asset-1', id]);
});
