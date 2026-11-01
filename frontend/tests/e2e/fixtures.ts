import { expect, test as base, type APIRequestContext, type Page, type Request } from '@playwright/test';
import type { Category, FormMovementType, Product, ProductFields, StockMovement, User } from '../../src/api/types';

/** Which servers a run targets. `remote` is a deployment: read-only, no reset and no test data. */
export type Target = 'dev' | 'prod' | 'remote';

export interface E2EOptions {
  target: Target;
  /** The API as the test process reaches it (test data and resets). */
  apiURL: string;
}

/** The users backend/tests/e2e-server.ts creates on every reset. Obviously fake. */
export const PASSWORD = 'correct horse battery staple';
export const USERS = {
  admin: { email: 'admin@example.com', fullName: 'Alex Admin' },
  employee: { email: 'employee@example.com', fullName: 'Erin Employee' },
  other: { email: 'other.employee@example.com', fullName: 'Owen Other' },
} as const;
export type UserKey = keyof typeof USERS;

/** The path and query of a URL, which is what the problem lines and `allow` patterns show. */
const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/**
 * Everything a healthy page never does: a console error, an uncaught
 * exception, a failed request, a response of 400 or more, a CSP violation.
 * Every test fails on any of them unless it allows that one (`allow`), such
 * as the 409 it provokes on purpose.
 */
export class PageProblems {
  private readonly seen: string[] = [];
  private readonly allowed: RegExp[] = [];

  allow(...patterns: RegExp[]): void {
    this.allowed.push(...patterns);
  }

  /** The problems seen so far that no `allow` pattern matches. */
  unexpected(): string[] {
    return this.seen.filter((problem) => !this.allowed.some((pattern) => pattern.test(problem)));
  }

  /** Every problem seen so far, allowed or not (to assert one happened). */
  all(): string[] {
    return [...this.seen];
  }

  watch(page: Page): void {
    // A request still in flight when the page starts loading another document
    // is cancelled by the browser: that is not a failure of the app.
    let documents = 0;
    const documentOf = new WeakMap<Request, number>();
    page.on('request', (request) => {
      documentOf.set(request, documents);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1;
    });
    page.on('console', (message) => {
      // The response or failed request behind this message is recorded on its own.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        this.seen.push(`console error: ${message.text()}`);
      }
    });
    page.on('pageerror', (error) => this.seen.push(`page error: ${error.message}`));
    page.on('requestfailed', (request) => {
      const reason = request.failure()?.errorText ?? 'unknown';
      if (reason === 'net::ERR_ABORTED' && documentOf.get(request) !== documents) return;
      this.seen.push(`request failed: ${request.method()} ${pathOf(request.url())} ${reason}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) this.seen.push(`${response.status()} ${response.request().method()} ${pathOf(response.url())}`);
    });
  }
}

/** The API as one user, for test data. */
export class TestApi {
  private readonly request: APIRequestContext;

  constructor(request: APIRequestContext) {
    this.request = request;
  }

  private async send<T>(method: 'post' | 'patch' | 'delete', path: string, data?: object): Promise<T> {
    const response = await this.request[method](path, { data });
    if (!response.ok()) throw new Error(`${method.toUpperCase()} ${path} answered ${response.status()}: ${await response.text()}`);
    return (response.status() === 204 ? undefined : await response.json()) as T;
  }

  category(name: string): Promise<Category> {
    return this.send('post', 'categories', { id: crypto.randomUUID(), name });
  }

  product(fields: Pick<ProductFields, 'categoryId' | 'name'> & Partial<ProductFields>): Promise<Product> {
    return this.send('post', 'products', {
      id: crypto.randomUUID(),
      brand: 'Acme',
      description: '',
      quantity: 10,
      price: '100.00',
      ...fields,
    });
  }

  updateProduct(product: Product, changes: Partial<ProductFields>): Promise<Product> {
    return this.send('patch', `products/${product.id}`, { version: product.version, ...changes });
  }

  movement(type: FormMovementType, lines: [Product, number][]): Promise<StockMovement> {
    return this.send('post', 'stock-movements', {
      id: crypto.randomUUID(),
      type,
      items: lines.map(([product, quantity]) => ({ productId: product.id, quantity })),
    });
  }

  employee(fullName: string, email: string): Promise<User> {
    return this.send('post', 'employees', { id: crypto.randomUUID(), fullName, email, password: PASSWORD });
  }
}

interface Fixtures {
  problems: PageProblems;
  /** The API signed in as the admin. */
  api: TestApi;
  /** The API signed in as any of the test users. */
  apiAs: (user: UserKey) => Promise<TestApi>;
}

export const test = base.extend<Fixtures & { resetData: void }, E2EOptions>({
  target: ['dev', { option: true, scope: 'worker' }],
  apiURL: ['', { option: true, scope: 'worker' }],

  // Every local test starts from the same data: the three users and nothing else.
  resetData: [
    async ({ target, apiURL }, use) => {
      if (target !== 'remote') {
        const response = await fetch(new URL('/__e2e/reset', apiURL), { method: 'POST' });
        expect(response.status, 'database reset').toBe(204);
      }
      await use();
    },
    { auto: true },
  ],

  problems: [
    async ({ page }, use) => {
      const problems = new PageProblems();
      problems.watch(page);
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || 'inline'}`);
        });
      });
      await use(problems);
      expect(problems.unexpected(), 'problems on the page').toEqual([]);
    },
    { auto: true },
  ],

  apiAs: async ({ playwright, apiURL, target }, use) => {
    const contexts: APIRequestContext[] = [];
    await use(async (user) => {
      if (target === 'remote') throw new Error('The remote smoke test is read-only: it never writes test data.');
      const request = await playwright.request.newContext({ baseURL: `${apiURL}/` });
      contexts.push(request);
      const response = await request.post('auth/login', { data: { email: USERS[user].email, password: PASSWORD } });
      expect(response.status(), `sign-in of ${user}`).toBe(200);
      return new TestApi(request);
    });
    for (const request of contexts) await request.dispose();
  },

  api: async ({ apiAs }, use) => {
    await use(await apiAs('admin'));
  },
});

export { expect };

/** Signs the page's browser in through the API (fast); the form itself is tested on its own. */
export async function signIn(page: Page, apiURL: string, user: UserKey): Promise<void> {
  const response = await page.request.post(`${apiURL}/auth/login`, {
    data: { email: USERS[user].email, password: PASSWORD },
  });
  expect(response.status(), `sign-in of ${user}`).toBe(200);
}

/** Signs in through the login form, as a person does. */
export async function signInWithForm(page: Page, email: string, password: string): Promise<void> {
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('current-user')).toBeVisible();
}

/** A main navigation link. */
export function navLink(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true });
}
