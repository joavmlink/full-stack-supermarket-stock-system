// Pure form logic: validation before sending (the API stays the authority),
// what changed on an edit, and the API's answer mapped back onto fields.
import type { ApiErrorDetail } from '../api/errors';
import {
  CATEGORY_NAME_MAX,
  EMAIL_MAX,
  FULL_NAME_MAX,
  MAX_LINE_QUANTITY,
  MAX_QUANTITY,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PRODUCT_BRAND_MAX,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_NAME_MAX,
} from '../api/limits';
import type { EmployeeFields, FormMovementType, MovementLineInput, Product, ProductFields, User } from '../api/types';
import { formatAmount, parsePriceInput } from './money';
import { formatInteger, parseQuantityInput } from './numbers';

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type FormResult<T, K extends string> = { ok: true; fields: T } | { ok: false; errors: FieldErrors<K> };

/** The same normalization as the API (trim + NFC), so lengths are counted the same way. */
export const normalizeText = (value: string) => value.trim().normalize('NFC');

const tooLong = (max: number) => `Use at most ${formatInteger(max)} characters.`;

function requiredText(value: string, label: string, max: number): string | undefined {
  const text = normalizeText(value);
  if (text === '') return `Enter a ${label}.`;
  if (text.length > max) return tooLong(max);
  return undefined;
}

/** A category name: the error, or undefined when it is valid. */
export const validateCategoryName = (value: string) => requiredText(value, 'name', CATEGORY_NAME_MAX);

