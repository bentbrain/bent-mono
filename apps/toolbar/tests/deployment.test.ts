import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseToolbar } from '../scripts/deploy-production.js';
import { toolbarReleaseSource } from '../scripts/release-guard.js';
import { maintainRuntimeAuth } from '../scripts/runtime-auth.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

void test('release CLIs reject unsupported flags before qualification or platform access', async () => {
  for (const { script, flag, message } of [
    { script: 'deploy-production.ts', flag: '--dry-run', message: /accepts no command arguments/ },
    { script: 'publish-assets.ts', flag: '--dry-run', message: /accepts no command arguments/ },
    { script: 'configure-auth.ts', flag: '--chec', message: /Unsupported authentication/ },
    { script: 'deploy-vercel.ts', flag: '--dry-ru', message: /Unsupported frontend/ },
  ]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        '--import',
        import.meta.resolve('tsx'),
        `scripts/${script}`,
        flag,
      ]),
      message,
    );
  }
});

const sha = '7'.repeat(40);
const eventEnvironment = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'bentbrain/bent-mono',
  GITHUB_REF: 'refs/heads/main',
  RELEASE_SHA: sha,
};
void test('Toolbar adapters accept real supported release events and reject forged legacy push mode', () => {
  for (const event of ['workflow_dispatch', 'workflow_run'])
    assert.equal(toolbarReleaseSource({ ...eventEnvironment, GITHUB_EVENT_NAME: event }), sha);
  for (const environment of [
    { ...eventEnvironment, GITHUB_EVENT_NAME: 'push' },
    { ...eventEnvironment, GITHUB_EVENT_NAME: 'pull_request' },
    { ...eventEnvironment, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/topic' },
    { ...eventEnvironment, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_SHA: 'main' },
    { ...eventEnvironment, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'fixture/other' },
    { ...eventEnvironment, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTIONS: 'false' },
  ])
    assert.throws(() => toolbarReleaseSource(environment));
});

const phases = [
  'preflight',
  'build',
  'archive',
  'migrate',
  'authentication',
  'frontend',
  'worker',
  'health',
];
function operations(calls: string[], fail?: string) {
  const phase = (name: string) => () => {
    calls.push(name);
    return fail === name
      ? Promise.reject(new Error(`Synthetic ${name} failure`))
      : Promise.resolve();
  };
  return {
    qualify: phase('qualify'),
    preflight: phase('preflight'),
    build: phase('build'),
    archive: phase('archive'),
    migrate: phase('migrate'),
    authentication: phase('authentication'),
    frontend: phase('frontend'),
    worker: phase('worker'),
    health: phase('health'),
  };
}
void test('Toolbar releases retain and verify frontend assets before Worker activation with fresh guards', async () => {
  const calls: string[] = [];
  await releaseToolbar(operations(calls));
  assert.deepEqual(calls, [
    'qualify',
    'preflight',
    'build',
    'qualify',
    'archive',
    'qualify',
    'migrate',
    'qualify',
    'authentication',
    'qualify',
    'frontend',
    'qualify',
    'worker',
    'health',
  ]);
});
for (const failure of phases) {
  void test(`${failure} failure blocks every later Toolbar release phase`, async () => {
    const calls: string[] = [];
    await assert.rejects(releaseToolbar(operations(calls, failure)), /Synthetic/);
    assert.equal(calls.at(-1), failure);
    for (const later of phases.slice(phases.indexOf(failure) + 1))
      assert.ok(!calls.includes(later));
  });
}
void test('changed qualification blocks the next mutation after a successful build', async () => {
  const calls: string[] = [];
  const actions = operations(calls);
  let attempts = 0;
  actions.qualify = () => {
    attempts++;
    return attempts === 1 ? Promise.resolve() : Promise.reject(new Error('Main changed'));
  };
  await assert.rejects(releaseToolbar(actions), /Main changed/);
  assert.deepEqual(calls, ['preflight', 'build']);
});

const auth = {
  FEEDBACK_PROXY_SECRET: 'synthetic-proxy-secret-'.repeat(3),
  BETTER_AUTH_SECRET: 'synthetic-session-secret-'.repeat(3),
  AUTH_GITHUB_CLIENT_ID: 'synthetic-client',
  AUTH_GITHUB_CLIENT_SECRET: 'synthetic-oauth-secret',
};
const secretNames = Object.keys(auth).map((name) => ({ name, type: 'secret_text' }));
void test('preserving runtime secrets checks names and the real shared-key contract without writing', async () => {
  const calls: string[] = [];
  await maintainRuntimeAuth(
    {
      TOOLBAR_PRESERVE_RUNTIME_SECRETS: 'true',
      FEEDBACK_PROXY_SECRET: auth.FEEDBACK_PROXY_SECRET,
    },
    {
      qualify: () => {
        calls.push('qualify');
        return Promise.resolve();
      },
      list: () => {
        calls.push('list');
        return Promise.resolve(secretNames);
      },
      verifyProxy: (secret) => {
        assert.equal(secret, auth.FEEDBACK_PROXY_SECRET);
        calls.push('verifyProxy');
        return Promise.resolve();
      },
      write: () => {
        throw new Error('Preserve mode must never write');
      },
    },
  );
  assert.deepEqual(calls, ['qualify', 'list', 'verifyProxy']);
});
for (const bindings of [
  secretNames.slice(1),
  [...secretNames, secretNames[0]],
  secretNames.map((binding) => ({ ...binding, type: 'plain_text' })),
]) {
  void test('missing, duplicate or incorrect secret metadata blocks preservation', async () => {
    await assert.rejects(
      maintainRuntimeAuth(
        { ...auth, TOOLBAR_PRESERVE_RUNTIME_SECRETS: 'true' },
        {
          qualify: () => Promise.resolve(),
          list: () => Promise.resolve(bindings),
          verifyProxy: () => {
            throw new Error('Invalid metadata must fail before proxy check');
          },
          write: () => {
            throw new Error('Invalid metadata must never write');
          },
        },
      ),
    );
  });
}
void test('a mismatched preserved proxy key cannot advance authentication', async () => {
  await assert.rejects(
    maintainRuntimeAuth(
      { ...auth, TOOLBAR_PRESERVE_RUNTIME_SECRETS: 'true' },
      {
        qualify: () => Promise.resolve(),
        list: () => Promise.resolve(secretNames),
        verifyProxy: () => Promise.reject(new Error('Shared key mismatch')),
        write: () => {
          throw new Error('Preserve mode must never write');
        },
      },
    ),
    /Shared key mismatch/,
  );
});
void test('supplied-secret mode retains validation, fresh qualification and non-mutating preflight', async () => {
  let writes = 0;
  let qualifications = 0;
  const actions = {
    qualify: () => {
      qualifications++;
      return Promise.resolve();
    },
    list: () => {
      throw new Error('Supplied mode does not list secrets');
    },
    verifyProxy: () => {
      throw new Error('Supplied mode is explicitly configured');
    },
    write: (configuration: typeof auth) => {
      assert.deepEqual(configuration, auth);
      writes++;
      return Promise.resolve();
    },
  };
  await maintainRuntimeAuth(auth, actions, { checkOnly: true });
  assert.equal(writes, 0);
  assert.equal(qualifications, 1);
  await maintainRuntimeAuth(auth, actions);
  assert.equal(writes, 1);
  assert.equal(qualifications, 3);
  await assert.rejects(maintainRuntimeAuth({}, actions), /Configure all/);
  await assert.rejects(
    maintainRuntimeAuth({ ...auth, TOOLBAR_PRESERVE_RUNTIME_SECRETS: 'yes' }, actions),
    /true or false/,
  );
  assert.equal(writes, 1);
});

void test('a changed qualification prevents supplied authentication values from being written', async () => {
  let attempts = 0;
  let writes = 0;
  await assert.rejects(
    maintainRuntimeAuth(auth, {
      qualify: () =>
        ++attempts === 1 ? Promise.resolve() : Promise.reject(new Error('Main changed')),
      list: () => Promise.resolve([]),
      verifyProxy: () => Promise.resolve(),
      write: () => {
        writes++;
        return Promise.resolve();
      },
    }),
    /Main changed/,
  );
  assert.equal(writes, 0);
});
