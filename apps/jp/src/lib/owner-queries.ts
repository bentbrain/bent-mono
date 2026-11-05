import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from './api-client';
import { categoryCollectionSchema } from './category-collection-model';

export const ownerMediaSchema = z.object({
  id: z.string(),
  status: z.string(),
  _rev: z.string(),
  data: z.object({
    title: z.string(),
    kind: z.enum(['photo', 'video']).nullish(),
    captured_at: z.string().nullish(),
    latitude: z.number().nullish(),
    longitude: z.number().nullish(),
    place: z.string().nullish(),
    categories: z.array(z.string()).nullish(),
    poster: z
      .object({ id: z.string().optional(), src: z.string().optional() })
      .nullish(),
    asset: z
      .object({ id: z.string().optional(), url: z.string().optional() })
      .nullish(),
    poster_url: z.string().nullish(),
    source_url: z.string().nullish(),
  }),
});
export type OwnerMediaItem = z.infer<typeof ownerMediaSchema>;
export const ownerMediaQuery = queryOptions({
  queryKey: ['owner', 'media'],
  queryFn: async ({ signal }) =>
    z
      .object({ items: z.array(ownerMediaSchema) })
      .parse(await api('/api/trip/media', undefined, 'GET', signal)).items,
});
export const ownerCategoriesQuery = queryOptions({
  queryKey: ['owner', 'categories'],
  queryFn: async ({ signal }) =>
    categoryCollectionSchema.parse(
      await api('/api/trip/categories', undefined, 'GET', signal),
    ),
});
const savedMediaSchema = z.object({
  data: z.object({
    _rev: z.string(),
    item: z.object({
      id: z.string(),
      status: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  }),
});

// Mutation responses contain raw media references. Keep resolved preview URLs
// from the query while replacing metadata with the server's accepted values.
export function updateOwnerMedia(client: QueryClient, response: unknown) {
  const saved = savedMediaSchema.parse(response).data;
  client.setQueryData(ownerMediaQuery.queryKey, (items) =>
    items?.map((item) =>
      item.id === saved.item.id
        ? ownerMediaSchema.parse({
            ...saved.item,
            _rev: saved._rev,
            data: {
              ...saved.item.data,
              asset: item.data.asset,
              poster: item.data.poster,
              source_url: item.data.source_url,
              poster_url: item.data.poster_url,
            },
          })
        : item,
    ),
  );
  return saved;
}