/** A rejected write, as the stores keep it. */
export interface Rejection {
  code: string;
  message: string;
  details: ApiErrorDetail[];
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** An API detail as a sentence: a fragment ("is required") follows its label, a full sentence stands alone. */
const labeled = (label: string, message: string) => sentence(/^[a-z]/.test(message) ? `${label} ${message}` : message);

/**
 * Field errors from a rejected write: the conflict codes that belong to one
 * field (EMAIL_TAKEN → email), then each validation detail whose `path` is a
 * field ("is required" becomes "Brand is required.").
 */
export function fieldErrorsFromApi<K extends string>(
  rejection: Rejection,
  labels: Record<K, string>,
  codeFields: Partial<Record<string, K>> = {},
): FieldErrors<K> {
  const errors: FieldErrors<K> = {};
  const field = codeFields[rejection.code];
  if (field !== undefined) errors[field] = rejection.message;
  for (const detail of rejection.details) {
    const path = detail.path as K | undefined;
    if (path === undefined || !(path in labels) || errors[path] !== undefined) continue;
    errors[path] = labeled(labels[path], detail.message);
  }
  return errors;
}

// Products ------------------------------------------------------------------

export interface ProductFormValues {
  categoryId: string;
  brand: string;
  name: string;
  description: string;
  quantity: string;
  price: string;
}
export type ProductField = keyof ProductFormValues;

export const PRODUCT_LIMITS = { brand: PRODUCT_BRAND_MAX, name: PRODUCT_NAME_MAX, description: PRODUCT_DESCRIPTION_MAX } as const;

export const PRODUCT_LABELS: Record<ProductField, string> = {
  categoryId: 'Category',
  brand: 'Brand',
  name: 'Name',
  description: 'Description',
  quantity: 'Quantity',
  price: 'Price',
};

export const emptyProductForm = (): ProductFormValues => ({
  categoryId: '',
  brand: '',
  name: '',
  description: '',
  quantity: '0',
  price: '',
});

/** The editable fields of a stored product. */
function productFields(product: Product): ProductFields {
  return {
    categoryId: product.category.id,
    brand: product.brand,
    name: product.name,
    description: product.description,
    quantity: product.quantity,
    price: product.price,
  };
}

/** API fields as the form shows them: the price and the quantity in Argentine format, as the admin types them. */
export function productFieldsToForm(fields: ProductFields): ProductFormValues {
  return { ...fields, quantity: formatInteger(fields.quantity), price: formatAmount(fields.price) };
}

export const productToForm = (product: Product) => productFieldsToForm(productFields(product));

export function validateProductForm(values: ProductFormValues): FormResult<ProductFields, ProductField> {
  const errors: FieldErrors<ProductField> = {};
  if (values.categoryId === '') errors.categoryId = 'Choose a category.';
  const brand = requiredText(values.brand, 'brand', PRODUCT_LIMITS.brand);
  if (brand !== undefined) errors.brand = brand;
  const name = requiredText(values.name, 'name', PRODUCT_LIMITS.name);
  if (name !== undefined) errors.name = name;
  if (normalizeText(values.description).length > PRODUCT_LIMITS.description) errors.description = tooLong(PRODUCT_LIMITS.description);
  const quantity = parseQuantityInput(values.quantity, { min: 0, max: MAX_QUANTITY });
  if (!quantity.ok) errors.quantity = quantity.error;
  const price = parsePriceInput(values.price);
  if (!price.ok) errors.price = price.error;

  if (!quantity.ok || !price.ok || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    fields: {
      categoryId: values.categoryId,
      brand: normalizeText(values.brand),
      name: normalizeText(values.name),
      description: normalizeText(values.description),
      quantity: quantity.value,
      price: price.value,
    },
  };
}

/** Only the fields that differ from the stored product (a PATCH sends nothing else). */
export function productChanges(product: Product, fields: ProductFields): Partial<ProductFields> {
  const current = productFields(product);
  return Object.fromEntries(
    (Object.keys(fields) as (keyof ProductFields)[])
      .filter((key) => fields[key] !== current[key])
      .map((key) => [key, fields[key]]),
  );
}

// Employees -----------------------------------------------------------------

export type EmployeeField = keyof EmployeeFields;

export const EMPLOYEE_LABELS: Record<EmployeeField, string> = {
  fullName: 'Full name',
  email: 'Email',
  password: 'Password',
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const codePoints = (value: string) => [...value.normalize('NFC')].length;

/** On an edit, an empty password keeps the current one. */
export function validateEmployeeForm(
  values: EmployeeFields,
  mode: 'create' | 'edit',
): FormResult<EmployeeFields, EmployeeField> {
  const errors: FieldErrors<EmployeeField> = {};
  const fullName = requiredText(values.fullName, 'full name', FULL_NAME_MAX);
  if (fullName !== undefined) errors.fullName = fullName;
  const email = values.email.trim().toLowerCase();
  if (email === '') errors.email = 'Enter an email.';
  else if (!EMAIL.test(email) || email.length > EMAIL_MAX) errors.email = 'Enter a valid email, like name@example.com.';
  const length = codePoints(values.password);
  if (values.password === '') {
    if (mode === 'create') errors.password = 'Enter a password.';
  } else if (length < PASSWORD_MIN_LENGTH) {
    errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  } else if (length > PASSWORD_MAX_LENGTH) {
    errors.password = tooLong(PASSWORD_MAX_LENGTH);
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, fields: { fullName: normalizeText(values.fullName), email, password: values.password } };
}

/** Changed name and email, plus the password when one was typed. */
export function employeeChanges(employee: User, fields: EmployeeFields): Partial<EmployeeFields> {
  const changes: Partial<EmployeeFields> = {};
  if (fields.fullName !== employee.fullName) changes.fullName = fields.fullName;
  if (fields.email !== employee.email) changes.email = fields.email;
  if (fields.password !== '') changes.password = fields.password;
  return changes;
}

// Stock form ----------------------------------------------------------------

/** A product picked in the stock form, with the stock it had when it was loaded. */
export interface ProductOption {
  id: string;
  name: string;
  brand: string;
  quantity: number;
}

export interface StockLine {
  /** Stable React key and error key; unrelated to the product. */
  key: string;
  product: ProductOption | null;
  quantity: string;
}

export interface LineErrors {
  product?: string;
  quantity?: string;
}

export interface StockFormErrors {
  lines: Record<string, LineErrors>;
}

/**
 * Checks the form's shape: a product and a whole quantity on every line, each
 * product once. Stock levels are left to the API, which knows the current
 * ones; its answer comes back through `stockErrorsFromApi`.
 */
export function validateStockForm(lines: StockLine[]): { ok: true; items: MovementLineInput[] } | { ok: false; errors: StockFormErrors } {
  const errors: StockFormErrors = { lines: {} };
  const seen = new Set<string>();
  const items: MovementLineInput[] = [];
  for (const line of lines) {
    const lineErrors: LineErrors = {};
    if (line.product === null) lineErrors.product = 'Choose a product.';
    else if (seen.has(line.product.id)) lineErrors.product = 'This product is already in another line.';
    else seen.add(line.product.id);
    const quantity = parseQuantityInput(line.quantity, { min: 1, max: MAX_LINE_QUANTITY });
    if (!quantity.ok) lineErrors.quantity = quantity.error;
    if (lineErrors.product !== undefined || lineErrors.quantity !== undefined) errors.lines[line.key] = lineErrors;
    else if (line.product !== null && quantity.ok) items.push({ productId: line.product.id, quantity: quantity.value });
  }
  if (Object.keys(errors.lines).length > 0) return { ok: false, errors };
  return { ok: true, items };
}

const LINE_PATH = /^items\.(\d+)\.(productId|quantity)$/;

/**
 * The API's per-line answer mapped onto the lines that were sent (in the same
 * order): stock shortfalls, the stock limit, deleted products. Also returns
 * the stock each product had, to refresh what the form shows.
 */
export function stockErrorsFromApi(
  rejection: Rejection,
  lines: StockLine[],
  type: FormMovementType,
): { errors: StockFormErrors; stock: Map<string, number> } {
  const errors: StockFormErrors = { lines: {} };
  const stock = new Map<string, number>();
  for (const detail of rejection.details) {
    const match = LINE_PATH.exec(detail.path ?? '');
    const line = match === null ? undefined : lines[Number(match[1])];
    if (match === null || line === undefined) continue;
    const lineErrors = (errors.lines[line.key] ??= {});
    if (match[2] === 'productId') {
      lineErrors.product = 'This product no longer exists. Remove it or choose another.';
      continue;
    }
    const available = typeof detail.available === 'number' ? detail.available : undefined;
    if (available !== undefined && typeof detail.productId === 'string') stock.set(detail.productId, available);
    if (rejection.code === 'INSUFFICIENT_STOCK' && available !== undefined) {
      lineErrors.quantity = available === 0 ? 'Out of stock.' : `Only ${formatInteger(available)} in stock.`;
    } else if (rejection.code === 'STOCK_LIMIT_EXCEEDED' && available !== undefined && type === 'restock') {
      const max = typeof detail.max === 'number' ? detail.max : MAX_QUANTITY;
      lineErrors.quantity = `The stock cannot exceed ${formatInteger(max)} (${formatInteger(available)} in stock).`;
    } else {
      lineErrors.quantity = labeled('Quantity', detail.message);
    }
  }
  return { errors, stock };
}
