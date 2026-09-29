import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./deploy.sh', import.meta.url));

// Exercise orchestration without a Docker daemon or production data.
async function fixture(t, failMigration = false) {
  const directory = await mkdtemp(join(tmpdir(), 'team-manager-deploy-shell-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = join(directory, 'private runtime');
  const temporary = join(directory, 'temporary');
  await mkdir(runtime);
  await mkdir(temporary);
  await writeFile(join(runtime, 'config.yaml'), 'test fixture');
  const log = join(directory, 'calls.jsonl');
  await writeFile(join(directory, 'docker'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'run') process.stdout.write('TEAMMGR_SERVER_PORT=43123\\0TEAMMGR_POSTGRES_PASSWORD=literal-$HOME-$(false)\\0');
if (process.env.TEST_FAIL_MIGRATION === '1' && args[0] === 'compose' && args.includes('run') && args.includes('migrate')) process.exit(23);
`, { mode: 0o700 });
  const env = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH}`,
    TMPDIR: temporary,
    TEST_DOCKER_LOG: log,
    TEST_FAIL_MIGRATION: failMigration ? '1' : '0',
  };
  return { runtime, temporary, log, env };
}

test('deploy waits for dependencies and finishes migration before starting the app', async (t) => {
  const { runtime, log, env } = await fixture(t);
  await execute('/bin/bash', [script, runtime, 'up'], { env });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const migration = calls.findIndex((args) => args.includes('run') && args.includes('migrate'));
  const stop = calls.findIndex((args) => args.includes('stop'));
  const dependencies = calls.findIndex((args) => args.includes('up') && args.includes('postgres'));
  const app = calls.findIndex((args) => args.includes('up') && args.at(-1) === 'team-manager');
  assert.ok(stop > 0 && stop < dependencies && dependencies < migration && migration < app);
  assert.ok(calls[app].includes('--wait'));
  assert.ok(calls[dependencies].includes('--wait'));
});

test('failed migration never starts the app and temporary secrets are removed', async (t) => {
  const { runtime, temporary, log, env } = await fixture(t, true);
  await assert.rejects(execute('/bin/bash', [script, runtime, 'up'], { env }), { code: 23 });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!calls.some((args) => args.includes('up') && args.at(-1) === 'team-manager'));
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(temporary), []);
});
