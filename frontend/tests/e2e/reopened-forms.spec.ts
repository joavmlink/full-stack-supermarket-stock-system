// Coming back to a form within the app: a store outlives the screen, so what a
// form starts from and what a write that finishes meanwhile does are tested here.
import type { Page } from '@playwright/test';
import { expect, navLink, signIn, test, USERS } from './fixtures';

/** Holds the next POST to this API path until `release`, so it lands while the user is elsewhere. */
async function holdCreate(page: Page, path: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === `/api/${path}`,
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await released;
      return route.continue();
    },
  );
  return release;
}

test('a product reopened after a sale starts from the stored values, so saving keeps the sale', async ({ page, apiURL, api, apiAs }) => {
  const dairy = await api.category('Dairy');
  const milk = await api.product({ categoryId: dairy.id, name: 'Whole milk 1 L', quantity: 100 });
  await signIn(page, apiURL, 'admin');
  await page.goto(`/products/${milk.id}/edit`);
  await expect(page.getByTestId('product-quantity')).toHaveValue('100');
  await page.getByRole('link', { name: 'Back to products' }).click();
  await expect(page.getByTestId('product-card')).toHaveCount(1);

  await (await apiAs('employee')).movement('sale', [[milk, 10]]);

  await page.getByTestId('edit-product').click();
  await expect(page.getByTestId('product-quantity')).toHaveValue('90');
  await page.getByTestId('product-price-input').fill('200');
  await page.getByTestId('save-product').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('product-stock')).toHaveText('90 in stock');
});

test('a rejected save does not come back when the form reopens', async ({ page, apiURL, problems }) => {
  await signIn(page, apiURL, 'admin');
  await page.goto('/employees/new');
  problems.allow(/^409 POST \/api\/employees$/);
  await page.getByTestId('employee-full-name').fill('Nora New');
  await page.getByTestId('employee-email').fill(USERS.employee.email);
  await page.getByTestId('employee-password').fill('a long and unrelated passphrase');
  await page.getByTestId('save-employee').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'rejected');

  await page.getByRole('link', { name: 'Back to employees' }).click();
  await page.getByRole('link', { name: 'New employee' }).click();
  await expect(page.getByTestId('employee-form')).toBeVisible();
  await expect(page.getByTestId('employee-full-name')).toHaveValue('');
  await expect(page.getByTestId('employee-password')).toHaveValue('');
  await expect(page.getByTestId('save-status')).toHaveCount(0);
});

test('a create that finishes after its form reopened leaves the form, so it cannot be sent twice', async ({ page, apiURL, api }) => {
  await api.category('Dairy');
  await signIn(page, apiURL, 'admin');
  await page.goto('/products/new');
  await page.getByTestId('product-category').selectOption({ label: 'Dairy' });
  await page.getByTestId('product-name-input').fill('Whole milk 1 L');
  await page.getByTestId('product-brand').fill('Acme');
  await page.getByTestId('product-price-input').fill('100');
  const release = await holdCreate(page, 'products');
  await page.getByTestId('save-product').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'pending');

  // Away and back: the form shows what is being sent.
  await page.getByRole('link', { name: 'Back to products' }).click();
  await page.getByTestId('new-product').click();
  await expect(page.getByTestId('product-name-input')).toHaveValue('Whole milk 1 L');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'pending');

  release();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('product-card')).toHaveCount(1);
});

test('a movement recorded while the user is elsewhere is confirmed on return, once', async ({ page, apiURL, api }) => {
  const dairy = await api.category('Dairy');
  await api.product({ categoryId: dairy.id, name: 'Whole milk 1 L', quantity: 8 });
  await signIn(page, apiURL, 'employee');
  await page.goto('/stock-movements/new');
  const line = page.getByTestId('movement-line');
  await line.getByTestId('line-product').fill('Whole milk');
  await line.getByTestId('product-option').click();
  await page.getByTestId('line-quantity').fill('2');
  const release = await holdCreate(page, 'stock-movements');
  await page.getByTestId('submit-movement').click();
  await expect(page.getByTestId('movement-status')).toHaveAttribute('data-state', 'pending');

  await navLink(page, 'Products').click();
  await expect(page.getByTestId('product-card')).toHaveCount(1);
  const landed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/stock-movements' && response.status() === 201);
  release();
  await landed;

  await navLink(page, 'Record movement').click();
  await expect(page.getByTestId('movement-recorded').getByRole('status')).toHaveText('Sale recorded: 2 units across 1 product.');

  // Already seen: the next visit starts with a blank form.
  await navLink(page, 'Products').click();
  await expect(page.getByTestId('product-card')).toHaveCount(1);
  await navLink(page, 'Record movement').click();
  await expect(page.getByTestId('movement-form')).toBeVisible();
  await expect(page.getByTestId('line-quantity')).toHaveValue('');
});
