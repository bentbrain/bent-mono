import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';

const script = resolve('scripts/deploy-verified.mjs');
const require = createRequire(import.meta.url);
const wranglerExecutable = join(
  dirname(require.resolve('wrangler/package.json')),
  'bin/wrangler.js',
);
const syntheticKey = 'synthetic-secret-fixture';
const syntheticEncryptionKey =
  'emdash_enc_v1_' + Buffer.alloc(32, 7).toString('base64url');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jp-deploy-fixture-'));
  const bin = join(directory, 'bin');
  const temporary = join(directory, 'temporary');
  const evidence = join(directory, 'received.json');
  const started = join(directory, 'started');
  await mkdir(bin);
  await mkdir(temporary);
  await writeFile(
    join(bin, 'bun'),
    `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
fs.writeFileSync(process.env.FIXTURE_STARTED, 'started');
const args = process.argv.slice(2);
if (process.env.FIXTURE_PRESERVE) {
  assert.equal(Object.hasOwn(process.env, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(process.env, 'EMDASH_ENCRYPTION_KEY'), false);
  if ((process.env.FIXTURE_PRESERVE_WAIT === 'list' && args[2] === 'secret') ||
      (process.env.FIXTURE_PRESERVE_WAIT === 'deploy' && args[2] === 'deploy')) {
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')"], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    descendant.once('message', () => {
      fs.writeFileSync(process.env.FIXTURE_EVIDENCE, JSON.stringify({pid: process.pid, descendant: descendant.pid}));
      setInterval(() => {}, 1000);
    });
  } else if (args[2] === 'secret') {
    assert.deepEqual(args, ['x', 'wrangler', 'secret', 'list', '--format', 'json']);
    fs.appendFileSync(process.env.FIXTURE_EVIDENCE, 'names\\n');
    if (process.env.FIXTURE_SECRET_OUTPUT) process.stdout.write(process.env.FIXTURE_SECRET_OUTPUT);
    else process.stdout.write(JSON.stringify(['EMDASH_ENCRYPTION_KEY', 'OPENAI_API_KEY', 'OWNER_EMAIL'].filter(name => name !== process.env.FIXTURE_MISSING_SECRET).map(name => ({name, type: 'secret_text'}))));
    process.stderr.write('synthetic-provider-private-diagnostic');
    process.exit(Number(process.env.FIXTURE_LIST_EXIT || 0));
  } else {
    assert.deepEqual(args, ['x', 'wrangler', 'deploy']);
    fs.appendFileSync(process.env.FIXTURE_EVIDENCE, 'deploy\\n');
    process.exit(0);
  }
} else {
const file = args[args.indexOf('--secrets-file') + 1];
// Reopen the path exactly as Wrangler does, including on the Linux CI runner.
const binding = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(binding.OPENAI_API_KEY === 'synthetic-secret-fixture', true);
assert.equal(binding.EMDASH_ENCRYPTION_KEY === ${JSON.stringify(syntheticEncryptionKey)}, true);
assert.deepEqual(Object.keys(binding), ['OPENAI_API_KEY', 'EMDASH_ENCRYPTION_KEY']);
assert.equal(Object.hasOwn(process.env, 'OPENAI_API_KEY'), false);
assert.equal(Object.hasOwn(process.env, 'EMDASH_ENCRYPTION_KEY'), false);
assert.equal(process.env.CLOUDFLARE_API_TOKEN === 'synthetic-cloudflare-token', true);
assert.equal(args.some(arg => arg.includes('synthetic-secret-fixture')), false);
assert.deepEqual(args.slice(0, -1), ['x', 'wrangler', 'deploy', '--secrets-file']);
assert.equal(fs.lstatSync(file).isFile(), true);
assert.equal(fs.statSync(file).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
assert.equal(path.dirname(path.dirname(file)), fs.realpathSync(process.env.TMPDIR));
const waiting = ['wait', 'stubborn'].includes(process.env.FIXTURE_MODE);
if (process.env.FIXTURE_MODE === 'stubborn') process.on('SIGTERM', () => {});
let descendant;
if (waiting) {
  descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  descendant.once('message', ready);
} else {
  ready();
}
function ready() {
  fs.writeFileSync(process.env.FIXTURE_EVIDENCE, JSON.stringify({ file, pid: process.pid, descendant: descendant?.pid }));
  if (waiting) {
    setInterval(() => {}, 1000);
  } else if (process.env.FIXTURE_MODE === 'signal') {
    process.kill(process.pid, 'SIGTERM');
  } else if (process.env.FIXTURE_MODE === 'wrangler') {
    const result = spawnSync(process.execPath, [process.env.FIXTURE_WRANGLER, 'deploy', '--config', process.env.FIXTURE_CONFIG, '--secrets-file', file, '--dry-run', '--outdir', process.env.FIXTURE_OUTPUT], { env: process.env, encoding: 'utf8' });
    assert.equal((result.stdout + result.stderr).includes('synthetic-secret-fixture'), false);
    process.exitCode = result.status ?? 1;
  } else {
    process.exitCode = Number(process.env.FIXTURE_EXIT || 0);
  }
}
}
`,
  );
  await chmod(join(bin, 'bun'), 0o700);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ''}`,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    FIXTURE_EVIDENCE: evidence,
    FIXTURE_STARTED: started,
    OPENAI_API_KEY: syntheticKey,
    EMDASH_ENCRYPTION_KEY: syntheticEncryptionKey,
    CLOUDFLARE_API_TOKEN: 'synthetic-cloudflare-token',
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
    CI: 'true',
  };
  return { directory, bin, temporary, evidence, started, env };
}

function launch(
  env: NodeJS.ProcessEnv,
  cwd: string,
  nodeArgs: string[] = [],
  scriptArgs: string[] = [],
) {
  const child = spawn(process.execPath, [...nodeArgs, script, ...scriptArgs], {
    env,
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout
    .setEncoding('utf8')
    .on('data', (part: string) => (stdout += part));
  child.stderr
    .setEncoding('utf8')
    .on('data', (part: string) => (stderr += part));
  const completed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

async function readEvidence(file: string) {
  const received: unknown = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(received && typeof received === 'object');
  assert.ok('file' in received && typeof received.file === 'string');
  return received.file;
}

void test('verified deploy reopens a private temporary JSON file and cleans it after success or failure', async () => {
  const setup = await fixture();
  try {
    for (const exitCode of [0, 7]) {
      const result = await launch(
        { ...setup.env, FIXTURE_EXIT: String(exitCode) },
        setup.directory,
      ).completed;
      assert.equal(result.stdout === '' && result.stderr === '', true);
      assert.equal(result.code, exitCode);
      assert.equal(result.signal, null);
      const file = await readEvidence(setup.evidence);
      await assert.rejects(readFile(file), { code: 'ENOENT' });
      assert.deepEqual(await readdir(setup.temporary), []);
    }
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('missing keys and child startup errors fail without leaving temporary files', async () => {
  const setup = await fixture();
  try {
    const missing = await launch(
      { ...setup.env, OPENAI_API_KEY: '   ' },
      setup.directory,
    ).completed;
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, '');
    assert.equal(
      missing.stderr.trim(),
      'OPENAI_API_KEY GitHub Actions secret is required',
    );
    const startup = await launch(
      { ...setup.env, PATH: setup.temporary },
      setup.directory,
    ).completed;
    assert.equal(startup.code, 1);
    assert.equal(startup.stdout === '' && startup.stderr === '', true);
    assert.deepEqual(await readdir(setup.temporary), []);
    await assert.rejects(readFile(setup.evidence), { code: 'ENOENT' });
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('missing and malformed encryption keys fail before deployment without exposing the input', async () => {
  const setup = await fixture();
  try {
    for (const value of [
      '',
      ',',
      ', ,',
      'legacy-key-fixture',
      'emdash_enc_v1_' + 'x'.repeat(43),
    ]) {
      const result = await launch(
        { ...setup.env, EMDASH_ENCRYPTION_KEY: value },
        setup.directory,
      ).completed;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.startsWith('EMDASH_ENCRYPTION_KEY'), true);
      if (value) assert.equal(result.stderr.includes(value), false);
      await assert.rejects(readFile(setup.started), { code: 'ENOENT' });
      await assert.rejects(readFile(setup.evidence), { code: 'ENOENT' });
      assert.deepEqual(await readdir(setup.temporary), []);
    }
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('temporary directories anywhere inside the monorepo are rejected before writing the key', async () => {
  const setup = await fixture();
  try {
    for (const temporary of [resolve(), resolve('../..')]) {
      const result = await launch(
        { ...setup.env, TMPDIR: temporary },
        setup.directory,
      ).completed;
      assert.equal(result.code, 1);
      assert.equal(
        result.stderr.trim(),
        'Deployment secrets require a temporary directory outside the repository',
      );
      assert.equal(result.stdout, '');
      await assert.rejects(readFile(setup.evidence), { code: 'ENOENT' });
      assert.deepEqual(await readdir(setup.temporary), []);
    }
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('child termination is propagated as a signal after cleanup', async () => {
  const setup = await fixture();
  try {
    const result = await launch(
      { ...setup.env, FIXTURE_MODE: 'signal' },
      setup.directory,
    ).completed;
    assert.equal(result.code, null);
    assert.equal(result.signal, 'SIGTERM');
    assert.equal(result.stdout === '' && result.stderr === '', true);
    assert.deepEqual(await readdir(setup.temporary), []);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

async function waitForEvidence(file: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return await readEvidence(file);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      ) {
        throw error;
      }
      await setTimeout(10);
    }
  }
  throw new Error('Deployment child did not become ready');
}

async function assertStopped(pid: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.ok(
        error instanceof Error && 'code' in error && error.code === 'ESRCH',
      );
      return;
    }
    await setTimeout(10);
  }
  assert.fail('Deployment descendant remained alive');
}

const cancellations: { signal: NodeJS.Signals; mode: string }[] = [
  { signal: 'SIGTERM', mode: 'wait' },
  { signal: 'SIGINT', mode: 'wait' },
  { signal: 'SIGHUP', mode: 'wait' },
  { signal: 'SIGTERM', mode: 'stubborn' },
];
for (const { signal, mode } of cancellations) {
  void test(
    `handled ${signal} stops the ${mode} deployment group and removes the secret`,
    { timeout: 15000 },
    async () => {
      const setup = await fixture();
      const deployment = launch(
        { ...setup.env, FIXTURE_MODE: mode },
        setup.directory,
      );
      try {
        const file = await waitForEvidence(setup.evidence);
        const received: unknown = JSON.parse(
          await readFile(setup.evidence, 'utf8'),
        );
        assert.ok(received && typeof received === 'object');
        assert.ok('pid' in received && typeof received.pid === 'number');
        assert.ok(
          'descendant' in received && typeof received.descendant === 'number',
        );
        deployment.child.kill(signal);
        if (mode === 'stubborn') {
          await setTimeout(30);
          assert.ok((await readFile(file)).length > 0);
          deployment.child.kill(signal);
        }
        const result = await deployment.completed;
        assert.equal(
          result.code,
          null,
          JSON.stringify({
            signal: result.signal,
            stderr: result.stderr
              .replaceAll(syntheticKey, '[synthetic key]')
              .replaceAll(syntheticEncryptionKey, '[synthetic encryption key]'),
          }),
        );
        assert.equal(result.signal, signal);
        assert.equal(result.stdout === '' && result.stderr === '', true);
        await assert.rejects(readFile(file), { code: 'ENOENT' });
        assert.deepEqual(await readdir(setup.temporary), []);
        await assertStopped(received.pid);
        await assertStopped(received.descendant);
      } finally {
        deployment.child.kill('SIGTERM');
        await deployment.completed;
        await rm(setup.directory, { recursive: true, force: true });
      }
    },
  );
}

void test('Wrangler consumes the same file in an offline dry run with a synthetic binding', async () => {
  const setup = await fixture();
  try {
    const config = join(setup.directory, 'wrangler.json');
    const output = join(setup.directory, 'output');
    await writeFile(
      config,
      JSON.stringify({
        name: 'deployment-secret-fixture',
        main: 'worker.mjs',
        compatibility_date: '2026-10-15',
      }),
    );
    await writeFile(
      join(setup.directory, 'worker.mjs'),
      "export default { fetch() { return new Response('fixture'); } };\n",
    );
    const result = await launch(
      {
        ...setup.env,
        FIXTURE_MODE: 'wrangler',
        FIXTURE_WRANGLER: wranglerExecutable,
        FIXTURE_CONFIG: config,
        FIXTURE_OUTPUT: output,
        // Keep Wrangler logs and config in this disposable fixture as well.
        WRANGLER_LOG_PATH: join(setup.directory, 'wrangler.log'),
        XDG_CONFIG_HOME: join(setup.directory, 'config'),
      },
      setup.directory,
    ).completed;
    assert.equal(result.stdout === '' && result.stderr === '', true);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.ok((await readdir(output)).includes('worker.js'));
    const outputText = await readFile(join(output, 'worker.js'), 'utf8');
    assert.equal(outputText.includes(syntheticKey), false);
    assert.equal(outputText.includes(syntheticEncryptionKey), false);
    const logs = await readFile(join(setup.directory, 'wrangler.log'), 'utf8');
    assert.equal(logs.includes(syntheticKey), false);
    assert.equal(logs.includes(syntheticEncryptionKey), false);
    assert.deepEqual(
      (await readdir(setup.temporary)).filter((name) =>
        name.startsWith('jp-deploy-secrets-'),
      ),
      [],
    );
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('an exited deployment process group is rechecked after a racy permission error', async () => {
  const setup = await fixture();
  try {
    const preload = join(setup.directory, 'synthetic-kill-race.mjs');
    await writeFile(
      preload,
      `
