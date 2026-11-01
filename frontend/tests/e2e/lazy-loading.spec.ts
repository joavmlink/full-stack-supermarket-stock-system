// Every page is its own chunk (a module of its own in development): a screen
// downloads its page and no other. In production a chunk can be missing (a
// tab opened before a deploy): the app reloads once, and if that does not
// help, the error screen appears instead of a reload loop.
import type { Page } from '@playwright/test';
import { expect, navLink, signIn, test } from './fixtures';

const PAGES = [
  'LoginPage',
  'ProductsPage',
  'ProductFormPage',
  'StockMovementFormPage',
  'StockMovementsPage',
  'StockMovementDetailPage',
  'CategoriesPage',
  'EmployeesPage',
  'EmployeeFormPage',
  'NotFoundPage',
];
const ADMIN_PAGES = ['ProductFormPage', 'CategoriesPage', 'EmployeesPage', 'EmployeeFormPage'];

/** `/src/pages/ProductsPage.tsx` in development, `/assets/ProductsPage-<hash>.js` in production. */
function pageOf(url: string): string | undefined {
  const file = new URL(url).pathname.split('/').pop() ?? '';
  return PAGES.find((name) => file === `${name}.tsx` || file.startsWith(`${name}-`));
}

/** The page modules the browser asked for, in order (each counted once per document). */
function recordPages(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    const name = request.resourceType() === 'script' ? pageOf(request.url()) : undefined;
    if (name !== undefined) requested.push(name);
  });
  return requested;
}

/** Counts the documents the tab loads (the first one and every reload). */
function countDocuments(page: Page): () => number {
  let documents = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1;
  });
  return () => documents;
}

test('each screen downloads only its own page, and an employee never an admin page', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'employee');
  const requested = recordPages(page);
  await page.goto('/');
  await expect(page.getByTestId('products-page')).toBeVisible();
  expect(requested).toEqual(['ProductsPage']);

  await navLink(page, 'History').click();
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await navLink(page, 'Record movement').click();
  await expect(page.getByTestId('movement-form')).toBeVisible();
  expect(requested).toEqual(['ProductsPage', 'StockMovementsPage', 'StockMovementFormPage']);

  for (const path of ['/categories', '/employees', '/products/new']) {
    await page.goto(path);
    await expect(page.getByTestId('forbidden')).toBeVisible();
  }
  expect(requested.filter((name) => ADMIN_PAGES.includes(name))).toEqual([]);
});

test('an admin page is downloaded when an admin opens it', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'admin');
  const requested = recordPages(page);
  await page.goto('/');
  await expect(page.getByTestId('products-page')).toBeVisible();
  await navLink(page, 'Categories').click();
  await expect(page.getByTestId('categories-page')).toBeVisible();
  expect(requested).toEqual(['ProductsPage', 'CategoriesPage']);
});

test.describe('a missing chunk (production build only)', () => {
  test.skip(({ target }) => target !== 'prod', 'Development serves modules, not chunks.');

  const historyChunk = '**/assets/StockMovementsPage-*.js';
  // Chromium reports a module script answered with 404 both as the response and as an aborted request.
  const missingChunk = [/^404 GET \/assets\/StockMovementsPage-/, /^request failed: GET \/assets\/StockMovementsPage-\S+ net::ERR_ABORTED$/];

  test('missing once: the app reloads and the page appears', async ({ page, apiURL, problems }) => {
    problems.allow(...missingChunk);
    await signIn(page, apiURL, 'employee');
    await page.goto('/');
    await expect(page.getByTestId('products-page')).toBeVisible();

    let requests = 0;
    await page.route(historyChunk, (route) => {
      requests += 1;
      return requests === 1 ? route.fulfill({ status: 404, body: 'Not found' }) : route.fallback();
    });
    const documents = countDocuments(page);
    await navLink(page, 'History').click();
    await expect(page.getByTestId('movements-page')).toBeVisible();
    expect(documents()).toBe(1);
    expect(requests).toBe(2);
  });

  test('missing for good: the error screen appears, without a reload loop', async ({ page, apiURL, problems }) => {
    // React reports the import error it caught.
    problems.allow(...missingChunk, /^console error: TypeError: Failed to fetch dynamically imported module: .*\/StockMovementsPage-/);
    await signIn(page, apiURL, 'employee');
    await page.goto('/');
    await expect(page.getByTestId('products-page')).toBeVisible();

    await page.route(historyChunk, (route) => route.fulfill({ status: 404, body: 'Not found' }));
    const documents = countDocuments(page);
    await navLink(page, 'History').click();
    await expect(page.getByTestId('error-boundary')).toBeVisible();
    await expect(page.getByTestId('current-user')).toBeVisible();
    // One automatic reload, then no more: give a loop the time it would need to show.
    await page.waitForTimeout(1_000);
    expect(documents()).toBe(1);
    await expect(page.getByTestId('error-boundary')).toBeVisible();
  });
});
