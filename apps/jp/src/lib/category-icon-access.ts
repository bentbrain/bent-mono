import type { D1Database } from '@cloudflare/workers-types';
import { categoryNames } from './category-icons';
import { ownerMediaItems } from './owner-media';

// Owner status uses the latest saved draft, including staged changes to a
// currently published item. Public routes use the published trip loader.
export async function visibleCategoryNames(
  emdash: Parameters<typeof ownerMediaItems>[0],
) {
  return (await ownerMediaItems(emdash)).flatMap((item) =>
    categoryNames(item.data.categories).map((name) => name.label),
  );
}

export async function categoryAssetRecord(
  db: D1Database,
  id: string,
  version: string,
) {
  return db
    .prepare(
      'SELECT normalized,ready_key FROM jp_categories WHERE id=? AND ready_version=? AND ready_key IS NOT NULL',
    )
    .bind(id, version)
    .first<{ normalized: string; ready_key: string }>();
}

// Bypass content-query caches for revocation checks. Draft revisions never
// overwrite these live columns. No private rows or icon records enter this set.
export async function currentPublishedCategoryNames(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT DISTINCT j.value AS label FROM ec_media_items m, json_each(CASE WHEN json_valid(m.categories) THEN m.categories ELSE '[]' END) j WHERE m.status='published' AND m.deleted_at IS NULL AND j.type='text'`,
    )
    .all<{ label: string }>();
  return categoryNames(rows.results.map((row) => row.label));
}
