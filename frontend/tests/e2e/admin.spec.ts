import { expect, signIn, test, USERS } from './fixtures';

test.beforeEach(async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'admin');
});

test('categories: create, reject a duplicate, rename and delete', async ({ page, api, problems }) => {
  await page.goto('/categories');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  for (const name of ['Dairy', 'Bakery', 'Cleaning']) {
    await page.getByTestId('new-category-name').fill(name);
    await page.getByTestId('add-category').click();
    await expect(page.getByTestId('category-name').filter({ hasText: name })).toBeVisible();
  }
  await expect(page.getByTestId('category-name')).toHaveText(['Bakery', 'Cleaning', 'Dairy']);

  // Names are unique ignoring case.
  problems.allow(/^409 POST \/api\/categories$/);
  await page.getByTestId('new-category-name').fill('dairy');
  await page.getByTestId('add-category').click();
  await expect(page.getByTestId('new-category-status')).toHaveAttribute('data-state', 'rejected');

  // Renaming twice: the second time starts from the name the first one saved.
  const cleaning = page.getByTestId('category-row').filter({ hasText: 'Cleaning' });
  await cleaning.getByTestId('rename-category').click();
  await expect(cleaning.getByTestId('category-name-input')).toHaveValue('Cleaning');
  await cleaning.getByTestId('category-name-input').fill('Cleaning supplies');
  await cleaning.getByTestId('save-category').click();
  await expect(cleaning.getByTestId('category-name')).toHaveText('Cleaning supplies');
  await cleaning.getByTestId('rename-category').click();
  await expect(cleaning.getByTestId('category-name-input')).toHaveValue('Cleaning supplies');
  await cleaning.getByRole('button', { name: 'Cancel' }).click();

  // A category with products cannot be deleted; an empty one can.
  const frozenCategory = await api.category('Frozen');
  await api.product({ categoryId: frozenCategory.id, name: 'Ice cream' });
  await page.reload();
  problems.allow(/^409 DELETE \/api\/categories\/[\w-]+$/);
  const frozen = page.getByTestId('category-row').filter({ hasText: 'Frozen' });
  await frozen.getByTestId('delete-category').click();
  await frozen.getByTestId('delete-category-confirm').click();
  await expect(frozen.getByTestId('category-status')).toContainText('still has products');

  const bakery = page.getByTestId('category-row').filter({ hasText: 'Bakery' });
  await bakery.getByTestId('delete-category').click();
  await bakery.getByTestId('delete-category-confirm').click();
  await expect(page.getByTestId('category-name')).toHaveText(['Cleaning supplies', 'Dairy', 'Frozen']);
});

test('products: create with an Argentine price, edit and delete', async ({ page, api }) => {
  await api.category('Dairy');
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toContainText('Add the first one');
  await page.getByTestId('new-product').click();

  // Saving an empty form explains each field.
  await page.getByTestId('save-product').click();
  await expect(page.getByText('Choose a category.')).toBeVisible();
  await expect(page.getByTestId('save-product')).toBeEnabled();

  await page.getByTestId('product-category').selectOption({ label: 'Dairy' });
  await page.getByTestId('product-name-input').fill('Whole milk 1 L');
  await page.getByTestId('product-brand').fill('La Serenísima');
  await page.getByTestId('product-description').fill('Ultra-pasteurized.');
  await page.getByTestId('product-quantity').fill('1.250');
  // A dot followed by two digits is not a thousands separator.
  await page.getByTestId('product-price-input').fill('12.50');
  await page.getByTestId('save-product').click();
  await expect(page.getByText('Use a comma for decimals.')).toBeVisible();
  await page.getByTestId('product-price-input').fill('1.234,5');
  await page.getByTestId('save-product').click();

  await expect(page).toHaveURL(/\/$/);
  const card = page.getByTestId('product-card').filter({ hasText: 'Whole milk 1 L' });
  await expect(card.getByTestId('product-price')).toHaveText('$\u00a01.234,50');
  await expect(card.getByTestId('product-stock')).toHaveText('1.250 in stock');
  await expect(page.getByTestId('stat-value').locator('dd')).toHaveText('$\u00a01.543.125,00');

  // Editing starts from the stored values, in the same format the admin types.
  await card.getByTestId('edit-product').click();
  await expect(page.getByTestId('product-price-input')).toHaveValue('1.234,50');
  await expect(page.getByTestId('product-quantity')).toHaveValue('1.250');
  await page.getByTestId('product-price-input').fill('1.300');
  await page.getByTestId('product-quantity').fill('8');
  await page.getByTestId('save-product').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(card.getByTestId('product-price')).toHaveText('$\u00a01.300,00');
  await expect(card.getByTestId('product-stock')).toHaveText('8 in stock (low)');

  // Changing the quantity by hand is recorded as an adjustment.
  await page.goto('/stock-movements');
  await expect(page.getByTestId('movement-row')).toHaveCount(2);
  await expect(page.getByTestId('movement-type-badge')).toHaveText(['Adjustment', 'Adjustment']);

  await page.goto('/');
  await card.getByTestId('edit-product').click();
  await page.getByTestId('delete-product').click();
  await page.getByTestId('delete-product-confirm').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('empty-state')).toBeVisible();
});

