import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { encode } from 'fast-png';
import { getPlatformProxy, unstable_splitSqlQuery } from 'wrangler';
import type { PlatformProxy } from 'wrangler';
import {
  claimIconJob,
  drainIconOutbox,
  ownerIconStatuses,
  ownerIconProviderStatus,
  resumeIconProvider,
  readyCategoryIcons,
  retryCategoryIcon,
  runCategoryIconJobs,
} from '../src/lib/category-icon-jobs';
import type { IconEnvironment } from '../src/lib/category-icon-jobs';
import {
  generateCategoryIcon,
  normalizeCategoryIconPng,
  validateStoredCategoryIcon,
} from '../src/lib/category-icon-image';
import { currentPublishedCategoryNames } from '../src/lib/category-icon-access';
import { serveCategoryIcon } from '../src/lib/category-icon-serving';
import {
  categoryNames,
  iconModel,
  normalizeCategory,
} from '../src/lib/category-icons';

const now = Date.UTC(2026, 9, 15);
const day = 86_400_000;
let platform: PlatformProxy<IconEnvironment> | undefined;
let temporaryDirectory: string | undefined;
let migration = '';

function environment(): IconEnvironment {
  assert.ok(platform);
  return {
    ...platform.env,
    OPENAI_API_KEY: 'synthetic-test-key',
    CATEGORY_ICON_MODEL: iconModel,
  };
}

async function sql(source: string) {
  const { DB } = environment();
  // Wrangler's SQLite-aware splitter keeps BEGIN ... END triggers intact.
  await DB.batch(
    unstable_splitSqlQuery(source).map((statement) => DB.prepare(statement)),
  );
}

async function resetSchema() {
  await sql(`
    DROP TABLE IF EXISTS jp_icon_assets;
    DROP TABLE IF EXISTS jp_icon_attempts;
    DROP TABLE IF EXISTS jp_icon_jobs;
    DROP TABLE IF EXISTS jp_categories;
    DROP TABLE IF EXISTS jp_icon_outbox;
    DROP TABLE IF EXISTS jp_icon_baseline;
    DROP TABLE IF EXISTS jp_icon_settings;
    DROP TABLE IF EXISTS ec_media_items;
    DROP TABLE IF EXISTS revisions;
    DROP TABLE IF EXISTS media;
    CREATE TABLE media(id TEXT PRIMARY KEY,storage_key TEXT);
    CREATE TABLE ec_media_items (
      id TEXT PRIMARY KEY, categories TEXT, draft_revision_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft', deleted_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT);
  `);
}

async function applyMigration() {
  const { DB } = environment();
  await DB.batch(
    migration
      .split('--> statement-breakpoint')
      .map((statement) => statement.replace(/^--.*$/gm, '').trim())
      .filter(Boolean)
      .map((statement) => DB.prepare(statement)),
  );
}

type CountedTable =
  | 'jp_categories'
  | 'jp_icon_jobs'
  | 'jp_icon_attempts'
  | 'jp_icon_outbox'
  | 'jp_icon_baseline';

async function count(table: CountedTable) {
  const row = await environment()
    .DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<{ count: number }>();
  assert.ok(row);
  return row.count;
}

async function saveCategories(
  names: string[],
  id: string = crypto.randomUUID(),
) {
  await environment()
    .DB.prepare('INSERT INTO ec_media_items(id,categories) VALUES(?,?)')
    .bind(id, JSON.stringify(names))
    .run();
}

interface StoredCategory {
  id: string;
  normalized: string;
  label: string;
  generation: number;
  ready_key: string | null;
  ready_version: string | null;
}

async function storedCategory(normalized: string) {
  const row = await environment()
    .DB.prepare('SELECT * FROM jp_categories WHERE normalized=?')
    .bind(normalized)
    .first<StoredCategory>();
  assert.ok(row);
  return row;
}

interface StoredJob {
  id: string;
  status: string;
  attempts: number;
  generation: number;
  available_at: number;
  lease_until: number | null;
  lease_token: string | null;
}

async function latestJob(normalized: string) {
  const row = await environment()
    .DB.prepare(
      `SELECT j.* FROM jp_icon_jobs j JOIN jp_categories c
      ON c.id=j.category_id WHERE c.normalized=? ORDER BY j.generation DESC LIMIT 1`,
    )
    .bind(normalized)
    .first<StoredJob>();
  assert.ok(row);
  return row;
}

function pngBytes(width = 8) {
  const data = new Uint8Array(32 * 32 * 4);
  const left = Math.floor((32 - width) / 2);
  for (let y = 12; y < 20; y++) {
    for (let x = left; x < left + width; x++) data[(y * 32 + x) * 4 + 3] = 255;
  }
  return encode({ width: 32, height: 32, channels: 4, depth: 8, data });
}

async function servingFixture() {
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 384; y < 640; y++) {
    for (let x = 384; x < 640; x++) data[(y * 1024 + x) * 4 + 3] = 255;
  }
  const bytes = await normalizeCategoryIconPng(
    encode({ width: 1024, height: 1024, channels: 4, depth: 8, data }),
  );
  assert.equal(await validateStoredCategoryIcon(bytes), true);
  await saveCategories(['Public Tea']);
  const generate: typeof generateCategoryIcon = () =>
    Promise.resolve({ status: 'ready', bytes });
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  const row = await storedCategory('public tea');
  assert.ok(row.ready_key);
  assert.ok(row.ready_version);
  return {
    bytes,
    id: row.id,
    file: `${row.ready_version}.png`,
    key: row.ready_key,
  };
}

function assertPrivateHeaders(response: Response) {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(
    response.headers.get('Cloudflare-CDN-Cache-Control'),
    'no-store',
  );
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
}

