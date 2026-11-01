import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeRedirectPath } from '../../src/lib/redirect';

test('keeps a path inside the app, with its query and hash', () => {
  for (const path of ['/', '/products/new', '/stock-movements?type=sale', '/employees#top', '/login-help']) {
    assert.equal(safeRedirectPath(path), path);
  }
});

test('anything that could leave the app or loop back to sign-in goes home', () => {
  for (const value of [
    undefined,
    null,
    42,
    { pathname: '/x' },
    '',
    'products',
    'https://example.com',
    'javascript:alert(1)',
    '//example.com',
    '/\\example.com',
    '/\t/example.com',
    '/\n/example.com',
    '/login',
    '/login?next=/x',
    '/login#x',
  ]) {
    assert.equal(safeRedirectPath(value), '/', JSON.stringify(value));
  }
});
