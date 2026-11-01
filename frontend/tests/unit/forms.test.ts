import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Product, User } from '../../src/api/types';
import {
  EMPLOYEE_LABELS,
  PRODUCT_LABELS,
  emptyProductForm,
  employeeChanges,
  fieldErrorsFromApi,
  productChanges,
  productToForm,
  stockErrorsFromApi,
  validateEmployeeForm,
  validateProductForm,
  validateStockForm,
  type StockLine,
} from '../../src/lib/forms';

const product: Product = {
  id: 'p1',
  category: { id: 'c1', name: 'Dairy' },
  brand: 'La Serenísima',
  name: 'Milk 1 L',
  description: '',
  quantity: 1250,
  price: '1234.50',
  version: 3,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

const employee: User = {
  id: 'u1',
  fullName: 'Ana Example',
  email: 'ana@example.com',
  role: 'employee',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

describe('product form', () => {
  test('the stored product shows the price and the quantity in Argentine format', () => {
    assert.deepEqual(productToForm(product), {
      categoryId: 'c1',
      brand: 'La Serenísima',
      name: 'Milk 1 L',
      description: '',
      quantity: '1.250',
      price: '1.234,50',
    });
  });

  test('valid values become API fields: trimmed, NFC, canonical price', () => {
    const result = validateProductForm({
      categoryId: 'c1',
      brand: '  La Serenı́sima ',
      name: 'Milk',
      description: ' Whole ',
      quantity: '1.250',
      price: '1.234,5',
    });
    assert.ok(result.ok);
    assert.deepEqual(result.fields, {
      categoryId: 'c1',
      brand: 'La Serenı́sima'.normalize('NFC'),
      name: 'Milk',
      description: 'Whole',
      quantity: 1250,
      price: '1234.50',
    });
  });

  test('every field explains what is wrong', () => {
    const result = validateProductForm({ ...emptyProductForm(), brand: ' ', name: 'x'.repeat(101), description: 'd'.repeat(1001), quantity: '1.000.001', price: '12.50' });
    assert.ok(!result.ok);
    assert.deepEqual(result.errors, {
      categoryId: 'Choose a category.',
      brand: 'Enter a brand.',
      name: 'Use at most 100 characters.',
      description: 'Use at most 1.000 characters.',
      quantity: 'Enter at most 1.000.000.',
      price: 'Use a comma for decimals.',
    });
  });

  test('a PATCH carries only what changed', () => {
    const fields = { categoryId: 'c1', brand: 'La Serenísima', name: 'Milk 1 L', description: '', quantity: 1250, price: '1234.50' };
    assert.deepEqual(productChanges(product, fields), {});
    assert.deepEqual(productChanges(product, { ...fields, categoryId: 'c2', price: '1300.00', quantity: 0 }), {
      categoryId: 'c2',
      price: '1300.00',
      quantity: 0,
    });
  });
});

describe('employee form', () => {
  const longPassword = 'correct horse battery staple';

  test('a new employee needs every field; the email is lowercased', () => {
    const result = validateEmployeeForm({ fullName: ' Ana ', email: ' Ana@Example.COM ', password: longPassword }, 'create');
    assert.deepEqual(result, { ok: true, fields: { fullName: 'Ana', email: 'ana@example.com', password: longPassword } });
    assert.deepEqual(validateEmployeeForm({ fullName: '', email: '', password: '' }, 'create'), {
      ok: false,
      errors: { fullName: 'Enter a full name.', email: 'Enter an email.', password: 'Enter a password.' },
    });
  });

  test('on an edit an empty password keeps the current one', () => {
    assert.ok(validateEmployeeForm({ fullName: 'Ana', email: 'ana@example.com', password: '' }, 'edit').ok);
  });

  test('password length counts code points, from 15 to 128', () => {
    const errors = (password: string) => {
      const result = validateEmployeeForm({ fullName: 'Ana', email: 'ana@example.com', password }, 'create');
      return result.ok ? undefined : result.errors.password;
    };
    assert.equal(errors('a'.repeat(14)), 'Use at least 15 characters.');
    assert.equal(errors('😀'.repeat(15)), undefined);
    assert.equal(errors('a'.repeat(129)), 'Use at most 128 characters.');
  });

  test('an invalid email is explained', () => {
    const result = validateEmployeeForm({ fullName: 'Ana', email: 'ana@example', password: '' }, 'edit');
    assert.deepEqual(result, { ok: false, errors: { email: 'Enter a valid email, like name@example.com.' } });
  });

  test('changes: name and email when different, the password when typed', () => {
    assert.deepEqual(employeeChanges(employee, { fullName: 'Ana Example', email: 'ana@example.com', password: '' }), {});
    assert.deepEqual(employeeChanges(employee, { fullName: 'Ana B', email: 'ana@example.com', password: longPassword }), {
      fullName: 'Ana B',
      password: longPassword,
    });
  });
});

describe('fieldErrorsFromApi', () => {
  test('a conflict code lands on its field', () => {
    const errors = fieldErrorsFromApi(
      { code: 'EMAIL_TAKEN', message: 'This email is already in use.', details: [] },
      EMPLOYEE_LABELS,
      { EMAIL_TAKEN: 'email' },
    );
    assert.deepEqual(errors, { email: 'This email is already in use.' });
  });

  test('validation details become sentences on their fields; unknown paths are ignored', () => {
    const errors = fieldErrorsFromApi(
      {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request body.',
        details: [
          { path: 'brand', message: 'is required' },
          { path: 'password', message: 'This password is on a list of commonly used passwords.' },
          { path: 'version', message: 'is stale' },
          { message: 'no path' },
        ],
      },
      { ...PRODUCT_LABELS, password: 'Password' },
    );
    assert.deepEqual(errors, { brand: 'Brand is required.', password: 'This password is on a list of commonly used passwords.' });
  });
});

describe('stock form', () => {
  const option = (id: string, quantity = 5) => ({ id, name: `Product ${id}`, brand: 'Brand', quantity });
  const line = (key: string, productId: string | null, quantity: string): StockLine => ({
    key,
    product: productId === null ? null : option(productId),
    quantity,
  });

  test('valid lines become items, in order', () => {
    assert.deepEqual(validateStockForm([line('a', 'p1', '2'), line('b', 'p2', '1.000')]), {
      ok: true,
      items: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1000 },
      ],
    });
  });

  test('stock levels are left to the API (the form may hold an old count)', () => {
    assert.ok(validateStockForm([line('a', 'p1', '99')]).ok);
  });

  test('missing products, repeated products and bad quantities are reported per line', () => {
    const result = validateStockForm([line('a', 'p1', '1'), line('b', null, '0'), line('c', 'p1', '1,5'), line('d', 'p2', '100.001')]);
    assert.deepEqual(result, {
      ok: false,
      errors: {
        lines: {
          b: { product: 'Choose a product.', quantity: 'Enter at least 1.' },
          c: { product: 'This product is already in another line.', quantity: 'Enter a whole number.' },
          d: { quantity: 'Enter at most 100.000.' },
        },
      },
    });
  });

  test("the API's stock shortfalls land on their lines with the current stock", () => {
    const lines = [line('a', 'p1', '2'), line('b', 'p2', '9'), line('c', 'p3', '1')];
    const { errors, stock } = stockErrorsFromApi(
      {
        code: 'INSUFFICIENT_STOCK',
        message: 'There is not enough stock for some products.',
        details: [
          { path: 'items.1.quantity', productId: 'p2', requested: 9, available: 1250, message: 'only 1250 in stock' },
          { path: 'items.2.quantity', productId: 'p3', requested: 1, available: 0, message: 'only 0 in stock' },
        ],
      },
      lines,
      'sale',
    );
    assert.deepEqual(errors, { lines: { b: { quantity: 'Only 1.250 in stock.' }, c: { quantity: 'Out of stock.' } } });
    assert.deepEqual([...stock], [
      ['p2', 1250],
      ['p3', 0],
    ]);
  });

  test('the stock limit and deleted products are explained', () => {
    const lines = [line('a', 'p1', '2'), line('b', 'p2', '9')];
    const limit = stockErrorsFromApi(
      {
        code: 'STOCK_LIMIT_EXCEEDED',
        message: 'This restock would exceed the stock limit.',
        details: [{ path: 'items.0.quantity', productId: 'p1', requested: 2, available: 999_999, max: 1_000_000, message: 'x' }],
      },
      lines,
      'restock',
    );
    assert.deepEqual(limit.errors.lines, { a: { quantity: 'The stock cannot exceed 1.000.000 (999.999 in stock).' } });

    const missing = stockErrorsFromApi(
      { code: 'VALIDATION_ERROR', message: 'Invalid.', details: [{ path: 'items.1.productId', message: 'does not match any product' }] },
      lines,
      'sale',
    );
    assert.deepEqual(missing.errors.lines, { b: { product: 'This product no longer exists. Remove it or choose another.' } });
  });

  test('other quantity details keep their message; paths outside the lines are ignored', () => {
    const { errors } = stockErrorsFromApi(
      {
        code: 'VALIDATION_ERROR',
        message: 'Invalid.',
        details: [
          { path: 'items.0.quantity', message: 'must be at most 100000' },
          { path: 'items.7.quantity', message: 'x' },
          { path: 'type', message: 'x' },
        ],
      },
      [line('a', 'p1', '2')],
      'sale',
    );
    assert.deepEqual(errors.lines, { a: { quantity: 'Quantity must be at most 100000.' } });
  });
});
