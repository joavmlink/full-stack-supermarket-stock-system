import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { AppError, alreadyExists, notFound } from '../errors.js';
import type { Page } from '../lib/pagination.js';
import type { Created } from '../lib/routing.js';
import { isRestrictViolation, isUniqueViolation } from '../lib/pg-errors.js';
import type { Category } from '../schemas/category-schemas.js';
import type { PageQuery } from '../schemas/common-schemas.js';
import { listPage } from './keyset.js';
import { timestampColumns, timestampsOf } from './rows.js';

const CategoryRow = z.object({ id: z.uuid(), name: z.string(), ...timestampColumns });
const COLUMNS = 't.id, t.name, t.created_at, t.updated_at';

function toCategory(row: unknown): Category {
  const value = CategoryRow.parse(row);
  return { id: value.id, name: value.name, ...timestampsOf(value) };
}

const categoryNotFound = () => notFound('CATEGORY', 'Category');

function rethrowNameTaken(error: unknown): never {
  throw isUniqueViolation(error, 'categories_name_key')
    ? new AppError(409, 'CATEGORY_NAME_TAKEN', 'A category with this name already exists.')
    : error;
}

async function findCategory(db: Queryable, id: string): Promise<Category | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM categories t WHERE t.id = $1`, [id]);
  return rows[0] === undefined ? null : toCategory(rows[0]);
}

/** A taken id with the same name is a replayed create: the stored category comes back. */
export async function createCategory(db: Queryable, input: { id: string; name: string }): Promise<Created<Category>> {
  const { rows } = await db
    .query(
      `INSERT INTO categories AS t (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.id, input.name],
    )
    .catch(rethrowNameTaken);
  if (rows[0] !== undefined) return { item: toCategory(rows[0]), created: true };
  const stored = await findCategory(db, input.id);
  if (stored === null || stored.name !== input.name) throw alreadyExists();
  return { item: stored, created: false };
}

export function listCategories(db: Queryable, query: PageQuery): Promise<Page<Category>> {
  return listPage(db, {
    table: 'categories',
    from: `SELECT ${COLUMNS} FROM categories t`,
    query,
    resource: 'category',
    toItem: toCategory,
  });
}

export async function getCategory(db: Queryable, id: string): Promise<Category> {
  const category = await findCategory(db, id);
  if (category === null) throw categoryNotFound();
  return category;
}

/** updated_at is refreshed by a trigger. */
export async function renameCategory(db: Queryable, id: string, name: string): Promise<Category> {
  const { rows } = await db
    .query(`UPDATE categories AS t SET name = $2 WHERE t.id = $1 RETURNING ${COLUMNS}`, [id, name])
    .catch(rethrowNameTaken);
  if (rows[0] === undefined) throw categoryNotFound();
  return toCategory(rows[0]);
}

/** A category that still has products cannot be deleted (409 CATEGORY_IN_USE). */
export async function deleteCategory(db: Queryable, id: string): Promise<void> {
  const { rowCount } = await db.query('DELETE FROM categories WHERE id = $1', [id]).catch((error: unknown) => {
    throw isRestrictViolation(error, 'products_category_id_fkey')
      ? new AppError(409, 'CATEGORY_IN_USE', 'This category still has products. Move or delete them first.')
      : error;
  });
  if (rowCount === 0) throw categoryNotFound();
}
