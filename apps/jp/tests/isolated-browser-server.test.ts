import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { startIsolatedBrowserServer } from './fixtures/isolated-browser-server';

const processSchema = z.object({
  pid: z.number(),
  descendant: z.number().optional(),
});

async function bounded<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Cleanup exceeded test bound'));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check: () => boolean | Promise<boolean>) {
  await bounded(
    (async () => {
      while (!(await check())) await delay(10);
    })(),
  );
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
      return false;
    throw error;
  }
}

const stubborn =
  "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); process.send('ready')\"],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>{fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,descendant:child.pid})); console.log('synthetic descendant ready');}); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);";

async function fixture(markerName = 'process.json') {
  const directory = await mkdtemp(join(tmpdir(), 'japan-runtime-control-'));
  const roots = join(directory, 'roots');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(roots);
  const marker = join(directory, markerName);
  const log = join(directory, 'runtime.log');
  const normal =
    "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid})); console.log('synthetic server started'); setInterval(() => {}, 1000);";
  const options = {
    temporaryDirectory: roots,
    inputs: [],
    installCommand: {
      file: process.execPath,
      args: ['-e', "console.log('synthetic install completed')"],
    },
    serverCommand: { file: process.execPath, args: ['-e', normal, marker] },
    startupTimeoutMs: 1_000,
    installTimeoutMs: 400,
    terminationGraceMs: 100,
    killTimeoutMs: 1_000,
    healthCheck: async () => {
      await until(
        async () => (await readFile(marker, 'utf8').catch(() => '')) !== '',
      );
      return true;
    },
  };
  async function processes() {
    return processSchema.parse(JSON.parse(await readFile(marker, 'utf8')));
  }
  async function clean() {
    assert.deepEqual(
      await readdir(roots),
      [],
      'temporary runtime root must be removed',
    );
    const record = await processes();
    assert.equal(alive(record.pid), false, 'owned parent must be absent');
    assert.equal(
      alive(-record.pid),
      false,
      'owned process group must be absent',
    );
    if (record.descendant)
      assert.equal(
        alive(record.descendant),
        false,
        'owned descendant must be absent',
      );
    assert.match(await readFile(log, 'utf8'), /synthetic/);
  }
  async function dispose() {
    // Emergency cleanup also makes the intentionally red historical controls safe.
    const record = await processes().catch(() => undefined);
    if (record) {
      for (const pid of [-record.pid, record.descendant, record.pid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ESRCH'
          ))
            throw error;
        }
      }
      await until(
        () =>
          !alive(record.pid) &&
          (!record.descendant || !alive(record.descendant)),
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
  return { directory, roots, marker, log, options, processes, clean, dispose };
}

void test('hung dependency installation reaches its deadline and removes owned work', async () => {
  const f = await fixture();
  const runtime = startIsolatedBrowserServer(f.log, {
    ...f.options,
    installCommand: f.options.serverCommand,
  });
  const result = assert.rejects(runtime.ready, /installation.*timed out/i);
  try {
    await bounded(result);
    await f.clean();
  } finally {
    await f.dispose();
  }
});

void test('failure after server spawn preserves the log and cleans the process group', async () => {
  const f = await fixture();
  const runtime = startIsolatedBrowserServer(f.log, {
    ...f.options,
    healthCheck: async () => {
      await f.options.healthCheck();
      throw new Error('synthetic health setup failure');
    },
  });
  try {
    await bounded(
      assert.rejects(runtime.ready, /synthetic health setup failure/),
    );
    await f.clean();
  } finally {
    await f.dispose();
  }
});

void test('owner can cancel before health resolves without awaiting startup', async () => {
  const f = await fixture();
  let checking = false;
  const runtime = startIsolatedBrowserServer(f.log, {
    ...f.options,
    healthCheck: async () => {
      await f.options.healthCheck();
      checking = true;
      return new Promise<boolean>(() => {});
    },
  });
  const result = assert.rejects(runtime.ready, /stopped/i);
  try {
    await until(() => checking);
    await bounded(Promise.all([runtime.stop(), runtime.stop()]));
    await bounded(result);
    await f.clean();
  } finally {
    await f.dispose();
  }
});

void test('copy failure waits for the other in-flight copies before removing the root', async () => {
  const f = await fixture();
  let copying = false;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = join(f.directory, 'source');
  await writeFile(source, 'synthetic copy');
  const runtime = startIsolatedBrowserServer(f.log, {
    ...f.options,
    inputs: ['failure', 'pending'],
    copyInput: async (from: string, to: string) => {
      if (from.endsWith('/failure')) throw new Error('synthetic copy failure');
      copying = true;
      await pending;
      await cp(source, to);
    },
  });
  const result = assert.rejects(runtime.ready, /synthetic copy failure/);
  try {
    await until(() => copying);
    await delay(50);
    assert.equal(
      (await readdir(f.roots)).length,
      1,
      'root must survive until pending copy settles',
    );
    release?.();
    await bounded(result);
    await runtime.stop();
    assert.deepEqual(await readdir(f.roots), []);
    assert.match(await readFile(f.log, 'utf8'), /synthetic copy failure/);
  } finally {
    release?.();
    await f.dispose();
  }
});

void test('teardown kills a same-group descendant after its parent exits on SIGTERM', async () => {
  const f = await fixture();
  const runtime = startIsolatedBrowserServer(f.log, {
    ...f.options,
    serverCommand: { file: process.execPath, args: ['-e', stubborn, f.marker] },
  });
  try {
    await bounded(runtime.ready);
    const record = await f.processes();
    assert.ok(record.descendant);
    assert.equal(alive(record.descendant), true);
    await bounded(runtime.stop());
    await f.clean();
  } finally {
    await f.dispose();
  }
});

void test('normal startup and idempotent teardown preserve diagnostics', async () => {
  const f = await fixture();
  const runtime = startIsolatedBrowserServer(f.log, f.options);
  try {
    const { baseURL } = await bounded(runtime.ready);
    assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+$/);
    await bounded(Promise.all([runtime.stop(), runtime.stop()]));
    await f.clean();
    await runtime.stop();
  } finally {
    await f.dispose();
  }
});

