import exifr from 'exifr';
import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';
import { z } from 'zod';

export function iso6709(
  value: string,
): { latitude: number; longitude: number } | undefined {
  const match = /^([+-]\d{2}(?:\.\d+)?)([+-]\d{3}(?:\.\d+)?)/.exec(value);
  if (!match) return;
  const latitude = Number(match[1]),
    longitude = Number(match[2]);
  if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)
    return { latitude, longitude };
}
export async function extractMetadata(file: Blob, video: boolean) {
  if (video) {
    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });
    try {
      const duration = await input.computeDuration();
      const tags = await input.getMetadataTags();
      const location = tags.raw?.['com.apple.quicktime.location.ISO6709'];
      const creation = tags.raw?.['com.apple.quicktime.creationdate'];
      const captured =
        typeof creation === 'string' ? new Date(creation) : tags.date;
      return {
        duration,
        ...(typeof location === 'string' ? iso6709(location) : {}),
        captured_at:
          captured && Number.isFinite(captured.valueOf())
            ? captured.toISOString()
            : undefined,
      };
    } finally {
      input.dispose();
    }
  }
  const value: unknown = await exifr
    .parse(await file.arrayBuffer(), {
      pick: [
        'GPSLatitude',
        'GPSLatitudeRef',
        'GPSLongitude',
        'GPSLongitudeRef',
        'DateTimeOriginal',
        'OffsetTimeOriginal',
      ],
      reviveValues: false,
    })
    .catch(() => null);
  const tags = z
    .object({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      DateTimeOriginal: z.string().optional(),
      OffsetTimeOriginal: z.string().optional(),
    })
    .safeParse(value);
  if (!tags.success) return {};
  const raw = tags.data.DateTimeOriginal?.replace(
    /^(\d{4}):(\d{2}):(\d{2}) /,
    '$1-$2-$3T',
  );
  const captured = raw
    ? new Date(`${raw}${tags.data.OffsetTimeOriginal || '+09:00'}`)
    : undefined;
  return {
    latitude: tags.data.latitude,
    longitude: tags.data.longitude,
    captured_at:
      captured && Number.isFinite(captured.valueOf())
        ? captured.toISOString()
        : undefined,
  };
}
