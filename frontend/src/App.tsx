import { lazy, Suspense, type ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { PageFallback } from './components/PageFallback';
import { RequireAuth } from './components/RequireAuth';
import { RequireRole } from './components/RequireRole';
import { RouteBoundary } from './components/RouteBoundary';
import { pages } from './pages';

// One page, one chunk: every route is lazy, so the first load only downloads
// what every screen shares (React, the router, the layout and the session).
// An employee never downloads the admin pages: RequireRole renders nothing lazy for them.
const LoginPage = lazy(pages.login);
const ProductsPage = lazy(pages.products);
const ProductFormPage = lazy(pages.productForm);
const StockMovementFormPage = lazy(pages.movementForm);
const StockMovementsPage = lazy(pages.movements);
const StockMovementDetailPage = lazy(pages.movementDetail);
const CategoriesPage = lazy(pages.categories);
const EmployeesPage = lazy(pages.employees);
const EmployeeFormPage = lazy(pages.employeeForm);
const NotFoundPage = lazy(pages.notFound);

const adminOnly = (page: ReactNode) => <RequireRole role="admin">{page}</RequireRole>;

export function App() {
  return (
    // The shell's boundary; each page has its own inside the layout (RouteBoundary).
    <ErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route
            path="/login"
            element={
              <RouteBoundary>
                <LoginPage />
              </RouteBoundary>
            }
          />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<ProductsPage />} />
            <Route path="products/new" element={adminOnly(<ProductFormPage />)} />
            <Route path="products/:id/edit" element={adminOnly(<ProductFormPage />)} />
            <Route path="stock-movements" element={<StockMovementsPage />} />
            <Route path="stock-movements/new" element={<StockMovementFormPage />} />
            <Route path="stock-movements/:id" element={<StockMovementDetailPage />} />
            <Route path="categories" element={adminOnly(<CategoriesPage />)} />
            <Route path="employees" element={adminOnly(<EmployeesPage />)} />
            <Route path="employees/new" element={adminOnly(<EmployeeFormPage />)} />
            <Route path="employees/:id/edit" element={adminOnly(<EmployeeFormPage />)} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
