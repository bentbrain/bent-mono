import { z } from 'zod';
import { daySchema, tokyoDay } from './model';

type DayRecord = { status: unknown; data: unknown };
type DayPage = { items: DayRecord[]; nextCursor?: string };
type DayReader = (
  collection: 'media_items' | 'posts',
  cursor?: string,
) => Promise<DayPage>;
const recordSchema = z.looseObject({ demo: z.unknown().optional() });
const captureSchema = z.union([z.iso.datetime({ offset: true }), z.date()]);

export async function readTripStartDay(read: DayReader) {
  async function days(collection: 'media_items' | 'posts') {
    const real: string[] = [],
      sample: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await read(collection, cursor);
      for (const item of page.items) {
        if (item.status !== 'published') continue;
        const data = recordSchema.safeParse(item.data);
        if (!data.success) continue;
        const value =
          collection === 'media_items'
            ? captureSchema.safeParse(data.data.captured_at)
            : daySchema.safeParse(data.data.day);
        if (!value.success) continue;
        const day =
          collection === 'media_items'
            ? tokyoDay(new Date(value.data))
            : String(value.data);
        (data.data.demo ? sample : real).push(day);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { real: real.sort()[0], sample: sample.sort()[0] };
  }
  const media = await days('media_items');
  if (media.real) return media.real;
  const posts = await days('posts');
  // Sample-only review sites keep their own timeline without shifting real trips.
  return posts.real || media.sample || posts.sample;
}

export function numberedTripTitle(
  day: string,
  firstDay: string,
  title: string,
) {
  const number =
    Math.round(
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return `day ${String(number)}: ${title.replace(/^day\s+\d+\s*:\s*/i, '')}`;
}

export function correctTripTitle(
  day: string,
  firstDay: string | undefined,
  title: string,
) {
  return isNumberedTripTitle(title)
    ? numberedTripTitle(day, firstDay || day, title)
    : title;
}

export function isNumberedTripTitle(title: string) {
  return /^day\s+\d+\s*:/i.test(title);
}