void test('marker paths stay runtime data for normal and descendant servers', async () => {
  const markerName = 'marker \'"`\\;${process.exit(91)}\n\u2028\u2029.json';
  for (const withDescendant of [false, true]) {
    const f = await fixture(markerName);
    const runtime = startIsolatedBrowserServer(f.log, {
      ...f.options,
      serverCommand: withDescendant
        ? { file: process.execPath, args: ['-e', stubborn, f.marker] }
        : f.options.serverCommand,
    });
    try {
      await bounded(runtime.ready);
      const record = await f.processes();
      assert.equal(alive(record.pid), true);
      if (withDescendant) {
        assert.ok(record.descendant);
        assert.equal(alive(record.descendant), true);
      }
      await bounded(runtime.stop());
      await f.clean();
    } finally {
      await f.dispose();
    }
  }
});

void test('monorepo fixture copies manifests, patched sources and shared packages without source caches', async () => {
  const f = await fixture();
  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  const sourcePaths: string[] = [];
  const runtime = startIsolatedBrowserServer(f.log, {
    ...f.options,
    inputs: undefined,
    configFile: 'tests/fixtures/map-library.config.mjs',
    additionalInputs: [
      'tests/fixtures/map-library.config.mjs',
      'tests/fixtures/map-library-endpoint.ts',
    ],
    copyInput: async (from, to) => {
      sourcePaths.push(relative(repository, from));
      await mkdir(dirname(to), { recursive: true });
      // The synthetic server needs no copied bytes. Exercise real path selection
      // while the existing lifecycle controls own disposable process groups.
      await writeFile(to, 'synthetic source copy');
    },
  });
  try {
    await bounded(runtime.ready);
    assert.ok(sourcePaths.includes('package.json'));
    assert.ok(sourcePaths.includes('bun.lock'));
    assert.ok(sourcePaths.includes('bunfig.toml'));
    assert.ok(sourcePaths.includes('apps/jp/src'));
    assert.ok(
      sourcePaths.includes('apps/jp/tests/fixtures/map-library.config.mjs'),
    );
    assert.ok(
      sourcePaths.includes('apps/jp/tests/fixtures/map-library-endpoint.ts'),
    );
    const [runtimeName] = await readdir(f.roots);
    assert.ok(runtimeName);
    assert.match(
      await readFile(
        join(f.roots, runtimeName, 'apps/jp/grid.config.mjs'),
        'utf8',
      ),
      /map-library\.config\.mjs/,
    );
    assert.ok(sourcePaths.includes('apps/jp/package.json'));
    assert.ok(sourcePaths.includes('packages/ui/package.json'));
    assert.ok(sourcePaths.includes('packages/ui/src'));
    assert.ok(sourcePaths.includes('packages/ui/tsconfig.json'));
    assert.ok(sourcePaths.includes('packages/design-tokens/src'));
    assert.ok(sourcePaths.includes('apps/jp/patches/emdash@1.2.0.patch'));
    assert.ok(
      sourcePaths.some((path) => path.startsWith('products/shop/patches/')),
    );
    assert.ok(sourcePaths.includes('apps/stay/package.json'));
    assert.equal(new Set(sourcePaths).size, sourcePaths.length);
    assert.ok(
      sourcePaths.every(
        (path) =>
          !/(node_modules|\.astro|\.vite|\.env|pnpm-lock|pnpm-workspace)/.test(
            path,
          ),
      ),
    );
    assert.ok(
      sourcePaths
        .filter(
          (path) =>
            !path.startsWith('apps/jp/') &&
            !path.startsWith('packages/ui/') &&
            !path.startsWith('packages/design-tokens/'),
        )
        .every(
          (path) =>
            path === 'bun.lock' ||
            path === 'bunfig.toml' ||
            path.endsWith('/package.json') ||
            path === 'package.json' ||
            path.endsWith('.patch'),
        ),
    );
    await runtime.stop();
    await f.clean();
  } finally {
    await runtime.stop();
    await f.dispose();
  }
});
