/**
 * The `before` cursor of the `rel="next"` link in an RFC 8288 `Link` header,
 * or null when there is no next page. Only the cursor is taken: the store
 * rebuilds the request from its own filters and base URL, so the path the API
 * wrote (which includes `/api`) does not matter.
 */
export function nextPageCursor(link: string | null): string | null {
  if (link === null) return null;
  // Link values are separated by commas outside <...>; a URL never holds a raw ">".
  for (const value of link.match(/<[^>]*>[^<]*/g) ?? []) {
    const match = /^<([^>]*)>(.*)$/s.exec(value);
    if (match === null) continue;
    const [, target = '', params = ''] = match;
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(params);
    const relations = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (!relations.includes('next')) continue;
    try {
      return new URL(target, 'http://link.invalid').searchParams.get('before');
    } catch {
      return null;
    }
  }
  return null;
}
