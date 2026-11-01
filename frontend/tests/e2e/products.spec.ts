import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixtures';

test.beforeEach(async ({ page, apiURL, api }) => {
  const dairy = await api.category('Dairy');
  const bakery = await api.category('Bakery');
  await api.product({ categoryId: dairy.id, name: 'Whole milk 1 L', brand: 'La Serenísima' });
  await api.product({ categoryId: dairy.id, name: 'Yogurt', brand: 'Milkaut' });
  await api.product({ categoryId: bakery.id, name: 'Milk bread', brand: 'Bimbo' });
  await api.product({ categoryId: bakery.id, name: 'Sliced bread', brand: 'Bimbo' });
  await signIn(page, apiURL, 'employee');
});

const names = (page: Page) => page.getByTestId('product-name');

/** The listed products, in any order: rows created in the same instant tie on created_at and sort by id. */
async function expectProducts(page: Page, expected: string[]): Promise<void> {
  await expect(names(page)).toHaveCount(expected.length);
  await expect.poll(async () => (await names(page).allTextContents()).sort()).toEqual([...expected].sort());
}

test('a pause after a space keeps it in the search box, so the next word stays apart', async ({ page }) => {
  await page.goto('/');
  const search = page.getByTestId('product-search');
  await search.fill('milk ');
  await expect(page).toHaveURL(/\?q=milk$/);
  await expect(search).toHaveValue('milk ');
  await search.pressSequentially('bread');
  await expect(page).toHaveURL(/\?q=milk\+bread$/);
  await expect(search).toHaveValue('milk bread');
  await expectProducts(page, ['Milk bread']);
});

test('search and category filter live in the URL, and Back undoes a filter', async ({ page }) => {
  await page.goto('/');
  await expect(names(page)).toHaveCount(4);

  // Name or brand.
  await page.getByTestId('product-search').fill('milk');
  await expect(page).toHaveURL(/\?q=milk$/);
  await expectProducts(page, ['Milk bread', 'Yogurt', 'Whole milk 1 L']);

  await page.getByTestId('category-filter').selectOption({ label: 'Bakery' });
  await expect(page).toHaveURL(/q=milk&category=/);
  await expectProducts(page, ['Milk bread']);

  await page.goBack();
  await expect(page).toHaveURL(/\?q=milk$/);
  await expect(page.getByTestId('category-filter')).toHaveValue('');
  await expect(names(page)).toHaveCount(3);

  // A shared link opens with its filters.
  await page.goto('/?q=bread');
  await expect(page.getByTestId('product-search')).toHaveValue('bread');
  await expectProducts(page, ['Sliced bread', 'Milk bread']);

  await page.getByTestId('product-search').fill('no such product');
  await expect(page.getByTestId('empty-state')).toHaveText('No products match these filters.');
});

test('a category picked right after typing keeps both filters', async ({ page }) => {
  await page.goto('/');
  await expect(names(page)).toHaveCount(4);
  // The category is chosen before the search's 300 ms pause ends.
  await page.getByTestId('product-search').fill('bread');
  await page.getByTestId('category-filter').selectOption({ label: 'Bakery' });
  await expect(page).toHaveURL(/category=.+/);
  await expect(page).toHaveURL(/q=bread/);
  await expect(page.getByTestId('category-filter')).not.toHaveValue('');
  await expectProducts(page, ['Sliced bread', 'Milk bread']);
});

test('"Load more" brings the next page without repeating products', async ({ page, api }) => {
  const frozen = await api.category('Frozen');
  for (let index = 1; index <= 21; index += 1) {
    await api.product({ categoryId: frozen.id, name: `Frozen item ${String(index).padStart(2, '0')}` });
  }
  await page.goto('/');
  await expect(names(page)).toHaveCount(20);
  await page.getByTestId('load-more').click();
  await expect(names(page)).toHaveCount(25);
  await expect(page.getByTestId('load-more')).toHaveCount(0);
  const all = await names(page).allTextContents();
  expect(new Set(all).size).toBe(25);
});
