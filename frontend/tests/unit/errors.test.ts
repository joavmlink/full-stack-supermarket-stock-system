import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  HTTP_ERROR,
  INVALID_RESPONSE,
  NETWORK_ERROR,
  errorMessage,
  isRetryable,
  isUnauthenticated,
} from '../../src/api/errors';

test('errorMessage shows the API message and hides anything else', () => {
  assert.equal(errorMessage(new ApiError(409, 'CATEGORY_IN_USE', 'The category has products.')), 'The category has products.');
  assert.equal(errorMessage(new TypeError('x is undefined')), 'Something went wrong. Please try again.');
  assert.equal(errorMessage('boom'), 'Something went wrong. Please try again.');
});

test('only errors that can go away on their own are retryable', () => {
  const cases: [unknown, boolean][] = [
    [new ApiError(0, NETWORK_ERROR, 'offline'), true],
    [new ApiError(429, 'RATE_LIMITED', 'slow down'), true],
    [new ApiError(500, 'INTERNAL_ERROR', 'oops'), true],
    [new ApiError(502, HTTP_ERROR, 'bad gateway'), true],
    [new ApiError(503, 'DATABASE_UNAVAILABLE', 'later'), true],
    [new ApiError(200, INVALID_RESPONSE, 'html'), false],
    [new ApiError(400, 'VALIDATION_ERROR', 'bad'), false],
    [new ApiError(401, 'UNAUTHENTICATED', 'sign in'), false],
    [new ApiError(403, 'FORBIDDEN', 'no'), false],
    [new ApiError(404, 'PRODUCT_NOT_FOUND', 'gone'), false],
    [new ApiError(409, 'INSUFFICIENT_STOCK', 'no stock'), false],
    [new Error('not from the API'), false],
  ];
  for (const [error, expected] of cases) assert.equal(isRetryable(error), expected, String(error));
});

test('isUnauthenticated matches only 401 UNAUTHENTICATED', () => {
  assert.equal(isUnauthenticated(new ApiError(401, 'UNAUTHENTICATED', 'sign in')), true);
  assert.equal(isUnauthenticated(new ApiError(401, 'INVALID_CREDENTIALS', 'wrong')), false);
  assert.equal(isUnauthenticated(new ApiError(403, 'UNAUTHENTICATED', 'odd')), false);
  assert.equal(isUnauthenticated(new Error('UNAUTHENTICATED')), false);
});
