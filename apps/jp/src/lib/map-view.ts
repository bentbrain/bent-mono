export type MapPoint = { x: number; y: number };
export type MapCamera = MapPoint & { zoom: number };
export type MapSize = { width: number; height: number };
export const MIN_MAP_ZOOM = 0.25;
export const MAX_MAP_ZOOM = 4096;

export function fitMapPoints(points: MapPoint[], size: MapSize): MapCamera {
  const locations = points.length
    ? points
    : [
        { x: 105, y: 20 },
        { x: 650, y: 420 },
      ];
  const minX = Math.min(...locations.map((point) => point.x));
  const maxX = Math.max(...locations.map((point) => point.x));
  const minY = Math.min(...locations.map((point) => point.y));
  const maxY = Math.max(...locations.map((point) => point.y));
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(
      MIN_MAP_ZOOM,
      Math.min(
        3,
        (size.width - 96) / Math.max(1, maxX - minX),
        (size.height - 96) / Math.max(1, maxY - minY),
      ),
    ),
  };
}

// Cluster in screen pixels so pins split as the camera moves closer.
export function clusterMapPoints<T extends MapPoint>(
  points: T[],
  zoom: number,
) {
  const groups: { x: number; y: number; items: T[] }[] = [];
  for (const point of points) {
    const group = groups.find(
      (entry) => Math.hypot(entry.x - point.x, entry.y - point.y) * zoom < 44,
    );
    if (group) {
      const count = group.items.length;
      group.x = (group.x * count + point.x) / (count + 1);
      group.y = (group.y * count + point.y) / (count + 1);
      group.items.push(point);
    } else groups.push({ x: point.x, y: point.y, items: [point] });
  }
  return groups;
}

// Keep the map coordinate under the pointer fixed as zoom changes.
export function zoomMapAt(
  camera: MapCamera,
  factor: number,
  anchor: MapPoint = { x: 0, y: 0 },
): MapCamera {
  const zoom = Math.max(
    MIN_MAP_ZOOM,
    Math.min(MAX_MAP_ZOOM, camera.zoom * factor),
  );
  return {
    zoom,
    x: camera.x + anchor.x / camera.zoom - anchor.x / zoom,
    y: camera.y + anchor.y / camera.zoom - anchor.y / zoom,
  };
}
