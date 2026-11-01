// The main screens, read-only, failing on any console error, exception, failed
// request, response >= 400 or CSP violation (the `problems` fixture). It also
// runs against the deployment (playwright.remote.config.ts) with the account in
// E2E_EMAIL / E2E_PASSWORD, so it never writes anything: the only requests with a
// body are the sign-in and two that the API rejects before reading any data.
import { expect, navLink, PASSWORD, signInWithForm, test, USERS } from './fixtures';

function credentials(target: string): { email: string; password: string } {
  if (target !== 'remote') return { email: USERS.admin.email, password: PASSWORD };
  const { E2E_EMAIL: email, E2E_PASSWORD: password } = process.env;
  if (!email || !password) throw new Error('Set E2E_EMAIL and E2E_PASSWORD to an account of the deployment.');
  return { email, password };
}

test.beforeEach(async ({ target, apiAs }) => {
  if (target === 'remote') return;
  const api = await apiAs('admin');
  const dairy = await api.category('Dairy');
  const milk = await api.product({ categoryId: dairy.id, name: 'Whole milk 1 L', price: '1234.50', quantity: 12 });
  await api.movement('sale', [[milk, 2]]);
});

test('the API parses request bodies itself: its errors and its size limit apply', async ({ request, apiURL }) => {
  const login = `${apiURL}/auth/login`;
  const headers = { 'Content-Type': 'application/json' };

  const malformed = await request.post(login, { headers, data: '{"email":' });
  expect(malformed.status()).toBe(400);
  expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON');

  const oversized = await request.post(login, { headers, data: JSON.stringify({ email: 'x'.repeat(20_000) }) });
  expect(oversized.status()).toBe(413);
  expect(((await oversized.json()) as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
});

test('the main screens load without errors', async ({ page, target }) => {
  const { email, password } = credentials(target);

  // Signed out, the app goes to the login page without any error response.
  await page.goto('/');
  await expect(page.getByTestId('login-form')).toBeVisible();
  await signInWithForm(page, email, password);

  await expect(page.getByTestId('products-page')).toBeVisible();
  await expect(page.getByTestId('stats')).toBeVisible();
  await expect(page.getByTestId('product-list').or(page.getByTestId('empty-state'))).toBeVisible();

  await navLink(page, 'History').click();
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await expect(page.getByTestId('movement-list').or(page.getByTestId('empty-state'))).toBeVisible();
  const rows = page.getByTestId('movement-row');
  if ((await rows.count()) > 0) {
    await rows.first().getByRole('link').click();
    await expect(page.getByTestId('movement-detail')).toBeVisible();
  }

  await navLink(page, 'Record movement').click();
  await expect(page.getByTestId('movement-form')).toBeVisible();

  if (await navLink(page, 'Categories').isVisible()) {
    await navLink(page, 'Categories').click();
    await expect(page.getByTestId('category-list').or(page.getByTestId('empty-state'))).toBeVisible();
    await navLink(page, 'Employees').click();
    await expect(page.getByTestId('employees-page')).toBeVisible();
    await expect(page.getByTestId('employee-list').or(page.getByTestId('empty-state'))).toBeVisible();
  }

  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
});
