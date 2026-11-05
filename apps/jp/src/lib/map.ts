import { geoMercator, geoPath } from 'd3-geo';
import { z } from 'zod';
import japan from './japan.json';
import type { TripMedia } from './model';

const geometry = z
  .object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(z.array(z.array(z.number())))),
  })
  .parse(japan.geometry);

// Geographic reference labels, separate from the owner's media locations.
const referencePlaces = [
  {
    name: 'hokkaido',
    latitude: 44,
    longitude: 143,
    kind: 'island',
    minZoom: 0,
  },
  {
    name: 'honshu',
    latitude: 37.2,
    longitude: 137.5,
    kind: 'island',
    minZoom: 0,
  },
  {
    name: 'shikoku',
    latitude: 33.7,
    longitude: 133.3,
    kind: 'island',
    minZoom: 2,
  },
  {
    name: 'kyushu',
    latitude: 32.4,
    longitude: 130.7,
    kind: 'island',
    minZoom: 0,
  },
  {
    name: 'okinawa',
    latitude: 26.5,
    longitude: 128,
    kind: 'island',
    minZoom: 0,
  },
  {
    name: 'tokyo',
    latitude: 35.68,
    longitude: 139.69,
    kind: 'city',
    minZoom: 0.8,
  },
  {
    name: 'sapporo',
    latitude: 43.06,
    longitude: 141.35,
    kind: 'city',
    minZoom: 2,
  },
  {
    name: 'sendai',
    latitude: 38.27,
    longitude: 140.87,
    kind: 'city',
    minZoom: 2,
  },
  {
    name: 'nagoya',
    latitude: 35.18,
    longitude: 136.91,
    kind: 'city',
    minZoom: 3,
  },
  {
    name: 'kyoto',
    latitude: 35.01,
    longitude: 135.77,
    kind: 'city',
    minZoom: 5,
  },
  {
    name: 'osaka',
    latitude: 34.69,
    longitude: 135.5,
    kind: 'city',
    minZoom: 2,
  },
  {
    name: 'hiroshima',
    latitude: 34.39,
    longitude: 132.46,
    kind: 'city',
    minZoom: 3,
  },
  {
    name: 'fukuoka',
    latitude: 33.59,
    longitude: 130.4,
    kind: 'city',
    minZoom: 3,
  },
  {
    name: 'naha',
    latitude: 26.21,
    longitude: 127.68,
    kind: 'city',
    minZoom: 3,
  },
];

export type MapReference = {
  name: string;
  x: number;
  y: number;
  kind: string;
  minZoom: number;
};

type Location = Pick<TripMedia, 'latitude' | 'longitude'>;

// A nearby buffer around Japan, including Okinawa, Ogasawara,
// Okinotorishima and Minamitorishima. This is a display region, not a border.
export function isJapanMapLocation({ latitude, longitude }: Location) {
  return (
    latitude >= 19 && latitude <= 47 && longitude >= 121 && longitude <= 155
  );
}

export function tripMap(media: Location[]) {
  const mapMedia = media.filter(isJapanMapLocation);
  const projection = geoMercator().fitExtent(
    [
      [105, 20],
      [650, 420],
    ],
    {
      type: 'GeometryCollection',
      geometries: [
        geometry,
        {
          type: 'MultiPoint',
          coordinates: mapMedia.map((item) => [item.longitude, item.latitude]),
        },
      ],
    },
  );
  return {
    projection: {
      worldSize: projection.scale() * 2 * Math.PI,
      x: projection.translate()[0] - projection.scale() * Math.PI,
      y: projection.translate()[1] - projection.scale() * Math.PI,
    },
    projectMedia: (item: Location) =>
      isJapanMapLocation(item)
        ? projection([item.longitude, item.latitude])
        : null,
    land: geoPath(projection)(geometry) || '',
    references: referencePlaces.flatMap((place) => {
      const point = projection([place.longitude, place.latitude]);
      if (!point) return [];
      return [
        {
          name: place.name,
          x: point[0],
          y: point[1],
          kind: place.kind,
          minZoom: place.minZoom,
        },
      ];
    }),
  };
}
