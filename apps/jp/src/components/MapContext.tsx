import { useEffect, useMemo, useRef, useState } from 'react';
import {
  contextTiles,
  contextTileUrl,
  decodeMapDetail,
  type MapDetail,
  type MapProjection,
} from '../lib/map-context';
import type { MapCamera, MapSize } from '../lib/map-view';

const layerStyles = new Map([
  ['AdmArea', 'fill-background stroke-none dark:fill-muted'],
  ['WA', 'fill-foreground/10 stroke-none dark:fill-foreground/15'],
  ['TpgphArea', 'fill-foreground/5 stroke-none'],
  ['Cstline', 'fill-none stroke-foreground/35 [stroke-width:0.8]'],
  ['RvrCL', 'fill-none stroke-foreground/20 [stroke-width:1]'],
  [
    'AdmBdry',
    'fill-none stroke-foreground/15 [stroke-width:0.7] [stroke-dasharray:3_4]',
  ],
  [
    'BldA',
    'fill-foreground/5 stroke-foreground/20 [stroke-width:0.6] dark:fill-foreground/10',
  ],
  ['RdCL', 'fill-none stroke-foreground/20 [stroke-width:1]'],
  [
    'RailCL',
    'fill-none stroke-foreground/45 [stroke-width:1] [stroke-dasharray:3_2]',
  ],
]);

export function MapContext({
  camera,
  size,
  projection,
  onUnavailable,
  revision,
}: {
  camera: MapCamera;
  size: MapSize;
  projection: MapProjection;
  onUnavailable: (unavailable: boolean) => void;
  revision: number;
}) {
  const cache = useRef(new Map<string, MapDetail>());
  const [details, setDetails] = useState(new Map<string, MapDetail>());
  const tiles = contextTiles(camera, size, projection);
  const key = tiles.map((tile) => tile.key).join(',');
  // Stable input while panning within a tile avoids aborting an in-flight fetch.
  const wanted = useMemo(() => key.split(',').filter(Boolean), [key]);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => {
      setDetails(
        new Map(
          wanted.flatMap((key) => {
            const detail = cache.current.get(key);
            return detail ? [[key, detail]] : [];
          }),
        ),
      );
    };
    update();
    let failures = 0;
    const timer = setTimeout(() => {
      void Promise.all(
        wanted.map(async (key) => {
          if (cache.current.has(key)) return;
          try {
            const response = await fetch(contextTileUrl({ key }), {
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(8000),
              ]),
              credentials: 'omit',
              referrerPolicy: 'no-referrer',
            });
            let detail: MapDetail;
            if (response.status === 404) {
              detail = { paths: [], labels: [] };
            } else {
              if (!response.ok) throw new Error('Map detail unavailable');
              const data = await response.arrayBuffer();
              if (data.byteLength > 2_000_000)
                throw new Error('Map detail too large');
              if (controller.signal.aborted) return;
              detail = decodeMapDetail(data);
            }
            if (controller.signal.aborted) return;
            cache.current.set(key, detail);
            // Evict on every insertion. A delayed sibling request may keep the
            // batch unfinished until a later viewport cancels it.
            for (const cachedKey of cache.current.keys()) {
              if (cache.current.size <= 64) break;
              if (!wanted.includes(cachedKey)) cache.current.delete(cachedKey);
            }
            update();
          } catch {
            if (!controller.signal.aborted) failures++;
          }
        }),
      ).then(() => {
        if (controller.signal.aborted) return;
        onUnavailable(failures > 0);
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wanted, onUnavailable, revision]);

  const rendered = tiles.map((tile) => {
    const detail = details.get(tile.key);
    if (!detail || !detail.paths.length) return null;
    const tileSize = (projection.worldSize / 2 ** tile.z) * camera.zoom;
    const x =
      (projection.x +
        (tile.x * projection.worldSize) / 2 ** tile.z -
        camera.x) *
        camera.zoom +
      size.width / 2;
    const y =
      (projection.y +
        (tile.y * projection.worldSize) / 2 ** tile.z -
        camera.y) *
        camera.zoom +
      size.height / 2;
    return (
      <svg
        key={tile.key}
        data-map-vector-tile={tile.key}
        x={x}
        y={y}
        width={tileSize}
        height={tileSize}
        viewBox="0 0 4096 4096"
        overflow="hidden"
      >
        {detail.paths
          .filter(
            (path) =>
              !(tile.z < 9 && path.layer === 'RdCL') &&
              !(tile.z < 7 && path.layer === 'RailCL'),
          )
          .map((path) => (
            <path
              key={path.layer}
              data-map-layer={path.layer}
              d={path.d}
              className={layerStyles.get(path.layer)}
              vectorEffect="non-scaling-stroke"
              fillRule="evenodd"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
      </svg>
    );
  });
  return (
    <g data-map-detail className="pointer-events-none" aria-hidden="true">
      {/* Empty ocean tiles share the same background as tiles with geometry.
          Keep the local outline visible until the whole viewport is available. */}
      {tiles.length > 0 &&
        tiles.every((tile) => details.has(tile.key)) &&
        tiles.some((tile) => details.get(tile.key)?.paths.length) && (
          <rect
            data-map-detail-background
            width={size.width}
            height={size.height}
            className="fill-background"
          />
        )}
      {rendered}
    </g>
  );
}
