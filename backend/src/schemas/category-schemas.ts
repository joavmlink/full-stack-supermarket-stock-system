import { z } from 'zod';
import { requiredTextSchema } from './common-schemas.js';

const CategoryNameSchema = requiredTextSchema(60);

export const CategoryCreateSchema = z.strictObject({
  id: z.uuid(),
  name: CategoryNameSchema,
});
export type CategoryCreate = z.infer<typeof CategoryCreateSchema>;

export const CategoryUpdateSchema = z.strictObject({ name: CategoryNameSchema });
export type CategoryUpdate = z.infer<typeof CategoryUpdateSchema>;

/** The category as the API returns it. */
const CategoryDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Category = z.infer<typeof CategoryDtoSchema>;
