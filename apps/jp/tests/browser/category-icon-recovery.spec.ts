import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { encode } from 'fast-png';
import { z } from 'zod';
import { getPlatformProxy } from 'wrangler';
import type { PlatformProxy } from 'wrangler';
import type { IconEnvironment } from '../../src/lib/category-icon-jobs';
import {
  ownerIconStatuses,
  retryCategoryIcon,
  runCategoryIconJobs,
} from '../../src/lib/category-icon-jobs';
import { iconModel } from '../../src/lib/category-icons';
import {
  categoryIconStatusResponse,
  categoryIconRetryResponse,
  iconProviderStatusResponse,
  iconProviderResumeResponse,
} from '../../src/lib/category-icon-api';

// Browser requests use the production API response functions over actual local
// D1. Only the external image provider is replaced. Native route auth and CSRF
// are exercised separately by the full HTTP integration suite.
let platform: PlatformProxy<IconEnvironment> | undefined;
let temporaryDirectory: string | undefined;
function env(): IconEnvironment {
  assert.ok(platform);
  return {
    ...platform.env,
    OPENAI_API_KEY: 'synthetic-fixture-key',
    CATEGORY_ICON_MODEL: iconModel,
  };
}
const now = Date.now();
function readyBytes() {
  const data = new Uint8Array(32 * 32 * 4);
  for (let y = 12; y < 20; y++)
    for (let x = 12; x < 20; x++) data[(y * 32 + x) * 4 + 3] = 255;
  return encode({ width: 32, height: 32, depth: 8, channels: 4, data });
}
async function save(names: string[], id: string = crypto.randomUUID()) {
  await env()
    .DB.prepare('INSERT INTO ec_media_items(id,categories) VALUES(?,?)')
    .bind(id, JSON.stringify(names))
    .run();
}
async function jobRows() {
  return (
    await env()
      .DB.prepare(
        'SELECT id,status,generation,attempts FROM jp_icon_jobs ORDER BY id',
      )
      .all()
  ).results;
}
async function requests(page: Page, names: () => string[]) {
  await page.route('**/api/trip/category-icons**', async (route) => {
    const source = route.request();
    const request = new Request(source.url(), {
      method: source.method(),
      headers: source.headers(),
      body: source.method() === 'GET' ? undefined : source.postData(),
    });
    let response: Response;
    if (new URL(source.url()).pathname.endsWith('/provider'))
      response =
        source.method() === 'GET'
          ? await iconProviderStatusResponse(env())
          : await iconProviderResumeResponse(env(), request);
    else
      response =
        source.method() === 'GET'
          ? await categoryIconStatusResponse(env(), names())
          : await categoryIconRetryResponse(env(), request, () =>
              Promise.resolve(names()),
            );
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
}

test.beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'icon-recovery-browser-'));
  const configPath = join(temporaryDirectory, 'wrangler.json');
  await writeFile(
    join(temporaryDirectory, 'worker.js'),
    'export default {fetch(){return new Response("synthetic fixture")}}',
  );
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'icon-recovery-browser',
      main: 'worker.js',
      compatibility_date: '2026-10-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'icon-recovery-browser',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
      r2_buckets: [{ binding: 'MEDIA', bucket_name: 'icon-recovery-browser' }],
    }),
  );
  platform = await getPlatformProxy<IconEnvironment>({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  await env().DB.batch([
    env().DB.prepare(
      'CREATE TABLE media(id TEXT PRIMARY KEY,storage_key TEXT)',
    ),
    env().DB.prepare('CREATE TABLE revisions(id TEXT PRIMARY KEY,data TEXT)'),
    env().DB.prepare(
      "CREATE TABLE ec_media_items(id TEXT PRIMARY KEY,categories TEXT,draft_revision_id TEXT,status TEXT DEFAULT 'draft',deleted_at TEXT)",
    ),
  ]);
  const sql = (
    await Promise.all(
      ['0001_category_icons.sql', '0002_icon_library.sql'].map((file) =>
        readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n--> statement-breakpoint\n');
  await env().DB.batch(
    sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim())
      .filter(Boolean)
      .map((statement) => env().DB.prepare(statement)),
  );
});
async function disposeIconFixture(page: Page) {
  try {
    await page.unrouteAll({ behavior: 'wait' });
  } finally {
    await platform?.dispose();
    platform = undefined;
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
test.afterEach(async ({ page }) => {
  await disposeIconFixture(page);
});

for (const scenario of ['removed', 'capped']) {
  test(`owner can resume queued icons after the ${scenario} configuration category cannot be retried`, async ({
    page,
  }) => {
    await save(['configuration fixture'], 'configuration-fixture');
    const generations = scenario === 'capped' ? 3 : 1;
    for (let generation = 1; generation <= generations; generation++) {
      await runCategoryIconJobs(env(), {
        now: () => now + generation,
        generate: () => Promise.resolve({ status: 'blocked_configuration' }),
      });
      if (generation < generations)
        assert.equal(
          await retryCategoryIcon(
            env(),
            'configuration fixture',
            false,
            now + generation + 1,
          ),
          true,
        );
    }
    if (scenario === 'removed')
      await env()
        .DB.prepare(
          "DELETE FROM ec_media_items WHERE id='configuration-fixture'",
        )
        .run();
    await save(['queued fixture']);
    await runCategoryIconJobs(env(), {
      now: () => now + 10,
      generate: () => {
        throw new Error('paused provider must not dispatch');
      },
    });
    const before = await jobRows();
    const names =
      scenario === 'removed'
        ? ['queued fixture']
        : ['configuration fixture', 'queued fixture'];
    await requests(page, () => names);
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
    await page.waitForURL('**/owner/media');
    const service = page.getByRole('region', {
      name: 'Icon generation service',
    });
    await expect(service).toContainText('may incur charges');
    await expect(page.locator('#metadata')).toHaveCount(0);
    await service
      .getByRole('button', { name: 'RESUME QUEUED ICONS', exact: true })
      .click();
    await expect(service).toContainText('icon generation resumed');
    expect(await jobRows()).toEqual(before);
    let calls = 0;
    await runCategoryIconJobs(env(), {
      now: () => now + 20,
      generate: () => {
        calls++;
        return Promise.resolve({ status: 'failed' });
      },
    });
    expect(calls).toBe(1);
    const [status] = await ownerIconStatuses(env(), ['configuration fixture']);
    expect(status?.canRetry).toBe(scenario !== 'capped');
    expect(
      (await jobRows()).filter((row) => row.status === 'configuration'),
    ).toHaveLength(generations);
  });
}

for (const outcome of ['failed', 'ready', 'uncertain']) {
  test(`acknowledged unknown then ${outcome} uses the offered retry through the real D1 API chain`, async ({
    page,
    baseURL,
  }) => {
    const name = `recovery ${outcome}`;
    await save([name]);
    await runCategoryIconJobs(env(), {
      now: () => now,
      generate: () => Promise.resolve({ status: 'uncertain' }),
    });
    await page.goto('/_emdash/api/auth/dev-bypass?redirect=/owner/media');
    await page.waitForURL('**/owner/media');
    const created = await page.request.post(
      '/_emdash/api/content/media_items',
      {
        headers: { Origin: baseURL || '', 'X-EmDash-Request': '1' },
        data: {
          slug: crypto.randomUUID(),
          data: {
            title: `synthetic ${name}`,
            kind: 'photo',
            categories: [name],
            place: 'synthetic fixture',
            source_url: '/demo/japan.jpg',
            captured_at: '2026-10-15T10:00:00Z',
            latitude: 35,
            longitude: 139,
          },
        },
      },
    );
    expect(created.status()).toBe(201);
    // Parse the native response so failed fixture creation cannot fake a test.
    z.object({ data: z.object({ item: z.object({ id: z.string() }) }) }).parse(
      await created.json(),
    );
    await requests(page, () => [name]);
    async function show() {
      await page.goto('/owner/media');
      await page
        .getByRole('button', { name: `synthetic ${name}, draft`, exact: true })
        .click();
    }
    await show();
    const status = page.getByLabel('Category icons', { exact: true });
    await expect(status).toContainText(
      'result unknown; retry may charge again',
    );
    expect(
      await page.evaluate(
        async (category) =>
          (
            await fetch('/api/trip/category-icons', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-EmDash-Request': '1',
              },
              body: JSON.stringify({ category, acknowledgeCharge: false }),
            })
          ).status,
        name,
      ),
    ).toBe(409);
    await status
      .getByRole('button', { name: 'RETRY (MAY CHARGE)', exact: true })
      .click();
    await expect(status).toContainText(`${name} icon · pending`);
    await runCategoryIconJobs(env(), {
      now: () => Date.now() + 1,
      generate: () =>
        Promise.resolve(
          outcome === 'ready'
            ? { status: 'ready', bytes: readyBytes() }
            : outcome === 'failed'
              ? { status: 'failed' }
              : { status: 'uncertain' },
        ),
    });
    await show();
    await expect(status).toContainText(
      outcome === 'uncertain'
        ? 'result unknown; retry may charge again'
        : `${name} icon · ${outcome}`,
    );
    if (outcome === 'uncertain')
      expect(
        await page.evaluate(
          async (category) =>
            (
              await fetch('/api/trip/category-icons', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-EmDash-Request': '1',
                },
                body: JSON.stringify({ category, acknowledgeCharge: false }),
              })
            ).status,
          name,
        ),
      ).toBe(409);
    const button =
      outcome === 'ready'
        ? 'REGENERATE'
        : outcome === 'failed'
          ? 'RETRY'
          : 'RETRY (MAY CHARGE)';
    await status.getByRole('button', { name: button, exact: true }).click();
    await expect(status).toContainText(`${name} icon · pending`);
    const rows = await jobRows();
    expect(rows.map((row) => row.generation)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.attempts)).toEqual([1, 1, 0]);
  });
}