const original = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGKILL') {
    const error = new Error('Synthetic exited-group race');
    error.code = 'EPERM';
    throw error;
  }
  return original(pid, signal);
};
`,
    );
    const result = await launch(setup.env, setup.directory, [
      '--import',
      preload,
    ]).completed;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout === '' && result.stderr === '', true);
    const file = await readEvidence(setup.evidence);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.deepEqual(await readdir(setup.temporary), []);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('an unresolved process-group permission error fails while still removing the private secret', async () => {
  const setup = await fixture();
  try {
    const preload = join(setup.directory, 'synthetic-live-group.mjs');
    await writeFile(
      preload,
      `
const original = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGKILL') {
    const error = new Error('Synthetic live-group permission error');
    error.code = 'EPERM';
    throw error;
  }
  if (pid < 0 && signal === 0) return true;
  return original(pid, signal);
};
`,
    );
    const result = await launch(setup.env, setup.directory, [
      '--import',
      preload,
    ]).completed;
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr.includes('Synthetic live-group permission error'),
      true,
    );
    const file = await readEvidence(setup.evidence);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.deepEqual(await readdir(setup.temporary), []);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('a briefly visible exited process group is reconciled without losing cleanup', async () => {
  const setup = await fixture();
  try {
    const preload = join(setup.directory, 'synthetic-delayed-group-exit.mjs');
    await writeFile(
      preload,
      `
