import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AuthApi } from '../../src/api/auth-api';
import type { Category, FormMovementType, MovementLineInput, Page, StockMovement, User } from '../../src/api/types';
import { createScreenScope } from '../../src/lib/screen-scope';
import { createAuthStore } from '../../src/stores/auth-store';
import { NEW_CATEGORY, createCategoriesStore } from '../../src/stores/categories-store';
import { createEditorStore, editorDraft, editorWrite } from '../../src/stores/editor-store';
import { createMovementFormStore, movementSubmission, type MovementFormState } from '../../src/stores/movement-form-store';
import { PREFERENCES_KEY, createPreferencesStore, safeStorage } from '../../src/stores/preferences-store';
import { resetOnUserChange } from '../../src/stores/user-data';
import { fakeMethod, fakeStoreDeps, flush, offline, rejected, serverError } from './helpers';

// Editor (products and employees share it) ---------------------------------

interface Thing {
  id: string;
  name: string;
  version: number;
}
interface ThingFields {
  name: string;
}

function setupEditor() {
  const { deps, timers } = fakeStoreDeps();
  const api = {
    get: fakeMethod<[string], Thing>(),
    create: fakeMethod<[string, ThingFields], Thing>(),
    update: fakeMethod<[Thing, Partial<ThingFields>], Thing>(),
    remove: fakeMethod<[string], void>(),
  };
  const saved: [Thing, boolean][] = [];
  const removed: string[] = [];
  const store = createEditorStore<Thing, ThingFields>({
    ...api,
    changes: (current, fields) => (current.name === fields.name ? {} : { name: fields.name }),
    onSaved: (item, created) => saved.push([item, created]),
    onRemoved: (id) => removed.push(id),
    deps,
  });
  return { store, api, timers, saved, removed, state: () => store.getState() };
}

async function openedThing() {
  const ctx = setupEditor();
  const open = ctx.state().open('t1');
  ctx.api.get.calls[0]?.reply.resolve({ id: 't1', name: 'Old', version: 1 });
  await open;
  return ctx;
}

describe('editor: create', () => {
  test('creates with a client id; a success is reported once', async () => {
    const { state, api, saved } = setupEditor();
    await state().open(null);
    const submit = state().submit({ name: 'Milk' });
    assert.deepEqual(editorWrite(state(), 'save'), { status: 'pending', retrying: false });
    assert.deepEqual(api.create.calls[0]?.args, ['id-1', { name: 'Milk' }]);
    api.create.calls[0]?.reply.resolve({ id: 'id-1', name: 'Milk', version: 1 });
    assert.equal((await submit).kind, 'succeeded');
    assert.deepEqual(editorWrite(state(), 'save'), { status: 'succeeded' });
    assert.deepEqual(saved, [[{ id: 'id-1', name: 'Milk', version: 1 }, true]]);
  });

  test('network errors and 5xx retry with the same id until it lands', async () => {
    const { state, api, timers } = setupEditor();
    await state().open(null);
    const submit = state().submit({ name: 'Milk' });
    api.create.calls[0]?.reply.reject(offline());
    await timers.wakeAll();
    assert.deepEqual(editorWrite(state(), 'save'), { status: 'pending', retrying: true });
    api.create.calls[1]?.reply.reject(serverError());
    await timers.wakeAll();
    api.create.calls[2]?.reply.resolve({ id: 'id-1', name: 'Milk', version: 1 });
    await submit;
    assert.deepEqual(
      api.create.calls.map((call) => call.args[0]),
      ['id-1', 'id-1', 'id-1'],
    );
    assert.deepEqual(editorWrite(state(), 'save'), { status: 'succeeded' });
  });

  test('failed after the last attempt; "Retry" sends the same id again', async () => {
    const { state, api, timers } = setupEditor();
    await state().open(null);
    const submit = state().submit({ name: 'Milk' });
    for (let call = 0; call < 4; call++) {
      api.create.calls[call]?.reply.reject(offline());
      await timers.wakeAll();
    }
    await submit;
    assert.deepEqual(editorWrite(state(), 'save'), { status: 'failed', message: 'Could not reach the server.' });
    const retry = state().submit({ name: 'Milk' });
    assert.equal(api.create.calls[4]?.args[0], 'id-1');
    api.create.calls[4]?.reply.resolve({ id: 'id-1', name: 'Milk', version: 1 });
    await retry;
    assert.deepEqual(editorWrite(state(), 'save'), { status: 'succeeded' });
  });

  test('a changed form gets a new id; the next create after a success too', async () => {
    const { state, api, timers } = setupEditor();
    await state().open(null);
    const first = state().submit({ name: 'Milk' });
    for (let call = 0; call < 4; call++) {
      api.create.calls[call]?.reply.reject(offline());
      await timers.wakeAll();
    }
    await first;
    const changed = state().submit({ name: 'Milk 1 L' });
    assert.equal(api.create.calls[4]?.args[0], 'id-2');
    api.create.calls[4]?.reply.resolve({ id: 'id-2', name: 'Milk 1 L', version: 1 });
    await changed;
    await state().open(null);
    void state().submit({ name: 'Milk 1 L' });
    assert.equal(api.create.calls[5]?.args[0], 'id-3');
  });

  test('a 4xx is rejected at once, with its code and details', async () => {
    const { state, api } = setupEditor();
    await state().open(null);
    const submit = state().submit({ name: '' });
    api.create.calls[0]?.reply.reject(rejected(400, 'VALIDATION_ERROR', 'Invalid request body.', [{ path: 'name', message: 'is required' }]));
    await submit;
    assert.deepEqual(editorWrite(state(), 'save'), {
      status: 'rejected',
      code: 'VALIDATION_ERROR',
      message: 'Invalid request body.',
      details: [{ path: 'name', message: 'is required' }],
    });
    assert.equal(api.create.calls.length, 1);
  });

  test('a second submit while one is pending sends nothing', async () => {
    const { state, api } = setupEditor();
    await state().open(null);
    void state().submit({ name: 'Milk' });
    assert.equal((await state().submit({ name: 'Milk' })).kind, 'cancelled');
    assert.equal(api.create.calls.length, 1);
  });
});

