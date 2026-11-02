# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Supermarket inventory system: an admin manages employees, categories and products; employees browse products and record stock movements (sales or restocks). npm workspaces monorepo (`backend`, `frontend`) deployed to Vercel (static frontend + the Express API as one Vercel Function) with Neon Postgres.

**Scope:** a personal portfolio project: no commercial use, no payments and no real personal data of third parties, so the data other than the owner's own account is made up.

## Working agreement

- **Language:** talk to the user in Spanish. Everything versioned (code, UI, errors, comments, tests, docs) is in English. Before a commit, search the tracked files for Spanish text.
- **Plan before code:** present a plan for any non-trivial change and wait for approval. Ask about ambiguous decisions that change the result; for the rest, pick the industry standard and say what you picked.
- **Verify before claiming:** never say something works without running it, and show failing output. Find the root cause of flaky tests; never retry or skip them.
- **Verification cadence:**
  - While working on a stage: typecheck plus only the test files you touched (`cd backend; npx tsx --test tests/<file>.test.ts`), and screenshots for UI work. The full suite runs once, when the stage closes.
  - Repeated runs to catch flaky tests (3 in a row): only before a push that changes code or a deploy, or when a test fails in an odd way.
  - Coverage with thresholds: when the backend is finished and at project close, not at every stage.
  - A test that fails before the fix is required only for real bugs. For refactors and simplifications that keep behavior, the suite staying green is enough.
  - Unchanged: typecheck, `npm audit`, `npm run check:versions` and the staged-file audit before every commit, and the full verification below before every push and deploy that changes code. A push that only changes docs needs the typecheck and those audits.
- **Full verification:** all of this passes and is shown:
  - in order: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, `npm run test:e2e:prod -w frontend`, `npm run test:coverage`, `npm run check:versions`, `npm run check:release-age -- --exclude=body-parser`, `npm run audit` (0 vulnerabilities);
  - the backend suite three times in a row without an intermittent failure;
  - `npm run test:concurrency -w backend` on a Neon "Schema only" branch, if a transaction, a lock or the schema changed;
  - screenshots of the main screens (desktop and phone) reviewed;
  - no Spanish text in the tracked files, a clean audit for secrets and personal data, and the new commits authored with the noreply email;
  - no vulnerability described anywhere in the diff, and none known and unfixed in what is pushed;
  - the reviews the policy below requires, with no finding pending, and this file up to date;
  - after the deploy: `npm run test:e2e:remote -w frontend` against the published URL.
