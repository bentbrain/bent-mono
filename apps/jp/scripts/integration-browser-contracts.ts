import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { newsletterJpeg } from '../src/lib/newsletter-image';
import { newsletterStatusSchema } from '../src/lib/newsletter-model';

// These contracts use the running Astro routes, native CMS handlers and local
// Cloudflare bindings. No HTTP response or CMS method is replaced.
type Transport = {
  request: (
    path: string,
    body?: unknown,
    method?: string,
    signed?: boolean,
  ) => Promise<Response>;
  raw: (path: string, init: RequestInit, signed?: boolean) => Promise<Response>;
};
const entry = z.object({
  data: z.object({
    _rev: z.string(),
    item: z.object({
      id: z.string(),
      status: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  }),
});
const beer = z.object({
  id: z.string(),
  data: z.object({ day: z.string(), count: z.number() }),
});
const page = z.object({
  data: z.object({
    items: z.array(beer),
    nextCursor: z.string().nullish(),
  }),
});

function checked(response: Response, status: number) {
  assert.equal(
    response.status,
    status,
    `HTTP contract expected ${String(status)}, received ${String(response.status)}`,
  );
  return response;
}
async function create(
  transport: Transport,
  collection: string,
  data: Record<string, unknown>,
  slug = crypto.randomUUID(),
) {
  return entry.parse(
    await checked(
      await transport.request(`/_emdash/api/content/${collection}`, {
        slug,
        data,
      }),
      201,
    ).json(),
  ).data;
}
async function load(transport: Transport, collection: string, id: string) {
  return entry.parse(
    await checked(
      await transport.request(`/_emdash/api/content/${collection}/${id}`),
      200,
    ).json(),
  ).data;
}
async function publish(transport: Transport, collection: string, id: string) {
  const current = await load(transport, collection, id);
  checked(
    await transport.request(
      `/_emdash/api/content/${collection}/${id}/publish`,
      { _rev: current._rev },
    ),
    200,
  );
}
async function trash(transport: Transport, collection: string, id: string) {
  checked(
    await transport.request(
      `/_emdash/api/content/${collection}/${id}`,
      undefined,
      'DELETE',
    ),
    200,
  );
}

export async function runBeerContracts(transport: Transport) {
  const { request } = transport;
  const legacy = await create(
    transport,
    'beers',
    { title: 'sample legacy beer day', day: '2098-10-18', count: 1 },
    'sample-http-legacy-beer-day',
  );
  const saved = entry.parse(
    await checked(
      await request('/api/trip/beers', { day: '2098-10-18', count: 2 }),
      200,
    ).json(),
  ).data.item;
  assert.equal(saved.id, legacy.item.id);
  assert.equal(saved.status, 'published');
  assert.equal(saved.data.day, '2098-10-18');
  assert.equal(saved.data.count, 2);
  const fresh = entry.parse(
    await checked(
      await request('/api/trip/beers', { day: '2098-10-19', count: 2 }),
      200,
    ).json(),
  ).data.item;
  assert.notEqual(fresh.id, legacy.item.id);
  await trash(transport, 'beers', legacy.item.id);
  await trash(transport, 'beers', fresh.id);

  for (const trashed of [false, true]) {
    const day = trashed ? '2098-10-22' : '2098-10-21';
    let originalId: string | undefined;
    if (trashed) {
      const first = entry.parse(
        await checked(
          await request('/api/trip/beers', { day, count: 1 }),
          200,
        ).json(),
      ).data.item;
      originalId = first.id;
      await trash(transport, 'beers', first.id);
    }
    const saves = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        await new Promise((resolve) => setTimeout(resolve, index * 3));
        return request('/api/trip/beers', { day, count: 3 });
      }),
    );
    assert.ok(saves.some((response) => response.status === 200));
    for (const response of saves)
      assert.ok([200, 409].includes(response.status));
    async function entries() {
      const items: z.infer<typeof beer>[] = [];
      let cursor: string | undefined;
      do {
        const result = page.parse(
          await checked(
            await request(
              `/_emdash/api/content/beers?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
            ),
            200,
          ).json(),
        ).data;
        items.push(...result.items.filter(({ data }) => data.day === day));
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      return items;
    }
    const active = await entries();
    assert.equal(active.length, 1);
    const activeId = active[0]?.id;
    assert.ok(activeId);
    if (originalId) assert.notEqual(activeId, originalId);
    checked(await request('/api/trip/beers', { day, count: 2 }), 200);
    assert.deepEqual(await entries(), [
      { id: activeId, data: { day, count: 2 } },
    ]);
    if (originalId) {
      const deleted = z
        .object({
          data: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                deletedAt: z.string(),
                data: z.object({ day: z.string(), count: z.number() }),
              }),
            ),
          }),
        })
        .parse(
          await checked(
            await request('/_emdash/api/content/beers/trash'),
            200,
          ).json(),
        );
      assert.deepEqual(
        deleted.data.items.find(({ id }) => id === originalId)?.data,
        { day, count: 1 },
      );
    }
    await trash(transport, 'beers', activeId);
  }
}

export async function runMediaEditContracts(transport: Transport) {
  const { request, raw } = transport;
  const originalData = {
    title: 'sample HTTP draft',
    kind: 'photo',
    captured_at: '2099-10-15T01:23:45.678Z',
    latitude: 0,
    longitude: 139.6917,
    place: 'sample Kyoto',
    categories: ['food', 'people'],
    source_url: '/demo/japan.jpg',
    demo: true,
  };
  const record = await create(transport, 'media_items', originalData);
  const data = {
    id: record.item.id,
    revision: record._rev,
    changes: { place: 'sample Tokyo' },
  };
  const rejected: number[] = [];
  async function reject(response: Response, status: number) {
    checked(response, status);
    const stored = await load(transport, 'media_items', record.item.id);
    assert.deepEqual(
      stored,
      record,
      'Rejected patch changed revision, status or original metadata',
    );
    rejected.push(status);
  }
  await reject(
    await request('/api/trip/media/edit', data, 'PATCH', false),
    401,
  );
  await reject(
    await raw('/api/trip/media/edit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    403,
  );
  await reject(
    await raw('/api/trip/media/edit', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://foreign.example',
        'X-EmDash-Request': '1',
      },
      body: JSON.stringify(data),
    }),
    403,
  );
  for (const changes of [
    {},
    { latitude: 0 },
    { longitude: 0 },
    { captured_at: '2099-10-16T00:00:00Z' },
    { title: 'sample title', asset: null },
  ]) {
    await reject(
      await request('/api/trip/media/edit', { ...data, changes }, 'PATCH'),
      400,
    );
  }
  const incomplete = await create(transport, 'media_items', {
    title: 'sample missing metadata',
    kind: 'photo',
    categories: ['food'],
  });
  let current = incomplete;
  for (const changes of [
    { place: '' },
    { categories: { mode: 'add', names: ['people'] } },
    { categories: { mode: 'replace', names: [] } },
  ]) {
    checked(
      await request(
        '/api/trip/media/edit',
        { id: current.item.id, revision: current._rev, changes },
        'PATCH',
      ),
      200,
    );
    current = await load(transport, 'media_items', current.item.id);
    assert.equal(current.item.status, 'draft');
  }
  assert.deepEqual(current.item.data, {
    ...incomplete.item.data,
    place: '',
    categories: [],
  });
  await trash(transport, 'media_items', record.item.id);
  await trash(transport, 'media_items', incomplete.item.id);
  console.log(
    JSON.stringify({
      contract: 'media-edit-rejection-state',
      statuses: rejected,
      unchangedAfterEveryRejection: true,
      draftOnly: true,
    }),
  );
}

export async function runCategoryContracts(transport: Transport) {
  const { request, raw } = transport;
  const icon = `/api/trip/icon-library/${'a'.repeat(64)}/${'b'.repeat(64)}.png`;
  for (const path of ['/api/trip/categories', icon])
    checked(await request(path, undefined, 'GET', false), 401);
  const redirect = checked(
    await request('/categories', undefined, 'GET', false),
    302,
  );
  assert.equal(
    redirect.headers.get('location'),
    '/_emdash/admin/login?redirect=/owner',
  );
  checked(
    await raw('/api/trip/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'forged category' }),
    }),
    403,
  );
  checked(
    await raw('/api/trip/categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://foreign.example',
        'X-EmDash-Request': '1',
      },
      body: JSON.stringify({ name: 'forged category' }),
    }),
    403,
  );
  for (const name of ['\u200B', '', 'x'.repeat(41)])
    checked(await request('/api/trip/categories', { name }), 400);
  checked(await request('/api/trip/categories'), 200);
  checked(await request(icon), 404);
  checked(
    await request('/api/trip/category-icons', undefined, 'GET', false),
    401,
  );
  checked(await request('/_emdash/api/admin/users'), 403);
}

async function uploadPhoto(transport: Transport) {
  const bytes = await readFile('public/demo/japan.jpg');
  const form = new FormData();
  for (const name of ['original', 'display', 'poster'])
    form.set(
      name,
      new File([bytes], 'synthetic-http.jpg', { type: 'image/jpeg' }),
    );
  const uploaded = entry.parse(
    await checked(
      await transport.raw('/api/trip/upload', { method: 'POST', body: form }),
      201,
    ).json(),
  ).data;
  checked(
    await transport.request(
      '/api/trip/media',
      {
        id: uploaded.item.id,
        revision: uploaded._rev,
        publish: true,
        metadata: {
          title: 'synthetic HTTP photo',
          captured_at: '2097-10-15T20:15:00+09:00',
          latitude: 35.6895,
          longitude: 139.6917,
          place: 'synthetic location',
          categories: [],
        },
      },
      'PATCH',
    ),
    200,
  );
  return uploaded.item.id;
}

export async function runNewsletterPhotoContract(transport: Transport) {
  const { request } = transport;
  const id = await uploadPhoto(transport);
  const post = await create(transport, 'posts', {
    title: 'day 1: synthetic newsletter',
    day: '2097-10-15',
    gallery: [id],
  });
  await publish(transport, 'posts', post.item.id);
  const status = z
    .object({ data: newsletterStatusSchema })
    .parse(
      await checked(
        await request('/_emdash/api/plugins/japan-newsletter/owner'),
        200,
      ).json(),
    ).data;
  const photo = status.posts.find((entry) => entry.id === post.item.id)
    ?.images?.[0];
  assert.ok(
    photo,
    'Published uploaded photo missing from native newsletter owner route',
  );
  const image = checked(await request(photo.src, undefined, 'GET', false), 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.match(image.headers.get('cache-control') ?? '', /no-store/);
  const bytes = new Uint8Array(await image.arrayBuffer());
  const jpeg = newsletterJpeg(bytes);
  assert.ok(bytes.length <= 150_000);
  assert.ok(jpeg.width <= 1120);
  assert.deepEqual(jpeg.bytes, bytes);
  checked(
    await request(`/_emdash/api/content/posts/${post.item.id}/unpublish`, {}),
    200,
  );
  checked(await request(photo.src, undefined, 'GET', false), 404);
  await trash(transport, 'posts', post.item.id);
  await trash(transport, 'media_items', id);
  console.log(
    JSON.stringify({
      contract: 'newsletter-native-image',
      bytes: bytes.length,
      width: jpeg.width,
      immediateUnpublishStatus: 404,
    }),
  );
}

export async function runNativeLibraryContract(transport: Transport) {
  const { request } = transport;
  // This phase runs last and owns the ephemeral database. Remove earlier
  // synthetic published fixtures so pagination proves an exact 600-record union.
  const previous: string[] = [];
  let previousCursor: string | undefined;
  do {
    const result = z
      .object({
        data: z.object({
          items: z.array(z.object({ id: z.string() })),
          nextCursor: z.string().nullish(),
        }),
      })
      .parse(
        await checked(
          await request(
            `/_emdash/api/content/media_items?status=published&limit=100${previousCursor ? `&cursor=${encodeURIComponent(previousCursor)}` : ''}`,
          ),
          200,
        ).json(),
      ).data;
    previous.push(...result.items.map(({ id }) => id));
    previousCursor = result.nextCursor ?? undefined;
  } while (previousCursor);
  for (const id of previous) await trash(transport, 'media_items', id);
  const sourceId = await uploadPhoto(transport);
  const seeded = z
    .object({ ids: z.array(z.string()).length(599) })
    .parse(
      await checked(
        await request(`/__synthetic/map-library?sourceId=${sourceId}`, {}),
        200,
      ).json(),
    );
  const expected = new Set([sourceId, ...seeded.ids]);
  assert.equal(expected.size, 600);
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  const pageSizes: number[] = [];
  do {
    const result = z
      .object({
        data: z.object({
          items: z.array(z.object({ id: z.string(), status: z.string() })),
          nextCursor: z.string().nullish(),
        }),
      })
      .parse(
        await checked(
          await request(
            `/_emdash/api/content/media_items?status=published&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ),
          200,
        ).json(),
      ).data;
    assert.ok(result.items.length <= 100);
    pageSizes.push(result.items.length);
    for (const item of result.items) {
      assert.equal(item.status, 'published');
      assert.ok(!seen.has(item.id), 'Native pagination repeated an identity');
      seen.add(item.id);
    }
    cursor = result.nextCursor ?? undefined;
    if (cursor) {
      assert.ok(!cursors.has(cursor), 'Native pagination repeated a cursor');
      cursors.add(cursor);
    }
  } while (cursor);
  for (const id of expected)
    assert.ok(seen.has(id), 'Native pagination lost a seeded identity');
  assert.deepEqual(
    seen,
    expected,
    'Native pagination must return exactly the 600 seeded identities',
  );
  assert.deepEqual(pageSizes, [100, 100, 100, 100, 100, 100]);
  const lastId = seeded.ids.at(-1);
  assert.ok(lastId);
  const last = await load(transport, 'media_items', lastId);
  assert.equal(last.item.id, lastId);
  assert.equal(last.item.status, 'published');
  const source = await load(transport, 'media_items', sourceId);
  assert.deepEqual(last.item.data.asset, source.item.data.asset);
  const publicMap = checked(
    await request(`/?media=${lastId}#japan-map`, undefined, 'GET', false),
    200,
  );
  assert.match(publicMap.headers.get('cache-control') ?? '', /no-store/);
  const html = await publicMap.text();
  const serialized = html.match(
    /<astro-island\b[^>]*component-export="JapanMapView"[^>]*>/,
  )?.[0];
  assert.ok(serialized, 'Map island missing');
  for (const id of expected)
    assert.ok(
      serialized.includes(id),
      'Public CMS traversal lost a seeded map identity',
    );
  console.log(
    JSON.stringify({
      contract: 'native-600-library',
      seededRecords: expected.size,
      nativePageSizes: pageSizes,
      allIdentitiesPresent: true,
      finalNativeIdentity: lastId,
      publicMapIdentities: 600,
      exactNativeUnion: true,
      noStore: true,
    }),
  );
}

export async function runBrowserContracts(transport: Transport) {
  const contracts: Array<[string, (transport: Transport) => Promise<void>]> = [
    ['beer-legacy-concurrency-trash', runBeerContracts],
    ['media-edit-authorization-allowlist', runMediaEditContracts],
    ['category-icon-library-authorization', runCategoryContracts],
    ['newsletter-native-image-serving', runNewsletterPhotoContract],
    ['native-600-library-pagination', runNativeLibraryContract],
  ];
  for (const [name, contract] of contracts) {
    const started = performance.now();
    await contract(transport);
    console.log(
      JSON.stringify({
        contract: name,
        elapsedMs: Math.round(performance.now() - started),
        passed: true,
      }),
    );
  }
}
