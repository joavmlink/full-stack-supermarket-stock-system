import { expect, navLink, PASSWORD, signIn, signInWithForm, test, USERS } from './fixtures';

test('a wrong password shows why and signs nobody in', async ({ page, problems }) => {
  problems.allow(/^401 POST \/api\/auth\/login$/);
  await page.goto('/login');
  await page.getByTestId('login-email').fill(USERS.admin.email);
  await page.getByTestId('login-password').fill('not the right password');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('signing in returns to the page that was asked for', async ({ page }) => {
  await page.goto('/stock-movements?type=sale');
  await expect(page).toHaveURL(/\/login$/);
  await signInWithForm(page, USERS.employee.email, PASSWORD);
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await expect(page).toHaveURL(/\/stock-movements\?type=sale$/);
});

test('after signing out, the next sign-in starts at the products page', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'employee');
  await page.goto('/stock-movements');
  await expect(page.getByTestId('movements-page')).toBeVisible();
  await page.getByTestId('sign-out').click();
  await expect(page.getByTestId('login-form')).toBeVisible();
  await signInWithForm(page, USERS.employee.email, PASSWORD);
  await expect(page.getByTestId('products-page')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('a lost session goes to the login page with a notice and comes back after signing in', async ({ page, apiURL, problems }) => {
  await signIn(page, apiURL, 'employee');
  await page.goto('/');
  await expect(page.getByTestId('products-page')).toBeVisible();
  // The session ends on the server's side (the cookie is gone): the next request answers 401.
  problems.allow(/^401 GET \/api\/stock-movements/);
  await page.context().clearCookies();
  await navLink(page, 'History').click();
  await expect(page.getByTestId('login-notice')).toBeVisible();
  await signInWithForm(page, USERS.employee.email, PASSWORD);
  await expect(page.getByTestId('movements-page')).toBeVisible();
});

test('navigating keeps the header mounted', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'admin');
  await page.goto('/');
  await expect(page.getByTestId('products-page')).toBeVisible();
  // A mark on the header element survives only if React keeps the same element.
  await page.locator('header').evaluate((header) => header.setAttribute('data-mark', 'kept'));
  for (const [link, screen] of [
    ['History', 'movements-page'],
    ['Categories', 'categories-page'],
    ['Employees', 'employees-page'],
    ['Products', 'products-page'],
  ] as const) {
    await navLink(page, link).click();
    await expect(page.getByTestId(screen)).toBeVisible();
  }
  await expect(page.locator('header')).toHaveAttribute('data-mark', 'kept');
});

test('an employee sees only the pages of their role', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'employee');
  await page.goto('/');
  await expect(page.getByTestId('current-user')).toHaveText(`${USERS.employee.fullName} · Employee`);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveText(['Products', 'Record movement', 'History']);
  for (const path of ['/products/new', '/categories', '/employees', '/employees/new']) {
    await page.goto(path);
    await expect(page.getByTestId('forbidden')).toBeVisible();
  }
});

test('an unknown address shows "Page not found" inside the layout', async ({ page, apiURL }) => {
  await signIn(page, apiURL, 'employee');
  await page.goto('/no-such-page');
  await expect(page.getByTestId('not-found')).toBeVisible();
  await expect(page.getByTestId('current-user')).toBeVisible();
});

test('the main screens fit a phone screen', async ({ page, apiURL, api }) => {
  const dairy = await api.category('Dairy products and other refrigerated goods');
  const milk = await api.product({
    categoryId: dairy.id,
    name: 'Whole milk with added vitamins A and D, family size',
    brand: 'A brand with a rather long name',
    price: '99999999.99',
    quantity: 999_999,
  });
  const movement = await api.movement('sale', [[milk, 1]]);
  await page.setViewportSize({ width: 360, height: 740 });
  await signIn(page, apiURL, 'admin');
  for (const [path, screen] of [
    ['/', 'product-list'],
    ['/stock-movements/new', 'movement-form'],
    ['/stock-movements', 'movement-list'],
    [`/stock-movements/${movement.id}`, 'movement-detail'],
    ['/categories', 'category-list'],
    [`/products/${milk.id}/edit`, 'product-form'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId(screen)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBe(0);
  }
});
