import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_MIN_DAYS, findTooRecent, listLockedPackages, parseMinDays } from './check-release-age.mjs';

const REGISTRY = 'https://registry.npmjs.org';

describe('listLockedPackages', () => {
  test('lists unique registry packages, including scoped and nested ones', () => {
    const lockfile = {
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'node_modules/a': { version: '1.0.0', resolved: `${REGISTRY}/a/-/a-1.0.0.tgz` },
        'node_modules/@scope/b': { version: '2.0.0', resolved: `${REGISTRY}/@scope/b/-/b-2.0.0.tgz` },
        'node_modules/c/node_modules/a': { version: '1.0.0', resolved: `${REGISTRY}/a/-/a-1.0.0.tgz` },
        'node_modules/alias': { name: 'real', version: '3.0.0', resolved: `${REGISTRY}/real/-/real-3.0.0.tgz` },
        'node_modules/backend': { resolved: 'backend', link: true },
        backend: { version: '0.0.0' },
        'node_modules/git-dep': { version: '1.0.0', resolved: 'git+https://example.com/x.git' },
      },
    };
    assert.deepEqual(listLockedPackages(lockfile), [
      { name: '@scope/b', version: '2.0.0' },
      { name: 'a', version: '1.0.0' },
      { name: 'real', version: '3.0.0' },
    ]);
  });

  test('handles a lockfile without packages', () => {
    assert.deepEqual(listLockedPackages({}), []);
  });
});

describe('findTooRecent', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const packages = [
    { name: 'old', version: '1.0.0' },
    { name: 'edge', version: '1.0.0' },
    { name: 'new', version: '1.0.0' },
    { name: 'unknown', version: '1.0.0' },
  ];
  const times = new Map([
    ['old@1.0.0', new Date('2026-01-01T00:00:00Z')],
    ['edge@1.0.0', new Date('2026-10-16T12:00:00Z')],
    ['new@1.0.0', new Date('2026-10-16T12:00:01Z')],
  ]);

  test('flags packages newer than the window and packages without a date', () => {
    assert.deepEqual(findTooRecent(packages, times, now, 14), [
      { name: 'new', version: '1.0.0', published: new Date('2026-10-16T12:00:01Z') },
      { name: 'unknown', version: '1.0.0', published: null },
    ]);
  });

  test('skips excluded packages', () => {
    assert.deepEqual(findTooRecent(packages, times, now, 14, new Set(['new', 'unknown'])), []);
  });

  test('flags a package whose date cannot be read', () => {
    const unreadable = new Map([['old@1.0.0', new Date('not a date')]]);
    assert.deepEqual(findTooRecent([{ name: 'old', version: '1.0.0' }], unreadable, now, 14), [
      { name: 'old', version: '1.0.0', published: null },
    ]);
  });
});

describe('parseMinDays', () => {
  test('uses the default without the option', () => {
    assert.equal(parseMinDays(['node', 'script', '--exclude=a']), DEFAULT_MIN_DAYS);
  });

  test('reads a whole number of days', () => {
    assert.equal(parseMinDays(['--days=30']), 30);
    assert.equal(parseMinDays(['--days=0']), 0);
  });

  for (const value of ['abc', '', '-1', '1.5', '1e3', ' 14', '14 ']) {
    test(`stops the check on --days=${value}`, () => {
      assert.throws(() => parseMinDays([`--days=${value}`]), /Invalid value/);
    });
  }
});
