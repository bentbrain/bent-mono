import { z } from 'zod';
import { categoryIconStatusSchema } from './category-icons';

export const categoryCollectionSchema = z.object({
  categories: z.array(categoryIconStatusSchema),
  icons: z.array(
    z.object({ id: z.string(), label: z.string(), url: z.string() }),
  ),
});
export type CategoryCollection = z.infer<typeof categoryCollectionSchema>;
