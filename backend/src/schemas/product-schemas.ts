import { z } from 'zod';
import { MAX_QUANTITY } from '../db/schema.js';
import { PageQuerySchema, requiredTextSchema, textSchema } from './common-schemas.js';

/**
 * Money travels as a canonical decimal string ("1234.50"), never a JS number,
 * so no precision is lost. Up to 8 integer digits fit NUMERIC(10,2). Input is
 * canonicalized ("012.5" becomes "12.50"), the form the database returns, so
 * a request and a stored product compare as plain strings.
 */
const PriceSchema = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'must be a decimal string with up to 8 integer digits and 2 decimals')
  .transform((value) => {
    const [integer = '0', decimals = ''] = value.split('.');
    return `${Number(integer)}.${decimals.padEnd(2, '0')}`;
  });

const QuantitySchema = z.number().int().min(0).max(MAX_QUANTITY);

const ProductFields = {
  categoryId: z.uuid(),
  brand: requiredTextSchema(60),
  name: requiredTextSchema(100),
  description: textSchema(1000),
  quantity: QuantitySchema,
  price: PriceSchema,
};

export const ProductCreateSchema = z.strictObject({
  id: z.uuid(),
  ...ProductFields,
  description: ProductFields.description.default(''),
});
export type ProductCreate = z.infer<typeof ProductCreateSchema>;

/** Partial update guarded by optimistic locking: `version` must match the stored one. */
export const ProductUpdateSchema = z
  .strictObject({
    version: z.number().int().min(1),
    ...z.object(ProductFields).partial().shape,
  })
  .refine(
    ({ version: _version, ...changes }) => Object.values(changes).some((value) => value !== undefined),
    'at least one field besides version is required',
  );
export type ProductUpdate = z.infer<typeof ProductUpdateSchema>;

export const ProductListQuerySchema = PageQuerySchema.extend({
  q: requiredTextSchema(100).optional(),
  categoryId: z.uuid().optional(),
});
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;

/** The product as the API returns it. */
const ProductDtoSchema = z.object({
  id: z.uuid(),
  category: z.object({ id: z.uuid(), name: z.string() }),
  brand: z.string(),
  name: z.string(),
  description: z.string(),
  quantity: z.number().int(),
  price: z.string(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof ProductDtoSchema>;
