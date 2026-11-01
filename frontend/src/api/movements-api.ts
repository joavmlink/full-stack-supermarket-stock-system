import type { HttpClient } from './http';
import { getPage, resourcePath } from './page';
import type { FormMovementType, MovementLineInput, MovementType, Page, StockMovement } from './types';

export interface MovementQuery {
  type?: MovementType;
  before?: string;
  limit?: number;
}

/** Movements are never edited or deleted. */
export interface MovementsApi {
  list(query: MovementQuery): Promise<Page<StockMovement>>;
  get(id: string): Promise<StockMovement>;
  create(id: string, type: FormMovementType, items: MovementLineInput[]): Promise<StockMovement>;
}

export function createMovementsApi(http: HttpClient): MovementsApi {
  return {
    list: (query) => getPage<StockMovement>(http, '/stock-movements', { ...query }),
    get: (id) => http.request<StockMovement>('GET', resourcePath('/stock-movements', id)),
    create: (id, type, items) => http.request<StockMovement>('POST', '/stock-movements', { body: { id, type, items } }),
  };
}
