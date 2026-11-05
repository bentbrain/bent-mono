import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { MapCamera, MapSize } from './map-view';

export type MapProjection = { worldSize: number; x: number; y: number };
export type ContextTile = { z: number; x: number; y: number; key: string };
export type MapDetail = {
  paths: { layer: string; d: string }[];
  labels: { x: number; y: number; text: string; priority: number }[];
};

// GSI vector tiles have a 512px display size and zooms 4–16. The camera and
// these tiles share Web Mercator; no approximate geographic alignment is used.
// https://github.com/gsi-cyberjapan/optimal_bvmap
export function contextTiles(
  camera: MapCamera,
  size: MapSize,
  projection: MapProjection,
): ContextTile[] {
  const world = projection.worldSize;
  if (!(world > 0 && camera.zoom > 0)) return [];
  const z = Math.max(
    4,
    Math.min(16, Math.floor(Math.log2((world * camera.zoom) / 512))),
  );
  const count = 2 ** z;
  const span = world / count;
  const west = (121 + 180) / 360;
  const east = (155 + 180) / 360;
  const north = (1 - Math.asinh(Math.tan((47 * Math.PI) / 180)) / Math.PI) / 2;
  const south = (1 - Math.asinh(Math.tan((19 * Math.PI) / 180)) / Math.PI) / 2;
  const minX = Math.max(
    Math.floor(west * count),
    Math.floor((camera.x - size.width / camera.zoom / 2 - projection.x) / span),
  );
  const maxX = Math.min(
    Math.floor(east * count),
    Math.floor((camera.x + size.width / camera.zoom / 2 - projection.x) / span),
  );
  const minY = Math.max(
    Math.floor(north * count),
    Math.floor(
      (camera.y - size.height / camera.zoom / 2 - projection.y) / span,
    ),
  );
  const maxY = Math.min(
    Math.floor(south * count),
    Math.floor(
      (camera.y + size.height / camera.zoom / 2 - projection.y) / span,
    ),
  );
  const tiles: ContextTile[] = [];
  if ((maxX - minX + 1) * (maxY - minY + 1) > 32) return tiles;
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      tiles.push({ z, x, y, key: `${String(z)}/${String(x)}/${String(y)}` });
  // Viewport work is bounded even if a malformed camera reaches this boundary.
  return tiles;
}

export function contextTileUrl(tile: Pick<ContextTile, 'key'>) {
  return `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${tile.key}.pbf`;
}

export function decodeMapDetail(bytes: ArrayBuffer): MapDetail {
  const tile = new VectorTile(new PbfReader(bytes));
  const paths: MapDetail['paths'] = [];
  // Painter order: land, water, terrain, boundaries, buildings, streets, rails.
  for (const name of [
    'AdmArea',
    'WA',
    'TpgphArea',
    'Cstline',
    'RvrCL',
    'AdmBdry',
    'BldA',
    'RdCL',
    'RailCL',
  ]) {
    const layer = tile.layers[name];
    if (!layer) continue;
    const commands: string[] = [];
    for (let index = 0; index < layer.length; index++) {
      const feature = layer.feature(index);
      // Road widths/markings and contour detail make a dense transport overlay.
      // Use a single restrained centreline per road, with local streets at z14+.
      if (
        name === 'RdCL' &&
        (feature.properties.vt_rdctg === '高速自動車国道等' ||
          ['建設中', '雪覆い'].includes(String(feature.properties.vt_rdstate)))
      )
        continue;
      if (
        name === 'RailCL' &&
        ['地下', 'トンネル'].includes(String(feature.properties.vt_railstate))
      )
        continue;
      if (feature.type !== 2 && feature.type !== 3) continue;
      const scale = 4096 / feature.extent;
      for (const ring of feature.loadGeometry()) {
        commands.push(
          ring
            .map(
              (point, position) =>
                `${position ? 'L' : 'M'}${(point.x * scale).toFixed(1)},${(point.y * scale).toFixed(1)}`,
            )
            .join(''),
        );
        if (feature.type === 3) commands.push('Z');
      }
    }
    if (commands.length) paths.push({ layer: name, d: commands.join('') });
  }
  const labels: MapDetail['labels'] = [];
  const annotations = tile.layers.Anno;
  if (annotations)
    for (let index = 0; index < annotations.length; index++) {
      const feature = annotations.feature(index);
      const text = feature.properties.vt_text;
      const code = Number(feature.properties.vt_code);
      // Towns, districts, geographic names and stations, rather than highway shields.
      if (
        typeof text !== 'string' ||
        !text ||
        text.length > 28 ||
        !(
          code === 422 ||
          (code >= 100 && code < 400) ||
          (code >= 1300 && code < 1500)
        )
      )
        continue;
      const point = feature.loadGeometry()[0]?.[0];
      if (point)
        labels.push({
          x: (point.x / feature.extent) * 4096,
          y: (point.y / feature.extent) * 4096,
          text,
          priority: code === 422 ? 0 : 1,
        });
    }
  return { paths, labels };
}