before(async () => {
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'category-icon-jobs-test-'),
  );
  await writeFile(
    join(temporaryDirectory, 'worker.js'),
    'export default {fetch(){return new Response("synthetic test worker")}};',
  );
  const configPath = join(temporaryDirectory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'category-icon-jobs-test',
      main: 'worker.js',
      compatibility_date: '2026-10-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'category-icon-jobs-test',
          database_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
      r2_buckets: [
        { binding: 'MEDIA', bucket_name: 'category-icon-jobs-test' },
      ],
    }),
  );
  platform = await getPlatformProxy<IconEnvironment>({
    configPath,
    persist: false,
    remoteBindings: false,
    envFiles: [],
  });
  migration = (
    await Promise.all(
      ['0001_category_icons.sql', '0002_icon_library.sql'].map((file) =>
        readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n--> statement-breakpoint\n');
});

beforeEach(async () => {
  await resetSchema();
  await applyMigration();
  const { MEDIA } = environment();
  const objects = await MEDIA.list();
  for (const object of objects.objects) await MEDIA.delete(object.key);
});

after(async () => {
  try {
    await platform?.dispose();
  } finally {
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

void test('normalization merges NFKC, case and spaces while retaining display spelling', () => {
  assert.deepEqual(normalizeCategory('  Ｔｅａ　 Houses  '), {
    normalized: 'tea houses',
    label: 'Ｔｅａ　 Houses',
  });
  assert.deepEqual(normalizeCategory('Cafe\u0301'), {
    normalized: 'café',
    label: 'Cafe\u0301',
  });
  assert.equal(categoryNames(['Ｔｅａ Houses', 'tea  houses']).length, 1);
  for (const invalid of [
    '',
    '   ',
    'x'.repeat(41),
    'tea\nshop',
    'tea\u200bshop',
  ])
    assert.equal(normalizeCategory(invalid), undefined);
  assert.deepEqual(categoryNames('tea'), []);
  assert.deepEqual(categoryNames(['tea', 42]), []);
});

void test('migration seeds published and native draft categories without paid backfill', async () => {
  await resetSchema();
  await sql(`
    INSERT INTO revisions(id,data) VALUES('baseline-draft','{"categories":["Draft Tea"]}');
    INSERT INTO ec_media_items(id,categories,draft_revision_id)
      VALUES('baseline','["Old Tea","food"]','baseline-draft');
    INSERT INTO ec_media_items(id,categories) VALUES('invalid','not JSON');
  `);
  await applyMigration();
  assert.equal(await count('jp_icon_baseline'), 3);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'failed' });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.equal(calls, 0);
  assert.equal(await count('jp_categories'), 3);
  assert.equal(await count('jp_icon_jobs'), 0);
  assert.equal(await count('jp_icon_attempts'), 0);
  assert.equal((await storedCategory('draft tea')).generation, 0);
  assert.deepEqual(
    (
      await ownerIconStatuses(environment(), ['Old Tea', 'Draft Tea', 'food'])
    ).map(({ state }) => state),
    ['default', 'default', 'default'],
  );
  await saveCategories(['New Tea', 'food']);
  await applyMigration();
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_icon_jobs'), 1);
  assert.equal((await latestJob('new tea')).attempts, 0);
  assert.equal((await storedCategory('food')).generation, 0);
});

void test('approved built-in categories never enqueue paid generation or retries', async () => {
  const names = ['food', 'shopping', 'landscape', 'people', 'beer', 'origami'];
  await saveCategories(names);
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_categories'), 6);
  assert.equal(await count('jp_icon_jobs'), 0);
  assert.equal(await count('jp_icon_attempts'), 0);
  const statuses = await ownerIconStatuses(environment(), names);
  assert.ok(
    statuses.every(({ state, canRetry }) => state === 'default' && !canRetry),
  );
  for (const name of names)
    assert.equal(
      await retryCategoryIcon(environment(), name, false, now),
      false,
    );
});

void test('pre-upgrade built-in jobs cannot dispatch or starve custom categories', async () => {
  await saveCategories(['origami']);
  await drainIconOutbox(environment(), now);
  const { DB } = environment();
  const origami = await storedCategory('origami');
  await DB.prepare(
    "INSERT INTO jp_icon_jobs(id,category_id,version,model,generation,status,available_at,created_at) VALUES(?,?,?,?,1,'pending',?,?)",
  )
    .bind(
      'pre-upgrade-origami',
      origami.id,
      'bent-pixel-v1',
      iconModel,
      now - 1,
      now - 1,
    )
    .run();
  const original = await latestJob('origami');
  const generated: string[] = [];
  const generate: typeof generateCategoryIcon = (input) => {
    generated.push(input.category.normalized);
    return Promise.resolve({ status: 'failed' });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.deepEqual(generated, []);
  assert.equal(await count('jp_icon_attempts'), 0);
  assert.deepEqual(await latestJob('origami'), original);
  await saveCategories(['new custom category']);
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.deepEqual(generated, ['new custom category']);
  assert.equal(await count('jp_icon_attempts'), 1);
  assert.deepEqual(await latestJob('origami'), original);
});

void test('built-in running and uncertain history stays intact during dispatch', async () => {
  await saveCategories(['origami', 'custom behind running job']);
  await drainIconOutbox(environment(), now);
  const { DB } = environment();
  const origami = await storedCategory('origami');
  await DB.batch([
    DB.prepare(
      "INSERT INTO jp_icon_jobs(id,category_id,version,model,generation,status,attempts,available_at,created_at) VALUES(?,?,?,?,1,'uncertain',1,?,?)",
    ).bind(
      'uncertain-origami',
      origami.id,
      'bent-pixel-v1',
      iconModel,
      now - 1,
      now - 1,
    ),
    DB.prepare(
      "INSERT INTO jp_icon_jobs(id,category_id,version,model,generation,status,attempts,available_at,created_at,lease_token,lease_until) VALUES(?,?,?,?,2,'running',1,?,?,'existing-lease',?)",
    ).bind(
      'running-origami',
      origami.id,
      'bent-pixel-v1',
      iconModel,
      now,
      now,
      now + 180_000,
    ),
  ]);
  const history = () =>
    DB.prepare('SELECT * FROM jp_icon_jobs ORDER BY id').all();
  const original = (await history()).results;
  const generated: string[] = [];
  const generate: typeof generateCategoryIcon = (input) => {
    generated.push(input.category.normalized);
    return Promise.resolve({ status: 'failed' });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.deepEqual(generated, []);
  assert.equal(await count('jp_icon_attempts'), 0);
  assert.deepEqual((await history()).results, original);
});

void test('baseline paging completes before queued categories can spend', async () => {
  await resetSchema();
  for (let index = 0; index < 101; index++)
    await saveCategories([`baseline-${String(index)}`]);
  await applyMigration();
  await saveCategories(['new paged category']);
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_icon_baseline'), 1);
  assert.equal(await count('jp_icon_outbox'), 1);
  assert.equal(await count('jp_icon_jobs'), 0);
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_icon_baseline'), 0);
  assert.equal(await count('jp_icon_outbox'), 0);
  assert.equal(await count('jp_icon_jobs'), 1);
});

void test('replayed outbox events and concurrent drains preserve one job and the first label', async () => {
  await saveCategories(['  Ｔｅａ　 Houses  ', 'food'], 'first');
  await saveCategories(['tea houses', 'FOOD'], 'second');
  await Promise.all([
    drainIconOutbox(environment(), now),
    drainIconOutbox(environment(), now),
  ]);
  assert.equal(await count('jp_categories'), 2);
  assert.equal(await count('jp_icon_jobs'), 1);
  assert.equal((await storedCategory('tea houses')).label, 'Ｔｅａ　 Houses');
  await environment()
    .DB.prepare('INSERT INTO jp_icon_outbox(categories) VALUES(?)')
    .bind(JSON.stringify(['TEA  HOUSES']))
    .run();
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_icon_jobs'), 1);
  assert.equal(await count('jp_icon_outbox'), 0);
  assert.equal((await storedCategory('tea houses')).generation, 1);
});

void test('a failed metadata transaction rolls back both categories and its trigger event', async () => {
  await saveCategories(['original'], 'metadata');
  await drainIconOutbox(environment(), now);
  const { DB } = environment();
  await assert.rejects(
    DB.batch([
      DB.prepare(
        'UPDATE ec_media_items SET categories=?,metadata=? WHERE id=?',
      ).bind('["rolled back"]', '{"synthetic":true}', 'metadata'),
      DB.prepare('INSERT INTO ec_media_items(id) VALUES(?)').bind('metadata'),
    ]),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(
    await DB.prepare(
      'SELECT categories,metadata FROM ec_media_items WHERE id=?',
    )
      .bind('metadata')
      .first(),
    { categories: '["original"]', metadata: '{}' },
  );
  assert.equal(await count('jp_icon_outbox'), 0);
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_categories'), 1);
});

void test('committed metadata retains its outbox when job creation fails and can recover', async () => {
  await saveCategories(['persisted metadata'], 'metadata');
  await sql(`CREATE TRIGGER fail_job BEFORE INSERT ON jp_icon_jobs
    BEGIN SELECT RAISE(ABORT,'synthetic job write failure'); END;`);
  await assert.rejects(
    drainIconOutbox(environment(), now),
    /synthetic job write failure/,
  );
  assert.equal(await count('jp_icon_outbox'), 1);
  assert.equal(await count('jp_categories'), 0);
  assert.equal(await count('jp_icon_jobs'), 0);
  assert.deepEqual(
    await environment()
      .DB.prepare('SELECT categories FROM ec_media_items WHERE id=?')
      .bind('metadata')
      .first(),
    { categories: '["persisted metadata"]' },
  );
  await sql('DROP TRIGGER fail_job;');
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_icon_outbox'), 0);
  assert.equal(await count('jp_icon_jobs'), 1);
});

void test('native draft revision pointer changes capture categories and ignore unchanged writes', async () => {
  await saveCategories([], 'draft');
  await drainIconOutbox(environment(), now);
  await sql(`INSERT INTO revisions(id,data) VALUES('draft-1','{"categories":["Draft Ramen"]}');
    UPDATE ec_media_items SET draft_revision_id='draft-1' WHERE id='draft';`);
  const event = await environment()
    .DB.prepare('SELECT categories FROM jp_icon_outbox')
    .first<{ categories: string }>();
  assert.ok(event);
  assert.deepEqual(JSON.parse(event.categories), ['Draft Ramen']);
  await sql(
    `UPDATE ec_media_items SET draft_revision_id='draft-1' WHERE id='draft';`,
  );
  assert.equal(await count('jp_icon_outbox'), 1);
  await drainIconOutbox(environment(), now);
  assert.equal((await latestJob('draft ramen')).attempts, 0);
  await sql(`INSERT INTO revisions(id,data) VALUES('draft-2','{"categories":["Draft Soba"]}');
    UPDATE ec_media_items SET draft_revision_id='draft-2' WHERE id='draft';`);
  await drainIconOutbox(environment(), now);
  assert.equal(await count('jp_icon_jobs'), 2);
});

void test('concurrent claims admit one request and one spend record across different jobs', async () => {
  await saveCategories(['claim ramen', 'claim soba']);
  await drainIconOutbox(environment(), now);
  const claims = await Promise.all([
    claimIconJob(environment(), now),
    claimIconJob(environment(), now),
    claimIconJob(environment(), now),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await count('jp_icon_attempts'), 1);
  const jobs = await environment()
    .DB.prepare(
      'SELECT status,attempts,lease_until,lease_token FROM jp_icon_jobs',
    )
    .all<StoredJob>();
  assert.deepEqual(jobs.results.map(({ attempts }) => attempts).sort(), [0, 1]);
  const running = jobs.results.find(({ status }) => status === 'running');
  assert.ok(running);
  assert.equal(running.lease_until, now + 180_000);
  assert.ok(running.lease_token);
});

void test('claim and spend record roll back together if attempt persistence fails', async () => {
  await saveCategories(['claim rollback']);
  await drainIconOutbox(environment(), now);
  await sql(`CREATE TRIGGER fail_attempt BEFORE INSERT ON jp_icon_attempts
    BEGIN SELECT RAISE(ABORT,'synthetic spend failure'); END;`);
  await assert.rejects(
    claimIconJob(environment(), now),
    /synthetic spend failure/,
  );
  const job = await latestJob('claim rollback');
  assert.equal(job.status, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.lease_token, null);
  assert.equal(await count('jp_icon_attempts'), 0);
});

void test('expired leases become uncertain without another request or automatic attempt', async () => {
  await saveCategories(['stale lease']);
  await drainIconOutbox(environment(), now);
  assert.ok(await claimIconJob(environment(), now));
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'failed' });
  };
  await runCategoryIconJobs(environment(), {
    now: () => now + 180_000,
    generate,
  });
  await runCategoryIconJobs(environment(), { now: () => now + day, generate });
  assert.equal(calls, 0);
  const job = await latestJob('stale lease');
  assert.equal(job.status, 'uncertain');
  assert.equal(job.attempts, 1);
  assert.equal(job.lease_token, null);
  assert.equal(job.lease_until, null);
  assert.equal(await count('jp_icon_attempts'), 1);
  assert.equal(
    await retryCategoryIcon(environment(), 'stale lease', false, now + day),
    false,
  );
  assert.equal(
    await retryCategoryIcon(environment(), 'stale lease', true, now + day),
    true,
  );
  assert.equal((await latestJob('stale lease')).generation, 2);
  assert.equal((await latestJob('stale lease')).attempts, 0);
});

void test('missing key or supported model never dispatches or records an attempt', async () => {
  await saveCategories(['setup category']);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'failed' });
  };
  const configurations: IconEnvironment[] = [
    { ...environment(), OPENAI_API_KEY: undefined },
    { ...environment(), OPENAI_API_KEY: '   ' },
    { ...environment(), CATEGORY_ICON_MODEL: undefined },
    { ...environment(), CATEGORY_ICON_MODEL: 'unsupported-model' },
  ];
  for (const env of configurations) {
    await runCategoryIconJobs(env, { now: () => now, generate });
    const [status] = await ownerIconStatuses(env, ['setup category']);
    assert.ok(status);
    assert.equal(status.state, 'setup');
    assert.equal(status.canRetry, false);
    assert.equal(
      await retryCategoryIcon(env, 'setup category', true, now),
      false,
    );
  }
  assert.equal(calls, 0);
  assert.equal(await count('jp_icon_attempts'), 0);
  assert.equal((await latestJob('setup category')).attempts, 0);
});

