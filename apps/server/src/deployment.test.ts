import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { parse, stringify } from 'yaml';

const execute = promisify(execFile);
const example = new URL('../../../config.example.yaml', import.meta.url);
const cli = fileURLToPath(new URL('./configCli.ts', import.meta.url));
const nodeArgs = process.execArgv.filter((argument) => argument !== '--test');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'team-manager-deployment-'));
  const config = parse(await readFile(example, 'utf8'));
  config.admin.password = '$2b$12$012345678901234567890u0123456789012345678901234567890';
  config.server.dataEncryptionKey = 'a'.repeat(64);
  config.server.jwtSecret = 'test-jwt-secret-' + 'b'.repeat(32);
  config.transport.curlCffiToken = 'test-worker-token-' + 'c'.repeat(32);
  const path = join(directory, 'config.yaml');
  async function run() {
    await writeFile(path, stringify(config), { mode: 0o600 });
    return execute(process.execPath, [...nodeArgs, cli, 'compose-env', '--config', path]);
  }
  return { directory, config, run };
}

test('production variables preserve secret characters through the shell without evaluation', async () => {
  const { directory, config, run } = await fixture();
  try {
    const password = 'literal-$HOME-${HOME}-$(false)-`false`-"quote"-\'quote\'-\\backslash\nsecond line';
    config.database.password = password;
    config.server.port = 43123;
    config.deployment.worker.ports.compose = 43124;
    config.transport.curlCffiUrls.compose = 'http://curl-cffi-worker:43124';
    const { stdout } = await run();
    const records = join(directory, 'environment');
    await writeFile(records, stdout, { mode: 0o600 });
    const shell = await execute('/bin/bash', ['-c',
      'while IFS= read -r -d "" assignment; do export "$assignment"; done < "$1"; exec "$2" -e \'console.log(JSON.stringify([process.env.TEAMMGR_POSTGRES_PASSWORD, process.env.TEAMMGR_SERVER_PORT, process.env.TEAMMGR_CURL_CFFI_PORT, process.env.TEAMMGR_CURL_CFFI_TOKEN, process.env.TEAMMGR_CHATGPT_PROXY]))\'',
      '--', records, process.execPath,
    ], { env: { ...process.env, TEAMMGR_CHATGPT_PROXY: 'stale-proxy' } });
    assert.deepEqual(JSON.parse(shell.stdout), [password, '43123', '43124', config.transport.curlCffiToken, '']);
    assert.ok(!stdout.includes(config.server.jwtSecret));
    assert.ok(!stdout.includes(config.server.dataEncryptionKey));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('production rejects ephemeral data paths, mismatched services, and invalid encryption before Compose', async () => {
  const { directory, config, run } = await fixture();
  const baseline = structuredClone(config);
  try {
    for (const [mutate, message] of [
      [(c: any) => { c.server.artifactDir = '../outside'; }, /挂载的配置目录/],
      [(c: any) => { c.server.dataDir = '/app/data'; }, /挂载的配置目录/],
      [(c: any) => { c.server.webDistDirs.compose = './apps/web/dist'; }, /webDistDirs.compose/],
      [(c: any) => { c.database.hosts.compose.host = 'localhost'; }, /postgres:5432/],
      [(c: any) => { c.deployment.worker.ports.compose = 43124; }, /curl-cffi-worker/],
      [(c: any) => { c.server.dataEncryptionKey = 'invalid-key'; }, /32 字节/],
      [(c: any) => { c.server.jwtSecret = 'short'; }, /jwtSecret/],
      [(c: any) => { c.database.password = 'invalid\0password'; }, /NUL/],
    ] as const) {
      Object.assign(config, structuredClone(baseline));
      mutate(config);
      await assert.rejects(run(), (error: unknown) => {
        const failure = error as { stderr: string; stdout: string };
        assert.match(failure.stderr, message);
        assert.equal(failure.stdout, '');
        return true;
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
