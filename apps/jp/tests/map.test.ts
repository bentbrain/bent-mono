import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJapanMapLocation, tripMap } from '../src/lib/map';

const japan = [
  { latitude: 35.6895, longitude: 139.6917 }, // Tokyo
  { latitude: 45.52, longitude: 141.93 }, // northern Hokkaido
  { latitude: 26.2124, longitude: 127.6809 }, // Okinawa
  { latitude: 24.45, longitude: 122.93 }, // Yonaguni
  { latitude: 27.09, longitude: 142.19 }, // Ogasawara
  { latitude: 20.425, longitude: 136.07 }, // Okinotorishima
  { latitude: 24.283, longitude: 153.987 }, // Minamitorishima
  { latitude: 34, longitude: 139 }, // nearby offshore
];
const outside = [
  { latitude: -27.47, longitude: 153.02 }, // Brisbane
  { latitude: 5, longitude: 145 }, // airplane south of Japan
  { latitude: 35, longitude: 170 }, // airplane east of Japan
  { latitude: 51.5, longitude: -0.12 },
  { latitude: 0, longitude: -180 },
  { latitude: 0, longitude: 180 },
  { latitude: -90, longitude: 0 },
  { latitude: 90, longitude: 0 },
  { latitude: NaN, longitude: 139 },
  { latitude: 35, longitude: Infinity },
];

void test('map includes Japan, outlying islands and nearby locations', () => {
  const { projectMedia, land } = tripMap(japan);
  assert.ok(land);
  for (const item of japan) {
    assert.equal(isJapanMapLocation(item), true);
    const point = projectMedia(item);
    assert.ok(point);
    const [x, y] = point;
    assert.ok(x >= 104.99 && x <= 650.01);
    assert.ok(y >= 19.99 && y <= 420.01);
  }
});

void test('map region includes its boundaries and rejects points just outside', () => {
  const edges = [
    { latitude: 19, longitude: 121 },
    { latitude: 19, longitude: 155 },
    { latitude: 47, longitude: 121 },
    { latitude: 47, longitude: 155 },
  ];
  const { projectMedia } = tripMap(edges);
  for (const item of edges) {
    assert.equal(isJapanMapLocation(item), true);
    assert.ok(projectMedia(item));
  }
  for (const item of [
    { latitude: 18.999999, longitude: 139 },
    { latitude: 47.000001, longitude: 139 },
    { latitude: 35, longitude: 120.999999 },
    { latitude: 35, longitude: 155.000001 },
  ]) {
    assert.equal(isJapanMapLocation(item), false);
    assert.equal(projectMedia(item), null);
  }
});

void test('outside media neither projects nor changes Japan bounds in a mixed set', () => {
  const media = [...japan, ...outside];
  const original = structuredClone(media);
  const eligible = tripMap(japan);
  const mixed = tripMap(media);
  assert.equal(mixed.land, eligible.land);
  for (const item of japan)
    assert.deepEqual(mixed.projectMedia(item), eligible.projectMedia(item));
  for (const item of outside) {
    assert.equal(isJapanMapLocation(item), false);
    assert.equal(mixed.projectMedia(item), null);
  }
  assert.deepEqual(media, original);
});

void test('empty and outside-only maps retain the Japan overview without invalid paths', () => {
  const empty = tripMap([]);
  assert.ok(empty.land);
  assert.doesNotMatch(empty.land, /NaN|Infinity/);
  assert.equal(tripMap(outside).land, empty.land);
  assert.equal(
    tripMap([{ latitude: 35.6895, longitude: 139.6917 }]).land,
    empty.land,
  );
  for (const item of outside) assert.equal(empty.projectMedia(item), null);
});

void test('geographic reference labels share media projection without changing bounds', () => {
  const map = tripMap([]);
  const tokyo = map.references.find((reference) => reference.name === 'tokyo');
  assert.ok(tokyo);
  assert.deepEqual(
    [tokyo.x, tokyo.y],
    map.projectMedia({ latitude: 35.68, longitude: 139.69 }),
  );
  for (const reference of map.references) {
    assert.ok(Number.isFinite(reference.x) && Number.isFinite(reference.y));
  }
});