describe('editor: leaving the screen', () => {
  test('the write keeps retrying after the screen is gone; the screen continues nothing', async () => {
    const { state, api, timers, saved } = setupEditor();
    await state().open(null);
    const scope = createScreenScope();
    let navigated = false;
    void state()
      .submit({ name: 'Milk' })
      .then((outcome) => {
        if (scope.active && outcome.kind === 'succeeded') navigated = true;
      });
    api.create.calls[0]?.reply.reject(offline());
    scope.dispose();
    await timers.wakeAll();
    assert.equal(api.create.calls.length, 2, 'the retry timer still ran');
    api.create.calls[1]?.reply.resolve({ id: 'id-1', name: 'Milk', version: 1 });
    await flush();
    assert.equal(navigated, false);
    assert.equal(saved.length, 1, 'the list still learns about the new item');
  });

  test('reopening the same form while it saves shows the save; opening another hides it', async () => {
    const { state, api } = await openedThing();
    void state().submit({ name: 'New' });
    void state().open('t1');
    assert.equal(editorWrite(state(), 'save').status, 'pending');
    void state().open('t2');
    assert.equal(editorWrite(state(), 'save').status, 'idle');
    api.update.calls[0]?.reply.resolve({ id: 't1', name: 'New', version: 2 });
    await flush();
    assert.equal(editorWrite(state(), 'save').status, 'idle', 'the old form state does not reach the new form');
  });

  test('reopening a form drops the item of the last visit until the stored one arrives', async () => {
    const { state, api } = await openedThing();
    const reopen = state().open('t1');
    assert.equal(state().item, null);
    api.get.calls[1]?.reply.resolve({ id: 't1', name: 'Theirs', version: 2 });
    await reopen;
    assert.deepEqual(state().item, { id: 't1', name: 'Theirs', version: 2 });
  });

  test('reopening a form whose save is unfinished keeps the item the save is based on', async () => {
    const { state } = await openedThing();
    void state().submit({ name: 'New' });
    void state().open('t1');
    assert.equal(state().item?.version, 1);
  });

  test('StrictMode opens twice with one request', async () => {
    const { state, api } = setupEditor();
    void state().open('t1');
    void state().open('t1');
    assert.equal(api.get.calls.length, 1);
  });

  test('a finished save does not show again when the form reopens', async () => {
    const { state, api } = setupEditor();
    await state().open(null);
    const submit = state().submit({ name: 'Milk' });
    api.create.calls[0]?.reply.resolve({ id: 'id-1', name: 'Milk', version: 1 });
    await submit;
    await state().open(null);
    assert.equal(editorWrite(state(), 'save').status, 'idle');
  });
});

