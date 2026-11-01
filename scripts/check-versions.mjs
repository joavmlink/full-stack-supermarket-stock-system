#!/usr/bin/env node
// Enforces the dependency policy: exact versions everywhere, a committed
// lockfile and the required .npmrc settings. Exits with code 1 on any problem.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_NPMRC = Object.freeze({
  'save-exact': 'true',
  'engine-strict': 'true',
  'min-release-age': '14',
});

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Parses the `key=value` lines of an .npmrc file, ignoring comments. */
export function parseNpmrc(text) {
  const settings = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    settings.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return settings;
}

export function findNpmrcProblems(text) {
  const settings = parseNpmrc(text);
  const problems = [];
  for (const [key, expected] of Object.entries(REQUIRED_NPMRC)) {
    const actual = settings.get(key);
    if (actual !== expected) {
      problems.push(`.npmrc: expected ${key}=${expected}, found ${actual === undefined ? 'nothing' : `${key}=${actual}`}`);
    }
  }
  return problems;
}

export function findDependencyProblems(manifest, label) {
  const problems = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
        problems.push(`${label}: ${field}.${name} must be an exact version, found "${version}"`);
      }
    }
  }
  return problems;
}

export function checkRepository(rootDir) {
  const problems = [];
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

  const npmrcPath = join(rootDir, '.npmrc');
  if (existsSync(npmrcPath)) {
    problems.push(...findNpmrcProblems(readFileSync(npmrcPath, 'utf8')));
  } else {
    problems.push('.npmrc is missing');
  }

  if (!existsSync(join(rootDir, 'package-lock.json'))) {
    problems.push('package-lock.json is missing');
  }

  const rootManifestPath = join(rootDir, 'package.json');
  if (!existsSync(rootManifestPath)) {
    problems.push('package.json is missing');
    return problems;
  }
  const rootManifest = readJson(rootManifestPath);
  problems.push(...findDependencyProblems(rootManifest, 'package.json'));

  for (const workspace of rootManifest.workspaces ?? []) {
    const manifestPath = join(rootDir, workspace, 'package.json');
    const label = `${workspace}/package.json`;
    if (!existsSync(manifestPath)) {
      problems.push(`${label} is missing`);
      continue;
    }
    problems.push(...findDependencyProblems(readJson(manifestPath), label));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const problems = checkRepository(process.cwd());
  if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
  }
  console.log('✓ Exact versions, lockfile and .npmrc settings are in place.');
}
