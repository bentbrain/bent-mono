import { SchemaRegistry, type CreateFieldInput } from 'emdash';
import {
  builtInCategoryNames,
  categoryNames,
  iconHash,
} from './category-icons';
import {
  categoryInsertStatements,
  drainIconOutbox,
  ownerIconStatuses,
} from './category-icon-jobs';
import type { IconEnvironment } from './category-icon-jobs';
import { iconAssets, validIconAsset } from './icon-library';
import { z } from 'zod';

type CMS = Pick<
  App.Locals['emdash'],
  | 'db'
  | 'handleContentList'
  | 'handleContentGetIncludingTrashed'
  | 'handleMediaCreate'
> & {
  // Native runtime policy rejections carry structured details that differ
  // from Astro's HTTP envelope. Synchronization only consumes success here.
  handleContentCreate(
    ...args: Parameters<App.Locals['emdash']['handleContentCreate']>
  ): Promise<{ success: boolean }>;
};
const definitions: {
  slug: string;
  label: string;
  fields: CreateFieldInput[];
}[] = [
  {
    slug: 'categories',
    label: 'Categories',
    fields: [
      { slug: 'title', type: 'string', label: 'category', required: true },
    ],
  },
  {
    slug: 'category_icons',
    label: 'Category icons',
    fields: [
      { slug: 'title', type: 'string', label: 'icon', required: true },
      { slug: 'image', type: 'image', label: 'image', required: true },
      { slug: 'category', type: 'string', label: 'subject', required: true },
    ],
  },
];
// Additive, resumable setup for existing instances. New instances get the same
// definitions in seed.json. No existing collection or record is changed.
async function ensureCollections(cms: CMS) {
  const registry = new SchemaRegistry(cms.db);
  for (const definition of definitions) {
    if (await registry.getCollection(definition.slug)) continue;
    try {
      await registry.createSeedCollection(
        {
          slug: definition.slug,
          label: definition.label,
          supports: ['drafts'],
          routable: false,
        },
        definition.fields,
      );
    } catch (error) {
      // Another owner request may have completed the same additive setup.
      const current = await registry.getCollectionWithFields(definition.slug);
      if (
        !current ||
        !definition.fields.every((field) =>
          current.fields.some(
            (saved) => saved.slug === field.slug && saved.type === field.type,
          ),
        )
      )
        throw error;
    }
  }
}
async function collectionItems(cms: CMS, collection: string) {
  const items: {
    id: string;
    slug: string | null;
    data: Record<string, unknown>;
  }[] = [];
  let cursor: string | undefined;
  do {
    const result = await cms.handleContentList(collection, {
      limit: 100,
      cursor,
    });
    if (!result.success) throw new Error('Could not read collection');
    const page = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            slug: z.string().nullable(),
            data: z.record(z.string(), z.unknown()),
          }),
        ),
        nextCursor: z.string().nullish(),
      })
      .parse(result.data);
    items.push(...page.items);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return items;
}
export async function savedCategoryNames(env: IconEnvironment) {
  return (
    await env.DB.prepare(
      'SELECT label FROM jp_categories ORDER BY normalized',
    ).all<{ label: string }>()
  ).results.map((row) => row.label);
}
export async function registerCategory(env: IconEnvironment, label: string) {
  const name = categoryNames([label])[0];
  if (!name) throw new Error('Choose a category of 1 to 40 characters');
  await env.DB.batch(await categoryInsertStatements(env, name));
  return name;
}
export async function categoryCollection(
  env: IconEnvironment,
  cms: CMS,
  user: Pick<NonNullable<App.Locals['user']>, 'id' | 'role'>,
) {
  await ensureCollections(cms);
  await drainIconOutbox(env);
  // Default icons and old media labels are retained without paid backfill.
  for (const name of categoryNames(builtInCategoryNames()))
    await env.DB.prepare(
      'INSERT OR IGNORE INTO jp_categories(id,normalized,label) VALUES(?,?,?)',
    )
      .bind(await iconHash(name.normalized), name.normalized, name.label)
      .run();
  const native = await collectionItems(cms, 'categories');
  const registered = new Set(
    categoryNames(await savedCategoryNames(env)).map((name) => name.normalized),
  );
  for (const item of native) {
    if (typeof item.data.title !== 'string') continue;
    const name = categoryNames([item.data.title])[0];
    if (name && !registered.has(name.normalized)) {
      await registerCategory(env, name.label);
      registered.add(name.normalized);
    }
  }
  const represented = new Set(
    categoryNames(native.map((item) => item.data.title)).map(
      (name) => name.normalized,
    ),
  );
  const actor = { id: user.id, role: user.role };
  const names = await savedCategoryNames(env);
  for (const name of categoryNames(names)) {
    if (represented.has(name.normalized)) continue;
    const slug = await iconHash(name.normalized);
    // Trashed records still reserve their slugs. Preserve that tombstone and
    // media's saved labels instead of recreating or restoring content on reads.
    if (
      (await cms.handleContentGetIncludingTrashed('categories', slug)).success
    )
      continue;
    const result = await cms.handleContentCreate('categories', {
      slug,
      data: { title: name.label },
      actor,
    });
    if (
      !result.success &&
      !(
        await cms.handleContentGetIncludingTrashed(
          'categories',
          await iconHash(name.normalized),
        )
      ).success
    )
      throw new Error('Could not save category collection');
  }
  const library = await collectionItems(cms, 'category_icons');
  const icons = [];
  for (const asset of await iconAssets(env)) {
    const bytes = await validIconAsset(env, asset);
    if (!bytes) continue;
    const slug = await iconHash(asset.storage_key);
    if (
      !library.some((item) => item.slug === slug) &&
      !(await cms.handleContentGetIncludingTrashed('category_icons', slug))
        .success
    ) {
      let media = await cms.db
        .selectFrom('media')
        .select('id')
        .where('storage_key', '=', asset.storage_key)
        .executeTakeFirst();
      if (!media) {
        const created = await cms.handleMediaCreate({
          filename: `${asset.version}.png`,
          mimeType: 'image/png',
          size: bytes.length,
          width: 32,
          height: 32,
          alt: asset.label,
          storageKey: asset.storage_key,
          authorId: user.id,
        });
        media = created.success
          ? z.object({ item: z.object({ id: z.string() }) }).parse(created.data)
              .item
          : await cms.db
              .selectFrom('media')
              .select('id')
              .where('storage_key', '=', asset.storage_key)
              .executeTakeFirst();
        if (!media) throw new Error('Could not save icon media');
      }
      const created = await cms.handleContentCreate('category_icons', {
        slug,
        data: {
          title: asset.label,
          category: asset.normalized,
          image: { id: media.id },
        },
        actor,
      });
      if (
        !created.success &&
        !(await cms.handleContentGetIncludingTrashed('category_icons', slug))
          .success
      )
        throw new Error('Could not save icon collection');
    }
    icons.push({
      id: slug,
      label: asset.label,
      url: `/api/trip/icon-library/${asset.category_id}/${asset.version}.png`,
    });
  }
  return { categories: await ownerIconStatuses(env, names), icons };
}
