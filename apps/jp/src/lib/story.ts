import { z } from 'zod';
import { daySchema } from './model';
import { numberedTripTitle } from './trip-days';
export const storySchema = z.object({
  day: daySchema,
  title: z.string(),
  counter: z.enum(['today', 'total', 'hidden']),
  perspective: z.enum(['angled', 'straight']).default('angled'),
  beers: z.object({ today: z.number(), total: z.number() }),
  media: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['photo', 'video']),
        url: z.string(),
        poster: z.string(),
        duration: z.number().nullish(),
      }),
    )
    .min(1)
    .max(15),
});
export type Story = z.infer<typeof storySchema>;
export function storyTitle(day: string, firstDay: string, place: string) {
  return numberedTripTitle(day, firstDay, place.toLowerCase() || 'japan');
}
export function tileCenters(count: number) {
  const steps = Math.max(1, count - 1);
  const spreadX = Math.min(220, (count - 1) * 44);
  const spreadY = Math.min(260, (count - 1) * 52);
  return Array.from({ length: count }, (_, i) => ({
    x: 540 - spreadX / 2 + (i * spreadX) / steps,
    y: 850 - spreadY / 2 + (i * spreadY) / steps,
  }));
}
export function storyTileSize(
  width: number,
  height: number,
  perspective: Story['perspective'],
) {
  // Include the skew in the height limit to keep cards clear of the text.
  const scale = Math.min(
    620 / width,
    580 / (height + (perspective === 'angled' ? width * 0.23 : 0)),
  );
  return { width: width * scale, height: height * scale };
}
export function drawStory(
  ctx: CanvasRenderingContext2D,
  story: Story,
  images: (CanvasImageSource & { width: number; height: number })[],
  time = 0,
) {
  ctx.fillStyle = '#0647ff';
  ctx.fillRect(0, 0, 1080, 1920);
  ctx.fillStyle = '#fff';
  const count =
    story.counter === 'total' ? story.beers.total : story.beers.today;
  const label = `${String(count)} ${count === 1 ? 'beer' : 'beers'}`;
  const iconAspectRatio = 12 / 11;
  const gap = 20;
  ctx.font = '34px "Geist Mono", monospace';
  const width = Math.max(
    ctx.measureText(story.title).width,
    story.counter === 'hidden'
      ? 0
      : ctx.measureText(label).width + 34 * iconAspectRatio + gap,
  );
  const textSize = Math.min(34, (34 * 900) / Math.max(1, width));
  ctx.font = `${String(textSize)}px "Geist Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(story.title, 540, 350);
  const centers = tileCenters(images.length);
  images.forEach((image, index) => {
    const center = centers[index];
    if (!center) return;
    const { width: tileWidth, height: tileHeight } = storyTileSize(
      image.width,
      image.height,
      story.perspective,
    );
    ctx.save();
    ctx.translate(center.x, center.y + Math.sin(time * 1.5 + index) * 8);
    // Upright panels, drawn from the upper-left back card to the lower-right front.
    if (story.perspective === 'angled') ctx.transform(0.78, -0.23, 0, 1, 0, 0);
    ctx.drawImage(
      image,
      -tileWidth / 2,
      -tileHeight / 2,
      tileWidth,
      tileHeight,
    );
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(-tileWidth / 2, -tileHeight / 2, tileWidth, tileHeight);
    ctx.restore();
  });
  if (story.counter !== 'hidden') {
    ctx.fillStyle = '#fff';
    const iconWidth = textSize * iconAspectRatio;
    const left = (1080 - iconWidth - gap - ctx.measureText(label).width) / 2;
    const mug = [
      '0001111111100000',
      '0011000000110000',
      '0010000000111100',
      '0010101010100100',
      '0010101010100100',
      '0010101010100100',
      '0010101010111100',
      '0010101010100000',
      '0010101010100000',
      '0010000000100000',
      '0001111111000000',
    ];
    const pixelSize = textSize / mug.length;
    mug.forEach((row, y) => {
      row.split('').forEach((bit, x) => {
        if (bit === '1')
          ctx.fillRect(
            left + (x - 2) * pixelSize,
            1395 - textSize / 2 + y * pixelSize,
            pixelSize,
            pixelSize,
          );
      });
    });
    ctx.textAlign = 'left';
    ctx.fillText(label, left + iconWidth + gap, 1395);
  }
}