const original = process.kill.bind(process);
let probes = 0;
process.kill = (pid, signal) => {
  if (pid < 0 && signal === 'SIGKILL') {
    const error = new Error('Synthetic delayed exited-group race');
    error.code = 'EPERM';
    throw error;
  }
  if (pid < 0 && signal === 0 && probes++ < 3) return true;
  return original(pid, signal);
};
`,
    );
    const result = await launch(setup.env, setup.directory, [
      '--import',
      preload,
    ]).completed;
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout === '' && result.stderr === '', true);
    const file = await readEvidence(setup.evidence);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.deepEqual(await readdir(setup.temporary), []);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('explicit preservation checks secret names and deploys without replacing any values', async () => {
  const setup = await fixture();
  try {
    const env: NodeJS.ProcessEnv = { ...setup.env, FIXTURE_PRESERVE: 'true' };
    delete env.OPENAI_API_KEY;
    // emDash declares this key required globally; this fixture deliberately removes it.
    Reflect.deleteProperty(env, 'EMDASH_ENCRYPTION_KEY');
    const result = await launch(
      env,
      setup.directory,
      [],
      ['--preserve-existing-secrets'],
    ).completed;
    assert.equal(result.code, 0);
    assert.equal(result.stdout + result.stderr, '');
    assert.equal(await readFile(setup.evidence, 'utf8'), 'names\ndeploy\n');
    assert.deepEqual(await readdir(setup.temporary), []);
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

void test('preservation fails closed for absent secrets, invalid metadata, listing failures and supplied replacements', async () => {
  const setup = await fixture();
  try {
    for (const extra of [
      { FIXTURE_MISSING_SECRET: 'EMDASH_ENCRYPTION_KEY' },
      { FIXTURE_MISSING_SECRET: 'OPENAI_API_KEY' },
      { FIXTURE_MISSING_SECRET: 'OWNER_EMAIL' },
      { FIXTURE_SECRET_OUTPUT: 'not-json' },
      {
        FIXTURE_SECRET_OUTPUT: JSON.stringify([
          { name: 'EMDASH_ENCRYPTION_KEY', type: 'unexpected' },
        ]),
      },
      { FIXTURE_LIST_EXIT: '7' },
      { OPENAI_API_KEY: syntheticKey },
      { EMDASH_ENCRYPTION_KEY: syntheticEncryptionKey },
    ]) {
      await rm(setup.evidence, { force: true });
      const env: NodeJS.ProcessEnv = { ...setup.env, FIXTURE_PRESERVE: 'true' };
      delete env.OPENAI_API_KEY;
      // emDash declares this key required globally; this fixture deliberately removes it.
      Reflect.deleteProperty(env, 'EMDASH_ENCRYPTION_KEY');
      const result = await launch(
        { ...env, ...extra },
        setup.directory,
        [],
        ['--preserve-existing-secrets'],
      ).completed;
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.includes(syntheticKey), false);
      assert.equal(result.stderr.includes(syntheticEncryptionKey), false);
      assert.equal(
        result.stderr.includes('synthetic-provider-private-diagnostic'),
        false,
      );
      const calls = await readFile(setup.evidence, 'utf8').catch(() => '');
      assert.equal(calls.includes('deploy'), false);
      assert.deepEqual(await readdir(setup.temporary), []);
    }
  } finally {
    await rm(setup.directory, { recursive: true, force: true });
  }
});

for (const phase of ['list', 'deploy']) {
  void test(
    `cancelling existing-secret ${phase} stops the entire process group`,
    { timeout: 15000 },
    async () => {
      const setup = await fixture();
      const env: NodeJS.ProcessEnv = {
        ...setup.env,
        FIXTURE_PRESERVE: 'true',
        FIXTURE_PRESERVE_WAIT: phase,
      };
      delete env.OPENAI_API_KEY;
      // emDash declares this key required globally; this fixture deliberately removes it.
      Reflect.deleteProperty(env, 'EMDASH_ENCRYPTION_KEY');
      const deployment = launch(
        env,
        setup.directory,
        [],
        ['--preserve-existing-secrets'],
      );
      try {
        let evidence: unknown;
        for (let attempt = 0; attempt < 500; attempt++) {
          try {
            evidence = JSON.parse(await readFile(setup.evidence, 'utf8'));
            break;
          } catch {
            await setTimeout(10);
          }
        }
        assert.ok(evidence && typeof evidence === 'object');
        assert.ok('pid' in evidence && typeof evidence.pid === 'number');
        assert.ok(
          'descendant' in evidence && typeof evidence.descendant === 'number',
        );
        deployment.child.kill('SIGTERM');
        const result = await deployment.completed;
        assert.equal(result.code, null);
        assert.equal(result.signal, 'SIGTERM');
        assert.equal(result.stdout, '');
        assert.equal(result.stderr.includes(syntheticKey), false);
        assert.equal(result.stderr.includes(syntheticEncryptionKey), false);
        await assertStopped(evidence.pid);
        await assertStopped(evidence.descendant);
        assert.deepEqual(await readdir(setup.temporary), []);
      } finally {
        deployment.child.kill('SIGTERM');
        await deployment.completed;
        await rm(setup.directory, { recursive: true, force: true });
      }
    },
  );
}
