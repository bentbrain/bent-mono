import type { APIRoute } from 'astro';
import { z } from 'zod';
import { daySchema, tokyoDay, mediaUrl, posterUrl } from '../../../lib/model';
import { tripMedia, beerCounts, tripStartDay } from '../../../lib/content';
import { storySchema, storyTitle } from '../../../lib/story';
export const POST: APIRoute = async ({ request }) => {
  const parsed = z
    .object({
      day: daySchema,
      ids: z.array(z.string()).min(1).max(15),
      counter: storySchema.shape.counter,
      perspective: storySchema.shape.perspective,
    })
    .safeParse(await request.json());
  if (!parsed.success)
    return Response.json(
      { error: 'Select up to 15 items from one day' },
      { status: 400 },
    );
  const { day, ids, counter, perspective } = parsed.data,
    all = await tripMedia(),
    media = ids.flatMap((id) => {
      const item = all.find(
        (m) => m.id === id && tokyoDay(m.captured_at) === day,
      );
      return item ? [item] : [];
    });
  if (media.length !== ids.length || new Set(ids).size !== ids.length)
    return Response.json(
      { error: 'Selected media is unavailable for this day' },
      { status: 400 },
    );
  return Response.json({
    day,
    title: storyTitle(
      day,
      (await tripStartDay(all)) || day,
      media[0]?.place || '',
    ),
    counter,
    perspective,
    beers: await beerCounts(day),
    media: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      url: mediaUrl(m),
      poster: posterUrl(m),
      duration: m.duration,
    })),
  });
};
