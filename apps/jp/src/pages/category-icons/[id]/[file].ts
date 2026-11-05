import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { currentPublishedCategoryNames } from '../../../lib/category-icon-access';
import { normalizeCategory } from '../../../lib/category-icons';
import { tripMedia } from '../../../lib/content';
import { serveCategoryIcon } from '../../../lib/category-icon-serving';

export const GET: APIRoute = ({ params, cache }) => {
  cache.set(false);
  return serveCategoryIcon(
    env,
    params.id || '',
    params.file || '',
    async () => {
      const current = new Set(
        (await currentPublishedCategoryNames(env.DB)).map(
          (name) => name.normalized,
        ),
      );
      return (await tripMedia())
        .flatMap((item) => item.categories)
        .filter((name) =>
          current.has(normalizeCategory(name)?.normalized || ''),
        );
    },
  );
};
