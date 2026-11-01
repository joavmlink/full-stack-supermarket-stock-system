import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Page } from '../../src/api/types';
import { createScreenScope } from '../../src/lib/screen-scope';
import { createPagedListStore } from '../../src/stores/paged-list-store';
import { createResourceStore } from '../../src/stores/resource-store';
import { fakeMethod, flush, offline, rejected } from './helpers';

interface Item {
  id: string;
  group: string;
}

const item = (id: string, group = 'a'): Item => ({ id, group });
const page = (ids: string[], nextCursor: string | null = null): Page<Item> => ({ items: ids.map((id) => item(id)), nextCursor });
const ids = (items: Item[]) => items.map((entry) => entry.id);

interface Filters {
  group: string;
}

function setupList() {
  const fetchPage = fakeMethod<[Filters, string | undefined], Page<Item>>();
  const store = createPagedListStore<Item, Filters>({
    fetchPage,
    matches: (entry, { group }) => group === '' || entry.group === group,
  });
  return { store, fetchPage, state: () => store.getState() };
}

/** A list with the first page loaded: a, b, c and a next page after c. */
async function loadedList() {
  const ctx = setupList();
  const load = ctx.state().load({ group: '' });
  ctx.fetchPage.calls[0]?.reply.resolve(page(['a', 'b', 'c'], 'c'));
  await load;
  return ctx;
}

const staleCursor = () => rejected(400, 'VALIDATION_ERROR', 'Invalid query.', [{ path: 'before', message: 'is not part of this list' }]);

describe('paged list: loading', () => {
  test('loads the first page', async () => {
    const { state, fetchPage } = await loadedList();
    assert.deepEqual(fetchPage.calls[0]?.args, [{ group: '' }, undefined]);
    assert.equal(state().status, 'loaded');
    assert.deepEqual(ids(state().items), ['a', 'b', 'c']);
    assert.equal(state().nextCursor, 'c');
  });

  test('StrictMode (mount, unmount, mount) sends one request and applies it once', async () => {
    const { state, fetchPage } = setupList();
    const firstMount = createScreenScope();
    const first = state().load({ group: '' });
    firstMount.dispose();
    const second = state().load({ group: '' });
    assert.equal(first, second);
    assert.equal(fetchPage.calls.length, 1);
    fetchPage.calls[0]?.reply.resolve(page(['a']));
    await second;
    assert.deepEqual(ids(state().items), ['a']);
  });

  test('leaving the screen mid-request: the answer fills the cache, the screen continues nothing', async () => {
    const { state, fetchPage } = setupList();
    const scope = createScreenScope();
    let continued = false;
    const load = state().load({ group: '' });
    void load.then(() => {
      if (scope.active) continued = true;
    });
    scope.dispose();
    fetchPage.calls[0]?.reply.resolve(page(['a']));
    await load;
    await flush();
    assert.equal(continued, false);
    assert.equal(state().status, 'loaded');
  });

  test('new filters clear the list; only the latest request applies', async () => {
    const { state, fetchPage } = await loadedList();
    const dairy = state().load({ group: 'dairy' });
    assert.deepEqual(state().items, []);
    const bakery = state().load({ group: 'bakery' });
    fetchPage.calls[2]?.reply.resolve(page(['bread']));
    fetchPage.calls[1]?.reply.resolve(page(['milk']));
    await Promise.all([dairy, bakery]);
    assert.deepEqual(ids(state().items), ['bread']);
    assert.deepEqual(state().filters, { group: 'bakery' });
  });

  test('a refresh with the same filters keeps the items on screen meanwhile', async () => {
    const { state, fetchPage } = await loadedList();
    const refresh = state().load({ group: '' });
    assert.equal(state().status, 'loading');
    assert.deepEqual(ids(state().items), ['a', 'b', 'c']);
    fetchPage.calls[1]?.reply.resolve(page(['z']));
    await refresh;
    assert.deepEqual(ids(state().items), ['z']);
  });

  test('a failed load shows its message and can be retried', async () => {
    const { state, fetchPage } = setupList();
    const load = state().load({ group: '' });
    fetchPage.calls[0]?.reply.reject(offline());
    await load;
    assert.equal(state().status, 'error');
    assert.equal(state().error, 'Could not reach the server.');
    const retry = state().load({ group: '' });
    fetchPage.calls[1]?.reply.resolve(page(['a']));
    await retry;
    assert.equal(state().status, 'loaded');
  });
});

