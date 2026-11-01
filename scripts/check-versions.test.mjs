import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRepository, findDependencyProblems, findNpmrcProblems, parseNpmrc } from './check-versions.mjs';

const VALID_NPMRC = 'save-exact=true\nengine-strict=true\nmin-release-age=14\n';
const scriptPath = fileURLToPath(new URL('./check-versions.mjs', import.meta.url));
const tempDirs = [];

function createRepo({ npmrc = VALID_NPMRC, lockfile = true, root = {}, workspaces = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-versions-'));
  tempDirs.push(dir);
  if (npmrc !== null) writeFileSync(join(dir, '.npmrc'), npmrc);
  if (lockfile) writeFileSync(join(dir, 'package-lock.json'), '{}');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: Object.keys(workspaces), ...root }));
  for (const [name, manifest] of Object.entries(workspaces)) {
    if (manifest === null) continue;
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'package.json'), JSON.stringify(manifest));
  }
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('parseNpmrc', () => {
  test('reads key=value lines and skips comments and blanks', () => {
    const settings = parseNpmrc('# comment\n; other\n\n save-exact = true \r\nbroken-line\nmin-release-age=14');
    assert.deepEqual([...settings], [
      ['save-exact', 'true'],
      ['min-release-age', '14'],
    ]);
  });
});

describe('findNpmrcProblems', () => {
  test('accepts the required settings', () => {
    assert.deepEqual(findNpmrcProblems(VALID_NPMRC), []);
  });

  test('reports missing and wrong settings', () => {
    assert.deepEqual(findNpmrcProblems('save-exact=false\nengine-strict=true'), [
      '.npmrc: expected save-exact=true, found save-exact=false',
      '.npmrc: expected min-release-age=14, found nothing',
    ]);
  });
});

describe('findDependencyProblems', () => {
  test('accepts exact versions in every dependency field', () => {
    const manifest = {
      dependencies: { a: '1.2.3' },
      devDependencies: { b: '10.0.0' },
      optionalDependencies: { c: '0.0.1' },
    };
    assert.deepEqual(findDependencyProblems(manifest, 'pkg'), []);
  });

  test('accepts a manifest without dependencies', () => {
    assert.deepEqual(findDependencyProblems({}, 'pkg'), []);
  });

  for (const range of ['^1.2.3', '~1.2.3', '>=1.0.0', '1.x', '*', 'latest', '1.2', '1.2.3-beta.1', 'file:../x']) {
    test(`rejects "${range}"`, () => {
      assert.deepEqual(findDependencyProblems({ devDependencies: { a: range } }, 'pkg'), [
        `pkg: devDependencies.a must be an exact version, found "${range}"`,
      ]);
    });
  }
});

describe('checkRepository', () => {
  test('passes on a compliant repository', () => {
    const dir = createRepo({
      root: { devDependencies: { a: '1.0.0' } },
      workspaces: { backend: { dependencies: { b: '2.0.0' } } },
    });
    assert.deepEqual(checkRepository(dir), []);
  });

  test('reports a missing .npmrc, lockfile and workspace manifest', () => {
    const dir = createRepo({ npmrc: null, lockfile: false, workspaces: { frontend: null } });
    assert.deepEqual(checkRepository(dir), [
      '.npmrc is missing',
      'package-lock.json is missing',
      'frontend/package.json is missing',
    ]);
  });

  test('reports ranges in the root and in workspaces', () => {
    const dir = createRepo({
      root: { devDependencies: { a: '^1.0.0' } },
      workspaces: { backend: { dependencies: { b: '~2.0.0' } } },
    });
    assert.deepEqual(checkRepository(dir), [
      'package.json: devDependencies.a must be an exact version, found "^1.0.0"',
      'backend/package.json: dependencies.b must be an exact version, found "~2.0.0"',
    ]);
  });

  test('reports a missing root package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-versions-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, '.npmrc'), VALID_NPMRC);
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    assert.deepEqual(checkRepository(dir), ['package.json is missing']);
  });
});

describe('CLI', () => {
  test('exits with 0 on a compliant repository', () => {
    const dir = createRepo();
    const result = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exact versions/);
  });

  test('exits with 1 and lists the problems', () => {
    const dir = createRepo({ lockfile: false });
    const result = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package-lock\.json is missing/);
  });
});