test('recovery fixture completes an active D1 status route before disposing its worker', async ({
  page,
}) => {
  const reading = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();
  const fixture = env();
  // Delay delivery of one actual D1 result, with no mocked query or data.
  // This keeps the production status API suspended across fixture cleanup.
  fixture.DB = new Proxy(fixture.DB, {
    get(database, property) {
      if (property === 'prepare')
        return (query: string) => {
          const statement = database.prepare(query);
          if (!query.startsWith('SELECT provider_blocked')) return statement;
          return new Proxy(statement, {
            get(target, method) {
              if (method === 'first')
                return async () => {
                  const result = target.first();
                  reading.resolve(undefined);
                  await resume.promise;
                  return result;
                };
              const value: unknown = Reflect.get(target, method);
              return value;
            },
          });
        };
      const value: unknown = Reflect.get(database, property);
      return value;
    },
  });
  let handlerFinished = false;
  let disposalStarted = false;
  let disposedBeforeHandler = false;
  assert.ok(platform);
  const dispose = platform.dispose.bind(platform);
  platform.dispose = async () => {
    disposalStarted = true;
    disposedBeforeHandler = !handlerFinished;
    await dispose();
  };
  await page.route(
    'https://fixture.invalid/api/trip/category-icons',
    async (route) => {
      try {
        const response = await categoryIconStatusResponse(fixture, [
          'cleanup fixture',
        ]);
        await route.fulfill({
          status: response.status,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: await response.text(),
        });
        handlerFinished = true;
      } catch (error) {
        await route.abort();
        throw error;
      }
    },
  );
  const response = page.evaluate(async () => {
    const result = await fetch(
      'https://fixture.invalid/api/trip/category-icons',
    );
    const body: unknown = await result.json();
    return { status: result.status, body };
  });
  await reading.promise;
  const cleanup = disposeIconFixture(page);
  const settled = Promise.allSettled([response, cleanup]);
  try {
    expect(disposalStarted).toBe(false);
  } finally {
    resume.resolve(undefined);
    await settled;
  }
  expect(await response).toEqual({
    status: 200,
    body: {
      icons: [
        {
          normalized: 'cleanup fixture',
          label: 'cleanup fixture',
          state: 'pending',
          canRetry: false,
        },
      ],
    },
  });
  await cleanup;
  expect(handlerFinished).toBe(true);
  expect(disposalStarted).toBe(true);
  expect(disposedBeforeHandler).toBe(false);
});
