import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AuthApi } from '../../src/api/auth-api';
import { ApiError } from '../../src/api/errors';
import type { User } from '../../src/api/types';
import { SESSION_EXPIRED_NOTICE, createAuthStore } from '../../src/stores/auth-store';
import { deferred, offline, type Deferred } from './helpers';

const ana: User = {
  id: '6f1c2b8e-0b4c-4a3e-9a51-3f0f5c1d2e10',
  fullName: 'Ana Example',
  email: 'ana@example.com',
  role: 'employee',
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

/** A fake API whose every call waits until the test settles it. */
function fakeApi() {
  const calls = { session: [] as Deferred<User | null>[], login: [] as Deferred<User>[], logout: [] as Deferred<void>[] };
  const api: AuthApi = {
    session: () => {
      const call = deferred<User | null>();
      calls.session.push(call);
      return call.promise;
    },
    login: () => {
      const call = deferred<User>();
      calls.login.push(call);
      return call.promise;
    },
    logout: () => {
      const call = deferred<void>();
      calls.logout.push(call);
      return call.promise;
    },
  };
  return { api, calls };
}

function setup() {
  const { api, calls } = fakeApi();
  const store = createAuthStore(api);
  return { store, calls, state: () => store.getState() };
}

async function signedIn() {
  const ctx = setup();
  const check = ctx.state().checkSession();
  ctx.calls.session[0]?.resolve(ana);
  await check;
  assert.equal(ctx.state().status, 'authenticated');
  return ctx;
}

describe('checkSession', () => {
  test('starts unknown, then a valid session signs the user in', async () => {
    const { state, calls } = setup();
    assert.equal(state().status, 'unknown');
    const check = state().checkSession();
    assert.equal(state().status, 'checking');
    calls.session[0]?.resolve(ana);
    await check;
    assert.equal(state().status, 'authenticated');
    assert.deepEqual(state().user, ana);
  });

  test('no session (user null) means anonymous, with no notice', async () => {
    const { state, calls } = setup();
    const check = state().checkSession();
    calls.session[0]?.resolve(null);
    await check;
    assert.equal(state().status, 'anonymous');
    assert.equal(state().notice, null);
  });

  test('any other failure is an error that can be retried', async () => {
    const { state, calls } = setup();
    const check = state().checkSession();
    calls.session[0]?.reject(offline());
    await check;
    assert.equal(state().status, 'error');
    assert.equal(state().checkError, 'Could not reach the server.');

    const retry = state().checkSession();
    assert.equal(state().checkError, null);
    calls.session[1]?.resolve(ana);
    await retry;
    assert.equal(state().status, 'authenticated');
  });

  test('concurrent calls (StrictMode runs effects twice) share one request', async () => {
    const { state, calls } = setup();
    const first = state().checkSession();
    const second = state().checkSession();
    assert.equal(first, second);
    assert.equal(calls.session.length, 1);
    calls.session[0]?.resolve(ana);
    await Promise.all([first, second]);
    assert.equal(state().status, 'authenticated');
  });

  test('a check that resolves after a sign-in started is ignored', async () => {
    const { state, calls } = setup();
    const check = state().checkSession();
    const login = state().signIn('ana@example.com', 'a long enough password');
    calls.session[0]?.resolve(null);
    await check;
    assert.equal(state().loginPending, true);
    assert.notEqual(state().status, 'anonymous');
    calls.login[0]?.resolve(ana);
    await login;
    assert.equal(state().status, 'authenticated');
  });
});

describe('signIn', () => {
  test('signs in and clears any previous error or notice', async () => {
    const { state, calls, store } = setup();
    store.setState({ status: 'anonymous', loginError: 'old', notice: SESSION_EXPIRED_NOTICE });
    const login = state().signIn('ana@example.com', 'a long enough password');
    assert.equal(state().loginPending, true);
    assert.equal(state().loginError, null);
    assert.equal(state().notice, null);
    calls.login[0]?.resolve(ana);
    await login;
    assert.equal(state().status, 'authenticated');
    assert.deepEqual(state().user, ana);
    assert.equal(state().loginPending, false);
  });

  test('wrong credentials show the API message and stay anonymous', async () => {
    const { state, calls, store } = setup();
    store.setState({ status: 'anonymous' });
    const login = state().signIn('ana@example.com', 'wrong password!!');
    calls.login[0]?.reject(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.'));
    await login;
    assert.equal(state().status, 'anonymous');
    assert.equal(state().loginError, 'Invalid email or password.');
    assert.equal(state().loginPending, false);
  });

  test('a second submit while one is pending sends nothing', async () => {
    const { state, calls } = setup();
    const first = state().signIn('ana@example.com', 'a long enough password');
    await state().signIn('ana@example.com', 'a long enough password');
    assert.equal(calls.login.length, 1);
    calls.login[0]?.resolve(ana);
    await first;
  });
});

describe('signOut', () => {
  test('clears the user after the API confirms', async () => {
    const { state, calls } = await signedIn();
    const logout = state().signOut();
    assert.equal(state().logoutPending, true);
    assert.equal(state().status, 'authenticated');
    calls.logout[0]?.resolve();
    await logout;
    assert.equal(state().status, 'anonymous');
    assert.equal(state().user, null);
    assert.equal(state().logoutPending, false);
    assert.equal(state().notice, null);
    assert.equal(state().signedOutByUser, true);
  });

  test('signing in again clears signedOutByUser; a lost session never sets it', async () => {
    const { state, calls } = await signedIn();
    const logout = state().signOut();
    calls.logout[0]?.resolve();
    await logout;
    const login = state().signIn('ana@example.com', 'a long enough password');
    calls.login[0]?.resolve(ana);
    await login;
    assert.equal(state().signedOutByUser, false);
    state().sessionExpired();
    assert.equal(state().signedOutByUser, false);
  });

  test('a failed sign-out keeps the session and shows why', async () => {
    const { state, calls } = await signedIn();
    const logout = state().signOut();
    calls.logout[0]?.reject(offline());
    await logout;
    assert.equal(state().status, 'authenticated');
    assert.equal(state().logoutPending, false);
    assert.equal(state().logoutError, 'Could not reach the server.');
  });

  test('a second click while one is pending sends nothing', async () => {
    const { state, calls } = await signedIn();
    const first = state().signOut();
    await state().signOut();
    assert.equal(calls.logout.length, 1);
    calls.logout[0]?.resolve();
    await first;
  });
});

describe('sessionExpired', () => {
  test('signs a signed-in user out with a notice', async () => {
    const { state } = await signedIn();
    state().sessionExpired();
    assert.equal(state().status, 'anonymous');
    assert.equal(state().user, null);
    assert.equal(state().notice, SESSION_EXPIRED_NOTICE);
  });

  test('no notice when nobody was signed in', () => {
    const { state } = setup();
    state().sessionExpired();
    assert.equal(state().status, 'anonymous');
    assert.equal(state().notice, null);
  });

  test('a sign-in that resolves after the session ended elsewhere is ignored', async () => {
    const { state, calls } = setup();
    const login = state().signIn('ana@example.com', 'a long enough password');
    state().sessionExpired();
    calls.login[0]?.resolve(ana);
    await login;
    assert.equal(state().status, 'anonymous');
    assert.equal(state().loginPending, false);
  });

  test('a sign-out that fails after the session already ended changes nothing', async () => {
    const { state, calls } = await signedIn();
    const logout = state().signOut();
    state().sessionExpired();
    calls.logout[0]?.reject(offline());
    await logout;
    assert.equal(state().status, 'anonymous');
    assert.equal(state().logoutError, null);
    assert.equal(state().notice, SESSION_EXPIRED_NOTICE);
  });

  test('a check started after the session ended sends a new request', async () => {
    const { state, calls } = setup();
    const stale = state().checkSession();
    state().sessionExpired();
    const fresh = state().checkSession();
    assert.notEqual(stale, fresh);
    assert.equal(calls.session.length, 2);
    calls.session[0]?.resolve(ana);
    await stale;
    assert.equal(state().status, 'checking');
    calls.session[1]?.resolve(null);
    await fresh;
    assert.equal(state().status, 'anonymous');
  });
});
