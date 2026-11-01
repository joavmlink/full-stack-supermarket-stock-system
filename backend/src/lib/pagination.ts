import type { Request, Response } from 'express';
import { requestPath } from './routing.js';

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

/** Models fetch `limit + 1` rows; the extra row only signals that a next page exists. */
export function toPage<T>(rows: T[], limit: number): Page<T> {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Sends the page's items with the RFC 8288 `Link: <...>; rel="next"` header, which
 * keeps the current filters and moves the cursor to the last item of this page.
 */
export function sendPage(req: Request, res: Response, page: Page<{ id: string }>, query: object): void {
  const last = page.items.at(-1);
  if (page.hasMore && last !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && key !== 'before') params.set(key, String(value));
    }
    params.set('before', last.id);
    res.set('Link', `<${requestPath(req)}?${params.toString()}>; rel="next"`);
  }
  res.json(page.items);
}
