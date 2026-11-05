import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import {
  ownerMediaQuery,
  ownerMediaSchema,
  updateOwnerMedia,
} from '../src/lib/owner-queries';
import { concurrentMap } from '../src/lib/concurrent-map';

void test('accepted mutation results replace metadata and revisions without losing preview URLs or other records', () => {
  const client = new QueryClient();
  const item = ownerMediaSchema.parse({
    id: 'sample',
    status: 'draft',
    _rev: 'old',
    data: {
      title: 'sample photo',
      kind: 'photo',
      place: 'sample Kyoto',
      categories: ['food'],
      captured_at: '2099-10-15T01:23:45.678Z',
      latitude: 0,
      longitude: 139,
      asset: { id: 'sample-asset', url: '/sample/asset.jpg' },
      poster: { id: 'sample-asset', src: '/sample/poster.jpg' },
      source_url: '/sample/photo.jpg',
      poster_url: '/sample/poster.jpg',
    },
  });
  const other = { ...item, id: 'sample-other' };
  client.setQueryData(ownerMediaQuery.queryKey, [item, other]);
  updateOwnerMedia(client, {
    data: {
      _rev: 'new',
      item: {
        ...item,
        status: 'published',
        data: {
          ...item.data,
          place: 'sample Tokyo',
          categories: [],
          asset: { id: 'sample-asset' },
          poster: { id: 'sample-asset' },
        },
      },
    },
  });
  const cached = client.getQueryData(ownerMediaQuery.queryKey);
  assert.ok(cached);
  assert.deepEqual(cached[0], {
    ...item,
    status: 'published',
    _rev: 'new',
    data: { ...item.data, place: 'sample Tokyo', categories: [] },
  });
  assert.equal(cached[1], other);
  client.clear();
});

void test('a five-photo batch starts four independent requests before any response and retains result order', async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = concurrentMap([1, 2, 3, 4, 5], 4, async (value) => {
    started++;
    active++;
    peak = Math.max(active, peak);
    await gate;
    active--;
    return value;
  });
  assert.equal(started, 4);
  release();
  assert.deepEqual(await pending, [1, 2, 3, 4, 5]);
  assert.equal(peak, 4);
});