test('products: a save based on old data shows the conflict, and "Load the latest version" clears it', async ({ page, api, problems }) => {
  const dairy = await api.category('Dairy');
  const milk = await api.product({ categoryId: dairy.id, name: 'Whole milk 1 L', quantity: 20 });
  await page.goto(`/products/${milk.id}/edit`);
  await expect(page.getByTestId('product-name-input')).toHaveValue('Whole milk 1 L');

  // Someone sells 5 units meanwhile.
  await api.movement('sale', [[milk, 5]]);
  problems.allow(/^409 PATCH \/api\/products\/[\w-]+$/);
  await page.getByTestId('product-name-input').fill('Skimmed milk 1 L');
  await page.getByTestId('save-product').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'rejected');
  await expect(page.getByTestId('load-latest')).toBeVisible();

  await page.getByTestId('load-latest').click();
  await expect(page.getByTestId('product-quantity')).toHaveValue('15');
  await expect(page.getByTestId('product-name-input')).toHaveValue('Whole milk 1 L');
  await expect(page.getByTestId('save-status')).toHaveCount(0);
  await expect(page.getByTestId('load-latest')).toHaveCount(0);

  await page.getByTestId('product-name-input').fill('Skimmed milk 1 L');
  await page.getByTestId('save-product').click();
  await expect(page.getByTestId('product-card').getByTestId('product-name')).toHaveText('Skimmed milk 1 L');
});

test('employees: validate, reject a taken email, create, edit and delete', async ({ page, problems }) => {
  await page.goto('/employees');
  // The seeded employees; admins are never listed.
  await expect(page.getByTestId('employee-name')).toHaveCount(2);
  await page.getByTestId('new-employee').click();

  await page.getByTestId('employee-full-name').fill('Sam Seller');
  await page.getByTestId('employee-email').fill('sam@example.com');
  await page.getByTestId('employee-password').fill('short');
  await page.getByTestId('save-employee').click();
  await expect(page.getByText('Use at least 15 characters.')).toBeVisible();

  problems.allow(/^409 POST \/api\/employees$/);
  await page.getByTestId('employee-email').fill(USERS.employee.email);
  await page.getByTestId('employee-password').fill('a long and unusual passphrase');
  await page.getByTestId('save-employee').click();
  await expect(page.getByText('This email is already in use.')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'rejected');

  await page.getByTestId('employee-email').fill('sam@example.com');
  await page.getByTestId('save-employee').click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByTestId('employee-name')).toHaveCount(3);

  const sam = page.getByTestId('employee-row').filter({ hasText: 'Sam Seller' });
  await sam.getByTestId('edit-employee').click();
  await expect(page.getByTestId('employee-email')).toHaveValue('sam@example.com');
  // The password is optional when editing.
  await expect(page.getByTestId('employee-password')).toHaveValue('');
  await page.getByTestId('employee-full-name').fill('Samantha Seller');
  await page.getByTestId('save-employee').click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByTestId('employee-row').filter({ hasText: 'Samantha Seller' })).toBeVisible();

  await page.getByTestId('employee-row').filter({ hasText: 'Samantha Seller' }).getByTestId('edit-employee').click();
  await page.getByTestId('delete-employee').click();
  await page.getByTestId('delete-employee-confirm').click();
  await expect(page).toHaveURL(/\/employees$/);
  await expect(page.getByTestId('employee-name')).toHaveCount(2);
  await expect(page.getByText('Samantha Seller')).toHaveCount(0);
});

test('the totals count products, stock, value and movements', async ({ page, api }) => {
  const dairy = await api.category('Dairy');
  await api.category('Bakery');
  const milk = await api.product({ categoryId: dairy.id, name: 'Milk', quantity: 30, price: '1000.00' });
  await api.product({ categoryId: dairy.id, name: 'Yogurt', quantity: 4, price: '500.50' });
  await api.product({ categoryId: dairy.id, name: 'Butter', quantity: 0, price: '2000.00' });
  await api.movement('sale', [[milk, 10]]);
  await page.goto('/');
  const stat = (id: string) => page.getByTestId(`stat-${id}`).locator('dd');
  await expect(stat('products')).toHaveText('3');
  await expect(stat('out-of-stock')).toHaveText('1');
  await expect(stat('low-stock')).toHaveText('1');
  await expect(stat('units')).toHaveText('24');
  await expect(stat('value')).toHaveText('$\u00a022.002,00');
  await expect(stat('categories')).toHaveText('2');
  await expect(stat('sales')).toHaveText('1');
  await expect(stat('restocks')).toHaveText('0');
  await expect(stat('employees')).toHaveText('2');
});
