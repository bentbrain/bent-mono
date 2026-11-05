import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const coreDist = dirname(require.resolve('emdash'));
const cloudflareDist = dirname(require.resolve('@emdash-cms/cloudflare'));

async function contentLock() {
  // Exercise the installed runtime bundle, including the pinned package patch.
  for (const name of await readdir(coreDist)) {
    if (!name.startsWith('registry-') || !name.endsWith('.mjs')) continue;
    const path = join(coreDist, name);
    const source = await readFile(path, 'utf8');
    const exported = /withContentUsageCollectionLock as ([\w$]+)/.exec(
      source,
    )?.[1];
    if (exported) return { path, exported };
  }
  throw new Error('Native content media-usage lock export required');
}

void test(
  'native media-usage locks retain request affinity, exclusion and progress in Workers',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'japan-media-lock-'));
    let worker: Unstable_DevWorker | undefined;
    try {
      const lock = await contentLock();
      const script = join(directory, 'worker.mjs');
      await writeFile(
        script,
        `
import { ${lock.exported} as withLock } from ${JSON.stringify(lock.path)};
import { createRequestScopedDb } from ${JSON.stringify(join(cloudflareDist, 'db/d1.mjs'))};
import { runWithContext, createRequestMetrics } from ${JSON.stringify(join(coreDist, 'request-context.mjs'))};
import { sql } from ${JSON.stringify(createRequire(require.resolve('emdash')).resolve('kysely'))};
let active=0, peak=0, entered=0, completed=0;
const received=[], order=[];
export default {
 async fetch(request) {
  const url=new URL(request.url);
  if(url.pathname==='/state') return Response.json({active,peak,entered,completed,received,order});
  const id=url.searchParams.get('id') || 'synthetic';
  if(id.startsWith('queue-')) received.push(id);
  const scoped=createRequestScopedDb({config:{binding:'DB',session:'auto'},isAuthenticated:true,isWrite:true,cookies:{get(){},set(){}},url});
  if(!scoped) throw new Error('Native D1 session required');
  return runWithContext({db:scoped.db,editMode:false,metrics:createRequestMetrics(performance.now())},()=>
   withLock(url.searchParams.get('key') || 'shared',async()=>{
    active++;entered++;peak=Math.max(peak,active);
    if(id.startsWith('queue-')) order.push(id);
    try {
     await new Promise(resolve=>setTimeout(resolve,Number(url.searchParams.get('hold')) || 10));
     if(url.pathname==='/throw') throw new Error('Synthetic operation failure');
     const result=await sql\`SELECT \${id} AS request\`.execute(scoped.db);
     completed++;scoped.commit();
     return Response.json({matched:result.rows[0].request===id});
    } finally {active--;}
   })
  );
 }
};
`,
      );
      await writeFile(join(directory, 'config.mjs'), 'export default {};');
      await writeFile(
        join(directory, 'wait-until.mjs'),
        "export { waitUntil } from 'cloudflare:workers';",
      );
      const config = join(directory, 'wrangler.json');
      await writeFile(
        config,
        JSON.stringify({
          name: 'synthetic-media-usage-lock',
          main: script,
          compatibility_date: '2026-10-01',
          compatibility_flags: ['nodejs_compat'],
          observability: { enabled: true },
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'synthetic-media-usage-lock',
              database_id: '00000000-0000-0000-0000-000000000001',
            },
          ],
          alias: {
            emdash: join(coreDist, '../src/config/errors.ts'),
            'emdash/database/instrumentation': join(
              coreDist,
              'database/instrumentation.mjs',
            ),
            'emdash/internal/database/migration-lock': join(
              coreDist,
              'database/migration-lock.mjs',
            ),
            'virtual:emdash/config': join(directory, 'config.mjs'),
            'virtual:emdash/wait-until': join(directory, 'wait-until.mjs'),
          },
        }),
      );
      worker = await unstable_dev(script, {
        config,
        local: true,
        ip: '127.0.0.1',
        port: 0,
        inspectorPort: 0,
        persist: false,
        envFiles: [],
        logLevel: 'none',
        experimental: {
          forceLocal: true,
          disableExperimentalWarning: true,
          disableDevRegistry: true,
          showInteractiveDevSession: false,
          watch: false,
        },
      });
      const base = `http://${worker.address}:${String(worker.port)}`;
      async function run(path: string, signal = AbortSignal.timeout(5_000)) {
        const response = await fetch(base + path, { signal });
        assert.equal(response.status, 200);
        const body: unknown = await response.json();
        z.object({ matched: z.literal(true) }).parse(body);
      }
      // Eight requests passed on the broken implementation. At 609 successful
      // requests the shared promise chain consistently stranded its next 31 callers.
      for (let wave = 0; wave < 24; wave++)
        await Promise.all(
          Array.from({ length: 32 }, (_, index) =>
            run(`/?id=${String(wave)}-${String(index)}`),
          ),
        );
      const state = z.object({
        active: z.number(),
        peak: z.number(),
        entered: z.number(),
        completed: z.number(),
        received: z.array(z.string()),
        order: z.array(z.string()),
      });
      async function stats() {
        const body: unknown = await (await fetch(base + '/state')).json();
        return state.parse(body);
      }
      assert.deepEqual(await stats(), {
        active: 0,
        peak: 1,
        entered: 768,
        completed: 768,
        received: [],
        order: [],
      });
      const cancellation = new AbortController();
      const abandoned = run('/?id=abandoned&hold=200', cancellation.signal);
      const observed = assert.rejects(abandoned, { name: 'AbortError' });
      while ((await stats()).active === 0)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const waiting = run('/?id=waiting');
      cancellation.abort();
      await observed;
      await waiting;
      assert.equal((await stats()).peak, 1);
      // A disconnected queued request must retain its place and release its token.
      // Observe receipt before aborting so this exercises a waiter, not a request
      // cancelled before it reaches the Worker.
      async function received(id: string) {
        const deadline = Date.now() + 5_000;
        while (!(await stats()).received.includes(id)) {
          assert.ok(Date.now() < deadline, 'queued request reached the Worker');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      const beforeQueue = await stats();
      const head = run('/?id=queue-head&hold=500');
      await received('queue-head');
      const queuedCancellation = new AbortController();
      const queued = run('/?id=queue-cancelled', queuedCancellation.signal);
      const queuedAbort = assert.rejects(queued, { name: 'AbortError' });
      await received('queue-cancelled');
      const tail = run('/?id=queue-tail');
      await received('queue-tail');
      assert.deepEqual((await stats()).order, ['queue-head']);
      queuedCancellation.abort();
      await queuedAbort;
      await Promise.all([head, tail]);
      const afterQueue = await stats();
      assert.deepEqual(afterQueue.order, [
        'queue-head',
        'queue-cancelled',
        'queue-tail',
      ]);
      assert.equal(afterQueue.entered, beforeQueue.entered + 3);
      assert.equal(afterQueue.completed, beforeQueue.completed + 3);
      assert.equal(afterQueue.active, 0);
      assert.equal(afterQueue.peak, 1);
      const failure = await fetch(base + '/throw');
      assert.equal(failure.status, 500);
      await failure.arrayBuffer();
      await run('/?id=after-error');
      await Promise.all([
        run('/?id=first&key=first&hold=100'),
        run('/?id=second&key=second&hold=100'),
      ]);
      const final = await stats();
      assert.equal(final.active, 0);
      assert.equal(final.peak, 2);
    } finally {
      await worker?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
