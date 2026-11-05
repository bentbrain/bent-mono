import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeMapPlaces, selectMapPlaces } from '../src/lib/map-places';
import { tripMap } from '../src/lib/map';

const projection = tripMap([]).projection;
void test('official English names retain GSI positions and exclude all non-place categories', async () => {
  const data: unknown = JSON.parse(
    await readFile(
      new URL('./fixtures/map-places/16-58211-25806.geojson', import.meta.url),
      'utf8',
    ),
  );
  const places = decodeMapPlaces(data, projection);
  assert.equal(places.length, 1);
  const place = places[0];
  assert.ok(place);
  assert.equal(place.text, 'marunouchi 2');
  const expected = tripMap([]).projectMedia({
    longitude: 139.762633015556,
    latitude: 35.6812544697222,
  });
  assert.ok(expected);
  assert.ok(Math.abs(place.x - expected[0]) < 1e-9);
  assert.ok(Math.abs(place.y - expected[1]) < 1e-9);
  const feature = (
    name: string,
    ftCode: number,
    annoCtg: number,
    coordinates = [139.76, 35.68],
  ) => ({
    type: 'Feature',
    properties: { name, ftCode, annoCtg },
    geometry: { type: 'Point', coordinates },
  });
  const candidates = [
    feature('Tokyo', 100, 110),
    feature('Ginza', 100, 212),
    feature('Kasumigaseki', 100, 210),
    feature('village', 100, 220),
    feature('road', 100, 411),
    feature('station', 2930, 0),
    feature('mountain', 100, 312),
    feature('Tokyo Prefecture', 100, 140),
    feature('東京', 100, 110),
    feature('wrong region', 100, 110, [0, 0]),
  ];
  assert.deepEqual(
    decodeMapPlaces(
      { type: 'FeatureCollection', features: candidates },
      projection,
    ).map((p) => p.text),
    ['tokyo', 'ginza', 'kasumigaseki', 'village'],
  );
  assert.throws(() => decodeMapPlaces({}, projection));
});

void test('place collision winners are independent of viewport edges, input order and duplicate tile features', () => {
  const places = [
    { id: 'a', text: 'city', priority: 0, x: 0, y: 0 },
    { id: 'b', text: 'suburb b', priority: 1, x: 50, y: 0 },
    { id: 'c', text: 'suburb c', priority: 1, x: 100, y: 0 },
    { id: 'd', text: 'suburb d', priority: 1, x: 300, y: 0 },
  ];
  const first = selectMapPlaces(places, [], 1)
    .map((p) => p.id)
    .sort();
  assert.deepEqual(first, ['a', 'd']);
  assert.deepEqual(
    selectMapPlaces([...places].reverse().concat(places), [], 1)
      .map((p) => p.id)
      .sort(),
    first,
  );
  // A camera pan is a shared screen translation. The geographic winners stay
  // fixed, including the chain blocked by a higher-ranked offscreen neighbor.
  const moved = places.map((p) => ({ ...p, x: p.x + 200, y: p.y - 90 }));
  assert.deepEqual(
    selectMapPlaces(moved, [], 1)
      .map((p) => p.id)
      .sort(),
    first,
  );
  assert.deepEqual(
    selectMapPlaces(places, [{ x: 300, y: 0 }], 1).map((p) => p.id),
    ['a'],
  );
  assert.ok(selectMapPlaces(places, [], 10).length > first.length);
});
