#!/usr/bin/env node
// Checks that every package in package-lock.json comes from the npm registry and
// was published at least DEFAULT_MIN_DAYS ago. npm only applies `min-release-age`
// when it resolves new versions, so this covers what is already pinned in the lockfile.
// Usage: node scripts/check-release-age.mjs [--days=14] [--exclude=<package>]...
// --exclude mirrors npm's --min-release-age-exclude for documented security fixes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MIN_DAYS = 14;
const REGISTRY = 'https://registry.npmjs.org/';
const CONCURRENCY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The packages npm installs: not the root, the workspaces or the links to them. */
function installedPackages(lockfile) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([path, entry]) => path.includes('node_modules/') && !entry.link)
    .map(([path, entry]) => ({
      name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version,
      resolved: entry.resolved,
    }));
}

/** Without a `resolved` URL, npm fetches the package from the registry. */
const isForeign = ({ resolved }) => resolved !== undefined && !resolved.startsWith(REGISTRY);

/** Returns the unique `name@version` pairs of the registry packages in a v3 lockfile. */
export function listLockedPackages(lockfile) {
  const seen = new Map();
  for (const pkg of installedPackages(lockfile)) {
    if (!pkg.version || isForeign(pkg)) continue;
    seen.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Returns the packages whose age cannot be checked because they do not come from the registry. */
export function listForeignPackages(lockfile) {
  return installedPackages(lockfile)
    .filter(isForeign)
    .map(({ name, resolved }) => ({ name, resolved }));
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
      const response = await fetch(`${REGISTRY}${name.replace('/', '%2F')}`);
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
  const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const packages = listLockedPackages(lockfile);
  const foreign = listForeignPackages(lockfile);
  const problems = findTooRecent(packages, await fetchPublishTimes(packages), new Date(), minDays, excluded);
  for (const { name, resolved } of foreign) {
    console.error(`✗ ${name} does not come from the npm registry: ${resolved}`);
  }
  for (const { name, version, published } of problems) {
    console.error(`✗ ${name}@${version} published ${published ? published.toISOString() : 'at an unknown date'}`);
  }
  if (foreign.length > 0 || problems.length > 0) process.exit(1);
  const note = excluded.size > 0 ? ` (excluded: ${[...excluded].join(', ')})` : '';
  console.log(`✓ All ${packages.length} locked packages are at least ${minDays} days old${note}.`);
}
