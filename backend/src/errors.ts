export interface ErrorDetail {
  path?: string;
  message: string;
  [key: string]: unknown;
}

/** An error whose status, code and message are safe to send to the client. */
export class AppError extends Error {
  override name = 'AppError';
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[];
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: ErrorDetail[]; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = options.details ?? [];
    this.headers = options.headers ?? {};
  }
}

export const notFound = (resource: string, label: string) =>
  new AppError(404, `${resource}_NOT_FOUND`, `${label} not found.`);

/** No valid session: the client signs in again. */
export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

/**
 * A create whose client-generated id is already taken by different data (the
 * same write repeated returns the stored resource instead; see `Created`).
 */
export const alreadyExists = () => new AppError(409, 'ALREADY_EXISTS', 'A resource with this id already exists.');