describe('editor: edit and delete', () => {
  test('loads the item; a 404 is "not found"', async () => {
    const { state, api } = await openedThing();
    assert.equal(state().loadStatus, 'loaded');
    const missing = state().open('gone');
    assert.equal(state().item, null);
    api.get.calls[1]?.reply.reject(rejected(404, 'PRODUCT_NOT_FOUND'));
    await missing;
    assert.equal(state().loadStatus, 'notFound');
  });

  test('saves only what changed, and nothing when nothing did', async () => {
    const { state, api, saved } = await openedThing();
    assert.equal((await state().submit({ name: 'Old' })).kind, 'succeeded');
    assert.equal(api.update.calls.length, 0);
    assert.equal(editorWrite(state(), 'save').status, 'succeeded', 'the form treats it like any save that landed');
    const submit = state().submit({ name: 'New' });
    assert.deepEqual(api.update.calls[0]?.args, [{ id: 't1', name: 'Old', version: 1 }, { name: 'New' }]);
    api.update.calls[0]?.reply.resolve({ id: 't1', name: 'New', version: 2 });
    await submit;
    assert.deepEqual(state().item, { id: 't1', name: 'New', version: 2 });
    assert.deepEqual(saved, [[{ id: 't1', name: 'New', version: 2 }, false]]);
  });

  test('a load that started before the save landed cannot bring back the older item', async () => {
    const { state, api } = await openedThing();
    const submit = state().submit({ name: 'New' });
    const reload = state().reload();
    api.update.calls[0]?.reply.resolve({ id: 't1', name: 'New', version: 2 });
    await submit;
    api.get.calls[1]?.reply.resolve({ id: 't1', name: 'Old', version: 1 });
    await reload;
    assert.equal(state().item?.version, 2);
  });

  test('a version conflict is rejected; reload brings the current item', async () => {
    const { state, api } = await openedThing();
    const submit = state().submit({ name: 'New' });
    api.update.calls[0]?.reply.reject(rejected(409, 'PRODUCT_VERSION_CONFLICT', 'Someone else changed this product.'));
    await submit;
    assert.equal(editorWrite(state(), 'save').status, 'rejected');
    const reload = state().reload();
    api.get.calls[1]?.reply.resolve({ id: 't1', name: 'Theirs', version: 5 });
    await reload;
    assert.equal(state().item?.name, 'Theirs');
  });

  test('reloading drops the item, so a failed load shows the error instead of stale values', async () => {
    const { state, api } = await openedThing();
    const reload = state().reload();
    assert.equal(state().item, null);
    api.get.calls[1]?.reply.reject(offline());
    await reload;
    assert.equal(state().item, null);
    assert.equal(state().loadStatus, 'error');
  });

  test('delete retries like any write and reports the id', async () => {
    const { state, api, timers, removed } = await openedThing();
    const deletion = state().delete();
    api.remove.calls[0]?.reply.reject(offline());
    await timers.wakeAll();
    api.remove.calls[1]?.reply.resolve();
    assert.equal((await deletion).kind, 'succeeded');
    assert.deepEqual(removed, ['t1']);
    assert.deepEqual(editorWrite(state(), 'remove'), { status: 'succeeded' });
  });

  test('reset stops a write that is still retrying and voids its result', async () => {
    const { state, api, timers, saved } = await openedThing();
    const submit = state().submit({ name: 'New' });
    api.update.calls[0]?.reply.reject(offline());
    await flush();
    state().reset();
    await timers.wakeAll();
    assert.deepEqual(await submit, { kind: 'cancelled' });
    assert.equal(api.update.calls.length, 1, 'no retry under the next session');
    assert.deepEqual(saved, []);
    assert.equal(state().targetId, null);
  });
});

