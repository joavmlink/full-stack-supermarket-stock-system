import { z } from 'zod';

/** The created_at / updated_at columns every table has, as Zod row fields. */
export const timestampColumns = { created_at: z.date(), updated_at: z.date() };

/** The API form of those columns: ISO 8601 in UTC. */
export function timestampsOf(row: { created_at: Date; updated_at: Date }) {
  return { createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