void test('provider configuration failures stop other jobs until an explicit valid retry', async () => {
  await saveCategories(['configuration category']);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'blocked_configuration' });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  await saveCategories(['waiting category']);
  await runCategoryIconJobs(environment(), { now: () => now + day, generate });
  assert.equal(calls, 1);
  assert.equal(
    (await latestJob('configuration category')).status,
    'configuration',
  );
  assert.equal((await latestJob('waiting category')).attempts, 0);
  assert.deepEqual(
    (
      await ownerIconStatuses(environment(), [
        'configuration category',
        'waiting category',
      ])
    ).map(({ state }) => state),
    ['configuration', 'configuration'],
  );
  assert.equal(
    await retryCategoryIcon(environment(), 'missing', true, now),
    false,
  );
  assert.equal(await claimIconJob(environment(), now + day), null);
  assert.equal(
    await retryCategoryIcon(
      environment(),
      'configuration category',
      false,
      now + day,
    ),
    true,
  );
  assert.ok(await claimIconJob(environment(), now + day));
});

void test('rate limits back off and stop after three attempts in the same generation', async () => {
  await saveCategories(['limited category']);
  let clock = now;
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'rate_limited' });
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runCategoryIconJobs(environment(), { now: () => clock, generate });
    const job = await latestJob('limited category');
    assert.equal(job.attempts, attempt);
    assert.equal(job.status, attempt < 3 ? 'pending' : 'failed');
    assert.equal(job.available_at, clock + 60_000 * 2 ** attempt);
    clock = job.available_at - 1;
    await runCategoryIconJobs(environment(), { now: () => clock, generate });
    assert.equal(calls, attempt);
    clock++;
  }
  await runCategoryIconJobs(environment(), {
    now: () => clock + day,
    generate,
  });
  assert.equal(calls, 3);
  assert.equal(await count('jp_icon_attempts'), 3);
});