// Categories ---------------------------------------------------------------

const category = (id: string, name: string): Category => ({
  id,
  name,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
});

function setupCategories() {
  const { deps, timers } = fakeStoreDeps();
  const api = {
    list: fakeMethod<[{ before?: string; limit?: number }], Page<Category>>(),
    create: fakeMethod<[string, string], Category>(),
    rename: fakeMethod<[string, string], Category>(),
    remove: fakeMethod<[string], void>(),
  };
  const store = createCategoriesStore(api, deps);
  return { api, timers, state: () => store.getState() };
}

describe('categories store', () => {
  test('loads every page and sorts by name', async () => {
    const { api, state } = setupCategories();
    const load = state().load();
    api.list.calls[0]?.reply.resolve({ items: [category('1', 'dairy'), category('2', 'Bakery')], nextCursor: '2' });
    await flush();
    assert.deepEqual(api.list.calls[1]?.args, [{ before: '2', limit: 100 }]);
    api.list.calls[1]?.reply.resolve({ items: [category('3', 'Cleaning')], nextCursor: null });
    await load;
    assert.deepEqual(state().items.map((item) => item.name), ['Bakery', 'Cleaning', 'dairy']);
  });

  test('create, rename and remove update the list; each row has its own write state', async () => {
    const { api, state } = setupCategories();
    const load = state().load();
    api.list.calls[0]?.reply.resolve({ items: [category('1', 'Dairy')], nextCursor: null });
    await load;

    const create = state().create('Bakery');
    assert.deepEqual(api.create.calls[0]?.args, ['id-1', 'Bakery']);
    api.create.calls[0]?.reply.resolve(category('id-1', 'Bakery'));
    await create;
    assert.deepEqual(state().writes[NEW_CATEGORY]?.state, { status: 'succeeded' });

    const rename = state().rename('1', 'Milk');
    assert.equal(state().writes['1']?.state.status, 'pending');
    api.rename.calls[0]?.reply.resolve(category('1', 'Milk'));
    await rename;
    assert.deepEqual(state().items.map((item) => item.name), ['Bakery', 'Milk']);

    const remove = state().remove('id-1');
    api.remove.calls[0]?.reply.resolve();
    await remove;
    assert.deepEqual(state().items.map((item) => item.name), ['Milk']);
  });

  test('a category in use is rejected and stays', async () => {
    const { api, state } = setupCategories();
    const load = state().load();
    api.list.calls[0]?.reply.resolve({ items: [category('1', 'Dairy')], nextCursor: null });
    await load;
    const remove = state().remove('1');
    api.remove.calls[0]?.reply.reject(rejected(409, 'CATEGORY_IN_USE', 'This category still has products.'));
    await remove;
    assert.equal(state().writes['1']?.state.status, 'rejected');
    assert.equal(state().items.length, 1);
    state().dismiss('1');
    assert.equal(state().writes['1'], undefined);
  });

  test('a write that lands during a load starts a fresh load', async () => {
    const { api, state } = setupCategories();
    const load = state().load();
    const create = state().create('Bakery');
    api.create.calls[0]?.reply.resolve(category('id-1', 'Bakery'));
    await create;
    assert.equal(api.list.calls.length, 2);
    api.list.calls[0]?.reply.resolve({ items: [], nextCursor: null });
    api.list.calls[1]?.reply.resolve({ items: [category('id-1', 'Bakery')], nextCursor: null });
    await load;
    await flush();
    assert.deepEqual(state().items.map((item) => item.id), ['id-1']);
    assert.equal(state().status, 'loaded');
  });
});

// Stock form ---------------------------------------------------------------

function setupMovementForm(initialType: FormMovementType = 'sale') {
  const { deps, timers } = fakeStoreDeps();
  const create = fakeMethod<[string, FormMovementType, MovementLineInput[]], StockMovement>();
  const typeChanges: FormMovementType[] = [];
  const recorded: StockMovement[] = [];
  const store = createMovementFormStore({
    api: { create },
    deps,
    initialType: () => initialType,
    onTypeChange: (type) => typeChanges.push(type),
    onRecorded: (movement) => recorded.push(movement),
  });
  return { store, create, timers, typeChanges, recorded, state: () => store.getState() };
}

