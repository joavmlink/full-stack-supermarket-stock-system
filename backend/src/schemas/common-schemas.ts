import { z } from 'zod';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Trimmed text in one Unicode form (NFC), so the same visible text is always
 * stored, compared and searched the same way, whichever form was typed. Postgres
 * text cannot hold a null character.
 */
export const textSchema = (maxLength: number) =>
  z
    .string()
    .trim()
    .normalize('NFC')
    .max(maxLength)
    .regex(/^[^\0]*$/u, 'must not contain null characters');

export const requiredTextSchema = (maxLength: number) => textSchema(maxLength).min(1, 'is required');

/** `/:id` route parameters: resources use UUIDs. */
export const IdParamsSchema = z.strictObject({ id: z.uuid() });

/** `?limit=&before=<id>` for keyset pagination on (created_at DESC, id DESC); resources extend it with filters. */
export const PageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  before: z.uuid().optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;
