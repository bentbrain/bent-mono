import { spawn } from 'node:child_process';
import { resolvePluginEncryptionKeys } from 'emdash';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Called only by Deploy, after require-checks verifies the checked-out SHA.
let directory;
let child;
let childClosed = false;
let interrupted;
let killTimer;
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const processGroup = process.platform !== 'win32';

function stopChild(signal) {
  if (!child?.pid) return;
  try {
    // Bun starts Wrangler as a descendant. Cancel the entire deployment.
    if (processGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    if (processGroup && error.code === 'EPERM') {
      // A reaped group can disappear while the kernel resolves the signal.
      // Ignore the race only when a fresh probe confirms no group remains.
      try {
        process.kill(-child.pid, 0);
      } catch (probe) {
        if (probe.code === 'ESRCH') return;
      }
    }
    throw error;
  }
}

async function stopClosedChild() {
  const deadline = performance.now() + 250;
  for (;;) {
    try {
      stopChild('SIGKILL');
      return;
    } catch (error) {
      // macOS can briefly retain an exited process group. Reconcile only after
      // close; a live or persistently inaccessible group remains a failure.
      if (
        !processGroup ||
        !childClosed ||
        error.code !== 'EPERM' ||
        performance.now() >= deadline
      )
        throw error;
      await delay(10);
    }
  }
}

function interrupt(signal) {
  interrupted ??= signal;
  stopChild(signal);
  killTimer ??= setTimeout(() => stopChild('SIGKILL'), 5000);
}

for (const signal of signals) process.on(signal, interrupt);

async function writeSecrets() {
  const key = process.env.OPENAI_API_KEY?.trim();
  const encryptionKey = process.env.EMDASH_ENCRYPTION_KEY?.trim();
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMDASH_ENCRYPTION_KEY;
  if (!key) throw new Error('OPENAI_API_KEY GitHub Actions secret is required');
  if (!encryptionKey)
    throw new Error('EMDASH_ENCRYPTION_KEY GitHub Actions secret is required');
  const encryptionKeys = await resolvePluginEncryptionKeys({
    EMDASH_ENCRYPTION_KEY: encryptionKey,
  });
  if (!encryptionKeys?.length)
    throw new Error(
      'EMDASH_ENCRYPTION_KEY must contain at least one encryption key',
    );

  const temporary = realpathSync(tmpdir());
  const repository = realpathSync(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const location = relative(repository, temporary);
  if (
    location === '' ||
    (!isAbsolute(location) &&
      !location.startsWith(`..${sep}`) &&
      location !== '..')
  ) {
    throw new Error(
      'Deployment secrets require a temporary directory outside the repository',
    );
  }

  // A Node child pipe cannot be reopened as /dev/stdin on Linux. Wrangler
  // requires a real path; keep it private and alive until the child finishes.
  directory = mkdtempSync(join(temporary, 'jp-deploy-secrets-'));
  chmodSync(directory, 0o700);
  const file = join(directory, 'secrets.json');
  const descriptor = openSync(file, 'wx', 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(
      descriptor,
      JSON.stringify({
        OPENAI_API_KEY: key,
        EMDASH_ENCRYPTION_KEY: encryptionKey,
      }),
    );
  } finally {
    closeSync(descriptor);
  }
  return file;
}

async function runWrangler(args, capture = false) {
  if (interrupted) throw new Error('Deployment cancelled before startup');
  childClosed = false;
  child = spawn('bun', ['x', 'wrangler', ...args], {
    stdio: [
      'ignore',
      capture ? 'pipe' : 'inherit',
      capture ? 'pipe' : 'inherit',
    ],
    env: process.env,
    detached: processGroup,
  });
  let output = '';
  if (capture) {
    child.stdout.setEncoding('utf8').on('data', (part) => {
      output += part;
      if (output.length > 1024 * 1024) interrupt('SIGTERM');
    });
    // Provider diagnostics can contain account information. Do not echo them.
    child.stderr.resume();
  }
  const result = await new Promise((resolve) => {
    child.once('error', () => resolve({ code: 1 }));
    child.once('close', (code, signal) => {
      childClosed = true;
      resolve({ code: code ?? 1, signal });
    });
  });
  await stopClosedChild();
  child = undefined;
  if (capture && (result.code !== 0 || result.signal || interrupted))
    throw new Error('Unable to verify existing Worker secret names');
  return { ...result, output };
}

async function verifyExistingSecrets() {
  // Preservation is explicit. Supplying replacement values at the same time is
  // ambiguous and must never rotate an existing encryption key accidentally.
  const supplied = [
    process.env.OPENAI_API_KEY,
    process.env.EMDASH_ENCRYPTION_KEY,
  ].some((value) => value !== undefined);
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMDASH_ENCRYPTION_KEY;
  if (supplied)
    throw new Error(
      'Existing-secret mode does not accept replacement secret values',
    );
  const { output } = await runWrangler(
    ['secret', 'list', '--format', 'json'],
    true,
  );
  let names;
  try {
    const entries = JSON.parse(output);
    if (
      !Array.isArray(entries) ||
      entries.some(
        (entry) =>
          entry === null ||
          typeof entry !== 'object' ||
          typeof entry.name !== 'string' ||
          entry.type !== 'secret_text',
      )
    )
      throw new Error('Invalid secret metadata');
    names = new Set(entries.map((entry) => entry.name));
  } catch {
    throw new Error('Unable to verify existing Worker secret names');
  }
  for (const name of [
    'EMDASH_ENCRYPTION_KEY',
    'OPENAI_API_KEY',
    'OWNER_EMAIL',
  ]) {
    if (!names.has(name))
      throw new Error(`Existing Worker secret ${name} is required`);
  }
}

let outcome;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--preserve-existing-secrets') {
    await verifyExistingSecrets();
    outcome = await runWrangler(['deploy']);
  } else if (args.length === 0) {
    const file = await writeSecrets();
    outcome = await runWrangler(['deploy', '--secrets-file', file]);
  } else {
    throw new Error('Use no arguments or --preserve-existing-secrets');
  }
} catch (error) {
  // Setup errors contain no secret values. Child startup errors use code 1.
  console.error(error.message);
  outcome = { code: 1 };
} finally {
  clearTimeout(killTimer);
  try {
    await stopClosedChild();
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
    for (const signal of signals) process.off(signal, interrupt);
  }
}

const signal = interrupted ?? outcome.signal;
if (signal) process.kill(process.pid, signal);
else process.exitCode = outcome.code;
