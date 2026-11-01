import { z } from 'zod';

/** Aggregates computed in SQL; movement counts are limited to the viewer's own for employees. */
const StatsDtoSchema = z.object({
  lowStockThreshold: z.number().int(),
  products: z.object({
    total: z.number().int(),
    outOfStock: z.number().int(),
    lowStock: z.number().int(),
    totalUnits: z.number().int(),
    inventoryValue: z.string(),
  }),
  categories: z.object({ total: z.number().int() }),
  movements: z.object({ sale: z.number().int(), restock: z.number().int(), adjustment: z.number().int() }),
  /** Only for admins. */
  employees: z.object({ total: z.number().int() }).optional(),
});
export type Stats = z.infer<typeof StatsDtoSchema>;
