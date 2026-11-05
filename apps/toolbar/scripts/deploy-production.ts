import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { originSchema } from '../src/shared/models.js';
import { requireToolbarRelease, toolbarReleaseSource } from './release-guard.js';
import { validateRuntimeAuthInput } from './runtime-auth.js';

type Phase = () => Promise<unknown>;
export async function releaseToolbar(operations: {
  qualify: Phase;
  preflight: Phase;
  build: Phase;
  archive: Phase;
  migrate: Phase;
  authentication: Phase;
  frontend: Phase;
  worker: Phase;
  health: Phase;
}) {
  await operations.qualify();
  await operations.preflight();
  await operations.build();
  // Every platform mutation rechecks the exact source and release qualification.
  for (const phase of [
    operations.archive,
    operations.migrate,
    operations.authentication,
    operations.frontend,
    operations.worker,
  ]) {
    await operations.qualify();
    await phase();
  }
  await operations.health();
}

const directory = fileURLToPath(new URL('../', import.meta.url));
const privateNames = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'VERCEL_TOKEN',
  'FEEDBACK_PROXY_SECRET',
  'BETTER_AUTH_SECRET',
  'AUTH_GITHUB_CLIENT_SECRET',
  'AUTH_GITHUB_CLIENT_ID',
  'TOOLBAR_LEGACY_ARCHIVE_TOKEN',
  'TOOLBAR_LEGACY_ARCHIVE_REPOSITORY',
  'TOOLBAR_MIGRATED_ARCHIVE_JSON',
];
function commandEnvironment(sha: string, permitted: string[]) {
  return Object.fromEntries(
    Object.entries({ ...process.env, GITHUB_SHA: sha }).filter(
      ([name]) => !privateNames.includes(name) || permitted.includes(name),
    ),
  );
}
async function run(sha: string, args: string[], permitted: string[] = [], command = 'bun') {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: commandEnvironment(sha, permitted),
      stdio: 'inherit',
    });
    child.once('error', () => {
      reject(new Error('Toolbar release command could not start.'));
    });
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error('Toolbar release command failed; later phases were not run.'));
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2)
    throw new Error('Toolbar production release accepts no command arguments.');
  const sha = toolbarReleaseSource(process.env);
  const auth = [
    'GH_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'FEEDBACK_PROXY_SECRET',
    'BETTER_AUTH_SECRET',
    'AUTH_GITHUB_CLIENT_SECRET',
    'AUTH_GITHUB_CLIENT_ID',
  ];
  await releaseToolbar({
    qualify: requireToolbarRelease,
    preflight: async () => {
      z.object({
        CLOUDFLARE_API_TOKEN: z.string().min(1),
        VERCEL_TOKEN: z.string().min(1),
        VERCEL_ORG_ID: z.string().startsWith('team_'),
        VERCEL_PROJECT_ID: z.string().startsWith('prj_'),
      }).parse(process.env);
      if (originSchema.parse(process.env.FEEDBACK_URL) !== 'https://toolbar.bent.build')
        throw new Error('Toolbar release must preserve its canonical production origin.');
      if (new URL(originSchema.parse(process.env.FEEDBACK_API_ORIGIN)).protocol !== 'https:')
        throw new Error('Toolbar production API requires HTTPS.');
      validateRuntimeAuthInput(process.env);
      await run(
        sha,
        ['--import', 'tsx', 'scripts/configure-auth.ts', '--check'],
        auth,
        process.execPath,
      );
    },
    build: async () => {
      await run(sha, ['run', 'build']);
      await run(
        sha,
        ['run', 'build:vercel', '--retain-active'],
        [
          'GH_TOKEN',
          'TOOLBAR_LEGACY_ARCHIVE_TOKEN',
          'TOOLBAR_LEGACY_ARCHIVE_REPOSITORY',
          'TOOLBAR_MIGRATED_ARCHIVE_JSON',
        ],
      );
    },
    archive: () =>
      run(sha, ['--import', 'tsx', 'scripts/publish-assets.ts'], ['GH_TOKEN'], process.execPath),
    migrate: () => run(sha, ['run', 'db:migrate'], ['CLOUDFLARE_API_TOKEN']),
    authentication: () =>
      run(sha, ['--import', 'tsx', 'scripts/configure-auth.ts'], auth, process.execPath),
    frontend: () =>
      run(sha, ['run', 'deploy:vercel'], ['GH_TOKEN', 'VERCEL_TOKEN', 'FEEDBACK_PROXY_SECRET']),
    worker: () =>
      run(sha, ['run', 'deploy:worker', '--var', `ASSET_VERSION:${sha}`], ['CLOUDFLARE_API_TOKEN']),
    health: async () => {
      const origin = originSchema.parse(process.env.FEEDBACK_URL);
      const response = await fetch(`${origin}/health`, {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('Toolbar production health failed.');
      const health = z.object({
        ok: z.literal(true),
        assetVersion: z.literal(sha),
        serviceOrigin: z.literal(origin),
      });
      health.parse(await response.json());
      console.log('Toolbar production release and canonical origin verified.');
    },
  });
}