const movement = (id: string): StockMovement => ({
  id,
  type: 'sale',
  user: { id: 'u1', fullName: 'Ana' },
  items: [],
  createdAt: '2026-10-01T12:00:00.000Z',
});

const option = (id: string, quantity = 5) => ({ id, name: `Product ${id}`, brand: 'Brand', quantity });

function fillLine(state: () => MovementFormState, index: number, productId: string, quantity: string) {
  const key = state().lines[index]?.key ?? '';
  state().setProduct(key, option(productId));
  state().setQuantity(key, quantity);
}

describe('stock form store', () => {
  test('starts with one blank line and the preferred type', () => {
    const { state } = setupMovementForm('restock');
    assert.equal(state().type, 'restock');
    assert.equal(state().lines.length, 1);
  });

  test('invalid lines are reported without sending anything', async () => {
    const { state, create } = setupMovementForm();
    await state().submit();
    assert.deepEqual(state().errors?.lines[state().lines[0]?.key ?? ''], { product: 'Choose a product.', quantity: 'Enter a quantity.' });
    assert.equal(create.calls.length, 0);
    fillLine(state, 0, 'p1', '2');
    assert.deepEqual(state().errors?.lines[state().lines[0]?.key ?? ''], {});
  });

  test('records the movement: one request with every line, then the success screen', async () => {
    const { state, create, recorded } = setupMovementForm();
    fillLine(state, 0, 'p1', '2');
    state().addLine();
    fillLine(state, 1, 'p2', '1.000');
    const submit = state().submit();
    assert.deepEqual(create.calls[0]?.args, [
      'id-1',
      'sale',
      [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1000 },
      ],
    ]);
    create.calls[0]?.reply.resolve(movement('id-1'));
    await submit;
    assert.equal(movementSubmission(state()).status, 'succeeded');
    assert.equal(state().recorded?.id, 'id-1');
    assert.equal(recorded.length, 1);
    state().startOver();
    assert.equal(state().recorded, null);
    assert.equal(state().lines.length, 1);
    assert.equal(state().lines[0]?.product, null);
  });

  test('the lines are locked while it is sent; retries reuse the id', async () => {
    const { state, create, timers } = setupMovementForm();
    fillLine(state, 0, 'p1', '2');
    const submit = state().submit();
    state().setQuantity(state().lines[0]?.key ?? '', '99');
    state().setType('restock');
    assert.equal(state().lines[0]?.quantity, '2');
    assert.equal(state().type, 'sale');
    create.calls[0]?.reply.reject(serverError());
    await timers.wakeAll();
    assert.equal(movementSubmission(state()).status, 'pending');
    create.calls[1]?.reply.resolve(movement('id-1'));
    await submit;
    assert.deepEqual(create.calls.map((call) => call.args[0]), ['id-1', 'id-1']);
  });

  test('failed: Retry sends the same id; editing first makes a new one', async () => {
    const { state, create, timers } = setupMovementForm();
    fillLine(state, 0, 'p1', '2');
    const submit = state().submit();
    for (let call = 0; call < 4; call++) {
      create.calls[call]?.reply.reject(offline());
      await timers.wakeAll();
    }
    await submit;
    assert.equal(movementSubmission(state()).status, 'failed');
    void state().submit();
    assert.equal(create.calls[4]?.args[0], 'id-1');
    create.calls[4]?.reply.reject(rejected(409, 'INSUFFICIENT_STOCK', 'Not enough stock.', []));
    await flush();
    state().setQuantity(state().lines[0]?.key ?? '', '1');
    void state().submit();
    assert.equal(create.calls[5]?.args[0], 'id-2');
  });

  test('a stock shortfall marks the line and shows the current stock', async () => {
    const { state, create } = setupMovementForm();
    fillLine(state, 0, 'p1', '9');
    const submit = state().submit();
    create.calls[0]?.reply.reject(
      rejected(409, 'INSUFFICIENT_STOCK', 'There is not enough stock for some products.', [
        { path: 'items.0.quantity', productId: 'p1', requested: 9, available: 3, message: 'only 3 in stock' },
      ]),
    );
    await submit;
    assert.equal(movementSubmission(state()).status, 'rejected');
    assert.deepEqual(state().errors?.lines[state().lines[0]?.key ?? ''], { quantity: 'Only 3 in stock.' });
    assert.equal(state().lines[0]?.product?.quantity, 3);
  });

  test('changing the type is remembered; a full form adds no more lines', () => {
    const { state, typeChanges } = setupMovementForm();
    state().setType('restock');
    assert.deepEqual(typeChanges, ['restock']);
    for (let i = 0; i < 60; i++) state().addLine();
    assert.equal(state().lines.length, 50);
    state().removeLine(state().lines[0]?.key ?? '');
    assert.equal(state().lines.length, 49);
  });

  test('a movement still retrying after the user left keeps going and ends recorded', async () => {
    const { state, create, timers } = setupMovementForm();
    fillLine(state, 0, 'p1', '2');
    const scope = createScreenScope();
    void state().submit();
    scope.dispose();
    create.calls[0]?.reply.reject(offline());
    await timers.wakeAll();
    create.calls[1]?.reply.resolve(movement('id-1'));
    await flush();
    assert.equal(movementSubmission(state()).status, 'succeeded');
  });

  test('reset (another user) stops the retries and clears the form', async () => {
    const { state, create, timers } = setupMovementForm();
    fillLine(state, 0, 'p1', '2');
    const submit = state().submit();
    create.calls[0]?.reply.reject(offline());
    await flush();
    state().reset();
    await timers.wakeAll();
    assert.deepEqual(await submit, { kind: 'cancelled' });
    assert.equal(create.calls.length, 1);
    assert.equal(movementSubmission(state()).status, 'idle');
    assert.equal(state().lines[0]?.product, null);
  });
});