void test('five attempts across jobs and generations exhaust the rolling 24 hour budget', async () => {
  await saveCategories(['budget retry']);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'failed' });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.equal(
    await retryCategoryIcon(environment(), 'budget retry', false, now + 1),
    true,
  );
  await runCategoryIconJobs(environment(), { now: () => now + 1, generate });
  await saveCategories(['budget a', 'budget b', 'budget c', 'budget d']);
  for (let index = 2; index <= 4; index++)
    await runCategoryIconJobs(environment(), {
      now: () => now + index,
      generate,
    });
  await runCategoryIconJobs(environment(), {
    now: () => now + day - 1,
    generate,
  });
  assert.equal(calls, 5);
  assert.equal(await count('jp_icon_attempts'), 5);
  await runCategoryIconJobs(environment(), { now: () => now + day, generate });
  assert.equal(calls, 6);
  assert.equal(await count('jp_icon_attempts'), 6);
});

for (const outcome of ['failed', 'uncertain']) {
  void test(`provider ${outcome} outcomes are not replayed automatically`, async () => {
    await saveCategories([`provider ${outcome}`]);
    let calls = 0;
    const generate: typeof generateCategoryIcon = () => {
      calls++;
      return Promise.resolve(
        outcome === 'failed' ? { status: 'failed' } : { status: 'uncertain' },
      );
    };
    await runCategoryIconJobs(environment(), { now: () => now, generate });
    await runCategoryIconJobs(environment(), {
      now: () => now + day,
      generate,
    });
    assert.equal(calls, 1);
    assert.equal((await latestJob(`provider ${outcome}`)).status, outcome);
    const [status] = await ownerIconStatuses(environment(), [
      `provider ${outcome}`,
    ]);
    assert.ok(status);
    assert.equal(status.state, outcome);
    assert.equal(status.canRetry, true);
  });
}

void test('provider exceptions become uncertain and require charge acknowledgment', async () => {
  await saveCategories(['thrown request']);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.reject(new Error('synthetic request failure'));
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  await runCategoryIconJobs(environment(), { now: () => now + day, generate });
  assert.equal(calls, 1);
  assert.equal((await latestJob('thrown request')).status, 'uncertain');
  assert.equal(
    await retryCategoryIcon(environment(), 'thrown request', false, now),
    false,
  );
  assert.equal((await storedCategory('thrown request')).generation, 1);
  assert.equal(
    await retryCategoryIcon(environment(), 'thrown request', true, now),
    true,
  );
});

void test('ready output is stored byte-for-byte in R2 under hashed safe keys', async () => {
  const label = '../Tea/../<script>?';
  await saveCategories([label]);
  const bytes = pngBytes();
  const generate: typeof generateCategoryIcon = (input) => {
    assert.equal(input.key, 'synthetic-test-key');
    assert.equal(input.model, iconModel);
    assert.deepEqual(input.category, {
      label,
      normalized: label.toLowerCase(),
    });
    return Promise.resolve({ status: 'ready', bytes });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  const row = await storedCategory(label.toLowerCase());
  assert.equal(
    row.id,
    createHash('sha256').update(label.toLowerCase()).digest('hex'),
  );
  assert.ok(row.ready_key);
  assert.ok(row.ready_version);
  assert.match(
    row.ready_key,
    /^category-icons\/[a-f0-9]{64}\/[a-f0-9]{64}\.png$/u,
  );
  const object = await environment().MEDIA.get(row.ready_key);
  assert.ok(object);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  assert.ok(object.httpMetadata);
  assert.equal(object.httpMetadata.contentType, 'image/png');
  assert.equal(object.httpMetadata.cacheControl, 'private, no-store');
  assert.equal((await latestJob(label.toLowerCase())).status, 'ready');
  assert.deepEqual(
    await readyCategoryIcons(environment(), [label, 'absent']),
    new Map([
      [
        label.toLowerCase(),
        `/category-icons/${row.id}/${row.ready_version}.png`,
      ],
    ]),
  );
  const [status] = await ownerIconStatuses(environment(), [label]);
  assert.ok(status);
  assert.equal(status.state, 'ready');
});

void test('a ready metadata write failure retains R2 bytes but never retries the charged request', async () => {
  await saveCategories(['storage failure']);
  await sql(`CREATE TRIGGER fail_ready BEFORE UPDATE OF ready_key ON jp_categories
    BEGIN SELECT RAISE(ABORT,'synthetic ready metadata failure'); END;`);
  let calls = 0;
  const bytes = pngBytes();
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'ready', bytes });
  };
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  await runCategoryIconJobs(environment(), { now: () => now + day, generate });
  assert.equal(calls, 1);
  assert.equal((await latestJob('storage failure')).status, 'uncertain');
  assert.equal((await storedCategory('storage failure')).ready_key, null);
  assert.equal(
    (await readyCategoryIcons(environment(), ['storage failure'])).size,
    0,
  );
  const objects = await environment().MEDIA.list();
  assert.equal(objects.objects.length, 1);
  const stored = objects.objects[0];
  assert.ok(stored);
  const object = await environment().MEDIA.get(stored.key);
  assert.ok(object);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
});

void test('explicit regeneration preserves the ready icon and stops at generation three', async () => {
  await saveCategories(['regenerate', 'food']);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'ready', bytes: pngBytes(calls + 4) });
  };
  assert.equal(
    await retryCategoryIcon(environment(), 'absent', true, now),
    false,
  );
  await drainIconOutbox(environment(), now);
  assert.equal(
    await retryCategoryIcon(environment(), 'regenerate', true, now),
    false,
  );
  assert.equal(
    await retryCategoryIcon(environment(), 'food', true, now),
    false,
  );
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  const initial = await readyCategoryIcons(environment(), ['regenerate']);
  assert.equal(initial.size, 1);
  const retries = await Promise.all([
    retryCategoryIcon(environment(), 'REGENERATE', false, now),
    retryCategoryIcon(environment(), 'regenerate', false, now),
  ]);
  assert.equal(retries.filter(Boolean).length, 1);
  assert.equal((await storedCategory('regenerate')).generation, 2);
  assert.equal(await count('jp_icon_jobs'), 2);
  assert.deepEqual(
    await readyCategoryIcons(environment(), ['regenerate']),
    initial,
  );
  await runCategoryIconJobs(environment(), { now: () => now + 1, generate });
  const second = await storedCategory('regenerate');
  assert.ok(second.ready_key);
  assert.ok(second.ready_version);
  assert.notEqual(
    `/category-icons/${second.id}/${second.ready_version}.png`,
    initial.get('regenerate'),
  );
  assert.equal(
    await retryCategoryIcon(environment(), 'regenerate', false, now),
    true,
  );
  await runCategoryIconJobs(environment(), { now: () => now + 2, generate });
  assert.equal((await storedCategory('regenerate')).generation, 3);
  assert.equal(
    await retryCategoryIcon(environment(), 'regenerate', true, now),
    false,
  );
  assert.equal(calls, 3);
  assert.equal(await count('jp_icon_jobs'), 3);
  assert.equal(await count('jp_icon_attempts'), 3);
  const [status] = await ownerIconStatuses(environment(), ['regenerate']);
  assert.ok(status);
  assert.equal(status.canRetry, false);
});

