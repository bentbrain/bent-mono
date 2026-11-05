import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureOrder, selectGalleryItem } from '../src/lib/gallery-order';
import { ownerMediaItems } from '../src/lib/owner-media';
import { z } from 'zod';

const media = [
  { id: 'late', data: { captured_at: new Date('2026-10-15T10:00:00Z') } },
  { id: 'early', data: { captured_at: new Date('2026-10-15T09:00:00+09:00') } },
  { id: 'middle', data: { captured_at: new Date('2026-10-15T08:00:00Z') } },
];

void test('gallery defaults follow capture instants rather than upload or selection order', () => {
  const original = [...media];
  assert.deepEqual(
    captureOrder(media).map((item) => item.id),
    ['early', 'middle', 'late'],
  );
  assert.deepEqual(media, original);
  let selected: string[] = [];
  for (const id of ['late', 'early', 'middle'])
    selected = selectGalleryItem(selected, id, media, false);
  assert.deepEqual(selected, ['early', 'middle', 'late']);
});

void test('manual and saved gallery order survives adding media without duplicates', () => {
  assert.deepEqual(
    selectGalleryItem(['late', 'early'], 'middle', media, true),
    ['late', 'early', 'middle'],
  );
  assert.deepEqual(selectGalleryItem(['late', 'early'], 'early', media, true), [
    'late',
    'early',
  ]);
});

void test('equal capture times have deterministic order', () => {
  const date = new Date('2026-10-15T00:00:00Z');
  assert.deepEqual(
    captureOrder([
      { id: 'b', data: { captured_at: date } },
      { id: 'a', data: { captured_at: date } },
    ]).map((item) => item.id),
    ['a', 'b'],
  );
});

void test('newest-first picker order spans dates and preserves the existing tie order', () => {
  const items = [
    ...media,
    { id: 'tomorrow', data: { captured_at: new Date('2026-10-16T01:00:00Z') } },
    { id: 'tie-b', data: { captured_at: new Date('2026-10-15T08:00:00Z') } },
    {
      id: 'tie-a',
      data: { captured_at: new Date('2026-10-15T17:00:00+09:00') },
    },
  ];
  const original = [...items];
  const ordered = captureOrder(items, 'desc');
  assert.deepEqual(
    ordered.map((item) => item.id),
    ['tomorrow', 'late', 'middle', 'tie-a', 'tie-b', 'early'],
  );
  assert.deepEqual(items, original);
  assert.deepEqual(captureOrder([], 'desc'), []);
  assert.deepEqual(captureOrder(items.slice(0, 1), 'desc'), items.slice(0, 1));
  let selected: string[] = [];
  for (const item of ordered)
    selected = selectGalleryItem(selected, item.id, items, false);
  assert.deepEqual(
    selected,
    captureOrder(items).map((item) => item.id),
  );
  assert.deepEqual(
    selectGalleryItem(['late', 'early'], 'tie-b', ordered, true),
    ['late', 'early', 'tie-b'],
  );
});

void test('picker sorting includes every owner media page before filtering and ordering', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `item-${String(index).padStart(3, '0')}`,
    status: 'published',
    version: 1,
    updatedAt: '2026-10-18T00:00:00Z',
    data: {
      captured_at: new Date(Date.UTC(2026, 9, 15, 0, index)).toISOString(),
    },
  }));
  const secondPage = [
    {
      ...firstPage[0],
      id: 'latest',
      data: { captured_at: '2026-10-17T00:00:00Z' },
    },
    {
      ...firstPage[0],
      id: 'oldest',
      data: { captured_at: '2026-10-13T00:00:00Z' },
    },
    { ...firstPage[0], id: 'draft', status: 'draft', data: {} },
  ];
  const reads: string[] = [];
  const items = await ownerMediaItems({
    handleContentList(collection, params) {
      assert.equal(collection, 'media_items');
      assert.equal(params.limit, 100);
      assert.equal(params.orderBy, 'createdAt');
      assert.equal(params.order, 'desc');
      reads.push(params.cursor || 'first');
      return Promise.resolve({
        success: true,
        data: params.cursor
          ? { items: secondPage }
          : { items: firstPage, nextCursor: 'second' },
      });
    },
    handleContentGet() {
      throw new Error('No staged revisions in this synthetic fixture');
    },
  });
  const published = items
    .filter((item) => item.status === 'published')
    .map((item) =>
      z
        .object({
          id: z.string(),
          data: z.object({ captured_at: z.coerce.date() }),
        })
        .parse(item),
    );
  assert.deepEqual(reads, ['first', 'second']);
  assert.deepEqual(
    captureOrder(published, 'desc').map((item) => item.id),
    ['latest', ...firstPage.map((item) => item.id).reverse(), 'oldest'],
  );
  assert.equal(items.length, 103);
});
