import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  correctTripTitle,
  numberedTripTitle,
  readTripStartDay,
} from '../src/lib/trip-days';

void test('Japan capture dates define the trip across pages; drafts, samples and earlier posts cannot shift it', async () => {
  const queried: string[] = [];
  const first = await readTripStartDay((collection, cursor) => {
    queried.push(collection);
    if (collection === 'posts')
      return Promise.resolve({
        items: [{ status: 'published', data: { day: '2026-10-01' } }],
      });
    return Promise.resolve(
      cursor
        ? {
            items: [
              {
                status: 'published',
                data: { captured_at: '2026-10-14T15:00:00Z' },
              },
              {
                status: 'published',
                data: { captured_at: '2026-10-17T10:00:00+09:00' },
              },
            ],
          }
        : {
            items: [
              {
                status: 'draft',
                data: { captured_at: '2026-10-01T00:00:00Z' },
              },
              {
                status: 'published',
                data: { captured_at: '2026-10-02T00:00:00Z', demo: true },
              },
              { status: 'published', data: { captured_at: 'not a date' } },
            ],
            nextCursor: 'next',
          },
    );
  });
  assert.equal(first, '2026-10-15');
  assert.deepEqual(queried, ['media_items', 'media_items']);
  assert.equal(
    numberedTripTitle('2026-10-15', first, 'arrival'),
    'day 1: arrival',
  );
  assert.equal(numberedTripTitle('2026-10-17', first, 'Tokyo'), 'day 3: Tokyo');
});

void test('no-photo trips use the earliest published post across pages, including already-sent posts', async () => {
  assert.equal(
    await readTripStartDay((collection, cursor) =>
      Promise.resolve(
        collection === 'media_items'
          ? {
              items: [
                {
                  status: 'published',
                  data: { demo: true, captured_at: '2020-01-01T00:00:00Z' },
                },
              ],
            }
          : cursor
            ? {
                items: [
                  { status: 'published', data: { day: '2026-10-15' } },
                  { status: 'published', data: { day: '2026-10-17' } },
                ],
              }
            : {
                items: [
                  {
                    status: 'published',
                    data: { day: '2020-01-01', demo: true },
                  },
                  { status: 'draft', data: { day: '2020-01-02' } },
                ],
                nextCursor: 'next',
              },
      ),
    ),
    '2026-10-15',
  );
});

void test('sample-only review sites retain sample capture numbering and empty trips have no start', async () => {
  assert.equal(
    await readTripStartDay((collection) =>
      Promise.resolve({
        items: [
          {
            status: 'published',
            data:
              collection === 'media_items'
                ? { demo: true, captured_at: '2026-10-14T23:59:00+09:00' }
                : { demo: true, day: '2026-10-01' },
          },
        ],
      }),
    ),
    '2026-10-14',
  );
  assert.equal(
    await readTripStartDay(() => Promise.resolve({ items: [] })),
    undefined,
  );
});

void test('all title formats recalculate stale prefixes without changing the owner title or calendar gaps', () => {
  assert.equal(
    numberedTripTitle('2026-10-15', '2026-10-15', 'day 2: arrival'),
    'day 1: arrival',
  );
  assert.equal(
    correctTripTitle('2026-10-17', '2026-10-15', 'DAY 99: Tokyo Station'),
    'day 3: Tokyo Station',
  );
  assert.equal(
    correctTripTitle('2026-10-15', '2026-10-15', 'arrival'),
    'arrival',
  );
  assert.equal(
    numberedTripTitle('2027-01-01', '2026-12-31', 'Tokyo'),
    'day 2: Tokyo',
  );
});