// Preferences --------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  };
}

describe('preferences store', () => {
  test('remembers the movement type under the project key', () => {
    const { data, storage } = memoryStorage();
    const store = createPreferencesStore(storage);
    assert.equal(store.getState().movementType, 'sale');
    store.getState().setMovementType('restock');
    assert.deepEqual(JSON.parse(data.get(PREFERENCES_KEY) ?? ''), { state: { movementType: 'restock' }, version: 1 });
    assert.equal(createPreferencesStore(storage).getState().movementType, 'restock');
  });

  test('ignores stored values that are not valid', () => {
    for (const stored of ['{"state":{"movementType":"adjustment"},"version":1}', '{"state":null,"version":1}', 'not json']) {
      const { storage } = memoryStorage({ [PREFERENCES_KEY]: stored });
      assert.equal(createPreferencesStore(storage).getState().movementType, 'sale', stored);
    }
  });

  test('storage that throws (private windows, full quota) changes nothing visible', () => {
    const broken = safeStorage(() => {
      throw new Error('SecurityError');
    });
    const store = createPreferencesStore(broken);
    store.getState().setMovementType('restock');
    assert.equal(store.getState().movementType, 'restock');
  });
});

// Reset on user change -----------------------------------------------------

describe('resetOnUserChange', () => {
  const user = (id: string): User => ({
    id,
    fullName: id,
    email: `${id}@example.com`,
    role: 'employee',
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  });

  test('resets the stores when the signed-in user changes, not on other auth changes', async () => {
    const login = fakeMethod<[string, string], User>();
    const logout = fakeMethod<[], void>();
    const api: AuthApi = { session: async () => null, login, logout };
    const auth = createAuthStore(api);
    let resets = 0;
    resetOnUserChange(auth, [() => resets++]);

    const signIn = auth.getState().signIn('ana@example.com', 'a long enough password');
    assert.equal(resets, 0, 'a pending sign-in changes no user');
    login.calls[0]?.reply.resolve(user('ana'));
    await signIn;
    assert.equal(resets, 1);
    auth.setState({ logoutError: 'x' });
    assert.equal(resets, 1);
    auth.getState().sessionExpired();
    assert.equal(resets, 2);
    const again = auth.getState().signIn('bob@example.com', 'a long enough password');
    login.calls[1]?.reply.resolve(user('bob'));
    await again;
    assert.equal(resets, 3);
  });
});