describe('paged list: load more', () => {
  test('appends the next page with the cursor and the same filters', async () => {
    const { state, fetchPage } = await loadedList();
    const more = state().loadMore();
    assert.equal(state().moreStatus, 'loading');
    assert.deepEqual(fetchPage.calls[1]?.args, [{ group: '' }, 'c']);
    fetchPage.calls[1]?.reply.resolve(page(['d', 'e']));
    await more;
    assert.deepEqual(ids(state().items), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(state().nextCursor, null);
    assert.equal(state().moreStatus, 'idle');
  });

  test('double clicks send one request; nothing happens on the last page', async () => {
    const { state, fetchPage } = await loadedList();
    const first = state().loadMore();
    await state().loadMore();
    assert.equal(fetchPage.calls.length, 2);
    fetchPage.calls[1]?.reply.resolve(page(['d']));
    await first;
    await state().loadMore();
    assert.equal(fetchPage.calls.length, 2);
  });

  test('a deleted cursor: retries from the item before it, skips duplicates and drops the deleted one', async () => {
    const { state, fetchPage } = await loadedList();
    const more = state().loadMore();
    fetchPage.calls[1]?.reply.reject(staleCursor());
    await flush();
    assert.deepEqual(fetchPage.calls[2]?.args, [{ group: '' }, 'b']);
    // From b, the API now returns d, e (c is gone).
    fetchPage.calls[2]?.reply.resolve(page(['d', 'e'], 'e'));
    await more;
    assert.deepEqual(ids(state().items), ['a', 'b', 'd', 'e']);
    assert.equal(state().nextCursor, 'e');
  });

  test('when every earlier item is gone too, load more fails with Retry', async () => {
    const { state, fetchPage } = await loadedList();
    const more = state().loadMore();
    for (let call = 1; call <= 3; call++) {
      fetchPage.calls[call]?.reply.reject(staleCursor());
      await flush();
    }
    await more;
    assert.equal(fetchPage.calls.length, 4);
    assert.equal(state().moreStatus, 'error');
    assert.deepEqual(ids(state().items), ['a', 'b', 'c']);
  });

  test('other errors fail load more and keep the list', async () => {
    const { state, fetchPage } = await loadedList();
    const more = state().loadMore();
    fetchPage.calls[1]?.reply.reject(offline());
    await more;
    assert.equal(state().moreStatus, 'error');
    assert.equal(state().moreError, 'Could not reach the server.');
    assert.equal(state().nextCursor, 'c');
  });

  test('a page that arrives after the list was reloaded is ignored', async () => {
    const { state, fetchPage } = await loadedList();
    const more = state().loadMore();
    const reload = state().load({ group: '' });
    fetchPage.calls[1]?.reply.resolve(page(['old']));
    fetchPage.calls[2]?.reply.resolve(page(['fresh']));
    await Promise.all([more, reload]);
    assert.deepEqual(ids(state().items), ['fresh']);
  });
});

describe('paged list: changes from writes', () => {
  test('added: first in a list it belongs to, ignored otherwise', async () => {
    const { state } = await loadedList();
    state().added(item('new'));
    assert.deepEqual(ids(state().items), ['new', 'a', 'b', 'c']);
    const { state: other, store, fetchPage } = setupList();
    const load = other().load({ group: 'bakery' });
    fetchPage.calls[0]?.reply.resolve(page([]));
    await load;
    store.getState().added(item('milk', 'dairy'));
    assert.deepEqual(other().items, []);
  });

  test('updated: replaced in place, or dropped when it leaves the filter', async () => {
    const { state, fetchPage } = setupList();
    const load = state().load({ group: 'a' });
    fetchPage.calls[0]?.reply.resolve(page(['x', 'y']));
    await load;
    state().updated({ id: 'x', group: 'a' });
    assert.deepEqual(ids(state().items), ['x', 'y']);
    state().updated({ id: 'y', group: 'b' });
    assert.deepEqual(ids(state().items), ['x']);
    state().updated(item('unknown'));
    assert.deepEqual(ids(state().items), ['x']);
  });

  test('removed and reset', async () => {
    const { state, fetchPage } = await loadedList();
    state().removed('b');
    assert.deepEqual(ids(state().items), ['a', 'c']);
    const refresh = state().load({ group: '' });
    state().reset();
    fetchPage.calls[1]?.reply.resolve(page(['late']));
    await refresh;
    assert.deepEqual(state().items, []);
    assert.equal(state().status, 'idle');
  });
});

describe('resource store', () => {
  function setup() {
    const fetch = fakeMethod<[string], { id: string; name: string }>();
    const store = createResourceStore(fetch);
    return { fetch, state: () => store.getState() };
  }

  test('StrictMode loads once; another id replaces the data', async () => {
    const { fetch, state } = setup();
    const first = state().load('m1');
    const second = state().load('m1');
    assert.equal(fetch.calls.length, 1);
    fetch.calls[0]?.reply.resolve({ id: 'm1', name: 'one' });
    await Promise.all([first, second]);
    assert.equal(state().data?.name, 'one');
    const other = state().load('m2');
    assert.equal(state().data, null);
    fetch.calls[1]?.reply.resolve({ id: 'm2', name: 'two' });
    await other;
    assert.equal(state().data?.name, 'two');
  });

  test('a 404 or an invalid id is "not found"; other errors keep a message', async () => {
    const { fetch, state } = setup();
    const missing = state().load('m1');
    fetch.calls[0]?.reply.reject(rejected(404, 'STOCK_MOVEMENT_NOT_FOUND'));
    await missing;
    assert.equal(state().status, 'notFound');
    const invalid = state().load('not-a-uuid');
    fetch.calls[1]?.reply.reject(rejected(400, 'VALIDATION_ERROR', 'Invalid path parameters.', [{ path: 'id', message: 'Invalid UUID' }]));
    await invalid;
    assert.equal(state().status, 'notFound');
    const failing = state().load('m3');
    fetch.calls[2]?.reply.reject(offline());
    await failing;
    assert.equal(state().status, 'error');
    assert.equal(state().error, 'Could not reach the server.');
  });

  test('a stale answer is ignored after a reset', async () => {
    const { fetch, state } = setup();
    const load = state().load('m1');
    state().reset();
    fetch.calls[0]?.reply.resolve({ id: 'm1', name: 'old user' });
    await load;
    assert.equal(state().data, null);
    assert.equal(state().status, 'idle');
  });
});

describe('review: writes during a read', () => {
  test('a refresh that read the list before a delete landed cannot bring the row back', async () => {
    const { state, fetchPage } = await loadedList();
    const refresh = state().load({ group: '' });
    state().removed('b');
    fetchPage.calls[1]?.reply.resolve(page(['a', 'b', 'c']));
    await flush();
    fetchPage.calls[2]?.reply.resolve(page(['a', 'c']));
    await refresh;
    await flush();
    assert.deepEqual(ids(state().items), ['a', 'c']);
    assert.equal(state().status, 'loaded');
  });
});
