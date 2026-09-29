import assert from 'node:assert/strict';
import test from 'node:test';

// Transport captures native fetch at import time. Keep this test entirely offline.
const requests: Request[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  requests.push(new Request(input, init));
  return Response.json({ status: 200, body: '{"ok":true}' });
};
const { CurlCffiTransport, createTransport } = await import('./transport.js');
globalThis.fetch = originalFetch;

test('worker transport fails closed without a valid service token', () => {
  for (const token of [undefined, '', 'short', 'a'.repeat(31), 'a'.repeat(32) + ':']) {
    assert.throws(() => new CurlCffiTransport('http://worker:8080', token), /curlCffiToken/);
    assert.throws(() => createTransport('http://worker:8080', token), /curlCffiToken/);
  }
  assert.doesNotThrow(() => createTransport());
  assert.equal(requests.length, 0);
});

test('service token authenticates only the worker hop and redirects are rejected', async () => {
  const token = 'test-worker-token-' + 'a'.repeat(32);
  const transport = new CurlCffiTransport('http://worker:8080/', token);
  const input = {
    method: 'GET', path: '/backend-api/me',
    headers: { Authorization: 'Bearer upstream-only-token' },
    proxy: 'http://proxy.example:8080'
  };
  assert.equal((await transport.fetch(input)).status, 200);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, 'http://worker:8080/fetch');
  assert.equal(request.headers.get('Authorization'), `Bearer ${token}`);
  assert.equal(request.redirect, 'error');
  assert.deepEqual(await request.json(), input);
});
