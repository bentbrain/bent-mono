import { ContentSaveRejectedError, definePlugin } from 'emdash';
import { daySchema, metadataSchema, mediaSchema } from '../lib/model';
import { z } from 'zod';
import { normalizeCategory } from '../lib/category-icons';
import { shopDesignSchema } from '../lib/shop-design';
import { isShortVideoDuration } from '../lib/video-duration';
import { isPostInlinePhoto } from '../lib/post-inline-media';

const publishableMediaSchema = mediaSchema.omit({ id: true, slug: true });

export function embeddedMediaReferences(
  value: unknown,
  kind?: 'image' | 'video',
): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => embeddedMediaReferences(item, kind));
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) return [];
  const block = parsed.data;
  if (block._type === 'image' || block._type === 'video') {
    if (kind && block._type !== kind) return [];
    const asset = z.object({ _ref: z.string().min(1) }).safeParse(block.asset);
    return [asset.success ? asset.data._ref : ''];
  }
  return Object.values(block).flatMap((item) =>
    embeddedMediaReferences(item, kind),
  );
}

export function validateMedia(
  content: Record<string, unknown>,
): string | undefined {
  const data = metadataSchema.safeParse(content);
  if (!data.success)
    return 'Add capture time and valid coordinates before publishing.';
  if (!publishableMediaSchema.safeParse(content).success)
    return 'Choose photo or video and complete the media details before publishing.';
  if (content.kind === 'video' && !isShortVideoDuration(content.duration))
    return 'Videos must be 10 seconds or shorter.';
  if (
    content.demo !== true &&
    content.demo !== 1 &&
    (!content.asset || typeof content.asset !== 'object')
  )
    return 'Upload a media file before publishing.';
}
export function createPlugin() {
  return definePlugin({
    id: 'japan-trip',
    version: '1.0.0',
    capabilities: [
      'content:read',
      'media:read',
      'content:write',
      'hooks.content-policy:register',
    ],
    hooks: {
      'content:beforeSave': (event) => {
        if (
          event.collection === 'categories' &&
          (typeof event.content.title !== 'string' ||
            !normalizeCategory(event.content.title))
        )
          throw new ContentSaveRejectedError(
            'Choose a category of 1 to 40 characters.',
          );
        if (
          event.collection === 'media_items' &&
          event.content.categories !== undefined
        ) {
          const names = z
            .array(
              z.string().refine((name) => Boolean(normalizeCategory(name))),
            )
            .max(20)
            .safeParse(event.content.categories);
          if (!names.success)
            throw new ContentSaveRejectedError(
              'Choose up to 20 categories, each 1 to 40 characters.',
            );
        }
        if (
          event.collection === 'posts' &&
          !shopDesignSchema.nullish().safeParse(event.content.shop_design)
            .success
        )
          throw new ContentSaveRejectedError(
            'Choose a shop.bent.build product and black or white.',
          );
        if (
          event.collection === 'posts' &&
          !daySchema.safeParse(event.content.day).success
        )
          throw new ContentSaveRejectedError('Choose a valid post day.');
        if (
          event.collection === 'beers' &&
          (!daySchema.safeParse(event.content.day).success ||
            !z.number().int().min(0).max(100).safeParse(event.content.count)
              .success)
        )
          throw new ContentSaveRejectedError(
            'Choose a day and a beer count between 0 and 100.',
          );
        return Promise.resolve();
      },
      'content:beforePublish': async (event, ctx) => {
        if (['categories', 'category_icons'].includes(event.collection))
          return {
            cancel: true,
            reason: 'Categories and the icon library stay in owner tools.',
          };
        const content = z
          .record(z.string(), z.unknown())
          .parse(event.content.data);
        if (event.collection === 'media_items') {
          const reason = validateMedia(content);
          if (reason) return { cancel: true, reason };
        }
        if (event.collection === 'posts') {
          if (
            !shopDesignSchema.nullish().safeParse(content.shop_design).success
          )
            return {
              cancel: true,
              reason: 'Choose a shop.bent.build product and black or white.',
            };
          const gallery = z.array(z.string()).safeParse(content.gallery ?? []);
          if (!gallery.success)
            return {
              cancel: true,
              reason: 'Choose media from the trip library.',
            };
          for (const id of gallery.data) {
            const item = await ctx.content?.get('media_items', id);
            if (
              !item ||
              item.status !== 'published' ||
              validateMedia(item.data)
            )
              return {
                cancel: true,
                reason:
                  'Publish every selected media item with its location first.',
              };
          }
          const embedded = embeddedMediaReferences(content.content);
          if (embedded.length) {
            const located = new Set<string>();
            let cursor: string | undefined;
            do {
              const page = await ctx.content?.list('media_items', {
                limit: 100,
                cursor,
              });
              for (const item of page?.items ?? []) {
                if (item.status !== 'published' || validateMedia(item.data))
                  continue;
                const asset = z
                  .object({ id: z.string() })
                  .safeParse(item.data.asset);
                if (asset.success) located.add(asset.data.id);
              }
              cursor = page?.hasMore ? page.cursor : undefined;
            } while (cursor);
            // Post-only display photos have no trip-library record. Permit only
            // registered assets from the dedicated owner upload path. Videos
            // and trip media still need their published capture metadata.
            const postOnly = new Set<string>();
            for (const id of embeddedMediaReferences(
              content.content,
              'image',
            )) {
              if (!id || located.has(id)) continue;
              const asset = await ctx.media?.get(id);
              if (asset && isPostInlinePhoto(asset)) postOnly.add(id);
            }
            if (
              embedded.some((id) => !located.has(id) && !postOnly.has(id)) ||
              embeddedMediaReferences(content.content, 'video').some(
                (id) => !located.has(id),
              )
            )
              return {
                cancel: true,
                reason:
                  'Upload post-only photos in the editor, or publish trip media with its location first.',
              };
          }
        }
      },
    },
  });
}