- **Web research:** only when the answer changes a decision (versions, security, platform behavior). One search or page per fact, not several in parallel, unless the first is not enough.
- **Summaries:** when a stage closes, a short summary: what was done, what was verified and what needs the user's approval. Don't repeat what is already in this file or in the commits.
- **`/compact`:** only the user runs it. Suggest it after the commit that closes a stage or block, and when the conversation is long before starting something big; never in the middle of a task. Before suggesting it, make sure everything important is saved in this file, the plan and the commits.
- **Commands for the user are PowerShell** (`$env:VAR = "x"; npm run y`, `A; if ($?) { B }`).
- **Never push.** The user pushes from their own terminal. Ask before irreversible or external actions (deleting files or git history, cloud resources).
- **Secrets:** never ask for or print connection strings or tokens. They live in `backend/.env` (gitignored) locally and as Sensitive variables in Vercel. Test credentials must be obviously fake (`postgresql://app_user:not-a-real-password@...`).
- **Before every commit:** `npm audit` with 0 vulnerabilities, `npm run check:versions`, and an audit of the staged files for secrets (API keys, GitHub/AWS/Slack tokens, Neon `npg_` passwords, private keys), `.env` contents, connection strings with credentials and personal data (emails, system paths such as `C:\Users\...`).
- **Git identity:** everything is published with the user's private GitHub noreply email, including merges from the web, which use the account's email. Before every commit, check `git config user.email`; before every push, check the new commits with `git log origin/main..HEAD --format='%ae %ce'`. The account keeps **Keep my email addresses private** and **Block command line pushes that expose my email** on.
- **GitHub:** `main` has a ruleset that targets only **Default branch**, with **Block force pushes** and **Restrict deletions**. With **All branches**, Dependabot's force pushes would be blocked too and its rebases would fail.
- **Preview deployments** share Production's database. That is accepted only for a portfolio, and only if they ask for the Vercel login: check it with an anonymous request. Before trying a schema or data change on a branch, give Preview its own Neon branch.
- **Vulnerabilities are fixed, never published.** Nothing in the repository describes a vulnerability: not the README, docs, comments, this file, test names, commit messages, PRs, issues, branch names, screenshots or logs. When one is found: report it in the chat at once (what it is, severity, impact); fix it before any other push or deploy of the affected part (rotate exposed secrets); the fix commit and its test describe the correct behavior ("Require ownership to update a ticket"), never the attack. One the user decides not to fix yet (low severity only) is tracked privately (a draft GitHub Security Advisory), never in the repo. A published vulnerability or secret is an incident. Only **limitations** go in the README's "Known limitations": a deliberate scope decision with negligible impact that gives an attacker nothing beyond the app's public behavior; when in doubt, it is a vulnerability. `SECURITY.md` asks for private reports.
- **Commits:** English, a summary line plus bullets, and keep the `Co-Authored-By` trailer for Claude.
- **README:** it describes the current state only (no history of earlier versions) and never names where ideas came from (courses, reference projects).
- **Review policy (few fixed moments, so the same code is not reviewed twice):**
  - The whole-code review before the first deploy is done. From now on, run `/security-review` before a push whose diff touches authentication, authorization, SQL or transactions, dependencies, headers or secret handling; no review when only tests or docs change.
  - A new backend area that is sensitive (authentication, sessions, authorization, transactions or concurrency) gets `/code-review high` on that area only when it is finished. A new frontend has no review of its own.
  - `/simplify` is not mandatory: it looks for quality improvements, not bugs or vulnerabilities. Run it only if the user asks, or if you see concrete duplication, say where and the user approves. It reports only, no edits.
  - Suggest `/compact` before each review, since every turn of a long conversation uses more.
  - After applying fixes, their tests and the suite are enough. Review again only if a fix changes a sensitive area, and only that part.
  - `/simplify` and `/security-review` have no levels; they always run the same way.
  - `max` and `ultra` only when the user explicitly asks: `max` uses a large share of the user's Pro plan; `ultra` runs in the cloud, is billed separately and only the user can launch it.
  - Every finding: verify it against the code, present it in a table as "confirmed" or "recommend no change" with the reason, and apply nothing until the user approves.
  - Reviews run in the background: don't edit files until they finish, so they review the real diff.
- Keep this file current: any change to commands, architecture or rules updates it in the same commit.

## Commands

Node 26.x is required (`.nvmrc` pins 26.13.0; `fnm use` picks it up). Always install with `npm ci`.

```powershell
npm run dev -w backend         # API on :3000 with tsx watch; PGlite persisted in backend/data (no DATABASE_URL)
npm run dev -w frontend        # Vite on :5173 (strictPort: CORS allows exactly that origin), calls the API on :3000
npm run build                  # backend/src -> backend/dist, then frontend: tsc -b + vite build -> frontend/dist (one chunk per page)
npm run preview -w frontend    # the production build on :4173, with the vercel.json headers and /api proxied to API_PROXY_TARGET (default :3000)
npm run typecheck              # both workspaces (TypeScript 7; the frontend uses tsc -b over tsconfig.app.json + tsconfig.node.json)
npm test                       # scripts + backend suites + frontend unit tests + e2e against the dev servers
npm test -w frontend           # frontend unit tests (Node test runner, fake APIs, 10 s limit per test)
cd frontend; npx tsx --test tests/unit/auth-store.test.ts   # one frontend file
npm run test:e2e -w frontend         # Playwright against the API (in-memory DB, :3100) + Vite (:5174)
npm run test:e2e:prod -w frontend    # the same specs against npm run build + vite preview (:4174, vercel.json headers)
cd frontend; npx playwright test tests/e2e/admin.spec.ts             # one spec
cd frontend; npx playwright test -g "keeps both filters"              # one test by name
$env:E2E_BASE_URL = "https://..."; $env:E2E_EMAIL = "..."; $env:E2E_PASSWORD = "..."; npm run test:e2e:remote -w frontend   # read-only smoke against a deployment
npm run test:coverage          # backend coverage with thresholds (97 % lines, 93 % branches, 93 % functions)
npm run test:concurrency -w backend   # the concurrency scenarios on a real Postgres: the DATABASE_URL in backend/.env.concurrency.local, a Neon "Schema only" branch; it changes that database freely and refuses one with users
npm test -w backend            # backend only; files run sequentially, 60 s limit per test
cd backend; npx tsx --test tests/rate-limit.test.ts                                     # one backend file
cd backend; npx tsx --test --test-concurrency=1 tests/products.test.ts tests/stock-movements.test.ts   # several files: always in sequence
cd backend; npx tsx --test --test-name-pattern="shared by every instance" tests/rate-limit.test.ts   # one test
npm run create-admin -w backend                                       # create an admin in the local PGlite (prompts)
npm run create-admin -w backend -- --env .env.production.local   # same, against the DATABASE_URL in that file
node scripts/build-password-blocklist.mjs <SecLists 100k-most-used-passwords-NCSC.txt>   # regenerate the blocklist module
npm run test:scripts           # tests of the repository scripts (node:test)
npm run check:versions         # exact versions, lockfile and .npmrc policy
npm run check:release-age -- --exclude=body-parser   # every locked package comes from the npm registry and is >= 14 days old (network)
npm run audit                  # npm audit --omit=dev --audit-level=low
node --test --test-name-pattern="rejects" scripts/check-versions.test.mjs   # one file / one test name
```

