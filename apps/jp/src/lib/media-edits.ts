import { z } from 'zod';
import { metadataSchema } from './model';
import { categoryNames, normalizeCategory } from './category-icons';

const categories = metadataSchema.shape.categories.refine(
  (names) => names.every((name) => normalizeCategory(name)),
  'Choose valid categories',
);
export const mediaChangesSchema = z
  .strictObject({
    title: metadataSchema.shape.title.optional(),
    place: z.string().trim().max(100).optional(),
    categories: z
      .strictObject({
        mode: z.enum(['add', 'remove', 'replace']),
        names: categories,
      })
      .optional(),
  })
  .refine(
    (changes) => Object.keys(changes).length > 0,
    'Choose a field to change',
  );
export type MediaChanges = z.infer<typeof mediaChangesSchema>;
export const mediaEditSchema = z.strictObject({
  id: z.string().min(1),
  revision: z.string().min(1),
  changes: mediaChangesSchema,
});

export function mediaEditData(
  current: Record<string, unknown>,
  changes: MediaChanges,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (changes.title !== undefined) data.title = changes.title;
  if (changes.place !== undefined) data.place = changes.place;
  if (changes.categories) {
    const existing = categoryNames(current.categories);
    const chosen = categoryNames(changes.categories.names);
    const keys = new Set(chosen.map((category) => category.normalized));
    const names =
      changes.categories.mode === 'replace'
        ? chosen
        : changes.categories.mode === 'remove'
          ? existing.filter((category) => !keys.has(category.normalized))
          : [
              ...existing,
              ...chosen.filter(
                (category) =>
                  !existing.some(
                    (value) => value.normalized === category.normalized,
                  ),
              ),
            ];
    data.categories = categories.parse(names.map((category) => category.label));
  }
  return data;
}
