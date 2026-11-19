import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, sessionForRequest } from '../functions/_lib/auth.js';
import { onRequestPost as register } from '../functions/api/auth/register.js';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { onRequestGet as getSession } from '../functions/api/auth/session.js';
import { onRequestPost as logout } from '../functions/api/auth/logout.js';
import { onRequest as pageMiddleware } from '../functions/_middleware.js';
import { onRequestGet as controlRequestStatus } from '../functions/api/control/request.js';
import { onRequestPost as requestControl } from '../functions/api/control/request.js';
import { onRequestPost as claimControl } from '../functions/api/control/claim.js';
import { onRequestPost as commandControl } from '../functions/api/control/command.js';
import { onRequestGet as presenterRequests } from '../functions/api/presenter/requests.js';
import { onRequestPost as presenterDecision } from '../functions/api/presenter/decision.js';
import { onRequestPost as presenterReset } from '../functions/api/presenter/reset.js';
import { onRequestGet as bridgeSocket } from '../functions/api/bridge/socket.js';
import { onRequestGet as liveSocket } from '../functions/api/live/socket.js';
import { FanControlCoordinator } from '../coordinator/worker.js';

globalThis.crypto ||= webcrypto;

class MemoryDB {
  users = new Map();
  sessions = new Map();
  prepare(sql) { return new MemoryStatement(this, sql); }
}

class MemoryStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.values = []; }
  bind(...values) { this.values = values; return this; }
  async run() {
    const s = this.sql;
    if (s.startsWith('INSERT INTO users')) {
      const [id, fullName, email, passwordHash] = this.values;
      if ([...this.db.users.values()].some((user) => user.email.toLowerCase() === email.toLowerCase())) throw new Error('UNIQUE constraint failed: users.email');
      this.db.users.set(id, { id, full_name: fullName, email, password_hash: passwordHash, status: 'active' });
      return { success: true };
    }
    if (s.startsWith('INSERT INTO sessions')) {
      const [tokenHash, userId, expiresAt] = this.values;
      this.db.sessions.set(tokenHash, { user_id: userId, expires_at: expiresAt });
      return { success: true };
    }
    if (s.startsWith('DELETE FROM sessions')) { this.db.sessions.delete(this.values[0]); return { success: true }; }
    throw new Error(`Unsupported test SQL: ${s}`);
  }
  async first() {
    if (this.sql.includes('FROM users WHERE email')) {
      const email = this.values[0].toLowerCase();
      return [...this.db.users.values()].find((user) => user.email.toLowerCase() === email) || null;
    }
    if (this.sql.includes('FROM sessions s JOIN users u')) {
      const [tokenHash, now] = this.values;
      const session = this.db.sessions.get(tokenHash);
      const user = session && this.db.users.get(session.user_id);
      if (!session || !user || session.expires_at <= now) return null;
      return { id: user.id, full_name: user.full_name, email: user.email, status: user.status, expires_at: session.expires_at };
    }
    throw new Error(`Unsupported test SQL: ${this.sql}`);
  }
}

const TEST_PRESENTER_ID = 'presenter';
const TEST_INTERNAL_TOKEN = 'test-internal-secret';

function envWith(db, extras = {}) { return { DB: db, ...extras }; }

