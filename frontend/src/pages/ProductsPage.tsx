import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useStore } from 'zustand';
import type { Product, Stats } from '../api/types';
import { ErrorState } from '../components/ErrorState';
import { LinkButton, PageHeader, StockBadge, textLinkClass } from '../components/feedback';
import { SelectField, TextField } from '../components/fields';
import { PagedListView } from '../components/PagedListView';
import { SEARCH_MAX } from '../api/limits';
import { useDebouncedValue } from '../hooks/use-debounced-value';
import { useDocumentTitle } from '../hooks/use-document-title';
import { useUpdateSearchParams } from '../hooks/use-update-search-params';
import { formatMoney } from '../lib/money';
import { formatInteger } from '../lib/numbers';
import { categoriesStore, productsStore, statsStore } from '../stores';
import { useAuth } from '../stores/auth';

const SEARCH_DELAY_MS = 300;

export default function ProductsPage() {
  useDocumentTitle('Products');
  const isAdmin = useAuth((state) => state.user?.role === 'admin');
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const categoryId = params.get('category') ?? '';

  return (
    <section data-testid="products-page">
      <PageHeader
        title="Products"
        actions={
          <>
            <LinkButton variant="secondary" to="/stock-movements/new">
              Record movement
            </LinkButton>
            {isAdmin && (
              <LinkButton to="/products/new" data-testid="new-product">
                New product
              </LinkButton>
            )}
          </>
        }
      />
      <StatsPanel isAdmin={isAdmin} />
      <Filters q={q} categoryId={categoryId} />
      <ProductList q={q} categoryId={categoryId} isAdmin={isAdmin} />
    </section>
  );
}

