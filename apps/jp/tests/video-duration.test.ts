import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isShortVideoDuration } from '../src/lib/video-duration';

void test('frame-timed ten-second captures share a finite positive 200ms tolerance', () => {
  for (const duration of [0.01, 10, 305 / 30, 10.2])
    assert.equal(isShortVideoDuration(duration), true);
  for (const duration of [
    0,
    -1,
    10.200001,
    11,
    NaN,
    Infinity,
    -Infinity,
    '10',
    null,
    undefined,
  ])
    assert.equal(isShortVideoDuration(duration), false);
});