## Dependency policy

- **14-day release window:** `.npmrc` sets `min-release-age=14`, so `npm install <pkg>` picks the newest version that is at least 14 days old. `save-exact=true` and `engine-strict=true` are set too. Every `package.json` uses exact versions, and `scripts/check-versions.mjs` enforces that.
- The window only applies when npm resolves new versions. After changing dependencies, run `npm run check:release-age` against the lockfile.
- **Security exception:** if a known vulnerability is fixed in a version newer than the window, install it with `npm audit fix --min-release-age-exclude=<pkg>`. Never save the exception in `.npmrc`. Current exception: `body-parser@2.4.0`, a transitive dependency of Express that fixes GHSA-27r3-jxmh-p828. Remove the `--exclude` once it is older than 14 days.
- **Install scripts:** npm 11.20 only runs approved install scripts (`allowScripts` in the root `package.json`). Only `esbuild` (used by tsx) is approved, and it is pinned by version, so it needs `npm install-scripts approve esbuild` again after an esbuild update.
- **Upgrade together:**
  - `@electric-sql/pglite` with `@electric-sql/pglite-socket` (exact peer dependency);
  - `react` with `react-dom` and their `@types`;
  - `tailwindcss` with `@tailwindcss/vite`;
  - `@types/node` with the Node major (26).

  Dependabot groups the first three and respects the 14-day window through its `cooldown`. It does not know about the Node major, so a major bump of `@types/node` is closed by hand.
- **Dependabot PRs (there is no CI):** nothing runs the tests on its own, and Vercel's `Ready` only says the deploy worked. Before merging, fetch the branch and run the full verification and `/security-review` on its **latest commit**. A `rebase` or `recreate` can change the version, so a new commit is verified again. After the deploy, run the remote smoke test. **A security alert comes first**, ahead of the usual PR review: it can skip the 14-day window, not this verification.

## Architecture (agreed design; sections are filled in as each stage lands)

- **Backend:** Express 5 with a strict MVC split:
  - routes connect validation middleware to controllers;
  - controllers are thin;
  - models are the only layer that knows SQL (always parameterized) and validate their rows with Zod;
  - Zod schemas are the single source of truth for validation and DTO types.

  `createApp(options)` never listens on a port. `server.ts` (long-running) and `vercel.ts` (serverless) reuse it.