function StatsPanel({ isAdmin }: { isAdmin: boolean }) {
  const stats = useStore(statsStore, (state) => state.data);
  const status = useStore(statsStore, (state) => state.status);
  const error = useStore(statsStore, (state) => state.error);

  useEffect(() => {
    void statsStore.getState().load('stats');
  }, []);

  if (status === 'error' && stats === null) {
    return (
      <div className="mb-6">
        <ErrorState message={`Could not load the totals. ${error ?? ''}`} onRetry={() => void statsStore.getState().load('stats')} />
      </div>
    );
  }
  if (stats === null) return <div className="mb-6 h-24 animate-pulse rounded-xl bg-slate-200/60 motion-reduce:animate-none" aria-hidden="true" />;
  return (
    <section aria-labelledby="stats-title" className="mb-6" data-testid="stats">
      <h2 id="stats-title" className="sr-only">
        Totals
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {tiles(stats, isAdmin).map((tile) => (
          <div key={tile.label} className="rounded-xl border border-slate-200 bg-white p-3" data-testid={`stat-${tile.id}`}>
            <dt className="text-sm text-slate-600">{tile.label}</dt>
            <dd className={`text-lg font-semibold break-words ${tile.alert ? 'text-red-800' : ''}`}>{tile.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function tiles(stats: Stats, isAdmin: boolean) {
  const list = [
    { id: 'products', label: 'Products', value: formatInteger(stats.products.total), alert: false },
    { id: 'out-of-stock', label: 'Out of stock', value: formatInteger(stats.products.outOfStock), alert: stats.products.outOfStock > 0 },
    {
      id: 'low-stock',
      label: `Low stock (1–${stats.lowStockThreshold})`,
      value: formatInteger(stats.products.lowStock),
      alert: false,
    },
    { id: 'units', label: 'Units in stock', value: formatInteger(stats.products.totalUnits), alert: false },
    { id: 'value', label: 'Inventory value', value: formatMoney(stats.products.inventoryValue), alert: false },
    { id: 'categories', label: 'Categories', value: formatInteger(stats.categories.total), alert: false },
    // Employees count only the movements they recorded.
    { id: 'sales', label: isAdmin ? 'Sales' : 'Your sales', value: formatInteger(stats.movements.sale), alert: false },
    { id: 'restocks', label: isAdmin ? 'Restocks' : 'Your restocks', value: formatInteger(stats.movements.restock), alert: false },
  ];
  if (stats.employees !== undefined) {
    list.push({ id: 'employees', label: 'Employees', value: formatInteger(stats.employees.total), alert: false });
  }
  return list;
}

function Filters({ q, categoryId }: { q: string; categoryId: string }) {
  const categories = useStore(categoriesStore, (state) => state.items);
  const categoriesStatus = useStore(categoriesStore, (state) => state.status);
  const updateParams = useUpdateSearchParams();
  const [text, setText] = useState(q);
  const debounced = useDebouncedValue(text, SEARCH_DELAY_MS);

  useEffect(() => {
    void categoriesStore.getState().load();
  }, []);

  // Typing reaches the URL after a pause, replacing the history entry (no entry per keystroke).
  useEffect(() => {
    updateParams({ q: debounced.trim() }, { replace: true });
  }, [debounced, updateParams]);

  // The URL changed on its own (Back): show its search, unless the user is still typing.
  useEffect(() => {
    setText((current) => (current === debounced && current.trim() !== q ? q : current));
    // Only a change of the URL's search runs this (`debounced` is read as it is then).
  }, [q]);

  return (
    <form role="search" aria-label="Products" className="mb-4 grid gap-3 sm:grid-cols-[1fr_16rem]" onSubmit={(event) => event.preventDefault()}>
      <TextField
        label="Search"
        type="search"
        placeholder="Name or brand"
        value={text}
        maxLength={SEARCH_MAX}
        onChange={(event) => setText(event.target.value)}
        testId="product-search"
      />
      <SelectField
        label="Category"
        value={categoryId}
        // A new history entry, so Back undoes the filter.
        onChange={(event) => updateParams({ category: event.target.value }, { replace: false })}
        testId="category-filter"
      >
        <option value="">All categories</option>
        {categoryId !== '' && categoriesStatus === 'loaded' && !categories.some((category) => category.id === categoryId) && (
          <option value={categoryId}>Unknown category</option>
        )}
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </SelectField>
    </form>
  );
}

function ProductList({ q, categoryId, isAdmin }: { q: string; categoryId: string; isAdmin: boolean }) {
  const load = () => void productsStore.getState().load({ q, categoryId });

  useEffect(() => {
    void productsStore.getState().load({ q, categoryId });
  }, [q, categoryId]);

  const filtered = q !== '' || categoryId !== '';
  return (
    <PagedListView
      store={productsStore}
      onRetry={load}
      errorText="Could not load the products."
      empty={
        filtered ? (
          'No products match these filters.'
        ) : isAdmin ? (
          <>
            There are no products yet.{' '}
            <Link to="/products/new" className={textLinkClass}>
              Add the first one
            </Link>
            .
          </>
        ) : (
          'There are no products yet.'
        )
      }
    >
      {(items) => (
        <ul className="grid gap-3 md:grid-cols-2" data-testid="product-list">
          {items.map((product) => (
            <ProductCard key={product.id} product={product} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
    </PagedListView>
  );
}

function ProductCard({ product, isAdmin }: { product: Product; isAdmin: boolean }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4" data-testid="product-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold break-words" data-testid="product-name">
            {product.name}
          </h2>
          <p className="text-sm text-slate-600 break-words">
            {product.brand} · {product.category.name}
          </p>
        </div>
        <p className="shrink-0 font-semibold" data-testid="product-price">
          {formatMoney(product.price)}
        </p>
      </div>
      {product.description !== '' && <p className="text-sm break-words text-slate-700">{product.description}</p>}
      <div className="mt-auto flex items-center justify-between gap-3">
        <span data-testid="product-stock">
          <StockBadge quantity={product.quantity} />
        </span>
        {isAdmin && (
          <Link to={`/products/${product.id}/edit`} className={textLinkClass} data-testid="edit-product">
            Edit<span className="sr-only"> {product.name}</span>
          </Link>
        )}
      </div>
    </li>
  );
}
