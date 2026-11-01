import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export interface VercelHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * The headers Vercel would send for `pathname`: every rule whose `source`
 * matches, in order, so a later rule overrides an earlier one. Only the
 * regular-expression subset of Vercel's source syntax is supported, which is
 * all vercel.json uses (`/(.*)`, `/assets/(.*)`).
 */
export function headersFor(rules: readonly VercelHeaderRule[], pathname: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rule of rules) {
    if (!new RegExp(`^${rule.source}$`).test(pathname)) continue;
    for (const { key, value } of rule.headers) headers[key] = value;
  }
  return headers;
}

/** Vercel serves a missing file under /assets/ as 404, never as the SPA's index.html. */
export function isMissingAsset(pathname: string, exists: (pathname: string) => boolean): boolean {
  return pathname.startsWith('/assets/') && !exists(pathname);
}

/** A malformed escape (`%E0`) names no file, so it stays as written and is reported missing. */
function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Makes `vite preview` behave like the Vercel deployment: the headers of
 * vercel.json on every response and a 404 for a missing chunk. The /api proxy
 * is configured in vite.config.ts.
 */
export function vercelPreview(vercelConfigPath: string): Plugin {
  return {
    name: 'vercel-preview',
    configurePreviewServer(server) {
      const { headers: rules = [] } = JSON.parse(readFileSync(vercelConfigPath, 'utf8')) as {
        headers?: VercelHeaderRule[];
      };
      const outDir = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, res, next) => {
        const { pathname } = new URL(req.url ?? '/', 'http://preview.invalid');
        for (const [key, value] of Object.entries(headersFor(rules, pathname))) res.setHeader(key, value);
        if (isMissingAsset(pathname, (asset) => existsSync(path.join(outDir, safeDecode(asset))))) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not found');
          return;
        }
        next();
      });
    },
  };
}
