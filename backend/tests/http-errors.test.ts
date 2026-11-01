import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AppError, notFound } from '../src/errors.js';
import { isDatabaseUnavailable, toHttpError } from '../src/middlewares/errors.js';

const withCode = (code: string, message = 'failure') => Object.assign(new Error(message), { code });

describe('toHttpError', () => {
  test('passes AppError through', () => {
    const error = notFound('PRODUCT', 'Product');
    assert.equal(toHttpError(error), error);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'PRODUCT_NOT_FOUND');
    assert.equal(error.message, 'Product not found.');
  });

  for (const [type, status, code] of [
    ['entity.parse.failed', 400, 'INVALID_JSON'],
    ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE'],
    ['encoding.unsupported', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['charset.unsupported', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ] as const) {
    test(`maps body parser error ${type} to ${status}`, () => {
      const error = toHttpError(Object.assign(new Error('x'), { type, status: 400 }));
      assert.equal(error.status, status);
      assert.equal(error.code, code);
    });
  }

  test('maps other 4xx errors (for example a malformed URL) to 400 BAD_REQUEST', () => {
    const error = toHttpError(Object.assign(new URIError('URI malformed'), { status: 400 }));
    assert.equal(error.status, 400);
    assert.equal(error.code, 'BAD_REQUEST');
    assert.equal(toHttpError(Object.assign(new Error('aborted'), { type: 'request.aborted', status: 400 })).code, 'BAD_REQUEST');
  });

  test('maps database unavailability to 503 with Retry-After', () => {
    const error = toHttpError(withCode('ECONNREFUSED'));
    assert.equal(error.status, 503);
    assert.equal(error.code, 'SERVICE_UNAVAILABLE');
    assert.deepEqual(error.headers, { 'Retry-After': '5' });
  });

  test('maps everything else to a generic 500', () => {
    for (const thrown of [new Error('secret detail'), 'a string', null, Object.assign(new Error('x'), { status: 500 })]) {
      const error = toHttpError(thrown);
      assert.equal(error.status, 500);
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.doesNotMatch(error.message, /secret/);
    }
  });
});

describe('isDatabaseUnavailable', () => {
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', '08006', '08001', '53300', '57P01', '57P02', '57P03', '57014', '25P03']) {
    test(`detects code ${code}`, () => assert.equal(isDatabaseUnavailable(withCode(code)), true));
  }

  for (const message of [
    'timeout exceeded when trying to connect',
    'Query read timeout',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'sorry, too many connections',
  ]) {
    test(`detects message "${message}"`, () => assert.equal(isDatabaseUnavailable(new Error(message)), true));
  }

  test('ignores other errors', () => {
    assert.equal(isDatabaseUnavailable(withCode('23505', 'duplicate key')), false);
    assert.equal(isDatabaseUnavailable(new Error('syntax error')), false);
    assert.equal(isDatabaseUnavailable('ECONNREFUSED'), false);
    assert.equal(isDatabaseUnavailable(new AppError(400, 'X', 'y')), false);
  });
});