function createCoordinator(ctx = coordinatorCtx(), presenterId = TEST_PRESENTER_ID) {
  return new FanControlCoordinator(ctx, {
    PRESENTER_USER_ID: presenterId,
    COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
  });
}
function request(url, { method = 'GET', body, cookie, origin = 'https://project.test' } = {}) {
  const headers = new Headers({ Origin: origin });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  return new Request(`https://project.test${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function jsonResponse(response) { return response.json(); }
async function createAccount(db, email = 'user@example.com') {
  const response = await register({ request: request('/api/auth/register', { method: 'POST', body: { fullName: 'Test User', email, password: 'Long-test-password-947!', confirmPassword: 'Long-test-password-947!' } }), env: envWith(db) });
  const data = await jsonResponse(response);
  return { response, data, cookie: response.headers.get('set-cookie') };
}
function cookieToken(setCookie) { return setCookie.split(';', 1)[0]; }

test('password hash is salted and verifies only the matching password', async () => {
  const a = await hashPassword('Long-test-password-947!');
  const b = await hashPassword('Long-test-password-947!');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('Long-test-password-947!', a), true);
  assert.equal(await verifyPassword('not-the-password', a), false);
  assert.equal(a.startsWith('pbkdf2-sha256$100000$'), true);
});

test('successful registration creates an ordinary account and secure cookie', async () => {
  const db = new MemoryDB();
  const { response, data, cookie } = await createAccount(db);
  assert.equal(response.status, 201);
  assert.equal(data.user.fullName, 'Test User');
  assert.equal(data.user.email, 'user@example.com');
  assert.equal(cookie.includes('Secure'), true);
  assert.equal(cookie.includes('HttpOnly'), true);
  assert.equal(cookie.includes('SameSite=Lax'), true);
  assert.equal([...db.users.values()][0].password_hash.includes('Long-test-password-947!'), false);
});

test('password and confirmation mismatch is rejected without creating a user', async () => {
  const db = new MemoryDB();
  const response = await register({ request: request('/api/auth/register', { method: 'POST', body: { fullName: 'Test User', email: 'x@example.com', password: 'Long-test-password-947!', confirmPassword: 'Different-password-123!' } }), env: envWith(db) });
  assert.equal(response.status, 400);
  assert.equal(db.users.size, 0);
});

test('duplicate email is rejected with the friendly login message', async () => {
  const db = new MemoryDB();
  await createAccount(db);
  const response = await register({ request: request('/api/auth/register', { method: 'POST', body: { fullName: 'Another User', email: 'user@example.com', password: 'Long-test-password-947!', confirmPassword: 'Long-test-password-947!' } }), env: envWith(db) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'This email is already registered. Please log in.');
});

test('email uniqueness is case-insensitive after normalization', async () => {
  const db = new MemoryDB();
  const first = await createAccount(db, 'USER@example.com');
  assert.equal(first.data.user.email, 'user@example.com');
  const second = await register({ request: request('/api/auth/register', { method: 'POST', body: { fullName: 'Another User', email: 'User@Example.com', password: 'Long-test-password-947!', confirmPassword: 'Long-test-password-947!' } }), env: envWith(db) });
  assert.equal(second.status, 409);
});

test('login accepts normalized email and verifies the password', async () => {
  const db = new MemoryDB();
  await createAccount(db);
  const response = await login({ request: request('/api/auth/login', { method: 'POST', body: { email: 'USER@example.com', password: 'Long-test-password-947!' } }), env: envWith(db) });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('set-cookie'));
});

test('invalid password login is rejected with a generic message', async () => {
  const db = new MemoryDB();
  await createAccount(db);
  const response = await login({ request: request('/api/auth/login', { method: 'POST', body: { email: 'user@example.com', password: 'wrong-password' } }), env: envWith(db) });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Email or password is incorrect.');
});

test('a valid persistent cookie restores the account in another visit', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const response = await getSession({ request: request('/api/auth/session', { cookie: cookieToken(cookie) }), env: envWith(db) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.authenticated, true);
  assert.equal(data.user.fullName, 'Test User');
});

test('a valid browser session opens the project page without another login', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const response = await pageMiddleware({
    request: request('/index.html', { cookie: cookieToken(cookie) }),
    env: envWith(db),
    next: async () => new Response('project home'),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'project home');
});

test('a new browser without the account cookie must authenticate', async () => {
  const db = new MemoryDB();
  await createAccount(db);
  const response = await getSession({ request: request('/api/auth/session'), env: envWith(db) });
  assert.equal(response.status, 401);
});

test('logout invalidates the session token', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const authCookie = cookieToken(cookie);
  let wasInvalidatedBeforeCleanup = false;
  const env = envWith(db, {
    COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    FAN_COORDINATOR: {
      idFromName: () => 'one',
      get: () => ({
        fetch: async () => {
          wasInvalidatedBeforeCleanup = (await getSession({ request: request('/api/auth/session', { cookie: authCookie }), env: envWith(db) })).status === 401;
          return Response.json({ ok: true });
        },
      }),
    },
  });
  const response = await logout({ request: request('/api/auth/logout', { method: 'POST', cookie: authCookie }), env });
  assert.equal(response.status, 200);
  assert.equal(wasInvalidatedBeforeCleanup, true);
  assert.match(response.headers.get('set-cookie'), /Path=\//);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  const after = await getSession({ request: request('/api/auth/session', { cookie: authCookie }), env });
  assert.equal(after.status, 401);
  assert.equal(db.users.size, 1);
  const protectedPage = await pageMiddleware({
    request: request('/index.html', { cookie: authCookie }),
    env,
    next: async () => new Response('project home'),
  });
  assert.equal(protectedPage.status, 302);
});

test('logout invalidates the session and reports failed coordinator cleanup', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const env = envWith(db, { FAN_COORDINATOR: { idFromName: () => 'one', get: () => ({ fetch: async () => { throw new Error('Coordinator unavailable'); } }) } });
  const response = await logout({ request: request('/api/auth/logout', { method: 'POST', cookie: cookieToken(cookie) }), env });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /You are signed out/);
  const after = await getSession({ request: request('/api/auth/session', { cookie: cookieToken(cookie) }), env });
  assert.equal(after.status, 401);
});

test('logout reports an unavailable account database without claiming success', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const response = await logout({
    request: request('/api/auth/logout', { method: 'POST', cookie: cookieToken(cookie) }),
    env: {},
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.has('set-cookie'), false);
  assert.match((await response.json()).error, /session service is unavailable/);
});

test('expired and invalid session tokens are not accepted', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const session = [...db.sessions.values()][0];
  session.expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await sessionForRequest(request('/index.html', { cookie: cookieToken(cookie) }), envWith(db));
  const invalid = await sessionForRequest(request('/index.html', { cookie: '__Host-group2_session=bogus' }), envWith(db));
  assert.equal(expired, null);
  assert.equal(invalid, null);
});

test('unauthenticated page navigation redirects to account form with safe return path', async () => {
  const db = new MemoryDB();
  const response = await pageMiddleware({ request: request('/TNP.html?section=intro'), env: envWith(db), next: async () => new Response('page') });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://project.test/account.html?next=%2FTNP.html%3Fsection%3Dintro');
});

test('Electronic page redirects to login when signed out and opens with a valid session', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const signInRequired = await pageMiddleware({
    request: request('/electronic.html'),
    env: envWith(db),
    next: async () => new Response('electronic page'),
  });
  assert.equal(signInRequired.status, 302);
  assert.equal(signInRequired.headers.get('location'), 'https://project.test/account.html?next=%2Felectronic.html');
  const allowed = await pageMiddleware({
    request: request('/electronic.html', { cookie: cookieToken(cookie) }),
    env: envWith(db),
    next: async () => new Response('electronic page'),
  });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'electronic page');
});

test('Electronic page loads its same-origin scripts and does not depend on the old ESP32 hotspot', () => {
  const pagePath = fileURLToPath(new URL('../electronic.html', import.meta.url));
  const source = readFileSync(pagePath, 'utf8');
  const script = readFileSync(new URL('../electronic.js', import.meta.url), 'utf8');
  const scripts = [...source.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.includes('electronic.js'));
  assert.ok(scripts.includes('account-ui.js'));
  for (const script of scripts) assert.equal(existsSync(new URL(`../${script}`, import.meta.url)), true, `${script} should exist`);
  assert.doesNotMatch(source + script, /192\.168\.4\.1/);
  assert.doesNotMatch(script, /Claim approved control/);
  assert.match(script, /activateLease\(requestStatus\.leaseToken\)/);
  assert.match(script, /You are in control\./);
});

test('authenticated control request includes server-verified identity', async () => {
  const db = new MemoryDB();
  const { cookie, data } = await createAccount(db);
  const calls = [];
  const env = envWith(db, { COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN, FAN_COORDINATOR: { idFromName: (name) => name, get: () => ({ fetch: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return Response.json({ id: 'req-1', status: 'pending' }, { status: 201 }); } }) } });
  const response = await requestControl({ request: request('/api/control/request', { method: 'POST', cookie: cookieToken(cookie), body: {} }), env });
  assert.equal(response.status, 201);
  assert.equal(calls[0].body.userId, data.user.id);
  assert.equal(calls[0].body.email, 'user@example.com');
});

test('presenter request list is hidden from ordinary users', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const response = await presenterRequests({ request: request('/api/presenter/requests', { cookie: cookieToken(cookie) }), env: envWith(db, { PRESENTER_USER_ID: 'different-id' }) });
  assert.equal(response.status, 403);
});

test('presenter receives the authenticated registrant identity and request status', async () => {
  const db = new MemoryDB();
  const { cookie, data: user } = await createAccount(db);
  const presenter = await createAccount(db, 'presenter@example.com');
  const coordinator = createCoordinator(coordinatorCtx(), presenter.data.user.id);
  const env = envWith(db, {
    PRESENTER_USER_ID: presenter.data.user.id,
    COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    FAN_COORDINATOR: {
      idFromName: () => 'one',
      get: () => ({ fetch: (url, options) => coordinator.fetch(new Request(url, options)) }),
    },
  });
  const submitted = await requestControl({ request: request('/api/control/request', { method: 'POST', cookie: cookieToken(cookie), body: {} }), env });
  assert.equal(submitted.status, 201);
  const response = await presenterRequests({ request: request('/api/presenter/requests', { cookie: cookieToken(presenter.cookie) }), env });
  const item = (await response.json()).requests[0];
  assert.equal(response.status, 200);
  assert.equal(item.userId, user.user.id);
  assert.equal(item.fullName, user.user.fullName);
  assert.equal(item.email, user.user.email);
  assert.equal(item.status, 'pending');
  assert.equal(Number.isFinite(item.at), true);
});

test('unapproved users cannot claim or issue fan commands', async () => {
  const db = new MemoryDB();
  const { cookie } = await createAccount(db);
  const stub = { fetch: async () => Response.json({ error: 'Presenter approval is required.' }, { status: 403 }) };
  const env = envWith(db, { COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN, FAN_COORDINATOR: { idFromName: () => 'one', get: () => stub } });
  const claim = await claimControl({ request: request('/api/control/claim', { method: 'POST', cookie: cookieToken(cookie), body: {} }), env });
  const command = await commandControl({ request: request('/api/control/command', { method: 'POST', cookie: cookieToken(cookie), body: { speed: 100, leaseToken: '' } }), env });
  assert.equal(claim.status, 403);
  assert.equal(command.status, 403);
});

test('presenter can reject a request, and presenter priority preempts a temporary lease', async () => {
  const db = new MemoryDB();
  const { data: user } = await createAccount(db);
  const coordinator = createCoordinator();
  const created = await coordinatorPost(coordinator, '/internal/request', { userId: user.user.id, fullName: user.user.fullName, email: user.user.email });
  const item = await created.json();
  const rejected = await coordinatorPost(coordinator, '/internal/presenter/decision', { presenterId: 'presenter', action: 'reject', requestId: item.id });
  assert.equal(rejected.status, 200);
  const rejectedStatus = await coordinatorPost(coordinator, '/internal/request-status', { userId: user.user.id });
  assert.equal((await rejectedStatus.json()).status, 'rejected');

  await coordinatorPost(coordinator, '/internal/presenter/decision', { presenterId: 'presenter', action: 'approve', requestId: item.id });
  const userClaim = await coordinatorPost(coordinator, '/internal/claim', { userId: user.user.id, isPresenter: false });
  const userLease = await userClaim.json();
  assert.equal(userClaim.status, 200);
  const presenterClaim = await coordinatorPost(coordinator, '/internal/claim', { userId: 'presenter', fullName: 'Presenter', isPresenter: true });
  assert.equal(presenterClaim.status, 200);
  const staleCommand = await coordinatorPost(coordinator, '/internal/command', {
    userId: user.user.id, isPresenter: false, leaseToken: userLease.leaseToken, command: { speed: 50 },
  });
  assert.equal(staleCommand.status, 403);
});

class MemoryStorage {
  values = new Map();
  calls = [];
  async get(key) { this.calls.push({ operation: 'get', key }); return this.values.get(key); }
  async put(key, value) {
    this.calls.push({ operation: 'put', key });
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.calls.push({ operation: 'delete', key });
    return this.values.delete(key);
  }
  async setAlarm() { this.calls.push({ operation: 'setAlarm' }); }
}

function coordinatorCtx() {
  const storage = new MemoryStorage();
  return { storage, blockConcurrencyWhile: (callback) => callback() };
}

function attachMockSocket(coordinator, socket, metadata) {
  coordinator.webSockets.add(socket);
  coordinator.socketMetadata.set(socket, metadata);
  if (metadata.role === 'bridge') {
    coordinator.bridge = socket;
    coordinator.bridgeConnected = true;
  }
}

test('coordinator WebSocket connections are held only in instance memory', async () => {
  const ctx = coordinatorCtx();
  const coordinator = createCoordinator(ctx);
  await coordinator.ready;
  const listeners = new Map();
  let acceptCount = 0;
  const socket = {
    accept() { acceptCount += 1; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    send() {},
  };
  coordinator.attachWebSocket(socket, { role: 'audience' });
  assert.equal(acceptCount, 1);
  assert.equal(coordinator.webSockets.has(socket), true);
  assert.equal(listeners.has('message'), true);
  assert.equal(listeners.has('close'), true);

  const restartedCoordinator = createCoordinator(ctx);
  await restartedCoordinator.ready;
  assert.equal(restartedCoordinator.webSockets.size, 0);
  assert.equal(ctx.storage.values.size, 0);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);
});

async function coordinatorPost(coordinator, path, body, headers = {}) {
  return coordinator.fetch(new Request(`https://do.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-coordinator-token': TEST_INTERNAL_TOKEN, ...headers }, body: JSON.stringify(body) }));
}

test('presenter approval atomically grants a temporary lease and duplicate approval is idempotent', async () => {
  const ctx = coordinatorCtx();
  const coordinator = createCoordinator(ctx);
  const submitted = await coordinatorPost(coordinator, '/internal/request', {
    userId: 'approved-user', fullName: 'Approved User', email: 'approved@example.com',
  });
  const requestItem = await submitted.json();

  const firstApproval = await coordinatorPost(coordinator, '/internal/presenter/decision', {
    presenterId: TEST_PRESENTER_ID, action: 'approve', requestId: requestItem.id,
  });
  const firstResult = await firstApproval.json();
  const assignedLease = { ...coordinator.lease };
  assert.equal(firstApproval.status, 200);
  assert.equal(firstResult.request.status, 'approved');
  assert.equal(coordinator.approvedUserId, 'approved-user');
  assert.equal(assignedLease.userId, 'approved-user');
  assert.equal(assignedLease.isPresenter, false);
  assert.ok(assignedLease.token);
  assert.equal('leaseToken' in firstResult, false);

  const duplicateApproval = await coordinatorPost(coordinator, '/internal/presenter/decision', {
    presenterId: TEST_PRESENTER_ID, action: 'approve', requestId: requestItem.id,
  });
  assert.equal(duplicateApproval.status, 200);
  assert.equal(coordinator.lease.token, assignedLease.token);
  assert.equal(coordinator.lease.expiresAt, assignedLease.expiresAt);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);
});

