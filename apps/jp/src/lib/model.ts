import { z } from 'zod';

export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.valueOf()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, 'Choose a valid day');
export const metadataSchema = z.object({
  title: z.string().trim().min(1).max(200),
  captured_at: z
    .union([z.iso.datetime({ offset: true }), z.date()])
    .pipe(z.coerce.date()),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  place: z.string().trim().max(100).default(''),
  categories: z.array(z.string().trim().min(1).max(40)).max(20),
});
const fileSchema = z.object({
  id: z.string().trim().min(1),
  url: z.string().optional(),
  src: z.string().optional(),
});
export const mediaSchema = metadataSchema.extend({
  id: z.string(),
  slug: z.string().nullable(),
  kind: z.enum(['photo', 'video']),
  asset: fileSchema.nullish(),
  poster: fileSchema.nullish(),
  source_url: z.string().nullish(),
  poster_url: z.string().nullish(),
  duration: z.number().nullish(),
  demo: z.coerce.boolean().nullish(),
});
export type TripMedia = z.infer<typeof mediaSchema>;
export function captureInputValue(value?: string | null): string {
  if (!value) return '';
  const instant = new Date(value).getTime();
  if (!Number.isFinite(instant)) return '';
  return new Date(instant + 9 * 3600_000).toISOString().slice(0, 23);
}
export function captureTimeFromInput(
  value: string,
  original?: string | null,
): string {
  // datetime-local may omit zero seconds even when the input supports them.
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? `${value}:00`
    : value;
  const captured = z.iso.datetime({ offset: true }).parse(`${local}+09:00`);
  if (original && new Date(original).getTime() === new Date(captured).getTime())
    return original;
  return captured;
}
export function tokyoDay(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    day: 'numeric',
    month: 'short',
  })
    .format(new Date(`${day}T12:00:00+09:00`))
    .toLowerCase();
}
export function mediaUrl(item: TripMedia): string {
  return item.asset?.url || item.asset?.src || item.source_url || '';
}
export function posterUrl(item: TripMedia): string {
  return (
    item.poster?.src || item.poster?.url || item.poster_url || mediaUrl(item)
  );
}
export function galleryIds(value: unknown): string[] {
  const parsed = z.array(z.string()).safeParse(value);
  return parsed.success ? parsed.data : [];
}
