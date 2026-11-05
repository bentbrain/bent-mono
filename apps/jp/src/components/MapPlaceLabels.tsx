import { useEffect, useMemo, useRef, useState } from 'react';
import { contextTiles, type MapProjection } from '../lib/map-context';
import {
  decodeMapPlaces,
  selectMapPlaces,
  type MapPlace,
} from '../lib/map-places';
import type { MapCamera, MapPoint, MapSize } from '../lib/map-view';

export function MapPlaceLabels({
  camera,
  size,
  projection,
  pins,
  revision,
  onUnavailable,
}: {
  camera: MapCamera;
  size: MapSize;
  projection: MapProjection;
  pins: MapPoint[];
  revision: number;
  onUnavailable: (unavailable: boolean) => void;
}) {
  const cache = useRef(new Map<string, MapPlace[]>());
  const [places, setPlaces] = useState<MapPlace[]>([]);
  // Fetch a geographic margin wider than the longest label's collision box.
  // Places at the viewport edge keep the same competitors while panning.
  const tiles = contextTiles(
    camera,
    { width: size.width + 1024, height: size.height + 1024 },
    projection,
  ).filter((tile) => tile.z >= 5);
  const key = tiles.map((tile) => tile.key).join(',');
  const wanted = useMemo(() => key.split(',').filter(Boolean), [key]);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => {
      setPlaces(wanted.flatMap((key) => cache.current.get(key) ?? []));
    };
    update();
    const timer = setTimeout(() => {
      void Promise.all(
        wanted.map(async (key) => {
          if (cache.current.has(key)) return true;
          try {
            const response = await fetch(
              `https://maps.gsi.go.jp/xyz/experimental_multil/${key}.geojson`,
              {
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(8000),
                ]),
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
              },
            );
            if (!response.ok && response.status !== 404)
              throw new Error('Place names unavailable');
            const text = response.status === 404 ? '' : await response.text();
            if (text.length > 2_000_000)
              throw new Error('Place names too large');
            const decoded = text
              ? decodeMapPlaces(JSON.parse(text), projection)
              : [];
            if (controller.signal.aborted) return false;
            cache.current.set(key, decoded);
            for (const cached of cache.current.keys()) {
              if (cache.current.size <= 64) break;
              if (!wanted.includes(cached)) cache.current.delete(cached);
            }
            return true;
          } catch {
            return false;
          }
        }),
      ).then((results) => {
        if (!controller.signal.aborted) {
          update();
          onUnavailable(results.some((ok) => !ok));
        }
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wanted, projection, revision, onUnavailable]);
  const visible = useMemo(
    () => selectMapPlaces(places, pins, camera.zoom),
    [places, pins, camera.zoom],
  );
  return (
    <g data-map-place-labels className="pointer-events-none" aria-hidden="true">
      {visible.map((place) => {
        const x = (place.x - camera.x) * camera.zoom + size.width / 2;
        const y = (place.y - camera.y) * camera.zoom + size.height / 2;
        if (x < -180 || x > size.width + 180 || y < -20 || y > size.height + 20)
          return null;
        return (
          <text
            key={place.id}
            data-map-place={place.id}
            x={x}
            y={y}
            textAnchor="middle"
            className="fill-foreground stroke-background font-mono text-[11px] [paint-order:stroke] [stroke-width:3]"
          >
            {place.text}
          </text>
        );
      })}
    </g>
  );
}