void test('retry generation, job creation and circuit reset roll back on an insert failure', async () => {
  await saveCategories(['retry rollback']);
  const generate: typeof generateCategoryIcon = () =>
    Promise.resolve({
      status: 'blocked_configuration',
    });
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  await sql(`CREATE TRIGGER fail_retry BEFORE INSERT ON jp_icon_jobs
    BEGIN SELECT RAISE(ABORT,'synthetic retry insert failure'); END;`);
  await assert.rejects(
    retryCategoryIcon(environment(), 'retry rollback', true, now),
    /synthetic retry insert failure/,
  );
  assert.equal((await storedCategory('retry rollback')).generation, 1);
  assert.equal(await count('jp_icon_jobs'), 1);
  assert.equal((await latestJob('retry rollback')).status, 'configuration');
  assert.equal(await claimIconJob(environment(), now + day), null);
  const settings = await environment()
    .DB.prepare('SELECT provider_blocked FROM jp_icon_settings WHERE id=1')
    .first<{ provider_blocked: number }>();
  assert.ok(settings);
  assert.equal(settings.provider_blocked, 1);
});

void test('invalid provider bytes become uncertain before R2 storage', async () => {
  await saveCategories(['invalid image']);
  const generate: typeof generateCategoryIcon = () =>
    Promise.resolve({
      status: 'ready',
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.equal((await latestJob('invalid image')).status, 'uncertain');
  assert.equal((await storedCategory('invalid image')).ready_key, null);
  assert.equal((await environment().MEDIA.list()).objects.length, 0);
});

void test('known ready keys remain private until their category is published', async () => {
  const fixture = await servingFixture();
  assert.ok(await environment().MEDIA.get(fixture.key));
  const response = await serveCategoryIcon(
    environment(),
    fixture.id,
    fixture.file,
    () => Promise.resolve([]),
  );
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  assertPrivateHeaders(response);
});

void test('published canonical masks are served without caching and disappear on unpublish', async () => {
  const fixture = await servingFixture();
  let published = [' Ｐｕｂｌｉｃ　Ｔｅａ '];
  const publishedNames = () => Promise.resolve(published);
  const response = await serveCategoryIcon(
    environment(),
    fixture.id,
    fixture.file,
    publishedNames,
  );
  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.equal(
    response.headers.get('Content-Length'),
    String(fixture.bytes.length),
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), fixture.bytes);
  published = ['unrelated published category'];
  const removed = await serveCategoryIcon(
    environment(),
    fixture.id,
    fixture.file,
    publishedNames,
  );
  assert.equal(removed.status, 404);
  assertPrivateHeaders(removed);
  published = [];
  assert.equal(
    (
      await serveCategoryIcon(
        environment(),
        fixture.id,
        fixture.file,
        publishedNames,
      )
    ).status,
    404,
  );
});

void test('public serving rejects corrupt, oversized or incorrectly typed R2 objects', async () => {
  const fixture = await servingFixture();
  const invalidObjects = [
    { bytes: new Uint8Array([137, 80, 78, 71]), contentType: 'image/png' },
    { bytes: new Uint8Array(8193), contentType: 'image/png' },
    { bytes: fixture.bytes, contentType: 'text/html' },
  ];
  for (const object of invalidObjects) {
    await environment().MEDIA.put(fixture.key, object.bytes, {
      httpMetadata: { contentType: object.contentType },
    });
    const response = await serveCategoryIcon(
      environment(),
      fixture.id,
      fixture.file,
      () => Promise.resolve(['Public Tea']),
    );
    assert.equal(response.status, 404);
    assertPrivateHeaders(response);
  }
  await environment().MEDIA.delete(fixture.key);
  assert.equal(
    (
      await serveCategoryIcon(environment(), fixture.id, fixture.file, () =>
        Promise.resolve(['Public Tea']),
      )
    ).status,
    404,
  );
});

void test('public serving rejects unsafe registry keys and mismatched category identity', async () => {
  const fixture = await servingFixture();
  const { DB } = environment();
  await DB.prepare('UPDATE jp_categories SET ready_key=? WHERE id=?')
    .bind('../synthetic-private-object.png', fixture.id)
    .run();
  assert.equal(
    (
      await serveCategoryIcon(environment(), fixture.id, fixture.file, () =>
        Promise.resolve(['Public Tea']),
      )
    ).status,
    404,
  );
  await DB.prepare(
    'UPDATE jp_categories SET ready_key=?,normalized=? WHERE id=?',
  )
    .bind(fixture.key, 'different private category', fixture.id)
    .run();
  assert.equal(
    (
      await serveCategoryIcon(environment(), fixture.id, fixture.file, () =>
        Promise.resolve(['Public Tea']),
      )
    ).status,
    404,
  );
});

void test('malformed paths are rejected before querying published names', async () => {
  const fixture = await servingFixture();
  let calls = 0;
  const publishedNames = () => {
    calls++;
    return Promise.resolve(['Public Tea']);
  };
  const paths = [
    { id: '../private', file: fixture.file },
    { id: fixture.id.toUpperCase(), file: fixture.file },
    { id: fixture.id, file: `${fixture.file}?private=true` },
    { id: fixture.id, file: `${'a'.repeat(64)}.svg` },
    { id: fixture.id, file: `../${fixture.file}` },
  ];
  for (const path of paths) {
    const response = await serveCategoryIcon(
      environment(),
      path.id,
      path.file,
      publishedNames,
    );
    assert.equal(response.status, 404);
    assertPrivateHeaders(response);
  }
  assert.equal(calls, 0);
});

void test('private names return 404 without reading even an unavailable registry', async () => {
  const fixture = await servingFixture();
  await sql(
    `DROP TABLE jp_icon_attempts; DROP TABLE jp_icon_jobs; DROP TABLE jp_categories;`,
  );
  const response = await serveCategoryIcon(
    environment(),
    fixture.id,
    fixture.file,
    () => Promise.resolve([]),
  );
  assert.equal(response.status, 404);
  assertPrivateHeaders(response);
});

void test('revocation check bypasses draft overlays and immediately removes unpublished and trashed categories', async () => {
  const env = environment();
  await saveCategories(['live category'], 'revocation');
  await env.DB.prepare(
    "UPDATE ec_media_items SET status='published' WHERE id='revocation'",
  ).run();
  assert.deepEqual(
    (await currentPublishedCategoryNames(env.DB)).map(
      (name) => name.normalized,
    ),
    ['live category'],
  );
  await env.DB.prepare(
    "INSERT INTO revisions(id,data) VALUES('private-revision',?)",
  )
    .bind(JSON.stringify({ categories: ['draft-only'] }))
    .run();
  await env.DB.prepare(
    "UPDATE ec_media_items SET draft_revision_id='private-revision' WHERE id='revocation'",
  ).run();
  assert.deepEqual(
    (await currentPublishedCategoryNames(env.DB)).map(
      (name) => name.normalized,
    ),
    ['live category'],
  );
  await env.DB.prepare(
    "UPDATE ec_media_items SET status='draft' WHERE id='revocation'",
  ).run();
  assert.deepEqual(await currentPublishedCategoryNames(env.DB), []);
  await env.DB.prepare(
    "UPDATE ec_media_items SET status='published',deleted_at='2099-01-01' WHERE id='revocation'",
  ).run();
  assert.deepEqual(await currentPublishedCategoryNames(env.DB), []);
});

for (const secondOutcome of ['failed', 'ready', 'uncertain']) {
  void test(`acknowledged uncertainty follows the latest ${secondOutcome} generation for retry consent`, async () => {
    await saveCategories(['chained recovery']);
    await runCategoryIconJobs(environment(), {
      now: () => now,
      generate: () => Promise.resolve({ status: 'uncertain' }),
    });
    assert.equal(
      await retryCategoryIcon(
        environment(),
        'chained recovery',
        false,
        now + 1,
      ),
      false,
    );
    assert.equal(
      await retryCategoryIcon(environment(), 'chained recovery', true, now + 1),
      true,
    );
    await runCategoryIconJobs(environment(), {
      now: () => now + 1,
      generate: () =>
        Promise.resolve(
          secondOutcome === 'ready'
            ? { status: 'ready', bytes: pngBytes() }
            : secondOutcome === 'failed'
              ? { status: 'failed' }
              : { status: 'uncertain' },
        ),
    });
    const [status] = await ownerIconStatuses(environment(), [
      'chained recovery',
    ]);
    assert.ok(status);
    assert.equal(status.state, secondOutcome);
    assert.equal(status.canRetry, true);
    const retry = await retryCategoryIcon(
      environment(),
      'chained recovery',
      false,
      now + 2,
    );
    assert.equal(retry, secondOutcome !== 'uncertain');
    if (secondOutcome === 'uncertain')
      assert.equal(
        await retryCategoryIcon(
          environment(),
          'chained recovery',
          true,
          now + 2,
        ),
        true,
      );
    assert.equal((await latestJob('chained recovery')).generation, 3);
    assert.equal(await count('jp_icon_attempts'), 2);
    assert.equal(
      await retryCategoryIcon(environment(), 'chained recovery', true, now + 3),
      false,
    );
  });
}

for (const failure of ['removed', 'capped']) {
  void test(`explicit provider resume recovers a ${failure} configuration category without changing jobs or limits`, async () => {
    await saveCategories(['configuration recovery'], 'configuration-recovery');
    const generations = failure === 'capped' ? 3 : 1;
    for (let generation = 1; generation <= generations; generation++) {
      await runCategoryIconJobs(environment(), {
        now: () => now + generation,
        generate: () => Promise.resolve({ status: 'blocked_configuration' }),
      });
      if (generation < generations)
        assert.equal(
          await retryCategoryIcon(
            environment(),
            'configuration recovery',
            false,
            now + generation + 1,
          ),
          true,
        );
    }
    if (failure === 'removed')
      await environment()
        .DB.prepare(
          "DELETE FROM ec_media_items WHERE id='configuration-recovery'",
        )
        .run();
    assert.deepEqual(await ownerIconProviderStatus(environment()), {
      paused: true,
      canResume: true,
    });
    const jobsBefore = await environment()
      .DB.prepare('SELECT * FROM jp_icon_jobs ORDER BY id')
      .all();
    const categoriesBefore = await environment()
      .DB.prepare('SELECT * FROM jp_categories ORDER BY id')
      .all();
    const attemptsBefore = await count('jp_icon_attempts');
    assert.equal(
      await resumeIconProvider({ ...environment(), OPENAI_API_KEY: undefined }),
      false,
    );
    assert.equal(
      await resumeIconProvider({
        ...environment(),
        CATEGORY_ICON_MODEL: 'unsupported',
      }),
      false,
    );
    assert.equal(await resumeIconProvider(environment()), true);
    assert.equal(await resumeIconProvider(environment()), false);
    assert.deepEqual(
      (
        await environment()
          .DB.prepare('SELECT * FROM jp_icon_jobs ORDER BY id')
          .all()
      ).results,
      jobsBefore.results,
    );
    assert.deepEqual(
      (
        await environment()
          .DB.prepare('SELECT * FROM jp_categories ORDER BY id')
          .all()
      ).results,
      categoriesBefore.results,
    );
    assert.equal(await count('jp_icon_attempts'), attemptsBefore);
    await saveCategories(['queued after provider recovery']);
    let calls = 0;
    await runCategoryIconJobs(environment(), {
      now: () => now + day,
      generate: () => {
        calls++;
        return Promise.resolve({ status: 'failed' });
      },
    });
    assert.equal(calls, 1);
    assert.equal(
      (await latestJob('configuration recovery')).status,
      'configuration',
    );
    assert.equal(
      (await storedCategory('configuration recovery')).generation,
      generations,
    );
    assert.deepEqual(await ownerIconProviderStatus(environment()), {
      paused: false,
      canResume: false,
    });
  });
}

void test('provider resume preserves rolling budget, exhausted attempts and unknown results', async () => {
  await saveCategories(['unknown before pause']);
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: () => Promise.resolve({ status: 'uncertain' }),
  });
  await saveCategories(['rate limit exhausted']);
  for (const time of [now + 1, now + 120_001, now + 360_001])
    await runCategoryIconJobs(environment(), {
      now: () => time,
      generate: () => Promise.resolve({ status: 'rate_limited' }),
    });
  await saveCategories(['pause after budget']);
  await runCategoryIconJobs(environment(), {
    now: () => now + 360_002,
    generate: () => Promise.resolve({ status: 'blocked_configuration' }),
  });
  await saveCategories(['waiting for budget']);
  assert.equal(await count('jp_icon_attempts'), 5);
  assert.equal(await resumeIconProvider(environment()), true);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({ status: 'failed' });
  };
  await runCategoryIconJobs(environment(), {
    now: () => now + 360_003,
    generate,
  });
  assert.equal(calls, 0);
  assert.equal((await latestJob('unknown before pause')).status, 'uncertain');
  assert.equal((await latestJob('unknown before pause')).attempts, 1);
  assert.equal((await latestJob('rate limit exhausted')).status, 'failed');
  assert.equal((await latestJob('rate limit exhausted')).attempts, 3);
  await runCategoryIconJobs(environment(), {
    now: () => now + day + 1,
    generate,
  });
  assert.equal(calls, 1);
  assert.equal((await latestJob('waiting for budget')).status, 'failed');
  assert.equal((await latestJob('unknown before pause')).status, 'uncertain');
  assert.equal((await storedCategory('rate limit exhausted')).generation, 1);
});

