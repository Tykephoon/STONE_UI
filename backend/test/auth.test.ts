import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import {
  type TestApp,
  TEST_PASSWORD,
  authHeaders,
  cookieHeader,
  cookieValue,
  makeApp,
  registerUser,
} from './helpers.js';

const apps: TestApp[] = [];
async function app() {
  const instance = await makeApp();
  apps.push(instance);
  return instance.app;
}

after(async () => {
  await Promise.all(apps.map((instance) => instance.close()));
});

describe('registration', () => {
  it('creates an account and issues a session', async () => {
    const server = await app();

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'New.User@example.com', password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.user.email, 'New.User@example.com', 'preserves the typed casing');
    assert.ok(body.csrf_token);
    assert.ok(!('password_hash' in body.user));
  });

  it('sets an httpOnly, Secure, SameSite=None session cookie', async () => {
    const server = await app();

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'cookie@example.com', password: TEST_PASSWORD },
    });

    const session = cookieValue(response, 'stone_session') as Record<string, unknown>;
    assert.ok(session, 'session cookie present');
    assert.equal(session.httpOnly, true, 'script must not be able to read the session');
    assert.equal(session.secure, true);
    assert.equal(String(session.sameSite).toLowerCase(), 'none');

    // The CSRF cookie must be readable — the client has to echo it in a header.
    const csrf = cookieValue(response, 'stone_csrf') as Record<string, unknown>;
    assert.ok(csrf);
    assert.notEqual(csrf.httpOnly, true);
  });

  it('rejects a short password before touching the database', async () => {
    const server = await app();

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'short@example.com', password: 'tooshort' },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'validation_failed');
  });

  it('refuses a duplicate email', async () => {
    const server = await app();
    await registerUser(server, 'dupe@example.com');

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'DUPE@example.com', password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 409, 'email comparison is case-insensitive');
  });
});

describe('login', () => {
  it('accepts correct credentials', async () => {
    const server = await app();
    await registerUser(server, 'login@example.com');

    const response = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'login@example.com', password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.json().csrf_token);
  });

  it('gives an identical response for a wrong password and an unknown account', async () => {
    const server = await app();
    await registerUser(server, 'real@example.com');

    const wrongPassword = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'real@example.com', password: 'not-the-right-password' },
    });

    const unknownAccount = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nobody@example.com', password: 'not-the-right-password' },
    });

    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownAccount.statusCode, 401);
    // Identical body is the whole point: anything that differs enumerates accounts.
    assert.deepEqual(wrongPassword.json(), unknownAccount.json());
  });

  it('locks an account after repeated failures', async () => {
    const server = await app();
    await registerUser(server, 'throttle@example.com');

    let lastStatus = 0;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'throttle@example.com', password: `wrong-${attempt}` },
      });
      lastStatus = response.statusCode;
    }

    assert.equal(lastStatus, 429);

    // The lock holds even once the correct password is supplied.
    const correct = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'throttle@example.com', password: TEST_PASSWORD },
    });
    assert.equal(correct.statusCode, 429);
  });
});

describe('session lifecycle', () => {
  it('rejects /me without a session', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/api/auth/me' });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'unauthenticated');
  });

  it('returns the signed-in user for /me', async () => {
    const server = await app();
    const session = await registerUser(server, 'me@example.com');

    const response = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookie },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().user.id, session.userId);
  });

  it('invalidates the session server-side on logout', async () => {
    const server = await app();
    const session = await registerUser(server, 'logout@example.com');

    const logout = await server.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: authHeaders(session),
    });
    assert.equal(logout.statusCode, 204);

    // Replaying the same cookie must fail: the row is gone, so clearing the
    // cookie was not what ended the session.
    const replay = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookie },
    });
    assert.equal(replay.statusCode, 401);
  });

  it('rotates the token on refresh and retires the old one', async () => {
    const server = await app();
    const session = await registerUser(server, 'refresh@example.com');

    const refresh = await server.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: authHeaders(session),
    });
    assert.equal(refresh.statusCode, 200);

    const rotatedCookie = cookieHeader(refresh);
    assert.notEqual(rotatedCookie, session.cookie, 'a new token was issued');

    const withNew = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: rotatedCookie },
    });
    assert.equal(withNew.statusCode, 200);

    const withOld = await server.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookie },
    });
    assert.equal(withOld.statusCode, 401, 'the superseded token is dead');
  });

  it('signs out every session at once', async () => {
    const server = await app();
    const first = await registerUser(server, 'multi@example.com');

    const secondLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'multi@example.com', password: TEST_PASSWORD },
    });
    const secondCookie = cookieHeader(secondLogin);

    await server.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: authHeaders(first),
    });

    for (const cookie of [first.cookie, secondCookie]) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { cookie },
      });
      assert.equal(response.statusCode, 401);
    }
  });
});

describe('CSRF', () => {
  it('rejects a state-changing request with no CSRF header', async () => {
    const server = await app();
    const session = await registerUser(server, 'csrf1@example.com');

    const response = await server.inject({
      method: 'POST',
      url: '/api/devices',
      headers: { cookie: session.cookie, origin: 'http://localhost:5173' },
      payload: { name: 'Sneaky' },
    });

    assert.equal(response.statusCode, 403);
  });

  it('rejects a mismatched CSRF token', async () => {
    const server = await app();
    const session = await registerUser(server, 'csrf2@example.com');

    const response = await server.inject({
      method: 'POST',
      url: '/api/devices',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': 'not-the-right-token',
        origin: 'http://localhost:5173',
      },
      payload: { name: 'Sneaky' },
    });

    assert.equal(response.statusCode, 403);
  });

  it('rejects a request from an origin outside the allowlist', async () => {
    const server = await app();
    const session = await registerUser(server, 'csrf3@example.com');

    const response = await server.inject({
      method: 'POST',
      url: '/api/devices',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
        origin: 'https://attacker.example',
      },
      payload: { name: 'Sneaky' },
    });

    assert.equal(response.statusCode, 403);
  });

  it('accepts a correctly formed request', async () => {
    const server = await app();
    const session = await registerUser(server, 'csrf4@example.com');

    const response = await server.inject({
      method: 'POST',
      url: '/api/devices',
      headers: authHeaders(session),
      payload: { name: 'Legitimate Pico' },
    });

    assert.equal(response.statusCode, 201);
  });

  it('does not require a CSRF token for a read', async () => {
    const server = await app();
    const session = await registerUser(server, 'csrf5@example.com');

    const response = await server.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: session.cookie },
    });

    assert.equal(response.statusCode, 200);
  });
});

describe('error handling', () => {
  it('does not leak internals on an unknown route', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/api/does-not-exist' });

    assert.equal(response.statusCode, 404);
    const body = response.body;
    assert.ok(!body.includes('at '), 'no stack frames');
    assert.ok(!/[A-Za-z]:\\|\/home\/|\/src\//.test(body), 'no filesystem paths');
  });

  it('sets hardening headers on responses', async () => {
    const server = await app();
    const response = await server.inject({ method: 'GET', url: '/health' });

    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
  });
});
