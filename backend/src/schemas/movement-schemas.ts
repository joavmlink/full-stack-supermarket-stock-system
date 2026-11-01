import { z } from 'zod';
import { MAX_ITEMS_PER_MOVEMENT } from '../db/schema.js';
import { PageQuerySchema } from './common-schemas.js';

/** sale and restock come from the stock form; adjustment from admin edits to a product's quantity. */
export const MovementTypeSchema = z.enum(['sale', 'restock', 'adjustment']);
export type MovementType = z.infer<typeof MovementTypeSchema>;

/** The most units one line of the stock form can move. */
export const MAX_LINE_QUANTITY = 100_000;

const MovementLineSchema = z.strictObject({
  productId: z.uuid(),
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});

/**
 * The stock form: one type for every line (a sale subtracts, a restock adds),
 * each product at most once. The client generates `id`, which makes a retry idempotent.
 */
export const StockMovementCreateSchema = z.strictObject({
  id: z.uuid(),
  type: MovementTypeSchema.exclude(['adjustment']),
  items: z
    .array(MovementLineSchema)
    .min(1)
    .max(MAX_ITEMS_PER_MOVEMENT)
    .superRefine((items, ctx) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item.productId)) {
          ctx.addIssue({ code: 'custom', path: [index, 'productId'], message: 'each product can appear only once' });
        }
        seen.add(item.productId);
      });
    }),
});
export type StockMovementCreate = z.infer<typeof StockMovementCreateSchema>;

export const StockMovementListQuerySchema = PageQuerySchema.extend({
  type: MovementTypeSchema.optional(),
});
export type StockMovementListQuery = z.infer<typeof StockMovementListQuerySchema>;

/**
 * The movement as the API returns it. The author's name and each product's
 * name, brand and price are snapshots taken when it was recorded; `user.id`
 * and `product.id` become null once that user or product is deleted.
 * `delta` is signed: negative for a sale, positive for a restock.
 */
const StockMovementDtoSchema = z.object({
  id: z.uuid(),
  type: MovementTypeSchema,
  user: z.object({ id: z.uuid().nullable(), fullName: z.string() }),
  items: z.array(
    z.object({
      product: z.object({ id: z.uuid().nullable(), name: z.string(), brand: z.string() }),
      unitPrice: z.string(),
      delta: z.number().int(),
      quantityAfter: z.number().int(),
    }),
  ),
  createdAt: z.iso.datetime(),
});
export type StockMovement = z.infer<typeof StockMovementDtoSchema>;
