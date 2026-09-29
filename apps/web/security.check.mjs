import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createServer } from 'vite';

test('development server listens on loopback and rejects untrusted Host headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'team-manager-vite-security-'));
  let server;
  try {
    await writeFile(join(directory, 'index.html'), '<main>security-test</main>');
    server = await createServer({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      root: directory,
      logLevel: 'silent',
      server: { port: 0, strictPort: false },
      optimizeDeps: { noDiscovery: true, include: [] }
    });
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(address.address, '127.0.0.1');
    assert.deepEqual(server.config.server.allowedHosts, []);
    const get = (host) => new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: '/', headers: { Host: host } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('test request timed out')));
      req.end();
    });
    assert.equal(await get('localhost'), 200);
    assert.equal(await get('127.0.0.1'), 200);
    assert.equal(await get('untrusted.example'), 403);
    assert.equal(await get('localhost.attacker.example'), 403);
    const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
    assert.doesNotMatch(pkg.scripts.dev, /--host(?:\s|=|$)/);
  } finally {
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
