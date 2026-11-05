import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const invoke = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const releaseShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

export function toolbarReleaseSource(environment: NodeJS.ProcessEnv) {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_REPOSITORY !== 'bentbrain/bent-mono' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    !['workflow_dispatch', 'workflow_run'].includes(environment.GITHUB_EVENT_NAME ?? '')
  )
    throw new Error('Toolbar releases require the protected canonical main pipeline.');
  return releaseShaSchema.parse(environment.RELEASE_SHA);
}

export async function requireToolbarRelease() {
  const sha = toolbarReleaseSource(process.env);
  // The shared gate validates the actual event file, clean checkout, current
  // main, authoritative Quality attempt and merged PR review/security evidence.
  await invoke(process.execPath, ['scripts/require-release-checks.mjs', '--sha', sha], {
    cwd: root,
    env: process.env,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return sha;
}
