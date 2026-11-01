import type pg from 'pg';
import { z } from 'zod';
import { withTransaction, type Queryable } from '../db/pool.js';
import { AppError, alreadyExists, notFound } from '../errors.js';
import type { Page } from '../lib/pagination.js';
import { verifyPassword } from '../lib/password.js';
import { isUniqueViolation } from '../lib/pg-errors.js';
import type { Created } from '../lib/routing.js';
import type { PageQuery } from '../schemas/common-schemas.js';
import { RoleSchema, type Role, type User } from '../schemas/user-schemas.js';
import { listPage } from './keyset.js';
import { timestampColumns, timestampsOf } from './rows.js';
import { deleteUserSessions } from './session-model.js';

/** Columns of a user as returned by the API, optionally qualified with a table alias. */
export const userColumns = (alias = '') => {
  const prefix = alias === '' ? '' : `${alias}.`;
  return ['id', 'full_name', 'email', 'role', 'created_at', 'updated_at'].map((column) => prefix + column).join(', ');
};

const UserRow = z.object({
  id: z.uuid(),
  full_name: z.string(),
  email: z.string(),
  role: RoleSchema,
  ...timestampColumns,
});

export function toUser(row: unknown): User {
  const value = UserRow.parse(row);
  return { id: value.id, fullName: value.full_name, email: value.email, role: value.role, ...timestampsOf(value) };
}

/** The user with its password hash, looked up by a unique column. */
async function findUserWithHash(db: Queryable, column: 'id' | 'email', value: string) {
  const { rows } = await db.query(`SELECT ${userColumns()}, password_hash FROM users WHERE ${column} = $1`, [value]);
  if (rows[0] === undefined) return null;
  return { user: toUser(rows[0]), passwordHash: z.string().parse(rows[0].password_hash) };
}

export function findLoginUser(db: Queryable, email: string) {
  return findUserWithHash(db, 'email', email);
}

function rethrowEmailTaken(error: unknown): never {
  throw isUniqueViolation(error, 'users_email_key') ? new AppError(409, 'EMAIL_TAKEN', 'This email is already in use.') : error;
}

interface NewUser {
  id: string;
  fullName: string;
  email: string;
  passwordHash: string;
  role: Role;
}

/** Inserts a user, or returns null when the id is already taken. */
async function insertUser(db: Queryable, input: NewUser): Promise<User | null> {
  const { rows } = await db
    .query(
      `INSERT INTO users (id, full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${userColumns()}`,
      [input.id, input.fullName, input.email, input.passwordHash, input.role],
    )
    .catch(rethrowEmailTaken);
  return rows[0] === undefined ? null : toUser(rows[0]);
}

/** Creates a user with a server-generated id (the create-admin CLI and tests). */
export async function createUser(db: Queryable, input: NewUser): Promise<User> {
  const user = await insertUser(db, input);
  if (user === null) throw alreadyExists();
  return user;
}

/**
 * Creates an employee with a client-generated id. A taken id whose stored
 * employee has the same name, email and password (checked against its hash)
 * is a replayed create: the stored employee comes back.
 */
export async function createEmployee(
  db: Queryable,
  input: { id: string; fullName: string; email: string; password: string; passwordHash: string },
): Promise<Created<User>> {
  const { password, ...fields } = input;
  const user = await insertUser(db, { ...fields, role: 'employee' });
  if (user !== null) return { item: user, created: true };
  const stored = await findUserWithHash(db, 'id', input.id);
  const same =
    stored !== null &&
    stored.user.role === 'employee' &&
    stored.user.fullName === input.fullName &&
    stored.user.email === input.email &&
    (await verifyPassword(password, stored.passwordHash));
  if (!same) throw alreadyExists();
  return { item: stored.user, created: false };
}

export function listEmployees(db: Queryable, query: PageQuery): Promise<Page<User>> {
  return listPage(db, {
    table: 'users',
    from: `SELECT ${userColumns('t')} FROM users t`,
    scope: [`t.role = 'employee'`],
    query,
    resource: 'employee',
    toItem: toUser,
  });
}

const employeeNotFound = () => notFound('EMPLOYEE', 'Employee');

export async function getEmployee(db: Queryable, id: string): Promise<User> {
  const { rows } = await db.query(`SELECT ${userColumns()} FROM users WHERE id = $1 AND role = 'employee'`, [id]);
  if (rows[0] === undefined) throw employeeNotFound();
  return toUser(rows[0]);
}

/** Updates an employee; a new password also signs them out everywhere, in the same transaction. */
export async function updateEmployee(
  pool: pg.Pool,
  id: string,
  changes: { fullName?: string | undefined; email?: string | undefined; passwordHash?: string | undefined },
): Promise<User> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client
      .query(
        `UPDATE users SET
           full_name = COALESCE($2, full_name),
           email = COALESCE($3, email),
           password_hash = COALESCE($4, password_hash)
         WHERE id = $1 AND role = 'employee'
         RETURNING ${userColumns()}`,
        [id, changes.fullName ?? null, changes.email ?? null, changes.passwordHash ?? null],
      )
      .catch(rethrowEmailTaken);
    if (rows[0] === undefined) throw employeeNotFound();
    if (changes.passwordHash !== undefined) await deleteUserSessions(client, id);
    return toUser(rows[0]);
  });
}

/** Deleting an employee cascades to their sessions; their movements keep a name snapshot. */
export async function deleteEmployee(db: Queryable, id: string): Promise<void> {
  const { rowCount } = await db.query(`DELETE FROM users WHERE id = $1 AND role = 'employee'`, [id]);
  if (rowCount === 0) throw employeeNotFound();
}
