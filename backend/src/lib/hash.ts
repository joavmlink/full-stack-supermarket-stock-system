import { createHash } from 'node:crypto';

/** Hex SHA-256, used wherever an identifier (IP, email) must be stored without its raw value. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