void test('a provider pause cannot hide a fresh unknown result or remove its consent requirement', async () => {
  await saveCategories(['fresh unknown']);
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: () => Promise.resolve({ status: 'uncertain' }),
  });
  await saveCategories(['other configuration error']);
  await runCategoryIconJobs(environment(), {
    now: () => now + 1,
    generate: () => Promise.resolve({ status: 'blocked_configuration' }),
  });
  const [status] = await ownerIconStatuses(environment(), ['fresh unknown']);
  assert.equal(status?.state, 'uncertain');
  assert.equal(
    await retryCategoryIcon(environment(), 'fresh unknown', false, now + 2),
    false,
  );
  assert.equal(await resumeIconProvider(environment()), true);
  assert.equal(
    await retryCategoryIcon(environment(), 'fresh unknown', false, now + 2),
    false,
  );
  assert.equal((await latestJob('fresh unknown')).generation, 1);
});

function diagnosticEvent(lines: unknown[][]) {
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line);
  assert.equal(line.length, 1);
  const event = line[0];
  const text = JSON.stringify(event);
  assert.ok(typeof event === 'object' && event !== null);
  assert.ok('operationId' in event && typeof event.operationId === 'string');
  assert.match(
    event.operationId,
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u,
  );
  assert.ok('elapsedMs' in event && typeof event.elapsedMs === 'number');
  assert.ok(
    Number.isInteger(event.elapsedMs) &&
      event.elapsedMs >= 0 &&
      event.elapsedMs <= 3_600_000,
  );
  return { text, event };
}

