// The data stores, wired to the real API (tests use the factories with fake
// APIs). Only pages import this module, so it loads with the first page and
// stays out of the shell's download; the session lives in `stores/auth.ts`.
import { createCategoriesApi, createProductsApi, createStatsApi } from '../api/catalog-api';
import { apiClient } from '../api/client';
import { createEmployeesApi } from '../api/employees-api';
import { createMovementsApi } from '../api/movements-api';
import type { EmployeeFields, MovementType, Product, ProductFields, StockMovement, User } from '../api/types';
import { employeeChanges, productChanges } from '../lib/forms';
import { memoizeRecent } from '../lib/memoize-recent';
import { authStore } from './auth';
import { createCategoriesStore } from './categories-store';
import { createEditorStore } from './editor-store';
import { createMovementFormStore } from './movement-form-store';
import { createPagedListStore } from './paged-list-store';
import { createPreferencesStore, safeStorage } from './preferences-store';
import { createResourceStore } from './resource-store';
import { realStoreDeps as deps } from './shared';
import { resetOnUserChange } from './user-data';

const preferencesStore = createPreferencesStore(safeStorage(() => window.localStorage));

const productsApi = createProductsApi(apiClient);
const categoriesApi = createCategoriesApi(apiClient);
const statsApi = createStatsApi(apiClient);
const movementsApi = createMovementsApi(apiClient);
const employeesApi = createEmployeesApi(apiClient);

/** '' means no filter. */
interface ProductFilters {
  q: string;
  categoryId: string;
}

const containsIgnoringCase = (text: string, query: string) =>
  text.toLocaleLowerCase('en').includes(query.toLocaleLowerCase('en'));

export const productsStore = createPagedListStore<Product, ProductFilters>({
  fetchPage: (filters, before) =>
    productsApi.list({ q: filters.q || undefined, categoryId: filters.categoryId || undefined, before }),
  matches: (product, { q, categoryId }) =>
    (categoryId === '' || product.category.id === categoryId) &&
    (q === '' || containsIgnoringCase(product.name, q) || containsIgnoringCase(product.brand, q)),
});

export const statsStore = createResourceStore(() => statsApi.get());

export const categoriesStore = createCategoriesStore(categoriesApi, deps);

export const productEditorStore = createEditorStore<Product, ProductFields>({
  get: productsApi.get,
  create: productsApi.create,
  update: (product, changes) => productsApi.update(product.id, product.version, changes),
  remove: productsApi.remove,
  changes: productChanges,
  onSaved: (product, created) =>
    created ? productsStore.getState().added(product) : productsStore.getState().updated(product),
  onRemoved: (id) => productsStore.getState().removed(id),
  deps,
});

/** '' means every type. */
interface MovementFilters {
  type: MovementType | '';
}

export const movementsStore = createPagedListStore<StockMovement, MovementFilters>({
  fetchPage: ({ type }, before) => movementsApi.list({ type: type || undefined, before }),
  matches: (movement, { type }) => type === '' || movement.type === type,
});

export const movementStore = createResourceStore((id) => movementsApi.get(id));

export const movementFormStore = createMovementFormStore({
  api: movementsApi,
  deps,
  initialType: () => preferencesStore.getState().movementType,
  onTypeChange: (type) => preferencesStore.getState().setMovementType(type),
  onRecorded: (movement) => movementsStore.getState().added(movement),
});

export const employeesStore = createPagedListStore<User, Record<string, never>>({
  fetchPage: (_filters, before) => employeesApi.list({ before }),
  matches: () => true,
});

export const employeeEditorStore = createEditorStore<User, EmployeeFields>({
  get: employeesApi.get,
  create: employeesApi.create,
  update: (employee, changes) => employeesApi.update(employee.id, changes),
  remove: employeesApi.remove,
  changes: employeeChanges,
  onSaved: (employee, created) =>
    created ? employeesStore.getState().added(employee) : employeesStore.getState().updated(employee),
  onRemoved: (id) => employeesStore.getState().removed(id),
  deps,
});

/**
 * The stock form's product picker: the first matches by name or brand. Each
 * picker asks again whenever it opens, so the same search within a few seconds
 * (another line, a refocus) reuses the answer.
 */
const productSearch = memoizeRecent((q: string) => productsApi.list({ q: q || undefined, limit: 8 }), { ttlMs: 5000 });
export const searchProducts = (q: string) => productSearch.get(q.trim());

resetOnUserChange(authStore, [
  () => productsStore.getState().reset(),
  () => statsStore.getState().reset(),
  () => categoriesStore.getState().reset(),
  () => productEditorStore.getState().reset(),
  () => movementsStore.getState().reset(),
  () => movementStore.getState().reset(),
  () => movementFormStore.getState().reset(),
  () => employeesStore.getState().reset(),
  () => employeeEditorStore.getState().reset(),
  () => productSearch.clear(),
]);
