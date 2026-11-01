import type { Request } from 'express';
import type { z } from 'zod';
import { AppError, type ErrorDetail } from '../errors.js';
import { IdParamsSchema } from '../schemas/common-schemas.js';

function toErrorDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

export function validationError(message: string, details: ErrorDetail[]): AppError {
  return new AppError(400, 'VALIDATION_ERROR', message, { details });
}

/** Parses params or query with a Zod schema, turning failures into a 400 VALIDATION_ERROR. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown, label: string): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(`Invalid ${label}.`, toErrorDetails(result.error));
  return result.data;
}

/** The UUID `:id` route parameter (400 VALIDATION_ERROR when it is not one). */
export function idParam(req: Request): string {
  return parseInput(IdParamsSchema, req.params, 'path parameters').id;
}
