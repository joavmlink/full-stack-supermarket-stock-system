// Every page is its own chunk. The factories live here so the router (lazy)
// and the startup preload share them; a chunk is downloaded once either way.
export const pages = {
  login: () => import('./pages/LoginPage'),
  products: () => import('./pages/ProductsPage'),
  productForm: () => import('./pages/ProductFormPage'),
  movementForm: () => import('./pages/StockMovementFormPage'),
  movements: () => import('./pages/StockMovementsPage'),
  movementDetail: () => import('./pages/StockMovementDetailPage'),
  categories: () => import('./pages/CategoriesPage'),
  employees: () => import('./pages/EmployeesPage'),
  employeeForm: () => import('./pages/EmployeeFormPage'),
  notFound: () => import('./pages/NotFoundPage'),
};

/** Pages every role can open; the admin pages are never fetched before the role is known. */
const PRELOADABLE: [RegExp, () => Promise<unknown>][] = [
  [/^\/$/, pages.products],
  [/^\/login$/, pages.login],
  [/^\/stock-movements$/, pages.movements],
  [/^\/stock-movements\/new$/, pages.movementForm],
  [/^\/stock-movements\/[^/]+$/, pages.movementDetail],
];

/**
 * Starts downloading the page of the first URL while the session is checked,
 * instead of after it. A failure here is ignored: the router asks again and
 * handles it (preload-error reload, then the error boundary).
 */
export function preloadPage(pathname: string): void {
  const page = PRELOADABLE.find(([pattern]) => pattern.test(pathname))?.[1];
  page?.().catch(() => undefined);
}