- **Database:** the same `pg` driver everywhere. Production uses Neon (pooled URL with `sslmode=verify-full`; the code sets no TLS options, so the URL decides). Development and tests use PGlite exposed through pglite-socket, with a 1-connection pool. The schema is idempotent and runs inside a transaction holding `pg_advisory_xact_lock`, only when `schema_version` does not hold the hash of its statements: a current schema costs one read and takes no table locks, so a new instance never holds up the writes in progress. An instance that waited for the lock checks again, and all the statements go in one round trip to keep the locks brief. They still lock tables in their own order, so a schema change during writes can deadlock with a sale: the victim rolls back and answers 503 (40P01), and the frontend retries it with the same id. Versioned migrations would remove that, and are worth it when the schema changes with real data. `withTransaction` sets `statement_timeout` and `idle_in_transaction_session_timeout` with `SET LOCAL` (the Neon pooler does not take them as connection parameters), so locks are released even if the function is cut off. IDs are UUIDs, and lists use keyset pagination on `(created_at DESC, id DESC)` with a `Link: rel="next"` header.
- **Auth:** server-side sessions in Postgres.
  - The cookie is httpOnly, `SameSite=Strict`, 12 h absolute (`__Host-sid` + Secure in production, `sid` locally). The database stores only the SHA-256 of the token. Each login issues a new token and revokes the browser's previous one.
  - `GET /auth/session` answers 200 `{ user }`, or `{ user: null }` without a valid session (`Cache-Control: no-store`), so the app's first load produces no error response; every route that needs a session answers 401.
  - `authenticate` (after the rate limits) loads `res.locals.user`; routes add `signedIn` / `adminOnly` chains (`middlewares/auth.ts`).
  - Roles are `admin` and `employee`. Admins come only from the `create-admin` CLI; `/employees` never reaches admin rows (404).
  - A route the role cannot use answers 403, before any lookup, so it reveals nothing about ids. Inside a route the role can use, a resource owned by someone else answers 404, never 403 (for example, another employee's stock movement).
  - Failed logins are limited per hashed IP (`login-ip`, `RATE_LIMIT_LOGIN_MAX`, 10) and, well above that, per hashed email from any IP (`login-account`, `RATE_LIMIT_LOGIN_ACCOUNT_MAX`, 100; the key is built in `auth-routes.ts`). Successful logins are refunded.
  - Each login rotates the session in one statement (`rotateSession`), which creates it only if the user still has the password hash that was verified, holding `FOR SHARE` on the row; otherwise the login answers 401.
  - `POST /auth/logout` clears the cookie only for a request that brought it; without one it answers 204 and sets nothing.
- **Passwords (NIST SP 800-63B-4):**
  - 15-128 code points, NFC-normalized, no composition rules.
  - scrypt with the OWASP parameters (`PRODUCTION_SCRYPT`, N = 2^17); each hash embeds its parameters.
  - `acceptNewPassword` (`lib/password-policy.ts`) is the only way to turn a new password into a hash, for the API and the CLI alike. The password must pass the offline checks: the bundled SecLists list (`password-blocklist-data.ts`, generated, MIT), repeated patterns, sequences, and the service name, email or full name (diacritics ignored). It must also pass Have I Been Pwned (k-anonymity, 3 s timeout). If HIBP fails, the check passes (fail-open) and the failure is logged.
  - The reason is returned in `details[0]` on `password`.
  - Unknown emails are verified against a dummy hash (`createDummyHash` + `verifyPasswordOrDummy`), built without hashing, so even the first login of a cold instance costs exactly one derivation and timing does not reveal accounts.
- **Catalog:**
  - Everyone signed in reads categories, products and `/stats`; only admins write.
  - Lists go through `listPage` (`models/keyset.ts`): one statement resolves the cursor and the page together.
    - `scope` defines which rows belong to the list (and so which rows are valid cursors); `where` holds request filters.
    - Their placeholders start at `$1`; the page size and the cursor are appended after them.
    - A cursor that is not a row of the list answers 400 on `before`. When a "Load more" cursor is deleted between two requests, the frontend list store retries with the previous item it has loaded.
  - Products use optimistic locking: a PATCH must send the current `version`; a stale one answers 409 `PRODUCT_VERSION_CONFLICT` with `currentVersion` (unless the edit already landed; see "Idempotent writes"). The `products_bump_version` trigger bumps `version` (and `updated_at`) on every UPDATE, whoever writes it, so a stock movement always invalidates an edit based on older data. `updated_at` on `categories` and `users` is also set by a trigger; models never write either column.
  - Creating a product with stock, changing its quantity, or deleting a product that still has stock records an `adjustment` movement in the same transaction (`insertMovement`).
  - A category with products cannot be deleted (409 `CATEGORY_IN_USE`). Names are unique ignoring case (409 `CATEGORY_NAME_TAKEN`).
  - Text fields go through `textSchema` / `requiredTextSchema` (trim + NFC, no null characters, which Postgres text cannot hold), so the same visible text is stored, compared and searched the same way.
  - `q` searches name and brand with ILIKE; the characters `%`, `_` and backslash are escaped, so they match literally.
  - `/stats` is one SQL round trip: out of stock = 0 units, low stock = 1 to `LOW_STOCK_THRESHOLD` (10, also returned as `lowStockThreshold`). Employees count only their own movements; only admins get `employees`.
- **Idempotent writes (resolved on the server):** creates carry a client-generated UUID. Repeating the same write returns the stored resource with **200** (`Created<T>` + `sendCreated`, `lib/routing.ts`), so a retry whose first response was lost succeeds with no client logic; the same id with different data answers 409 `alreadyExists()`. Each create inserts with `ON CONFLICT (id) DO NOTHING` and, when the id is taken, compares the stored row:
  - categories: the name; products: every value (a product whose stock moved since no longer matches); employees: name, email, role and the password against the stored hash (`createEmployee`); stock movements: author, type and the lines in order.
  - A product PATCH with a stale `version` whose product already holds every requested value returns it with 200 and records nothing.
  - DELETE stays REST: a retry gets 404, which the client treats as success.
- **Money:** `price` is `NUMERIC(10,2)` in the database and a canonical decimal string (`"1234.56"`) in the API, never a JS float. `PriceSchema` canonicalizes input (`"012.5"` → `"12.50"`), so requests and stored rows compare as strings. The UI shows ARS as `$ 1.234,56` (non-breaking space after `$`), using pure string functions in `frontend/src/lib/money.ts`.
- **Stock movements:** `sale`, `restock` and `adjustment` (adjustments come from admin edits to the quantity).
  - `POST /stock-movements` `{ id, type: sale|restock, items: [{ productId, quantity }] }`: 1 to `MAX_ITEMS_PER_MOVEMENT` lines, each product once, 1 to `MAX_LINE_QUANTITY` units per line. Everyone signed in can record one. Movements are never edited or deleted (405).
  - The client generates the movement id (see "Idempotent writes").
  - Each form is one transaction (`createStockMovement`, `models/movement-model.ts`), all or nothing:
    1. claim the id (`claimMovementId`: `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING created_at`); a taken id is settled before the lines are judged: the same form from the same author returns the stored movement (200), anything else 409 `ALREADY_EXISTS`. A retry racing the attempt that landed waits on that insert, so one statement settles every duplicate;
    2. lock the products with `ORDER BY id FOR UPDATE`, so forms sharing products cannot deadlock;
    3. report every failing line: 400 `VALIDATION_ERROR` on `items.N.productId` for a product that no longer exists (like `categoryId` on products), then 409 `INSUFFICIENT_STOCK` (sale) or 409 `STOCK_LIMIT_EXCEEDED` (restock past `MAX_QUANTITY`) with `path`, `productId`, `requested` and `available` in `details`;
    4. update the quantities and insert the lines; the trigger bumps each product's `version`. The response is built in memory, with no read-back.
  - Every movement, adjustments included, goes through `claimMovementId`, which turns an author deleted mid-request (`stock_movements_user_id_fkey`) into 401 `unauthenticated()`.
  - Reads: admins see every movement; an employee sees only their own, as a list `scope` (so another employee's id is not a valid cursor either) and on `GET /:id` (404). `?type=` filters the list. Each movement carries its lines; `user.id` and `product.id` turn null when that user or product is deleted, and the snapshots remain.
- **Middleware order (`app.ts`):**
  1. helmet, then CORS (an origin outside the list gets no headers, never a 403), then the request log;
  2. `/api/health`, outside every limit;
  3. the read limit (in memory, before anything that queries the database), then the write limit (Postgres `rate_limits`, keyed by the SHA-256 of `ipKeyGenerator(req.ip)`);
  4. `requireJson` (415), then `express.json` (10 kb, `inflate: false`);
  5. the routes, then 404, then `createErrorHandler` (`toHttpError` maps body-parser, 4xx and database-unavailable errors; everything else becomes a generic 500 with the stack logged).

  Routes are registered with `defineRoute` (`lib/routing.ts`), which adds the 405 + `Allow` fallback.
- **Frontend (React 19, Vite 8, React Router 8 declarative mode, Zustand 5, Tailwind v4):**
  - `api/errors.ts` (`ApiError`, `errorMessage`, `isRetryable`, `isUnauthenticated`) and `api/http.ts` (`createHttpClient`) never read `import.meta.env`, so Node unit tests import them with a fake `fetch`. `api/client.ts` builds the one instance from `VITE_API_URL` (versioned `.env.development` = `http://localhost:3000/api`, `.env.production` = `/api`; `.env.local` overrides, gitignored).
  - The client sends `credentials: 'include'`, maps the API error body to `ApiError` (any other error response to `HTTP_ERROR` with its status), a failed fetch to `NETWORK_ERROR` (status 0) and a 2xx that is not JSON to `INVALID_RESPONSE`. `requestWithHeaders` also returns the headers (`Link`). Every 401 `UNAUTHENTICATED` notifies `onUnauthenticated` listeners; `stores/auth.ts` connects that to `authStore.sessionExpired()`.
  - Stores are factories that receive their API (`createAuthStore(api)`). `stores/auth.ts` wires the session and exports `useAuth(selector)`; it is all the shell (layout, guards, sign-in) imports. `stores/index.ts` wires the data stores; only pages import it, so it is a chunk of its own. Tests use the factories with fake APIs whose calls the test settles (`fakeMethod`, `tests/unit/helpers.ts`).
  - Auth store: `status` `unknown → checking → authenticated | anonymous | error` (from `GET /auth/session`; `error` only when that request fails). Concurrent `checkSession` calls share the request in flight (StrictMode runs effects twice). Every change of who is signed in bumps a generation; a response from an older generation is ignored. A failed sign-out keeps the session and shows why. After a voluntary sign-out (`signedOutByUser`) the next sign-in starts at home; after a lost session it returns to the page (`state.from`, filtered by `safeRedirectPath`).
  - Data stores:
    - generic factories: `createPagedListStore` (products, movements, employees: first page, "Load more", `added`/`updated`/`removed` from writes), `createResourceStore` (stats, a movement), `createEditorStore` (product and employee forms: load, create or PATCH only what changed, delete), plus `createCategoriesStore` (every page, sorted, a write state per row) and `createMovementFormStore` (the stock form's lines and submission live in the store);
    - reads are never aborted: `createRequestGate` shares an identical request in flight (StrictMode asks twice, the network sees one) and lets only the latest apply. When a write lands, `writeLanded()` sends a read in flight again, since it may have been answered from before the write. List screens reload their data on every visit and keep the old data on screen meanwhile (a failed refresh shows the error above the list, `ListStates`);
    - "Load more" after the cursor row was deleted (400 on `before`) retries from the item before it, skips duplicates and drops the deleted one;
    - every write goes through `createWriteTracker` (`stores/shared.ts`) on top of `runWithRetries` (`lib/retry.ts`): network, 429 and 5xx up to 4 attempts with jittered backoff (a `Retry-After` over 30 s stops it). Each store keeps `writes` by key (a category row, `save:<id|new>` and `remove:<id>` in the editors, the stock form's one submission), each with its `kind`, its `WriteState` (`pending`, with `retrying` after a failure; `failed`, which offers "Retry"; `rejected`, a 4xx with no "Retry") and the `input` it sent. "Retry" (`retry(key)`) resends exactly the stored request (same id, same body), whatever the screen shows by then. A create's id comes from `createIdempotencyKey`: the same body reuses the id, a changed body or the next create gets a new one, and a landed create clears only its own id. `deleteResource` treats the resource's own 404 code as done;
    - writes do not depend on the screen: they keep retrying after the user leaves. What a screen does after an await checks `useScreenScope()`, so a late answer starts nothing. Editor pages are `EditorGate` (open, not found, load error, loading) plus `useEditorForm` (values, field errors from the API, save/delete/Retry, navigation) plus `EditorActions` (the footer). `EditorGate` mounts the form only after `open`, which forgets the finished writes and drops the item of the last visit, so a form always starts from what is stored now (its PATCH must carry the version of the values it shows); only an unfinished write keeps its item and is shown again with what it sent (`editorDraft`). `useEditorForm` leaves the form when a write lands while it is open, whichever visit started it, so a create can never be sent twice from it. The stock form's confirmation is shown once, even when the movement landed while the user was elsewhere (`recordedShown`);
    - `resetOnUserChange` (`stores/user-data.ts`): when the signed-in user id changes (including to null), every data store resets (and the product search cache clears), which also stops the writes still retrying, so a retry never runs under the next user's session;
    - the preferences store (zustand `persist`, key `supermarket-stock-system:preferences`, through `safeStorage`, which never throws) keeps only the stock form's last type; stored values are validated in `merge`.
  - Pure logic in `lib/` (tested in Node): `money.ts` (ARS strings, see Money), `numbers.ts` (`1.250 units`, quantity input with dot thousands), `dates.ts` ("31 Oct 2026, 14:05"; only numeric parts come from Intl, one cached formatter per time zone), `link-header.ts` (the `before` of `rel="next"`), `forms.ts` (validation, PATCH changes, API details mapped onto fields and stock lines), `movement-types.ts` (types and labels), `memoize-recent.ts` (the product picker reuses a search for 5 s). Every API limit the forms mirror lives in `api/limits.ts`.
  - Product filters (`q`, `category`) and the history's `type` live in the URL, always written through `useUpdateSearchParams` (it builds on the URL as it is now, not on the last render's params, so a debounced search cannot drop a newer filter). Typing replaces the history entry after a 300 ms pause; picking a filter pushes one, so Back undoes it.
  - Routing (`App.tsx`): every page is `React.lazy` (factories in `pages.ts`). Each page renders inside a `RouteBoundary` (an `ErrorBoundary` with `key={pathname}`, "Try again" reloads, around a `Suspense`), inside the `Layout`, so navigating never remounts the header; an outer boundary catches the shell. `main.tsx` preloads the first URL's page while the session is checked (only pages every role can open; a failure is ignored and handled by the router). `RequireAuth` wraps the `Layout` route; `RequireRole` shows "Access denied" inside it. `PageFallback` and `Refreshing` appear after 300 ms (`useDelayedFlag`). `lib/preload-error.ts` reloads once per 10 s on `vite:preloadError` (guard in `sessionStorage`; without storage it never reloads). It first requests the failed chunk with `cache: 'reload'`, because the `/assets/` cache header also covers a 404 and the browser would keep it after a rollback.
  - End-to-end tests (Playwright, Chromium, `tests/e2e`):
    - three configs over `playwright.shared.ts`: `playwright.config.ts` (dev), `playwright.prod.config.ts` (build + preview), `playwright.remote.config.ts` (only `smoke.spec.ts`, read-only, no traces or screenshots because it types real credentials). Each writes to its own `test-results/<target>` (Playwright empties its `outputDir`). Servers bind `127.0.0.1` on dedicated ports through CLI flags, never `localhost` (Vite listens only on `::1` on Windows);
    - `backend/tests/e2e-server.ts` (`npm run e2e-server -w backend`) is the real app on an in-memory PGlite with three fake users (`admin@example.com`, `employee@example.com`, `other.employee@example.com`, password `correct horse battery staple`) plus `POST /__e2e/reset` (test-only, never in `dist`). It prints slow or unanswered requests and event-loop stalls;
    - `tests/e2e/fixtures.ts`: every test resets the data (`resetData`), and fails on any console error, page error, failed request, response >= 400 or CSP violation (`problems`) unless it allows that one (`problems.allow(/^409 POST \/api\/categories$/)`). Test data goes through the API (`api`, `apiAs(user)`); `signIn` signs the browser in through the API, and the login form has its own tests. One worker: tests share the database;
    - API errors are simulated with `page.route` and a URL predicate kept in a constant (`page.unroute` needs the same function). Wait for conditions or responses, never for an intermediate state that may pass unseen; rows created in the same instant tie on `created_at`, so assert those lists in any order.
  - `vite preview` mimics Vercel through `vercel-preview.ts`: the headers of `vercel.json` (pure `headersFor`, tested against the real file) and 404 for a missing `/assets/` file.
- **Entries:** `index.ts` is the long-running process (bootstrap, signals, exit 1 on startup failure). `vercel.ts` forces `NODE_ENV=production` and `VERCEL=1` (trust proxy), answers 503 `SERVER_MISCONFIGURED` when the config is invalid, and creates the schema lazily on the first request, retrying on a later request if that fails. `api/index.js` re-exports its default export, which must stay an Express app: Vercel gives a plain function a request whose body it has already read, and its own `res.json`/`res.send`, while an app gets the untouched request, so `express.json` applies its limit and errors. The smoke test checks that on the deployment too. PGlite stays out of the function through `excludeFiles` in `vercel.json` (it is a lazy import that production never reaches).

## Known pitfalls

- **Tests:** every test file must close what it opens (HTTP servers, pools, PGlite) in `after()`, or the file never exits. That is the first thing to check when a test run hangs.
- **Diagnosing a stuck or flaky run:** each test has a 60 s limit (`--test-timeout`), so a stuck test fails with its stack. The spec reporter prints error details only in the final summary, which is lost if the run is killed; for repeated verification runs add `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=<temp file>` so each error is written as it happens.
- **A stalled e2e run on this Windows machine:** about once in 20 to 40 runs, early in the run, `e2e_event_loop_stalled` reports about 7 s with almost no CPU and a test fails on its 5 s wait. Traced with a watchdog in every Node process: Vite and the API blocked at once and were released within 60 ms of each other, while a worker thread in each kept running and no clock jumped. So it is a wait in the operating system, outside the app. The exact component is unknown (the machine runs a third-party firewall). A failure without that line is a real failure.
- **Test apps:** build them with `createTestApp` (`tests/helpers.ts`), which uses `TEST_SCRYPT` and a fake breach check. `testConfig()` points HIBP at an unroutable address, so a test that forgets the fake never calls the real API (the check answers "unavailable" and fails open, so the test does not fail either).
- **Foreign keys:** deleting a row that an `ON DELETE RESTRICT` key still references fails with SQLSTATE **23001** (`restrict_violation`) since Postgres 18, 23503 before it. Use `isRestrictViolation` on a DELETE and `isForeignKeyViolation` (23503) for an invalid reference on a write.
- **Failed queries and the pool:** `pool.query` discards its connection when the query fails. The local server accepts two connections, so a test that holds one open (an inspector) can run out while the pool replaces its own; open one per query instead.
- **Ordering in tests:** rows inserted in quick succession can share `created_at` (PGlite's clock is coarse). Tests fix the timestamps with `spreadCreatedAt` (some distinct, some tied) and compute the expected order with `ORDER BY created_at DESC, id DESC`; `walkPages` follows the `Link` header.
- **Numbers inside JSON built in SQL:** `json_build_object` turns a `numeric` into a JSON number, which loses precision in JavaScript. Cast money to text inside the JSON (`unit_price::text`).
- **Concurrency tests:** PGlite is single-session and the test pool has one connection, so concurrent requests are serialized before they reach the database. They prove the outcome (one sale of the last unit wins, the other gets 409), not the row locks. Under real concurrency (Neon) correctness rests on `ORDER BY id FOR UPDATE`, with the CHECK constraints as the last line of defense. `tests/concurrency/scenarios.ts` holds the overlapping-request scenarios: `npm test` runs them on PGlite, and `npm run test:concurrency` on a real Postgres with two app instances, where the locks and the pooler do the work. Run that one after changing a transaction, a lock or the schema. In them a 503 is always accepted and checked to leave nothing behind; a 500 never is.
- **Keyset pagination:** compare the cursor row inside SQL (`(created_at, id) < (SELECT created_at, id ...)`). Passing `created_at` through a JS `Date` drops its microseconds and skips or repeats rows on ties.
- **CLI environment:**
  - Without flags, `create-admin` reads `.env` like the server does, and variables set in the shell win.
  - `--env <file>` wins over the shell, so a stale exported `DATABASE_URL` cannot redirect it. The flag is not `--env-file`, because tsx also hands that one to Node, which fails on its own.
  - It prints the target database (without credentials) before writing.
  - Tests launch it through tsx's own CLI, exactly like `npm run create-admin`, from a temporary working directory, so they can never touch `backend/data` or `backend/.env`.
- **Local PGlite lock:** a data directory can be open in only one process at a time (`<dir>.lock` with the PID; a stale lock is taken over). Stop `npm run dev` before running `create-admin` against the local database.
- **Coverage:** `src/index.ts` and `src/cli/**` are excluded because they are tested as child processes. Pure logic used by the CLI lives in `src/lib` (for example `hidden-input.ts`), so it is measured.
- **Background work:** probabilistic cleanups (expired rate-limit rows, expired sessions) go through `maybeRunInBackground` (`lib/background.ts`); the request never waits for them.
- **Frontend TypeScript:** imports inside `src` are extensionless (bundler resolution; tsx resolves them in tests). `vite.config.ts` imports `./vercel-preview.ts` with its extension, as Vite's native config loader requires (`allowImportingTsExtensions` in `tsconfig.node.json`). A module that tests import must not use `import.meta.env`: `tsconfig.node.json` has no Vite types, so `tsc -b` rejects it.
- **`vercel build` on Windows:** it does not apply `excludeFiles` (the tracer turns the pattern into backslashes, which then match nothing), so a local build shows PGlite in the function (about 25 MB instead of 3.3 MB). The CLI must also be new enough to know the Node major in `engines`.
- **Windows:** stopping a backgrounded `npm run dev` task leaves its `node` child running. Stop only the process that listens on the port (`Get-NetTCPConnection -LocalPort <port>`), never every `node.exe`. The SIGTERM test is skipped on Windows because Windows has no POSIX signals.