void test('dispatched provider failure emits one private-safe terminal event without replay or lost consent', async (t) => {
  const lines: unknown[][] = [];
  t.mock.method(console, 'info', (...values: unknown[]) => lines.push(values));
  const label = 'private fixture label';
  await saveCategories([label]);
  const requestId = 'req_0123456789abcdef0123456789abcdef';
  let calls = 0;
  const generate: typeof generateCategoryIcon = (input, dependencies) =>
    generateCategoryIcon(input, {
      ...dependencies,
      fetch: () => {
        calls++;
        return Promise.resolve(
          new Response('private body', {
            status: 503,
            headers: {
              'x-request-id': requestId,
              'x-secret': 'synthetic-test-key',
            },
          }),
        );
      },
    });
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  await runCategoryIconJobs(environment(), { now: () => now + day, generate });
  assert.equal(calls, 1);
  assert.equal((await latestJob(label)).status, 'uncertain');
  assert.equal(
    await retryCategoryIcon(environment(), label, false, now + day),
    false,
  );
  const { text, event } = diagnosticEvent(lines);
  assert.deepEqual(
    Object.keys(event).sort(),
    [
      'event',
      'operationId',
      'stage',
      'reason',
      'httpStatus',
      'providerRequestId',
      'elapsedMs',
    ].sort(),
  );
  assert.ok('event' in event && event.event === 'category_icon_generation');
  assert.ok('stage' in event && event.stage === 'status');
  assert.ok('reason' in event && event.reason === 'response_received');
  assert.ok('httpStatus' in event && event.httpStatus === 503);
  assert.ok(
    'providerRequestId' in event && event.providerRequestId === requestId,
  );
  assert.doesNotMatch(
    text,
    /private|fixture|synthetic-test-key|category-icons\/|lease|prompt|body|secret/,
  );
  assert.equal(
    await retryCategoryIcon(environment(), label, true, now + day),
    true,
  );
  assert.equal(lines.length, 1);
});

for (const failure of ['none', 'mask', 'r2', 'ready_d1', 'terminal_d1']) {
  void test(`terminal diagnostics cover ${failure} storage outcome with actual D1/R2 state`, async (t) => {
    const lines: unknown[][] = [];
    t.mock.method(console, 'info', (...values: unknown[]) =>
      lines.push(values),
    );
    await saveCategories(['storage diagnostic fixture']);
    const env = environment();
    if (failure === 'r2')
      env.MEDIA = new Proxy(env.MEDIA, {
        get(target, property) {
          if (property === 'put')
            return () => Promise.reject(new Error('private storage error'));
          const value: unknown = Reflect.get(target, property);
          return value;
        },
      });
    if (failure === 'ready_d1')
      await sql(
        `CREATE TRIGGER fail_ready BEFORE UPDATE OF ready_key ON jp_categories BEGIN SELECT RAISE(ABORT,'private ready error'); END;`,
      );
    if (failure === 'terminal_d1')
      await sql(
        `CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON jp_icon_jobs WHEN NEW.status='uncertain' BEGIN SELECT RAISE(ABORT,'private terminal error'); END;`,
      );
    let calls = 0;
    const generate: typeof generateCategoryIcon = (_input, dependencies) => {
      calls++;
      if (failure === 'none') {
        const data = new Uint8Array(1024 * 1024 * 4);
        for (let y = 384; y < 640; y++)
          for (let x = 384; x < 640; x++) data[(y * 1024 + x) * 4 + 3] = 255;
        const source = encode({
          width: 1024,
          height: 1024,
          channels: 4,
          depth: 8,
          data,
        });
        return generateCategoryIcon(
          {
            key: 'synthetic-test-key',
            model: iconModel,
            category: {
              normalized: 'storage diagnostic fixture',
              label: 'storage diagnostic fixture',
            },
          },
          {
            ...dependencies,
            fetch: () =>
              Promise.resolve(
                Response.json(
                  {
                    data: [
                      { b64_json: Buffer.from(source).toString('base64') },
                    ],
                  },
                  {
                    headers: {
                      'x-request-id': 'req_0123456789abcdef0123456789abcdef',
                    },
                  },
                ),
              ),
          },
        );
      }
      return Promise.resolve(
        failure === 'terminal_d1'
          ? { status: 'uncertain' }
          : {
              status: 'ready',
              bytes: failure === 'mask' ? new Uint8Array([1]) : pngBytes(),
            },
      );
    };
    const run = runCategoryIconJobs(env, { now: () => now, generate });
    if (failure === 'terminal_d1') await assert.rejects(run);
    else await run;
    const { text, event } = diagnosticEvent(lines);
    assert.deepEqual(
      Object.keys(event).sort(),
      [
        'event',
        'operationId',
        'stage',
        'reason',
        'elapsedMs',
        ...(failure === 'none' ? ['httpStatus', 'providerRequestId'] : []),
      ].sort(),
    );
    assert.ok(
      'stage' in event &&
        event.stage ===
          (failure === 'mask' ? 'mask' : failure === 'r2' ? 'r2' : 'd1'),
    );
    assert.ok(
      'reason' in event &&
        event.reason ===
          (failure === 'none'
            ? 'ready'
            : failure === 'mask'
              ? 'invalid_mask'
              : 'write_failed'),
    );
    assert.doesNotMatch(text, /private|fixture|synthetic|category-icons\//);
    assert.equal(
      (await latestJob('storage diagnostic fixture')).status,
      failure === 'none'
        ? 'ready'
        : failure === 'terminal_d1'
          ? 'running'
          : 'uncertain',
    );
    assert.equal(
      (await env.MEDIA.list()).objects.length,
      failure === 'mask' || failure === 'r2' || failure === 'terminal_d1'
        ? 0
        : 1,
    );
    if (failure === 'terminal_d1') await sql('DROP TRIGGER fail_terminal;');
    await runCategoryIconJobs(env, { now: () => now + day, generate });
    assert.equal(calls, 1);
    assert.equal(lines.length, 1);
  });
}

void test('a throwing terminal logger cannot change ready D1/R2 state', async (t) => {
  t.mock.method(console, 'info', () => {
    throw new Error('synthetic logger failure');
  });
  await saveCategories(['logger fixture']);
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: () => Promise.resolve({ status: 'ready', bytes: pngBytes() }),
  });
  assert.equal((await latestJob('logger fixture')).status, 'ready');
  assert.equal((await environment().MEDIA.list()).objects.length, 1);
});

