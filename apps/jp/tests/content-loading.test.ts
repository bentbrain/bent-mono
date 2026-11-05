import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tripStartDayFromContent } from '../src/lib/content';

void test('owner day titles read paginated metadata without resolving assets and match public media validity', async () => {
  const read: string[] = [];
  const data = {
    title: 'sample photo',
    kind: 'photo',
    captured_at: '2099-10-15T01:23:45.678Z',
    latitude: 0,
    longitude: 139,
    categories: [],
    demo: false,
    asset: { id: 'sample-unresolved-asset' },
  };
  const day = await tripStartDayFromContent({
    handleContentList(collection, params) {
      read.push(`${collection}:${params.cursor || ''}`);
      assert.equal(params.status, 'published');
      return Promise.resolve({
        success: true,
        data: params.cursor
          ? {
              items: [{ status: 'published', data }],
            }
          : {
              items: [
                {
                  status: 'published',
                  data: {
                    ...data,
                    captured_at: '2099-10-01T00:00:00Z',
                    latitude: 91,
                  },
                },
                {
                  status: 'draft',
                  data: { ...data, captured_at: '2099-10-02T00:00:00Z' },
                },
                {
                  status: 'published',
                  data: {
                    ...data,
                    captured_at: '2099-10-03T00:00:00Z',
                    demo: true,
                  },
                },
              ],
              nextCursor: 'sample-next',
            },
      });
    },
  });
  assert.equal(day, '2099-10-15');
  assert.deepEqual(read, ['media_items:', 'media_items:sample-next']);
});
