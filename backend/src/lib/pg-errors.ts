function isConstraintError(error: unknown, code: string, constraint: string): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown } | null;
  return pgError?.code === code && pgError.constraint === constraint;
}

/** A unique violation (SQLSTATE 23505) on the given constraint or index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isConstraintError(error, '23505', constraint);
}

/** A row that references a missing row (SQLSTATE 23503) through the given foreign key. */
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return isConstraintError(error, '23503', constraint);
}

/**
 * Deleting a row that an `ON DELETE RESTRICT` foreign key still references, so
 * only for a DELETE. SQLSTATE 23001 (restrict_violation) since Postgres 18; 23503
 * before it.
 */
export function isRestrictViolation(error: unknown, constraint: string): boolean {
  return isConstraintError(error, '23001', constraint) || isConstraintError(error, '23503', constraint);
}

/** A statement on a table that does not exist (SQLSTATE 42P01). */
export function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '42P01';
}
