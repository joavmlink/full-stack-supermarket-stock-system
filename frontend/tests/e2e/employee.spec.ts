import type { Page } from '@playwright/test';
import type { Product } from '../../src/api/types';
import { expect, signIn, test, USERS } from './fixtures';

/** Picks a product in line `index` of the stock form: types part of its name and clicks the result. */
async function pickProduct(page: Page, index: number, text: string): Promise<void> {
  const line = page.getByTestId('movement-line').nth(index);
  await line.getByTestId('line-product').fill(text);
  await line.getByTestId('product-option').filter({ hasText: text }).click();
  await expect(line.getByTestId('line-product')).toHaveValue(new RegExp(`^${text}`));
  await expect(line.getByTestId('line-product-stock')).toBeVisible();
}

/** The same with the keyboard: once the results are the one product, Arrow Down and Enter pick it. */
async function pickProductWithKeyboard(page: Page, index: number, text: string): Promise<void> {
  const line = page.getByTestId('movement-line').nth(index);
  const input = line.getByTestId('line-product');
  await input.fill(text);
  await expect(line.getByTestId('product-option')).toHaveText([new RegExp(text)]);
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(input).toHaveValue(new RegExp(`^${text}`));
  await expect(line.getByTestId('line-product-stock')).toBeVisible();
}

let milk: Product;
let bread: Product;

test.beforeEach(async ({ page, apiURL, api }) => {
  const dairy = await api.category('Dairy');
  const bakery = await api.category('Bakery');
  milk = await api.product({ categoryId: dairy.id, name: 'Whole milk 1 L', price: '1234.50', quantity: 8 });
  bread = await api.product({ categoryId: bakery.id, name: 'Sliced bread', price: '2100.00', quantity: 15 });
  await signIn(page, apiURL, 'employee');
});

test('an employee browses products without admin actions', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('product-card')).toHaveCount(2);
  await expect(page.getByTestId('edit-product')).toHaveCount(0);
  await expect(page.getByTestId('new-product')).toHaveCount(0);
  await expect(page.getByTestId('stat-sales')).toContainText('Your sales');
  await expect(page.getByTestId('stat-employees')).toHaveCount(0);
});

test('a sale of several products: stock is checked per line, then every line is recorded', async ({ page, problems }) => {
  await page.goto('/stock-movements/new');
  await expect(page.getByTestId('movement-type')).toHaveValue('sale');

  // Nothing chosen yet.
  await page.getByTestId('submit-movement').click();
  await expect(page.getByText('Choose a product.')).toBeVisible();

  await pickProduct(page, 0, 'Whole milk');
  await page.getByTestId('line-quantity').nth(0).fill('20');
  await page.getByTestId('add-line').click();
  await pickProduct(page, 1, 'Sliced bread');
  await page.getByTestId('line-quantity').nth(1).fill('2');

  // More than the stock: the server rejects the whole movement and the line says why.
  problems.allow(/^409 POST \/api\/stock-movements$/);
  await page.getByTestId('submit-movement').click();
  await expect(page.getByTestId('movement-status')).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByText('Only 8 in stock.')).toBeVisible();

  await page.getByTestId('line-quantity').nth(0).fill('3');
  await page.getByTestId('submit-movement').click();
  const recorded = page.getByTestId('movement-recorded');
  await expect(recorded.getByRole('status')).toHaveText('Sale recorded: 5 units across 2 products.');
  await expect(recorded).toContainText('5 left');
  await expect(recorded).toContainText('13 left');

  await page.goto('/');
  const milk = page.getByTestId('product-card').filter({ hasText: 'Whole milk' });
  await expect(milk.getByTestId('product-stock')).toHaveText('5 in stock (low)');
});

test('a restock adds units, and the form remembers the last type', async ({ page }) => {
  await page.goto('/stock-movements/new');
  await page.getByTestId('movement-type').selectOption('restock');
  await pickProductWithKeyboard(page, 0, 'Sliced bread');
  await page.getByTestId('line-quantity').nth(0).fill('1.000');
  await page.getByTestId('submit-movement').click();
  await expect(page.getByTestId('movement-recorded').getByRole('status')).toHaveText('Restock recorded: 1.000 units across 1 product.');

  // "Record another" starts a blank form of the same type; so does a later visit.
  await page.getByTestId('record-another').click();
  await expect(page.getByTestId('movement-type')).toHaveValue('restock');
  await page.reload();
  await expect(page.getByTestId('movement-type')).toHaveValue('restock');

  await page.goto('/');
  const bread = page.getByTestId('product-card').filter({ hasText: 'Sliced bread' });
  await expect(bread.getByTestId('product-stock')).toHaveText('1.015 in stock');
});

test('the history shows an employee only their own movements, with their details', async ({ page, apiAs, problems }) => {
  const own = await (await apiAs('employee')).movement('sale', [[milk, 2], [bread, 1]]);
  await (await apiAs('other')).movement('restock', [[bread, 5]]);
  await (await apiAs('admin')).movement('sale', [[milk, 1]]);

  await page.goto('/stock-movements');
  await expect(page.getByTestId('movement-row')).toHaveCount(1);
  await page.getByTestId('movement-row').getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/stock-movements/${own.id}$`));
  const detail = page.getByTestId('movement-detail');
  await expect(detail).toContainText(`Recorded by ${USERS.employee.fullName}`);
  await expect(detail.getByTestId('movement-item')).toHaveCount(2);
  await expect(detail.getByTestId('movement-item').first()).toContainText('Whole milk 1 L');
  await expect(detail.getByTestId('movement-item').first()).toContainText('$\u00a01.234,50');

  // Another employee's movement does not exist for this one.
  problems.allow(/^404 GET \/api\/stock-movements\/[\w-]+$/);
  const others = await (await apiAs('admin')).movement('restock', [[milk, 1]]);
  await page.goto(`/stock-movements/${others.id}`);
  await expect(page.getByTestId('movement-not-found')).toBeVisible();
});

test('the history counts one unit in the singular', async ({ page, apiAs }) => {
  await (await apiAs('employee')).movement('sale', [[milk, 1]]);
  await page.goto('/stock-movements');
  await expect(page.getByTestId('movement-row')).toHaveText(/1 product · -1 unit$/);
});

test('the history filter by type lives in the URL', async ({ page, apiAs }) => {
  const employee = await apiAs('employee');
  await employee.movement('sale', [[milk, 1]]);
  await employee.movement('restock', [[bread, 3]]);
  await page.goto('/stock-movements');
  await expect(page.getByTestId('movement-row')).toHaveCount(2);
  await page.getByTestId('movement-type-filter').selectOption('restock');
  await expect(page).toHaveURL(/\?type=restock$/);
  await expect(page.getByTestId('movement-row')).toHaveCount(1);
  await expect(page.getByTestId('movement-type-badge')).toHaveText(['Restock']);
  await page.goBack();
  await expect(page.getByTestId('movement-row')).toHaveCount(2);
  await page.getByTestId('movement-type-filter').selectOption('adjustment');
  await expect(page.getByTestId('empty-state')).toHaveText('No movements of this type.');
});
