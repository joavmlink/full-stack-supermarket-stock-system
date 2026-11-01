import { nextPageCursor } from '../lib/link-header';
import { ApiError } from './errors';
import type { HttpClient } from './http';
import type { Page } from './types';

/** `/products/<id>`, with the id encoded. */
export const resourcePath = (collection: string, id: string) => `${collection}/${encodeURIComponent(id)}`;

export type QueryParams = Record<string, string | number | undefined>;

/** GET a keyset-paginated list; empty and undefined params are left out. */
export async function getPage<T>(http: HttpClient, path: string, params: QueryParams = {}): Promise<Page<T>> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const search = query.size > 0 ? `?${query.toString()}` : '';
  const { data, headers } = await http.requestWithHeaders<T[]>('GET', `${path}${search}`);
  return { items: data, nextCursor: nextPageCursor(headers.get('link')) };
}

/**
 * A DELETE whose resource is already gone did its job: after a retry whose
 * first response was lost, or when someone else deleted it first. Only the
 * resource's own 404 code counts, never an unknown route.
 */
export function deleteResource(http: HttpClient, path: string, notFoundCode: string): Promise<void> {
  return http.request<void>('DELETE', path).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404 && error.code === notFoundCode) return;
    throw error;
  });
}
