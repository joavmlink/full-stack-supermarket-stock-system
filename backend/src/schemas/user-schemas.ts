import { z } from 'zod';
import { requiredTextSchema } from './common-schemas.js';
import { normalizePassword } from '../lib/password.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/password-policy.js';

export const RoleSchema = z.enum(['admin', 'employee']);
export type Role = z.infer<typeof RoleSchema>;

const FullNameSchema = requiredTextSchema(100);

/** Emails are stored lowercase, so lookups and the unique index are case-insensitive. */
const EmailSchema = z.string().trim().toLowerCase().pipe(z.email('must be a valid email').max(254));

const codePoints = (value: string) => [...value].length;

/** Any password: NFC-normalized and at most 128 code points (NIST SP 800-63B-4). */
const PasswordSchema = z
  .string()
  .transform(normalizePassword)
  .refine((value) => codePoints(value) <= PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

/** A password being set: also at least 15 code points, with no composition rules. */
const NewPasswordSchema = PasswordSchema.refine(
  (value) => codePoints(value) >= PASSWORD_MIN_LENGTH,
  `must be at least ${PASSWORD_MIN_LENGTH} characters`,
);

export const LoginBodySchema = z.strictObject({
  email: EmailSchema,
  password: z.string().min(1, 'is required').pipe(PasswordSchema),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

export const EmployeeCreateSchema = z.strictObject({
  id: z.uuid(),
  fullName: FullNameSchema,
  email: EmailSchema,
  password: NewPasswordSchema,
});
export type EmployeeCreate = z.infer<typeof EmployeeCreateSchema>;

export const EmployeeUpdateSchema = z
  .strictObject({
    fullName: FullNameSchema.optional(),
    email: EmailSchema.optional(),
    password: NewPasswordSchema.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'at least one field is required');
export type EmployeeUpdate = z.infer<typeof EmployeeUpdateSchema>;

export const AdminCreateSchema = EmployeeCreateSchema.omit({ id: true });

/** The user as the API returns it. */
const UserDtoSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  role: RoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserDtoSchema>;
