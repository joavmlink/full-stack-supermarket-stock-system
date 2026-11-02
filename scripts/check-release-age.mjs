#!/usr/bin/env node
// Checks that every package in package-lock.json was published at least
// MIN_RELEASE_AGE_DAYS ago. npm only applies `min-release-age` when it resolves
// new versions, so this covers what is already pinned in the lockfile.
// Usage: node scripts/check-release-age.mjs [--days=14] [--exclude=<package>]...
// --exclude mirrors npm's --min-release-age-exclude for documented security fixes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MIN_DAYS = 14;
const REGISTRY = 'https://registry.npmjs.org';
const CONCURRENCY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the unique `name@version` pairs of the registry packages in a v3 lockfile. */
export function listLockedPackages(lockfile) {
  const seen = new Map();
  for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
    if (path === '' || entry.link || !entry.version || !entry.resolved?.startsWith(REGISTRY)) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    seen.set(`${name}@${entry.version}`, { name, version: entry.version });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns the packages published less than `minDays` before `now`, or with an unknown date. */
export function findTooRecent(packages, publishTimes, now, minDays, excluded = new Set()) {
  const cutoff = now.getTime() - minDays * DAY_MS;
  const problems = [];
  for (const { name, version } of packages) {
    if (excluded.has(name)) continue;
    const published = publishTimes.get(`${name}@${version}`);
    if (published === undefined || Number.isNaN(published.getTime())) {
      problems.push({ name, version, published: null });
    } else if (published.getTime() > cutoff) {
      problems.push({ name, version, published });
    }
  }
  return problems;
}

/** Reads `--days=`: a mistyped value must stop the check, not make every date pass. */
export function parseMinDays(args) {
  const daysArg = args.find((arg) => arg.startsWith('--days='));
  if (!daysArg) return DEFAULT_MIN_DAYS;
  const value = daysArg.slice('--days='.length);
  if (!/^\d+$/.test(value)) throw new Error(`Invalid value: ${daysArg}`);
  return Number(value);
}

async function fetchPublishTimes(packages) {
  const times = new Map();
  const names = [...new Set(packages.map((pkg) => pkg.name))];
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next++];
      const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`);
      if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
      const { time = {} } = await response.json();
      for (const [version, date] of Object.entries(time)) times.set(`${name}@${version}`, new Date(date));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return times;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const minDays = parseMinDays(process.argv);
  const excluded = new Set(
    process.argv.filter((arg) => arg.startsWith('--exclude=')).map((arg) => arg.slice('--exclude='.length)),
  );
  const packages = listLockedPackages(JSON.parse(readFileSync('package-lock.json', 'utf8')));
  const problems = findTooRecent(packages, await fetchPublishTimes(packages), new Date(), minDays, excluded);
  if (problems.length > 0) {
    for (const { name, version, published } of problems) {
      console.error(`✗ ${name}@${version} published ${published ? published.toISOString() : 'at an unknown date'}`);
    }
    process.exit(1);
  }
  const note = excluded.size > 0 ? ` (excluded: ${[...excluded].join(', ')})` : '';
  console.log(`✓ All ${packages.length} locked packages are at least ${minDays} days old${note}.`);
}
