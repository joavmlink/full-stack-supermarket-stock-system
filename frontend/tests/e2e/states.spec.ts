// Empty, error and unexpected states. Errors are simulated with page.route on
// the API calls; everything else is the real API.
import type { Page, Route } from '@playwright/test';
import { expect, navLink, signIn, test, type TestApi } from './fixtures';

/**
 * Matches one API path (any query), in dev and prod alike. Keep the returned
 * function: page.unroute removes a route only when given the same matcher.
 */
const apiPath = (path: string) => (url: URL) => url.pathname === `/api/${path}`;
const products = apiPath('products');
const session = apiPath('auth/session');

const serverError = (route: Route) =>
  route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.', details: [] } }),
  });

async function seedProducts(api: TestApi, count: number): Promise<void> {
  const dairy = await api.category('Dairy');
  for (let index = 1; index <= count; index += 1) {
    await api.product({ categoryId: dairy.id, name: `Product ${String(index).padStart(2, '0')}` });
  }
}

const productCards = (page: Page) => page.getByTestId('product-card');

test('empty lists say so, and the admin is offered the first step', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'admin');
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toHaveText('There are no products yet. Add the first one.');
  await page.goto('/stock-movements');
  await expect(page.getByTestId('empty-state')).toHaveText('No movements yet.');
  await page.goto('/categories');
  await expect(page.getByTestId('empty-state')).toHaveText('No categories yet. Add the first one above.');
});

test('a failed first load shows the error with Retry', async ({ page, apiURL, problems }) => {
  problems.allow(/^500 GET \/api\/products/);
  await signIn(page, apiURL, 'employee');
  await page.route(products, serverError);
  await page.goto('/');
  await expect(page.getByTestId('error-state')).toContainText('Something went wrong on our side.');
  await page.unroute(products);
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('a failed refresh keeps the list on screen, with the error and Retry above it', async ({ page, apiURL, api, problems }) => {
  await seedProducts(api, 2);
  await signIn(page, apiURL, 'employee');
  await page.goto('/');
  await expect(productCards(page)).toHaveCount(2);

  // Every visit reloads the list; this time the request fails.
  problems.allow(/^500 GET \/api\/products/);
  await page.route(products, serverError);
  await navLink(page, 'History').click();
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await navLink(page, 'Products').click();
  await expect(page.getByTestId('error-state')).toContainText('Could not refresh the list.');
  await expect(productCards(page)).toHaveCount(2);

  await page.unroute(products);
  // Wait for the answer: the error also leaves the screen while the retry is loading.
  const reloaded = page.waitForResponse((response) => products(new URL(response.url())) && response.ok());
  await page.getByTestId('retry-button').click();
  await reloaded;
  await expect(page.getByTestId('error-state')).toHaveCount(0);
  await expect(productCards(page)).toHaveCount(2);
});

test('a failed refresh of the categories keeps them on screen, with the error and Retry above them', async ({ page, apiURL, api, problems }) => {
  await api.category('Dairy');
  await signIn(page, apiURL, 'admin');
  await page.goto('/categories');
  await expect(page.getByTestId('category-name')).toHaveText(['Dairy']);

  problems.allow(/^500 GET \/api\/categories/);
  const categories = apiPath('categories');
  await page.route(categories, serverError);
  await navLink(page, 'History').click();
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await navLink(page, 'Categories').click();
  await expect(page.getByTestId('error-state')).toContainText('Could not refresh the list.');
  await expect(page.getByTestId('category-name')).toHaveText(['Dairy']);

  await page.unroute(categories);
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('error-state')).toHaveCount(0);
  await expect(page.getByTestId('category-name')).toHaveText(['Dairy']);
});

test('a failed "Load more" offers Retry under the list', async ({ page, apiURL, api, problems }) => {
  await seedProducts(api, 21);
  await signIn(page, apiURL, 'employee');
  await page.goto('/');
  await expect(productCards(page)).toHaveCount(20);

  problems.allow(/^500 GET \/api\/products\?.*before=/);
  const nextPage = (url: URL) => url.pathname === '/api/products' && url.searchParams.has('before');
  await page.route(nextPage, serverError);
  await page.getByTestId('load-more').click();
  await expect(page.getByTestId('load-more-error')).toHaveText('Something went wrong on our side.');
  await expect(page.getByTestId('load-more')).toHaveText('Retry');

  await page.unroute(nextPage);
  await page.getByTestId('load-more').click();
  await expect(productCards(page)).toHaveCount(21);
});

test('a response that is not JSON is an error with Retry, not a broken page', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'employee');
  await page.route(products, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>Gateway</p>' }));
  await page.goto('/');
  await expect(page.getByTestId('error-state')).toContainText('The server sent an unexpected response.');
});

test('data the page cannot display shows the error screen inside the layout', async ({ page, apiURL, problems }) => {
  // React reports the error it caught: the error itself in production, with the component in development.
  problems.allow(/^console error: (TypeError: Cannot read properties of undefined|[\s\S]*The above error occurred in the <StatsPanel> component)/);
  await signIn(page, apiURL, 'employee');
  // Valid JSON of the wrong shape: rendering the totals throws.
  await page.route(apiPath('stats'), (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('/');
  await expect(page.getByTestId('error-boundary')).toBeVisible();
  await expect(page.getByTestId('current-user')).toBeVisible();

  // Navigating leaves the broken page behind.
  await navLink(page, 'History').click();
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await expect(page.getByTestId('error-boundary')).toHaveCount(0);
});

test('a session check that cannot reach the server offers Retry', async ({ page, problems }) => {
  problems.allow(/^request failed: GET \/api\/auth\/session /);
  await page.route(session, (route) => route.abort('internetdisconnected'));
  await page.goto('/');
  await expect(page.getByTestId('error-state')).toBeVisible();
  await page.unroute(session);
  await page.getByTestId('retry-button').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
});

test('a create whose answer is lost retries, then offers Retry, and saves it only once', async ({ page, apiURL, problems }) => {
  // The waits between attempts are half fixed, half random: fix the random half at 0 (0.5 s, 1 s, 2 s).
  await page.addInitScript(() => {
    Math.random = () => 0;
  });
  await signIn(page, apiURL, 'admin');
  await page.goto('/categories');
  await expect(page.getByTestId('empty-state')).toBeVisible();

  problems.allow(/^request failed: POST \/api\/categories /);
  let attempts = 0;
  const create = (url: URL) => url.pathname === '/api/categories';
  await page.route(create, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts += 1;
    // The first attempt reaches the server, which stores the category; its answer never arrives.
    if (attempts === 1) await route.fetch();
    return route.abort('connectionreset');
  });
  await page.getByTestId('new-category-name').fill('Dairy');
  await page.getByTestId('add-category').click();
  await expect(page.getByTestId('new-category-status')).toContainText('Connection problem. Retrying…');
  await expect(page.getByTestId('new-category-status')).toHaveAttribute('data-state', 'failed', { timeout: 10_000 });
  expect(attempts).toBe(4);

  await page.unroute(create);
  await page.getByTestId('retry-write').click();
  await expect(page.getByTestId('category-name')).toHaveText(['Dairy']);
  await expect(page.getByTestId('new-category-status')).toHaveCount(0);

  const stored = await page.request.get(`${apiURL}/categories`);
  expect((await stored.json()) as unknown[]).toHaveLength(1);
});
