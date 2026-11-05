import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  contextTiles,
  contextTileUrl,
  decodeMapDetail,
} from '../src/lib/map-context';
import { tripMap } from '../src/lib/map';

const station = { latitude: 35.681236, longitude: 139.767125 };
void test('vector tile coordinates align with media at all supported zooms and stay within the Japan display region', () => {
  const map = tripMap([station]);
  const point = map.projectMedia(station);
  assert.ok(point);
  for (const zoom of [0.25, 0.75, 3, 12, 96, 768, 3072, 4096]) {
    const camera = { x: point[0], y: point[1], zoom };
    const tiles = contextTiles(
      camera,
      { width: 1280, height: 440 },
      map.projection,
    );
    assert.ok(tiles.length > 0 && tiles.length <= 32);
    assert.equal(new Set(tiles.map((tile) => tile.key)).size, tiles.length);
    for (const tile of tiles) {
      assert.ok(tile.z >= 4 && tile.z <= 16);
      const west = (tile.x / 2 ** tile.z) * 360 - 180;
      const east = ((tile.x + 1) / 2 ** tile.z) * 360 - 180;
      const north =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / 2 ** tile.z))) *
          180) /
        Math.PI;
      const south =
        (Math.atan(
          Math.sinh(Math.PI * (1 - (2 * (tile.y + 1)) / 2 ** tile.z)),
        ) *
          180) /
        Math.PI;
      assert.ok(west <= 155 && east >= 121 && north >= 19 && south <= 47);
      assert.match(
        contextTileUrl(tile),
        /^https:\/\/cyberjapandata.gsi.go.jp\/xyz\/optimal_bvmap-v1\/\d+\/\d+\/\d+\.pbf$/,
      );
    }
    const tile = tiles.find(
      (tile) =>
        tile.x ===
          Math.floor(((station.longitude + 180) / 360) * 2 ** tile.z) &&
        tile.y ===
          Math.floor(
            ((1 -
              Math.asinh(Math.tan((station.latitude * Math.PI) / 180)) /
                Math.PI) /
              2) *
              2 ** tile.z,
          ),
    );
    assert.ok(
      tile,
      'the projected pin and its geographic tile share a viewport',
    );
  }
  assert.deepEqual(
    contextTiles(
      { x: -1e6, y: -1e6, zoom: 10 },
      { width: 1280, height: 440 },
      map.projection,
    ),
    [],
  );
});

void test('real GSI vectors decode to precise water, streets, rails, buildings and place names', async () => {
  for (const z of [6, 10, 14, 16]) {
    const stationX = Math.floor(((station.longitude + 180) / 360) * 2 ** z);
    const stationY = Math.floor(
      ((1 -
        Math.asinh(Math.tan((station.latitude * Math.PI) / 180)) / Math.PI) /
        2) *
        2 ** z,
    );
    // Derive the path from public station coordinates, independent of fixture naming assumptions.
    const bytes = await readFile(
      new URL(
        `./fixtures/map-context/${String(z)}-${String(stationX)}-${String(stationY)}.pbf`,
        import.meta.url,
      ),
    );
    const detail = decodeMapDetail(Uint8Array.from(bytes).buffer);
    const layers = detail.paths.map((path) => path.layer);
    for (const layer of ['RdCL', 'RailCL', 'WA'])
      assert.ok(layers.includes(layer));
    if (z >= 14) assert.ok(layers.includes('BldA'));
    assert.ok(
      detail.paths.every(
        (path) => path.d.startsWith('M') && !/NaN|Infinity/.test(path.d),
      ),
    );
    assert.ok(detail.labels.length > 0);
  }
  assert.deepEqual(decodeMapDetail(new ArrayBuffer(0)), {
    paths: [],
    labels: [],
  });
  assert.throws(() => decodeMapDetail(Uint8Array.from([255, 255, 255]).buffer));
});