// Review fixes (stage 7-8 review) ------------------------------------------

describe('review: editor and idempotency', () => {
  test('a save that lands after another item was opened does not leave that item loading', async () => {
    const { state, api } = await openedThing();
    const submit = state().submit({ name: 'New' });
    const openOther = state().open('t2');
    api.update.calls[0]?.reply.resolve({ id: 't1', name: 'New', version: 2 });
    await submit;
    await flush();
    for (const call of api.get.calls.filter((entry) => entry.args[0] === 't2')) {
      call.reply.resolve({ id: 't2', name: 'Other', version: 1 });
    }
    await openOther;
    await flush();
    assert.equal(state().loadStatus, 'loaded');
    assert.equal(state().item?.id, 't2');
  });

  test('loading the latest version clears the version conflict', async () => {
    const { state, api } = await openedThing();
    const submit = state().submit({ name: 'New' });
    api.update.calls[0]?.reply.reject(rejected(409, 'PRODUCT_VERSION_CONFLICT', 'Someone else changed this product.'));
    await submit;
    const reload = state().reload();
    api.get.calls[1]?.reply.resolve({ id: 't1', name: 'Theirs', version: 5 });
    await reload;
    assert.equal(editorWrite(state(), 'save').status, 'idle');
  });

  test('a create that lands does not drop the id of a newer create', async () => {
    const { createIdempotencyKey } = await import('../../src/stores/shared');
    let counter = 0;
    const key = createIdempotencyKey(() => `id-${++counter}`);
    const first = key.for({ name: 'A' });
    const second = key.for({ name: 'B' });
    key.clear(first);
    assert.equal(key.for({ name: 'B' }), second);
  });
});

describe('review: Retry resends what was sent', () => {
  test('a create that fails after the form reopened keeps its input, and Retry resends it with the same id', async () => {
    const { state, api, timers } = setupEditor();
    await state().open(null);
    void state().submit({ name: 'Milk' });
    api.create.calls[0]?.reply.reject(offline());
    await flush();
    // The user leaves and comes back while it is still retrying: the form shows what was sent.
    await state().open(null);
    assert.equal(editorWrite(state(), 'save').status, 'pending');
    assert.deepEqual(editorDraft(state()), { name: 'Milk' });
    for (let call = 0; call < 3; call++) {
      await timers.wakeAll();
      api.create.calls[call + 1]?.reply.reject(offline());
    }
    await flush();
    assert.equal(editorWrite(state(), 'save').status, 'failed');
    const retry = state().retry('save');
    assert.deepEqual(api.create.calls[4]?.args, ['id-1', { name: 'Milk' }]);
    api.create.calls[4]?.reply.resolve({ id: 'id-1', name: 'Milk', version: 1 });
    assert.equal((await retry).kind, 'succeeded');
  });

  test('Retry on a category row repeats that row\'s write (a delete stays a delete)', async () => {
    const { api, timers, state } = setupCategories();
    const load = state().load();
    api.list.calls[0]?.reply.resolve({ items: [category('1', 'Dairy')], nextCursor: null });
    await load;
    const removal = state().remove('1');
    for (let call = 0; call < 4; call++) {
      api.remove.calls[call]?.reply.reject(offline());
      await timers.wakeAll();
    }
    await removal;
    assert.equal(state().writes['1']?.kind, 'remove');
    assert.equal(state().writes['1']?.state.status, 'failed');
    const retry = state().retry('1');
    assert.equal(api.remove.calls.length, 5);
    assert.equal(api.rename.calls.length, 0);
    api.remove.calls[4]?.reply.resolve();
    await retry;
    assert.deepEqual(state().items, []);
  });

  test('Retry does nothing unless the write failed', async () => {
    const { state } = setupEditor();
    await state().open(null);
    assert.deepEqual(await state().retry('save'), { kind: 'cancelled' });
  });
});
