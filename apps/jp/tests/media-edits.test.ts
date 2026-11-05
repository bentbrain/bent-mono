import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  mediaChangesSchema,
  mediaEditData,
  mediaEditSchema,
} from '../src/lib/media-edits';

void test('edits only opted-in fields and leaves original metadata out of the patch', () => {
  const current = {
    title: 'first',
    place: 'Kyoto',
    captured_at: '2099-10-15T01:23:45.678Z',
    latitude: 0,
    longitude: 139,
    categories: ['food', 'People'],
  };
  assert.deepEqual(mediaEditData(current, { place: '' }), { place: '' });
  assert.deepEqual(mediaEditData(current, { title: 'new title' }), {
    title: 'new title',
  });
  assert.deepEqual(
    mediaEditData(current, {
      categories: { mode: 'add', names: ['FOOD', 'shopping'] },
    }),
    { categories: ['food', 'People', 'shopping'] },
  );
  assert.deepEqual(
    mediaEditData(current, {
      categories: { mode: 'remove', names: ['people'] },
    }),
    { categories: ['food'] },
  );
  assert.deepEqual(
    mediaEditData(current, { categories: { mode: 'replace', names: [] } }),
    { categories: [] },
  );
  assert.deepEqual(mediaEditData({}, { place: 'Tokyo' }), { place: 'Tokyo' });
});

void test('rejects original metadata, status, empty patches and invalid categories', () => {
  for (const changes of [
    {},
    { latitude: 1 },
    { longitude: 1 },
    { captured_at: '2099-01-01T00:00:00Z' },
    { asset: {} },
    { title: '' },
    { categories: { mode: 'add', names: ['bad\u0000'] } },
  ])
    assert.equal(mediaChangesSchema.safeParse(changes).success, false);
  assert.equal(
    mediaEditSchema.safeParse({
      id: 'sample',
      revision: 'rev',
      changes: { place: 'Tokyo' },
      publish: true,
    }).success,
    false,
  );
  assert.throws(() =>
    mediaEditData(
      {
        categories: Array.from({ length: 20 }, (_, i) => `sample ${String(i)}`),
      },
      { categories: { mode: 'add', names: ['extra'] } },
    ),
  );
});