void test('a lost lease is diagnosed without reporting ready or dispatching again', async (t) => {
  const lines: unknown[][] = [];
  t.mock.method(console, 'info', (...values: unknown[]) => lines.push(values));
  await saveCategories(['expired diagnostic fixture']);
  let calls = 0;
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: async () => {
      calls++;
      assert.equal(await claimIconJob(environment(), now + 180_000), null);
      return { status: 'ready', bytes: pngBytes() };
    },
  });
  const { event } = diagnosticEvent(lines);
  assert.ok('stage' in event && event.stage === 'd1');
  assert.ok('reason' in event && event.reason === 'lease_lost');
  assert.equal(calls, 1);
  assert.equal(
    (await latestJob('expired diagnostic fixture')).status,
    'uncertain',
  );
  assert.equal(
    (await storedCategory('expired diagnostic fixture')).ready_key,
    null,
  );
});

void test('distinct dispatched generations have independent random operation IDs', async (t) => {
  const lines: unknown[][] = [];
  t.mock.method(console, 'info', (...values: unknown[]) => lines.push(values));
  await saveCategories([
    'first diagnostic fixture',
    'second diagnostic fixture',
  ]);
  const generate: typeof generateCategoryIcon = () =>
    Promise.resolve({ status: 'failed' });
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  await runCategoryIconJobs(environment(), { now: () => now, generate });
  assert.equal(lines.length, 2);
  const first = diagnosticEvent(lines.slice(0, 1)).event;
  const second = diagnosticEvent(lines.slice(1)).event;
  assert.ok('operationId' in first && 'operationId' in second);
  assert.notEqual(first.operationId, second.operationId);
});

void test('new categories reuse a suitable stored icon without another generation or spend', async () => {
  await saveCategories(['ramen']);
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: () => Promise.resolve({ status: 'ready', bytes: pngBytes() }),
  });
  const original = await storedCategory('ramen');
  await saveCategories(['noodles']);
  await drainIconOutbox(environment(), now + 1);
  const reused = await storedCategory('noodles');
  assert.ok(reused.ready_version);
  assert.equal(reused.ready_key, original.ready_key);
  assert.equal(reused.generation, 0);
  assert.equal(await count('jp_icon_jobs'), 1);
  assert.equal(await count('jp_icon_attempts'), 1);
  const privateResponse = await serveCategoryIcon(
    environment(),
    reused.id,
    `${reused.ready_version}.png`,
    () => Promise.resolve([]),
  );
  assert.equal(privateResponse.status, 404);
  const published = await serveCategoryIcon(
    environment(),
    reused.id,
    `${reused.ready_version}.png`,
    () => Promise.resolve(['noodles']),
  );
  assert.equal(published.status, 200);
  assertPrivateHeaders(published);
  assert.deepEqual(new Uint8Array(await published.arrayBuffer()), pngBytes());
  assert.equal(
    (await environment().DB.prepare('SELECT * FROM jp_icon_assets').all())
      .results.length,
    1,
  );
});

void test('a queued synonym reuses an icon completed while waiting, preserving explicit regeneration', async () => {
  await saveCategories(['ramen']);
  await drainIconOutbox(environment(), now);
  await saveCategories(['noodles']);
  await drainIconOutbox(environment(), now + 1);
  let calls = 0;
  const generate: typeof generateCategoryIcon = () => {
    calls++;
    return Promise.resolve({
      status: 'ready',
      bytes: pngBytes(calls === 1 ? 8 : 10),
    });
  };
  await runCategoryIconJobs(environment(), { now: () => now + 2, generate });
  await runCategoryIconJobs(environment(), { now: () => now + 3, generate });
  assert.equal(calls, 1);
  assert.equal((await latestJob('noodles')).attempts, 0);
  assert.equal((await latestJob('noodles')).status, 'ready');
  assert.equal(
    await retryCategoryIcon(environment(), 'noodles', false, now + 4),
    true,
  );
  await runCategoryIconJobs(environment(), { now: () => now + 5, generate });
  assert.equal(calls, 2);
  assert.notEqual(
    (await storedCategory('noodles')).ready_key,
    (await storedCategory('ramen')).ready_key,
  );
  assert.equal(
    (await environment().DB.prepare('SELECT * FROM jp_icon_assets').all())
      .results.length,
    2,
  );
});

void test('missing or corrupt library assets and mismatched modifiers queue a new icon', async () => {
  await saveCategories(['ramen']);
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: () => Promise.resolve({ status: 'ready', bytes: pngBytes() }),
  });
  const original = await storedCategory('ramen');
  await saveCategories(['cold noodles']);
  await drainIconOutbox(environment(), now + 1);
  assert.equal((await storedCategory('cold noodles')).ready_key, null);
  assert.equal((await latestJob('cold noodles')).status, 'pending');
  assert.ok(original.ready_key);
  await environment().MEDIA.delete(original.ready_key);
  await saveCategories(['noodles']);
  await drainIconOutbox(environment(), now + 2);
  assert.equal((await storedCategory('noodles')).ready_key, null);
  assert.equal((await latestJob('noodles')).status, 'pending');
});

void test('dispatch candidate beyond the first fifty pending rows reuses its icon before spending', async () => {
  await saveCategories(['ramen']);
  await drainIconOutbox(environment(), now);
  const targetId = createHash('sha256').update('noodles').digest('hex');
  const waiting: string[] = [];
  for (let index = 0; waiting.length < 50; index++) {
    const label = `waiting fixture ${String(index)}`;
    if (createHash('sha256').update(label).digest('hex') > targetId)
      waiting.push(label);
  }
  for (const label of [...waiting, 'noodles']) {
    await saveCategories([label]);
    await drainIconOutbox(environment(), now + 1);
  }
  await runCategoryIconJobs(environment(), {
    now: () => now,
    generate: () => Promise.resolve({ status: 'ready', bytes: pngBytes() }),
  });
  const calls: string[] = [];
  await runCategoryIconJobs(environment(), {
    now: () => now + 2,
    generate: (input) => {
      calls.push(input.category.normalized);
      return Promise.resolve({ status: 'failed' });
    },
  });
  assert.equal(calls.includes('noodles'), false);
  assert.equal(
    (await storedCategory('noodles')).ready_key,
    (await storedCategory('ramen')).ready_key,
  );
  assert.equal((await latestJob('noodles')).attempts, 0);
});
