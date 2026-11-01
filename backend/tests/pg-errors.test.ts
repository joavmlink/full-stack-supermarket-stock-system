import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isForeignKeyViolation, isRestrictViolation, isUniqueViolation } from '../src/lib/pg-errors.js';

const pgError = (code: string, constraint: string) => Object.assign(new Error('pg'), { code, constraint });

describe('Postgres constraint errors', () => {
  test('isUniqueViolation matches 23505 on the named constraint only', () => {
    assert.equal(isUniqueViolation(pgError('23505', 'users_email_key'), 'users_email_key'), true);
    assert.equal(isUniqueViolation(pgError('23505', 'users_pkey'), 'users_email_key'), false);
    assert.equal(isUniqueViolation(pgError('23503', 'users_email_key'), 'users_email_key'), false);
    assert.equal(isUniqueViolation(null, 'users_email_key'), false);
  });

  test('an invalid reference is 23503 only', () => {
    assert.equal(isForeignKeyViolation(pgError('23503', 'products_category_id_fkey'), 'products_category_id_fkey'), true);
    assert.equal(isForeignKeyViolation(pgError('23001', 'products_category_id_fkey'), 'products_category_id_fkey'), false);
  });

  test('a blocked RESTRICT delete is recognized under the code of any Postgres version', () => {
    for (const code of ['23001', '23503']) {
      assert.equal(isRestrictViolation(pgError(code, 'products_category_id_fkey'), 'products_category_id_fkey'), true);
      assert.equal(isRestrictViolation(pgError(code, 'other_fkey'), 'products_category_id_fkey'), false);
    }
    assert.equal(isRestrictViolation(pgError('23505', 'products_category_id_fkey'), 'products_category_id_fkey'), false);
  });
});
