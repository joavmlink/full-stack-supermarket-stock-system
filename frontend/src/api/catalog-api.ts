import type { HttpClient } from './http';
import { deleteResource, getPage, resourcePath as at } from './page';
import type { Category, Page, Product, ProductFields, Stats } from './types';

export interface ProductQuery {
  q?: string;
  categoryId?: string;
  before?: string;
  limit?: number;
}

export interface CategoriesApi {
  list(params: { before?: string; limit?: number }): Promise<Page<Category>>;
  create(id: string, name: string): Promise<Category>;
  rename(id: string, name: string): Promise<Category>;
  remove(id: string): Promise<void>;
}

export interface ProductsApi {
  list(query: ProductQuery): Promise<Page<Product>>;
  get(id: string): Promise<Product>;
  create(id: string, fields: ProductFields): Promise<Product>;
  update(id: string, version: number, changes: Partial<ProductFields>): Promise<Product>;
  remove(id: string): Promise<void>;
}

export interface StatsApi {
  get(): Promise<Stats>;
}

export function createCategoriesApi(http: HttpClient): CategoriesApi {
  return {
    list: (params) => getPage<Category>(http, '/categories', { ...params }),
    create: (id, name) => http.request<Category>('POST', '/categories', { body: { id, name } }),
    rename: (id, name) => http.request<Category>('PATCH', at('/categories', id), { body: { name } }),
    remove: (id) => deleteResource(http, at('/categories', id), 'CATEGORY_NOT_FOUND'),
  };
}

export function createProductsApi(http: HttpClient): ProductsApi {
  return {
    list: (query) => getPage<Product>(http, '/products', { ...query }),
    get: (id) => http.request<Product>('GET', at('/products', id)),
    create: (id, fields) => http.request<Product>('POST', '/products', { body: { id, ...fields } }),
    update: (id, version, changes) =>
      http.request<Product>('PATCH', at('/products', id), { body: { version, ...changes } }),
    remove: (id) => deleteResource(http, at('/products', id), 'PRODUCT_NOT_FOUND'),
  };
}

export function createStatsApi(http: HttpClient): StatsApi {
  return { get: () => http.request<Stats>('GET', '/stats') };
}
