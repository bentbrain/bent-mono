import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, sha256 } from '../data.mjs';
import { fixtureEnvironment } from './fixtures.mjs';

const executable = fileURLToPath(new URL('../controller.mjs', import.meta.url));
export async function cli(fixture, origin, { command = 'advance', extra = [], env = {}, timeoutMs = 15000 } = {}) {
  const args = [executable, command, '--bundle', fixture.bundle, '--manifest', fixture.manifest, '--trust', fixture.trustPath,
    '--journal', fixture.journal, '--provider', origin, ...extra];
  const startedAt = Date.now();
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { env: { ...fixtureEnvironment(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(timeout); accept({ code, signal, stdout, stderr }); });
  });
  const evidence = { schema: 'shop.actual-cli-invocation/v1', executable: process.execPath, executableDigest: sha256(await readFile(process.execPath)), args,
    startedAt, finishedAt: Date.now(), ...result };
  const directory = join(fixture.directory, 'invocations'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${startedAt}-${randomUUID()}.json`), canonical(evidence), { mode: 0o600 });
  return result;
}
