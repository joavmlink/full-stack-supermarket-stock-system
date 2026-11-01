import type { Queryable } from '../db/pool.js';
import { toPage, type Page } from '../lib/pagination.js';
import { validationError } from '../lib/validation.js';
import type { PageQuery } from '../schemas/common-schemas.js';

/**
 * One page of rows ordered by (created_at DESC, id DESC), the newest first.
 *
 * `table`, `from`, `scope` and `where` are SQL written in the code, never
 * request data. The paged table is aliased `t` in `from`, which must select
 * `id` and `created_at`. `scope` limits which rows belong to the list at all
 * (and therefore which rows are valid cursors); `where` holds request filters.
 * Both number their placeholders from `$1` over `params`; the page size and
 * the cursor are appended after them.
 *
 * The cursor is resolved in the same statement as the page: its created_at is
 * compared inside SQL (a JS Date would drop the microseconds and skip or repeat
 * rows on ties), and a cursor that is deleted between two requests cannot turn
 * the page into an empty "last" page. A cursor that is not a row of this list
 * answers 400.
 */
export async function listPage<T>(
  db: Queryable,
  options: {
    table: string;
    from: string;
    scope?: string[];
    where?: string[];
    params?: unknown[];
    query: PageQuery;
    resource: string;
    toItem: (row: unknown) => T;
  },
): Promise<Page<T>> {
  const { table, query } = options;
  const params = options.params ?? [];
  const limit = `$${params.length + 1}`;
  const cursor = `$${params.length + 2}`;
  const scope = options.scope ?? [];
  const pageConditions = [
    `(${cursor}::uuid IS NULL OR (t.created_at, t.id) < (SELECT created_at, id FROM cursor_row))`,
    ...scope,
    ...(options.where ?? []),
  ];
  const { rows } = await db.query<{ cursor_found: number; id: string | null }>(
    `WITH cursor_row AS (
       SELECT t.created_at, t.id FROM ${table} t WHERE ${[`t.id = ${cursor}`, ...scope].join(' AND ')}
     )
     SELECT (SELECT count(*) FROM cursor_row)::int AS cursor_found, page.*
     FROM (VALUES (0)) AS anchor
     LEFT JOIN LATERAL (
       ${options.from}
       WHERE ${pageConditions.join(' AND ')}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${limit}
     ) page ON true
     ORDER BY page.created_at DESC, page.id DESC`,
    [...params, query.limit + 1, query.before ?? null],
  );
  if (query.before !== undefined && rows[0]?.cursor_found === 0) {
    throw validationError('Invalid query.', [{ path: 'before', message: `does not match any ${options.resource}` }]);
  }
  // An empty page still yields the anchor row, with every page column NULL.
  const items = rows.filter((row) => row.id !== null);
  return toPage(items.map(options.toItem), query.limit);
}