test('concurrent approvals assign only one temporary controller', async () => {
  const coordinator = createCoordinator();
  const requests = [];
  for (const [userId, fullName] of [['user-a', 'User A'], ['user-b', 'User B']]) {
    const submitted = await coordinatorPost(coordinator, '/internal/request', {
      userId, fullName, email: `${userId}@example.com`,
    });
    requests.push(await submitted.json());
  }

  const results = await Promise.all(requests.map((item) => coordinatorPost(coordinator, '/internal/presenter/decision', {
    presenterId: TEST_PRESENTER_ID, action: 'approve', requestId: item.id,
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const approvedRequests = coordinator.requests.filter((item) => item.status === 'approved');
  assert.equal(approvedRequests.length, 1);
  assert.equal(coordinator.approvedUserId, coordinator.lease.userId);
  assert.equal(approvedRequests[0].userId, coordinator.lease.userId);
  assert.equal(coordinator.requests.filter((item) => item.status === 'pending').length, 1);
});

test('approved user receives the assigned lease only through their authenticated status request', async () => {
  const db = new MemoryDB();
  const user = await createAccount(db, 'approved@example.com');
  const otherUser = await createAccount(db, 'other@example.com');
  const presenter = await createAccount(db, 'presenter@example.com');
  const coordinator = createCoordinator(coordinatorCtx(), presenter.data.user.id);
  const env = envWith(db, {
    PRESENTER_USER_ID: presenter.data.user.id,
    COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    FAN_COORDINATOR: {
      idFromName: () => 'one',
      get: () => ({ fetch: (url, options) => coordinator.fetch(new Request(url, options)) }),
    },
  });

  const userRequest = await requestControl({
    request: request('/api/control/request', { method: 'POST', cookie: cookieToken(user.cookie), body: {} }),
    env,
  });
  const otherRequest = await requestControl({
    request: request('/api/control/request', { method: 'POST', cookie: cookieToken(otherUser.cookie), body: {} }),
    env,
  });
  const userRequestItem = await userRequest.json();
  assert.equal(otherRequest.status, 201);

  const approval = await presenterDecision({
    request: request('/api/presenter/decision', {
      method: 'POST',
      cookie: cookieToken(presenter.cookie),
      body: { action: 'approve', requestId: userRequestItem.id },
    }),
    env,
  });
  assert.equal(approval.status, 200);

  const userStatus = await controlRequestStatus({
    request: request('/api/control/request', { cookie: cookieToken(user.cookie) }),
    env,
  });
  const userStatusData = await userStatus.json();
  assert.equal(userStatusData.status, 'approved');
  assert.equal(userStatusData.leaseToken, coordinator.lease.token);
  assert.ok(userStatusData.leaseExpiresAt > Date.now());

  const otherStatus = await controlRequestStatus({
    request: request('/api/control/request', { cookie: cookieToken(otherUser.cookie) }),
    env,
  });
  const otherStatusData = await otherStatus.json();
  assert.equal(otherStatusData.status, 'pending');
  assert.equal('leaseToken' in otherStatusData, false);
});

test('coordinator rejects requests without the internal token', async () => {
  const coordinator = createCoordinator();
  const response = await coordinator.fetch(new Request('https://do.test/internal/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.equal(response.status, 403);
});

test('coordinator rejects requests with an incorrect internal token', async () => {
  const coordinator = createCoordinator();
  const response = await coordinator.fetch(new Request('https://do.test/internal/status', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-coordinator-token': 'wrong-internal-secret',
    },
    body: '{}',
  }));
  assert.equal(response.status, 403);
});

test('spoofed presenter flag cannot grant presenter control', async () => {
  const coordinator = createCoordinator();
  const response = await coordinatorPost(coordinator, '/internal/claim', {
    userId: 'ordinary-user',
    isPresenter: true,
    fullName: 'Fake Presenter',
  });
  assert.equal(response.status, 403);
});

test('presenter approval, single-controller lease, revocation, and reset preserve separate account data', async () => {
  const db = new MemoryDB();
  await createAccount(db);
  const ctx = coordinatorCtx();
  const bridgeMessages = [];
  const bridge = { send: (message) => bridgeMessages.push(JSON.parse(message)) };
  const coordinator = createCoordinator(ctx);
  attachMockSocket(coordinator, bridge, { role: 'bridge', userId: 'presenter' });
  const created = await coordinatorPost(coordinator, '/internal/request', { userId: 'u1', fullName: 'User One', email: 'one@example.com' });
  const requestItem = await created.json();
  const hidden = await coordinatorPost(coordinator, '/internal/claim', { userId: 'u1', fullName: 'User One', isPresenter: false });
  assert.equal(hidden.status, 403);
  const approved = await coordinatorPost(coordinator, '/internal/presenter/decision', { presenterId: 'presenter', action: 'approve', requestId: requestItem.id });
  assert.equal(approved.status, 200);
  const claim = await coordinatorPost(coordinator, '/internal/claim', { userId: 'u1', fullName: 'User One', isPresenter: false });
  const lease = await claim.json();
  assert.equal(claim.status, 200);
  assert.equal(bridgeMessages.some((message) => message.type === 'lease-active'), true);
  const second = await coordinatorPost(coordinator, '/internal/claim', { userId: 'u2', fullName: 'User Two', isPresenter: false });
  assert.equal(second.status, 403);
  const revoke = await coordinatorPost(coordinator, '/internal/presenter/decision', { presenterId: 'presenter', action: 'revoke', requestId: requestItem.id });
  assert.equal(revoke.status, 200);
  assert.equal(bridgeMessages.some((message) => message.type === 'lease-ended'), true);
  const unauthorizedCommand = await coordinatorPost(coordinator, '/internal/command', { userId: 'u1', isPresenter: false, leaseToken: lease.leaseToken, command: { speed: 100 } });
  assert.equal(unauthorizedCommand.status, 403);
  const reset = await coordinatorPost(coordinator, '/internal/presenter/reset', { presenterId: 'presenter' });
  assert.equal(reset.status, 200);
  assert.equal(db.users.size, 1);
  assert.equal(coordinator.approvedUserId, null);
  assert.equal(coordinator.lease, null);
  assert.deepEqual(coordinator.requests, []);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);
});

test('presenter access is assigned only from the server-side user ID setting', async () => {
  const db = new MemoryDB();
  const { cookie, data } = await createAccount(db);
  const response = await getSession({ request: request('/api/auth/session', { cookie: cookieToken(cookie) }), env: envWith(db, { PRESENTER_USER_ID: data.user.id }) });
  assert.equal((await response.json()).user.isPresenter, true);
});

test('bridge WebSocket is restricted to the same-origin presenter session', async () => {
  const db = new MemoryDB();
  const ordinary = await createAccount(db, 'audience@example.com');
  const presenter = await createAccount(db, 'presenter@example.com');
  let forwardedPath = '';
  const env = envWith(db, {
    PRESENTER_USER_ID: presenter.data.user.id,
    COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    FAN_COORDINATOR: {
      idFromName: () => 'one',
      get: () => ({
        fetch: async (incomingRequest) => {
          const forwardedUrl = new URL(incomingRequest.url);
          forwardedPath = forwardedUrl.pathname;
          assert.equal(incomingRequest.headers.get('x-coordinator-token'), TEST_INTERNAL_TOKEN);
          assert.equal(forwardedUrl.searchParams.get('presenterUserId'), presenter.data.user.id);
          return new Response('bridged');
        },
      }),
    },
  });
  const socketRequest = (cookie, origin = 'https://project.test', upgrade = true) => new Request('https://project.test/api/bridge/socket', {
    headers: { Cookie: cookieToken(cookie), Origin: origin, ...(upgrade ? { Upgrade: 'websocket' } : {}) },
  });
  const denied = await bridgeSocket({ request: socketRequest(ordinary.cookie), env });
  assert.equal(denied.status, 403);
  const crossOrigin = await bridgeSocket({ request: socketRequest(presenter.cookie, 'https://attacker.test'), env });
  assert.equal(crossOrigin.status, 403);
  const missingUpgrade = await bridgeSocket({ request: socketRequest(presenter.cookie, 'https://project.test', false), env });
  assert.equal(missingUpgrade.status, 426);
  const accepted = await bridgeSocket({ request: socketRequest(presenter.cookie), env });
  assert.equal(await accepted.text(), 'bridged');
  assert.equal(forwardedPath, '/bridge');
});

test('presenter logout closes only the authenticated bridge connection', async () => {
  const closeCalls = [];
  const bridge = {
    close: (...args) => closeCalls.push(args),
    send() {},
  };
  const ctx = coordinatorCtx();
  const coordinator = createCoordinator(ctx, 'presenter-id');
  attachMockSocket(coordinator, bridge, { role: 'bridge', userId: 'presenter-id' });
  const released = await coordinatorPost(coordinator, '/internal/bridge-release', { userId: 'other-id' });
  assert.equal(released.status, 200);
  assert.equal(closeCalls.length, 0);
  const presenterRelease = await coordinatorPost(coordinator, '/internal/bridge-release', { userId: 'presenter-id' });
  assert.equal(presenterRelease.status, 200);
  assert.equal(closeCalls.length, 1);
  assert.equal(coordinator.bridge, null);
  assert.equal(coordinator.lease, null);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);
});

test('authenticated audience WebSockets are forwarded to the live-only coordinator route', async () => {
  const db = new MemoryDB();
  const audience = await createAccount(db, 'audience@example.com');
  let forwardedPath = '';
  const env = envWith(db, {
    COORDINATOR_INTERNAL_TOKEN: TEST_INTERNAL_TOKEN,
    FAN_COORDINATOR: {
      idFromName: () => 'one',
      get: () => ({ fetch: async (incomingRequest) => { forwardedPath = new URL(incomingRequest.url).pathname; assert.equal(incomingRequest.headers.get('x-coordinator-token'), TEST_INTERNAL_TOKEN); return new Response('live'); } }),
    },
  });
  const liveRequest = new Request('https://project.test/api/live/socket', {
    headers: { Cookie: cookieToken(audience.cookie), Origin: 'https://project.test', Upgrade: 'websocket' },
  });
  const response = await liveSocket({ request: liveRequest, env });
  assert.equal(await response.text(), 'live');
  assert.equal(forwardedPath, '/live');
});

test('coordinator keeps temporary state in memory, purges legacy keys, and resets after restart', async () => {
  const db = new MemoryDB();
  const account = await createAccount(db);
  const ctx = coordinatorCtx();
  ctx.storage.values.set('state', {
    approvedUserId: account.data.user.id,
    lease: { userId: account.data.user.id, token: 'old-token', expiresAt: Date.now() + 30_000 },
    telemetry: { temperatureC: 25.4, fanSpeed: 22, mode: 'auto', fanOff: false },
    telemetryAt: Date.now(),
    bridgeConnected: true,
  });
  ctx.storage.values.set('requests', [{ id: 'old-request', userId: account.data.user.id, status: 'pending', at: Date.now() }]);
  const coordinator = createCoordinator(ctx);
  await coordinator.ready;
  assert.equal(ctx.storage.values.size, 0);

  const sent = [];
  const audienceSocket = { send: (message) => sent.push(JSON.parse(message)) };
  const bridge = { send() {} };
  attachMockSocket(coordinator, audienceSocket, { role: 'audience' });
  attachMockSocket(coordinator, bridge, { role: 'bridge', userId: 'presenter' });

  const created = await coordinatorPost(coordinator, '/internal/request', {
    userId: account.data.user.id, fullName: account.data.user.fullName, email: account.data.user.email,
  });
  const controlRequest = await created.json();
  assert.equal(created.status, 201);
  const approved = await coordinatorPost(coordinator, '/internal/presenter/decision', {
    presenterId: 'presenter', action: 'approve', requestId: controlRequest.id,
  });
  assert.equal(approved.status, 200);
  const claim = await coordinatorPost(coordinator, '/internal/claim', {
    userId: account.data.user.id, fullName: account.data.user.fullName, isPresenter: false,
  });
  const { leaseToken } = await claim.json();
  assert.equal(claim.status, 200);
  await coordinator.webSocketMessage(bridge, JSON.stringify({
    type: 'telemetry', data: { temperatureC: 25.4, fanSpeed: 22, mode: 'auto', fanOff: false },
  }));
  assert.deepEqual(sent.at(-1), { type: 'telemetry', data: { temperatureC: 25.4, fanSpeed: 22, mode: 'auto', fanOff: false } });

  const before = await coordinatorPost(coordinator, '/internal/status', {});
  const beforeData = await before.json();
  assert.equal(beforeData.online, true);
  assert.equal(coordinator.approvedUserId, account.data.user.id);
  assert.equal(coordinator.lease.token, leaseToken);
  assert.equal(ctx.storage.values.size, 0);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);

  const restartedCoordinator = createCoordinator(ctx);
  await restartedCoordinator.ready;
  assert.equal(restartedCoordinator.approvedUserId, null);
  assert.equal(restartedCoordinator.lease, null);
  assert.deepEqual(restartedCoordinator.requests, []);
  assert.equal(restartedCoordinator.telemetry, null);
  assert.equal(restartedCoordinator.webSockets.size, 0);
  const afterRestart = await coordinatorPost(restartedCoordinator, '/internal/status', {});
  const afterRestartData = await afterRestart.json();
  assert.equal(afterRestartData.online, false);
  assert.equal('temperatureC' in afterRestartData, false);
  const lostRequest = await coordinatorPost(restartedCoordinator, '/internal/request-status', { userId: account.data.user.id });
  assert.deepEqual(await lostRequest.json(), { status: 'none' });
  const deniedClaim = await coordinatorPost(restartedCoordinator, '/internal/claim', {
    userId: account.data.user.id, isPresenter: false,
  });
  assert.equal(deniedClaim.status, 403);
  const deniedCommand = await coordinatorPost(restartedCoordinator, '/internal/command', {
    userId: account.data.user.id, isPresenter: false, leaseToken, command: { speed: 50 },
  });
  assert.equal(deniedCommand.status, 403);
  const presenterRequests = await coordinatorPost(restartedCoordinator, '/internal/presenter/requests', {}, { 'x-presenter-user': 'presenter' });
  assert.deepEqual((await presenterRequests.json()).requests, []);
  assert.equal(ctx.storage.values.size, 0);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);

  const recoveredMessages = [];
  const recoveredAudience = { send: (message) => recoveredMessages.push(JSON.parse(message)) };
  const recoveredBridge = { send() {} };
  attachMockSocket(restartedCoordinator, recoveredAudience, { role: 'audience' });
  attachMockSocket(restartedCoordinator, recoveredBridge, { role: 'bridge', userId: 'presenter' });
  await restartedCoordinator.webSocketMessage(recoveredAudience, JSON.stringify({ type: 'audience-ping' }));
  assert.deepEqual(recoveredMessages.at(-1), { type: 'telemetry', online: false });
  await restartedCoordinator.webSocketMessage(recoveredBridge, JSON.stringify({
    type: 'telemetry', data: { temperatureC: 26.1, fanSpeed: 30, mode: 'manual', fanOff: false },
  }));
  assert.deepEqual(recoveredMessages.at(-1), { type: 'telemetry', data: { temperatureC: 26.1, fanSpeed: 30, mode: 'manual', fanOff: false } });
  assert.equal(db.users.size, 1);
});

test('expired in-memory controller lease revokes approval and signals the bridge', async () => {
  const signals = [];
  const bridge = { send: (message) => signals.push(JSON.parse(message)) };
  const ctx = coordinatorCtx();
  const coordinator = createCoordinator(ctx);
  attachMockSocket(coordinator, bridge, { role: 'bridge' });
  coordinator.approvedUserId = 'user-1';
  coordinator.lease = { userId: 'user-1', fullName: 'Test User', token: 'lease-token', expiresAt: Date.now() - 1 };
  coordinator.requests = [{ id: 'request-1', userId: 'user-1', at: Date.now(), status: 'approved' }];
  const status = await coordinatorPost(coordinator, '/internal/status', {});
  const statusData = await status.json();
  assert.equal(statusData.occupied, false);
  assert.equal(coordinator.approvedUserId, null);
  assert.equal(coordinator.lease, null);
  assert.equal(coordinator.requests[0].status, 'expired');
  assert.deepEqual(signals, [{ type: 'lease-ended' }]);
  assert.equal(ctx.storage.calls.every((call) => call.operation === 'delete'), true);
});
