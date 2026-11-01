import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { headersFor, isMissingAsset, type VercelHeaderRule } from '../../vercel-preview';

const vercel = JSON.parse(readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')) as {
  headers: VercelHeaderRule[];
};

test('every page gets the security headers of vercel.json, without the asset cache', () => {
  for (const pathname of ['/', '/login', '/products/new', '/api/health']) {
    const headers = headersFor(vercel.headers, pathname);
    assert.match(headers['Content-Security-Policy'] ?? '', /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Cache-Control'], undefined, pathname);
  }
});

test('assets also get the immutable cache', () => {
  const headers = headersFor(vercel.headers, '/assets/index-abc123.js');
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(headers['X-Frame-Options'], 'DENY');
});

test('a later rule overrides an earlier one, and a source matches the whole path', () => {
  const rules: VercelHeaderRule[] = [
    { source: '/(.*)', headers: [{ key: 'X-Test', value: 'all' }] },
    { source: '/docs', headers: [{ key: 'X-Test', value: 'docs' }] },
  ];
  assert.equal(headersFor(rules, '/docs')['X-Test'], 'docs');
  assert.equal(headersFor(rules, '/docs/more')['X-Test'], 'all');
});

test('only a missing file under /assets/ is a 404; other paths fall back to the SPA', () => {
  const existing = new Set(['/assets/index-abc.js']);
  const exists = (pathname: string) => existing.has(pathname);
  assert.equal(isMissingAsset('/assets/index-abc.js', exists), false);
  assert.equal(isMissingAsset('/assets/ProductsPage-old.js', exists), true);
  assert.equal(isMissingAsset('/products/new', exists), false);
  assert.equal(isMissingAsset('/assetsx/file.js', exists), false);
});
