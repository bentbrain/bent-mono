import { z } from 'zod';
import type { MapProjection } from './map-context';
import type { MapPoint } from './map-view';

export type MapPlace = MapPoint & {
  id: string;
  text: string;
  priority: number;
};
// GSI's English annotations supply names and WGS84 positions. Never translate
// Japanese annotations or include roads, stations, facilities or terrain.
// https://www.gsi.go.jp/kihonjohochousa/multilingual
const feature = z.object({
  geometry: z.object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  }),
  properties: z.object({
    ftCode: z.number(),
    annoCtg: z.number().optional(),
    name: z.string().trim().min(1).max(48),
  }),
});
export function decodeMapPlaces(
  data: unknown,
  projection: MapProjection,
): MapPlace[] {
  const collection = z
    .object({
      type: z.literal('FeatureCollection'),
      features: z.array(z.unknown()).max(20000),
    })
    .parse(data);
  return collection.features.flatMap((value) => {
    const result = feature.safeParse(value);
    if (!result.success) return [];
    const { properties, geometry } = result.data;
    const city =
      [51301, 1401, 1402, 1403].includes(properties.ftCode) ||
      (properties.ftCode === 100 && properties.annoCtg === 110);
    const suburb =
      properties.ftCode === 100 &&
      [210, 212, 220].includes(properties.annoCtg ?? 0);
    const [longitude, latitude] = geometry.coordinates;
    if (
      (!city && !suburb) ||
      !/^[\p{Script=Latin}\p{M}\d\s.'’()/-]+$/u.test(properties.name) ||
      latitude < 19 ||
      latitude > 47 ||
      longitude < 121 ||
      longitude > 155
    )
      return [];
    const text = properties.name.toLowerCase();
    return [
      {
        id: `${longitude.toFixed(6)},${latitude.toFixed(6)}:${text}`,
        text,
        priority: city ? 0 : 1,
        x: projection.x + ((longitude + 180) / 360) * projection.worldSize,
        y:
          projection.y +
          ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) /
            2) *
            projection.worldSize,
      },
    ];
  });
}

export function selectMapPlaces(
  places: MapPlace[],
  pins: MapPoint[],
  zoom: number,
) {
  const unique = [
    ...new Map(places.map((place) => [place.id, place])).values(),
  ];
  // Every candidate competes against geographically nearby higher-ranked names,
  // even if that name is outside the viewport or is itself suppressed. Unlike
  // viewport-first greedy placement, removing an edge label cannot cause a chain
  // of unrelated replacements. Panning is absent from this calculation.
  return unique.filter(
    (place) =>
      !pins.some(
        (pin) =>
          (place.x - pin.x) * zoom > -24 - place.text.length * 3.5 &&
          (place.x - pin.x) * zoom < 186 + place.text.length * 3.5 &&
          Math.abs((place.y - pin.y) * zoom) < 36,
      ) &&
      !unique.some(
        (other) =>
          other.id !== place.id &&
          (other.priority < place.priority ||
            (other.priority === place.priority && other.id < place.id)) &&
          Math.abs((other.x - place.x) * zoom) <
            (other.text.length + place.text.length) * 3.5 + 16 &&
          Math.abs((other.y - place.y) * zoom) < 26,
      ),
  );
}
