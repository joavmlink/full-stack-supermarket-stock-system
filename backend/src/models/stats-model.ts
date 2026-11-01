import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import type { Stats } from '../schemas/stats-schemas.js';
import type { User } from '../schemas/user-schemas.js';
import { ownerFilter } from './movement-model.js';

/** A product with 1..LOW_STOCK_THRESHOLD units is "low stock"; 0 units is "out of stock". */
const LOW_STOCK_THRESHOLD = 10;

const StatsRow = z.object({
  product_count: z.number().int(),
  out_of_stock_count: z.number().int(),
  low_stock_count: z.number().int(),
  // sum(int) is bigint, which pg returns as a string.
  total_units: z.coerce.number().int().max(Number.MAX_SAFE_INTEGER),
  inventory_value: z.string(),
  category_count: z.number().int(),
  sale_count: z.number().int(),
  restock_count: z.number().int(),
  adjustment_count: z.number().int(),
  employee_count: z.number().int(),
});

/** Every aggregate in one round trip. Employees only count their own movements. */
export async function getStats(db: Queryable, viewer: User): Promise<Stats> {
  const { rows } = await db.query(
    `WITH p AS (
       SELECT count(*)::int AS product_count,
              count(*) FILTER (WHERE quantity = 0)::int AS out_of_stock_count,
              count(*) FILTER (WHERE quantity BETWEEN 1 AND $1)::int AS low_stock_count,
              coalesce(sum(quantity), 0)::bigint AS total_units,
              coalesce(sum(quantity * price), 0)::numeric(20, 2)::text AS inventory_value
       FROM products
     ), m AS (
       SELECT count(*) FILTER (WHERE type = 'sale')::int AS sale_count,
              count(*) FILTER (WHERE type = 'restock')::int AS restock_count,
              count(*) FILTER (WHERE type = 'adjustment')::int AS adjustment_count
       FROM stock_movements
       WHERE $2::uuid IS NULL OR user_id = $2
     )
     SELECT p.*, m.*,
            (SELECT count(*)::int FROM categories) AS category_count,
            (SELECT count(*)::int FROM users WHERE role = 'employee') AS employee_count
     FROM p, m`,
    [LOW_STOCK_THRESHOLD, ownerFilter(viewer)],
  );
  const row = StatsRow.parse(rows[0]);
  return {
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    products: {
      total: row.product_count,
      outOfStock: row.out_of_stock_count,
      lowStock: row.low_stock_count,
      totalUnits: row.total_units,
      inventoryValue: row.inventory_value,
    },
    categories: { total: row.category_count },
    movements: { sale: row.sale_count, restock: row.restock_count, adjustment: row.adjustment_count },
    ...(viewer.role === 'admin' ? { employees: { total: row.employee_count } } : {}),
  };
}
