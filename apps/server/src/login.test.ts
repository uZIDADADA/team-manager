import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createLoginRoutes } from './auth/login.js';
import { LoginLimiter } from './auth/loginLimiter.js';
import { verifyJwt } from './auth/jwt.js';
import { hashPassword } from './auth/password.js';

const config = { adminUsername: 'admin', adminPasswordHash: 'test-hash', jwtIssuer: 'test', jwtSecret: 'test-only-secret' };
const credentials = JSON.stringify({ username: 'admin', password: 'test-password' });
function fixture(verifyPassword: (password: string, hash: string) => Promise<boolean> = async () => false) {
  let time = 0;
  const app = new Hono().route('/api/auth', createLoginRoutes(config, {
    limiter: new LoginLimiter(() => time), verifyPassword
  }));
  app.onError(() => new Response('test error', { status: 500 }));
  const send = (source = '192.0.2.1', body = credentials, headers: Record<string, string> = {}) =>
    app.request('/api/auth/login', { method: 'POST', body, headers }, {
      incoming: { socket: { remoteAddress: source } }
    });
  return { app, send, advance: (ms: number) => { time += ms; } };
}

test('failed logins back off, cannot spoof source headers or reset the delay by rotating usernames', async () => {
  let calls = 0;
  const { send, advance } = fixture(async () => { calls++; return false; });
  for (let n = 0; n < 3; n++) assert.equal((await send()).status, 401);
  const blocked = await send('::ffff:192.0.2.1', JSON.stringify({ username: 'another-user', password: 'test' }), {
    'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2', Forwarded: 'for=198.51.100.3'
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '1');
  assert.equal(calls, 3);
  advance(1000);
  assert.equal((await send()).status, 401);
  assert.equal((await send()).headers.get('Retry-After'), '2');
  assert.equal((await send('192.0.2.2')).status, 401);
  advance(15 * 60_000);
  assert.equal((await send()).status, 401);
});

test('successful login clears failure backoff but does not bypass the per-source rate limit', async () => {
  let valid = false;
  const { send, advance } = fixture(async () => valid);
  await send(); await send(); await send();
  advance(1000);
  valid = true;
  const success = await send();
  assert.equal(success.status, 200);
  assert.equal(success.headers.get('Cache-Control'), 'no-store');
  const { data } = await success.json() as { data: { token: string } };
  assert.equal(verifyJwt({ token: data.token, secret: config.jwtSecret, issuer: config.jwtIssuer, tokenType: 'access' })?.sub, 'admin');
  valid = false;
  assert.equal((await send()).status, 401); // no delay inherited from earlier failures
  valid = true;
  for (let n = 0; n < 5; n++) assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 429);
  advance(60_000);
  assert.equal((await send()).status, 200);
});

test('global attempt budget applies even when the source address changes', async () => {
  let calls = 0;
  const { send, advance } = fixture(async () => { calls++; return true; });
  for (let n = 0; n < 60; n++) assert.equal((await send(`192.0.2.${n + 1}`)).status, 200);
  assert.equal((await send('198.51.100.1')).status, 429);
  assert.equal(calls, 60);
  advance(60_000);
  assert.equal((await send('198.51.100.1')).status, 200);
});

test('failure backoff is capped and rejected retries cannot extend the cooldown', () => {
  let now = 0;
  const limiter = new LoginLimiter(() => now);
  for (let failure = 1; failure <= 9; failure++) {
    const admission = limiter.acquire('192.0.2.1');
    assert.ok('finish' in admission);
    admission.finish(false);
    if (failure >= 3 && failure < 9) now += Math.min(60, 2 ** (failure - 3)) * 1000;
  }
  assert.deepEqual(limiter.acquire('192.0.2.1'), { retryAfter: 60 });
  now += 59_000;
  assert.deepEqual(limiter.acquire('192.0.2.1'), { retryAfter: 1 });
  now += 1000;
  const admission = limiter.acquire('192.0.2.1');
  assert.ok('finish' in admission);
  admission.finish(true);
});

test('at most two verifications run concurrently, with only one per source and no queued work', async () => {
  const releases: Array<(valid: boolean) => void> = [];
  const { send } = fixture(() => new Promise<boolean>((resolve) => releases.push(resolve)));
  const first = send('192.0.2.1');
  const second = send('192.0.2.2');
  // Let the admitted requests finish reading their small bodies.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.equal((await send('192.0.2.3')).status, 429);
  assert.equal((await send('192.0.2.1')).status, 429);
  releases[0]!(true);
  assert.equal((await first).status, 200);
  const third = send('192.0.2.3');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 3);
  releases[1]!(false); releases[2]!(true);
  assert.equal((await second).status, 401);
  assert.equal((await third).status, 200);
});

test('malformed and oversized bodies never reach password verification; errors release capacity', async () => {
  let calls = 0;
  const { send } = fixture(async () => { calls++; throw new Error('verification failure'); });
  for (const [index, body] of ['null', '[]', '{', '{"username":{},"password":[]}',
    JSON.stringify({ username: 'admin', password: 'a'.repeat(73) }), 'a'.repeat(4097)].entries()) {
    assert.equal((await send(`192.0.2.${index}`, body)).status, body.length > 4096 ? 413 : 400);
  }
  assert.equal(calls, 0);
  for (let n = 0; n < 3; n++) assert.equal((await send(`198.51.100.${n}`)).status, 500);
  assert.equal(calls, 3);
});

test('chunked upload cannot bypass the byte limit with a false Content-Length', async () => {
  let called = false;
  const { app, send } = fixture(async () => { called = true; return true; });
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(3000));
    controller.enqueue(new Uint8Array(3000));
    controller.close();
  } });
  const request = new Request('http://localhost/api/auth/login', {
    method: 'POST', body: stream, headers: { 'Content-Length': '1' }, duplex: 'half'
  } as RequestInit);
  assert.equal((await app.request(request)).status, 413);
  assert.equal(called, false);
  assert.equal((await send()).status, 200);
});

test('slow request body times out and releases its admission', async () => {
  const { app } = fixture(async () => true);
  let cancelled = false;
  const request = new Request('http://localhost/api/auth/login', {
    method: 'POST', body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: 'half'
  } as RequestInit);
  assert.equal((await app.request(request)).status, 408);
  assert.equal(cancelled, true);
  const response = await app.request('/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(response.status, 200);
});

test('missing socket metadata cannot be bypassed by forwarding headers', async () => {
  const { app } = fixture();
  for (let n = 0; n < 3; n++) assert.equal((await app.request('/api/auth/login', { method: 'POST', body: credentials })).status, 401);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', body: credentials, headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 429);
});

test('real bcrypt login remains compatible with the existing token response', async () => {
  const app = createLoginRoutes({ ...config, adminPasswordHash: await hashPassword('test-password') });
  assert.equal((await app.request('/login', { method: 'POST', body: credentials })).status, 200);
});
