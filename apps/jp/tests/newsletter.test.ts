import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { definePlugin, createHookPipeline } from 'emdash';
import { sqlite } from 'emdash/db';
import { createDialect } from 'emdash/db/sqlite';
import { z } from 'zod';
import type { StorageCollection, ConditionalWriteResult } from 'emdash';
import {
  checkNewsletterRun,
  newsletterCron,
  cleanupNewsletter,
  configureNewsletter,
  confirmSubscription,
  pendingDigestPosts,
  requestSubscription,
  runNewsletter,
  type NewsletterContext,
} from '../src/lib/newsletter';
import {
  newsletterExcerpt,
  newsletterHash,
  newsletterSettingsSchema,
  newsletterStatusSchema,
  nextNewsletterSend,
} from '../src/lib/newsletter-model';
import { digestEmail } from '../src/emails/newsletter';

type QueryOptions = NonNullable<Parameters<StorageCollection['query']>[0]>;
type WhereClause = NonNullable<Parameters<StorageCollection['count']>[0]>;
type ContentItem = NonNullable<
  Awaited<ReturnType<NonNullable<NewsletterContext['content']>['get']>>
>;

class MemoryCollection implements StorageCollection {
  rows = new Map<string, { value: unknown; revision: string }>();
  version = 0;
  get(id: string) {
    return Promise.resolve(this.rows.get(id)?.value ?? null);
  }
  exists(id: string) {
    return Promise.resolve(this.rows.has(id));
  }
  put(id: string, value: unknown) {
    this.rows.set(id, {
      value: structuredClone(value),
      revision: String(++this.version),
    });
    return Promise.resolve();
  }
  delete(id: string) {
    return Promise.resolve(this.rows.delete(id));
  }
  getVersioned(id: string) {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  compareAndSet(
    id: string,
    revision: string | null,
    value: unknown,
  ): Promise<ConditionalWriteResult> {
    if ((this.rows.get(id)?.revision ?? null) !== revision)
      return Promise.resolve({ applied: false });
    const nextRevision = String(++this.version);
    this.rows.set(id, {
      value: structuredClone(value),
      revision: nextRevision,
    });
    return Promise.resolve({ applied: true, revision: nextRevision });
  }
  compareAndDelete(id: string, revision: string) {
    if (this.rows.get(id)?.revision !== revision)
      return Promise.resolve({ applied: false });
    this.rows.delete(id);
    return Promise.resolve({ applied: true });
  }
  getMany(ids: string[]) {
    const values = new Map<string, unknown>();
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) values.set(id, row.value);
    }
    return Promise.resolve(values);
  }
  async putMany(items: Array<{ id: string; data: unknown }>) {
    for (const item of items) await this.put(item.id, item.data);
  }
  deleteMany(ids: string[]) {
    return Promise.resolve(
      ids.reduce((sum, id) => sum + Number(this.rows.delete(id)), 0),
    );
  }
  matches(value: unknown, where: WhereClause = {}) {
    const row = z.record(z.string(), z.unknown()).parse(value);
    return Object.entries(where).every(([key, expected]) => {
      if (typeof expected !== 'object' || expected === null)
        return row[key] === expected;
      if ('lt' in expected)
        return z.number().parse(row[key]) < z.number().parse(expected.lt);
      throw new Error('Unexpected test query');
    });
  }
  query(options: QueryOptions = {}) {
    return Promise.resolve({
      items: [...this.rows]
        .filter(([, row]) => this.matches(row.value, options.where))
        .slice(0, options.limit ?? 100)
        .map(([id, row]) => ({ id, data: row.value })),
      hasMore: false,
    });
  }
  count(where?: WhereClause) {
    return Promise.resolve(
      [...this.rows.values()].filter((row) => this.matches(row.value, where))
        .length,
    );
  }
  updateIf(): Promise<never> {
    return Promise.reject(new Error('Unused test operation'));
  }
}
function namespace() {
  const collection = new MemoryCollection();
  return {
    get: (key: string) => collection.get(key),
    set: (key: string, value: unknown) => collection.put(key, value),
    delete: (key: string) => collection.delete(key),
    getVersioned: (key: string) => collection.getVersioned(key),
    compareAndSet: (key: string, revision: string | null, value: unknown) =>
      collection.compareAndSet(key, revision, value),
    compareAndDelete: (key: string, revision: string) =>
      collection.compareAndDelete(key, revision),
  };
}
type Call = {
  path: string;
  method: string;
  body: unknown;
  idempotency: string | null;
};
function fixture() {
  const calls: Call[] = [];
  const posts: ContentItem[] = [];
  const media: ContentItem[] = [];
  const beers: ContentItem[] = [];
  const collections: Record<string, ContentItem[]> = {
    posts,
    media_items: media,
    beers,
  };
  const storage = {
    subscribers: new MemoryCollection(),
    confirmations: new MemoryCollection(),
    limits: new MemoryCollection(),
    sent: new MemoryCollection(),
    runs: new MemoryCollection(),
  };
  let respond = (call: Call): Promise<Response> => {
    if (call.path.startsWith('/contacts/') && call.method === 'GET')
      return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(
      Response.json({ id: 'provider-id', status: 'sent' }),
    );
  };
  const ctx: NewsletterContext = {
    storage,
    kv: namespace(),
    settings: namespace(),
    log: { warn() {} },
    http: {
      async fetch(url, init) {
        const body: unknown =
          typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        const call = {
          path: new URL(url).pathname,
          method: init?.method ?? 'GET',
          body,
          idempotency: new Headers(init?.headers).get('Idempotency-Key'),
        };
        calls.push(call);
        return respond(call);
      },
    },
    content: {
      get(collection, id) {
        return Promise.resolve(
          collections[collection]?.find((post) => post.id === id) ?? null,
        );
      },
      list(collection) {
        return Promise.resolve({
          items: collections[collection] ?? [],
          hasMore: false,
        });
      },
    },
  };
  return {
    ctx,
    calls,
    posts,
    media,
    beers,
    storage,
    setRespond(value: typeof respond) {
      respond = value;
    },
  };
}
function post(id: string, status = 'published', demo = false): ContentItem {
  return {
    id,
    type: 'posts',
    slug: id,
    status,
    locale: null,
    createdAt: '',
    updatedAt: '',
    publishedAt: '',
    data: {
      title: `synthetic entry ${id}`,
      day: '2026-10-15',
      demo,
      content: [
        {
          _type: 'block',
          children: [{ _type: 'span', text: `public story ${id}` }],
        },
      ],
    },
  };
}

void test('first arrival newsletter is day 1 despite an earlier beer entry', async () => {
  const f = fixture();
  const arrival = post('arrival');
  arrival.data.title = 'arrival';
  f.posts.push(arrival);
  f.media.push({
    ...post('photo'),
    type: 'media_items',
    data: { captured_at: '2026-10-14T15:05:00.000Z' },
  });
  f.beers.push({
    ...post('beer'),
    type: 'beers',
    data: { day: '2026-10-14', count: 1 },
  });
  const withBeer = (await pendingDigestPosts(f.ctx))[0]?.title;
  f.beers.length = 0;
  const withoutBeer = (await pendingDigestPosts(f.ctx))[0]?.title;
  assert.deepEqual(
    { withBeer, withoutBeer },
    { withBeer: 'day 1: arrival', withoutBeer: 'day 1: arrival' },
  );
});
async function configured(f: ReturnType<typeof fixture>) {
  await f.ctx.settings.set('apiKey', 'synthetic-key');
  await f.ctx.settings.set('segmentId', 'japan-only');
}
const now = Date.UTC(2026, 9, 18, 9);
async function due(f: ReturnType<typeof fixture>) {
  await configured(f);
  await f.ctx.kv.set('configuration', { enabled: true });
  await f.ctx.kv.set('state', { nextSend: now - 1 });
}

void test('weekly and interval schedules use Japan calendar days and never drift to UTC weekdays', () => {
  const weekly = newsletterSettingsSchema.parse({});
  assert.equal(nextNewsletterSend(weekly, Date.UTC(2026, 9, 16)), now);
  assert.equal(nextNewsletterSend(weekly, now, now), now + 7 * 86_400_000);
  assert.equal(
    nextNewsletterSend({ ...weekly, frequency: 'interval', days: 3 }, now, now),
    now + 3 * 86_400_000,
  );
});
void test('signup only sends a confirmation; token is hashed, expires, and cannot be replayed to resubscribe', async () => {
  const f = fixture();
  await configured(f);
  assert.deepEqual(
    await requestSubscription(
      f.ctx,
      { email: 'reader@example.com' },
      'synthetic-ip',
      'https://jp.bent.build',
      'owner@example.com',
      now,
    ),
    { ok: true },
  );
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/emails'],
  );
  const body = z
    .object({ html: z.string(), reply_to: z.email(), subject: z.string() })
    .parse(f.calls[0]?.body);
  assert.equal(body.reply_to, 'owner@example.com');
  assert.equal(body.subject, 'confirm your email');
  const token = body.html.match(/token=([a-f0-9]{64})/)?.[1];
  assert.ok(token);
  assert.equal(
    [...f.storage.confirmations.rows.keys()][0],
    await newsletterHash(token),
  );
  assert.equal(await f.storage.subscribers.count({ confirmed: true }), 0);
  assert.deepEqual(await confirmSubscription(f.ctx, { token }, now + 1000), {
    ok: true,
  });
  assert.equal(await f.storage.subscribers.count({ confirmed: true }), 1);
  assert.ok(f.calls.some((call) => call.path.endsWith('/segments/japan-only')));
  const count = f.calls.length;
  assert.deepEqual(await confirmSubscription(f.ctx, { token }, now + 2000), {
    ok: true,
  });
  assert.equal(f.calls.length, count);
  assert.ok(!JSON.stringify([...f.storage.confirmations.rows]).includes(token));
});
void test('expired confirmations, malformed addresses and honeypot submissions never add contacts', async () => {
  const f = fixture();
  await configured(f);
  assert.equal(
    (
      await requestSubscription(
        f.ctx,
        { email: 'not-an-address' },
        'ip',
        'https://jp.bent.build',
        'owner@example.com',
        now,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await requestSubscription(
        f.ctx,
        { email: 'reader@example.com', website: 'bot' },
        'ip',
        'https://jp.bent.build',
        'owner@example.com',
        now,
      )
    ).ok,
    true,
  );
  await f.storage.confirmations.put(await newsletterHash('a'.repeat(64)), {
    emailKey: 'unknown',
    consumed: false,
    expiresAt: now - 1,
  });
  assert.equal(
    (await confirmSubscription(f.ctx, { token: 'a'.repeat(64) }, now)).ok,
    false,
  );
  assert.equal(f.calls.length, 0);
});
void test('rate limits and concurrent requests permit only one confirmation email per address per hour', async () => {
  const f = fixture();
  await configured(f);
  await Promise.all(
    Array.from({ length: 12 }, () =>
      requestSubscription(
        f.ctx,
        { email: 'reader@example.com' },
        'ip',
        'https://jp.bent.build',
        'owner@example.com',
        now,
      ),
    ),
  );
  assert.equal(f.calls.filter((call) => call.path === '/emails').length, 1);
});
void test('failed confirmation delivery is reported honestly and remains retryable', async () => {
  const f = fixture();
  await configured(f);
  f.setRespond(() =>
    Promise.resolve(new Response('provider error', { status: 503 })),
  );
  assert.equal(
    (
      await requestSubscription(
        f.ctx,
        { email: 'reader@example.com' },
        'ip',
        'https://jp.bent.build',
        'owner@example.com',
        now,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await requestSubscription(
        f.ctx,
        { email: 'reader@example.com' },
        'ip',
        'https://jp.bent.build',
        'owner@example.com',
        now + 1,
      )
    ).ok,
    false,
  );
  assert.equal(f.calls.length, 2);
});
void test('only public live entries are compiled, including late older days, with drafts and sample data excluded', async () => {
  const f = fixture();
  f.posts.push(
    post('public'),
    post('draft', 'draft'),
    post('sample', 'published', true),
    post('already-sent'),
    post('late'),
  );
  await f.storage.sent.put('already-sent', {});
  assert.deepEqual(
    (await pendingDigestPosts(f.ctx)).map((entry) => entry.id),
    ['public', 'late'],
  );
  assert.equal(
    newsletterExcerpt([{ _type: 'image', alt: 'private metadata' }]),
    '',
  );
});
void test('long stories stay complete in previews, owner tests and subscriber emails', async () => {
  const f = fixture();
  await due(f);
  const story = post('long-story');
  const paragraphs = [
    'A complete first paragraph. '.repeat(30).trim(),
    'A complete second paragraph. '.repeat(30).trim(),
    'The final paragraph must reach the reader.',
  ];
  story.data.content = paragraphs.map((text) => ({
    _type: 'block',
    children: [{ _type: 'span', text }],
  }));
  f.posts.push(story);

  const posts = await pendingDigestPosts(f.ctx);
  assert.equal(posts[0]?.excerpt, paragraphs.join('\n\n'));
  const preview = await digestEmail(posts, 'https://jp.bent.build', true);
  await configureNewsletter(f.ctx, { action: 'test' }, 'owner@example.com');
  await runNewsletter(f.ctx, 'owner@example.com', now);
  const emailSchema = z.object({ html: z.string(), text: z.string() });
  const ownerEmail = emailSchema.parse(
    f.calls.find((call) => call.path === '/emails')?.body,
  );
  const subscriberEmail = emailSchema.parse(
    f.calls.find((call) => call.path === '/broadcasts')?.body,
  );
  for (const email of [preview, ownerEmail, subscriberEmail]) {
    for (const paragraph of paragraphs) {
      assert.ok(email.html.includes(paragraph));
      assert.ok(email.text.includes(paragraph));
    }
  }
});
void test('concurrent schedules create and send one broadcast to the dedicated segment', async () => {
  const f = fixture();
  await due(f);
  f.posts.push(post('one'));
  await Promise.all([
    runNewsletter(f.ctx, 'owner@example.com', now),
    runNewsletter(f.ctx, 'owner@example.com', now),
  ]);
  assert.equal(f.calls.filter((call) => call.path === '/broadcasts').length, 1);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/send')).length, 1);
  const broadcast = z
    .object({
      segment_id: z.string(),
      reply_to: z.string(),
      subject: z.string(),
    })
    .parse(f.calls.find((call) => call.path === '/broadcasts')?.body);
  assert.equal(broadcast.segment_id, 'japan-only');
  assert.equal(broadcast.subject, 'blog updates');
  assert.equal(await f.storage.sent.exists('one'), true);
  await runNewsletter(f.ctx, 'owner@example.com', now + 8 * 86_400_000);
  assert.equal(f.calls.filter((call) => call.path === '/broadcasts').length, 1);
});
void test('quiet periods skip sending and uncertain sends block automatic duplication until reconciled', async () => {
  const f = fixture();
  await due(f);
  await runNewsletter(f.ctx, 'owner@example.com', now);
  assert.equal(f.calls.length, 0);
  f.posts.push(post('one'));
  await f.ctx.kv.set('state', { nextSend: now - 1 });
  f.setRespond((call) => {
    if (call.path.endsWith('/send'))
      return Promise.reject(new Error('unknown delivery result'));
    return Promise.resolve(
      Response.json({ id: 'broadcast-id', status: 'sent' }),
    );
  });
  await runNewsletter(f.ctx, 'owner@example.com', now);
  const before = f.calls.length;
  await runNewsletter(f.ctx, 'owner@example.com', now + 8 * 86_400_000);
  assert.equal(f.calls.length, before);
  await checkNewsletterRun(f.ctx);
  assert.equal(await f.storage.sent.exists('one'), true);
});
void test('scheduled checks reconcile an interrupted send without creating or sending another broadcast', async () => {
  const f = fixture();
  await due(f);
  await f.storage.runs.put('interrupted', {
    status: 'sending',
    createdAt: Date.now() - 180_000,
    postIds: ['one'],
    broadcastId: 'saved-draft',
  });
  await f.ctx.kv.set('state', {
    nextSend: Date.now() + 86_400_000,
    lastRun: 'interrupted',
  });
  f.setRespond(() => Promise.resolve(Response.json({ status: 'draft' })));
  await newsletterCron(() => 'owner@example.com').handler(
    { name: 'digest' },
    f.ctx,
  );
  assert.equal(
    z
      .object({ status: z.string() })
      .parse(await f.storage.runs.get('interrupted')).status,
    'draft',
  );
  assert.deepEqual(
    f.calls.map(({ path, method }) => ({ path, method })),
    [{ path: '/broadcasts/saved-draft', method: 'GET' }],
  );
});

void test('a photo-heavy digest can finish its publication checks after two minutes', async (t) => {
  const f = fixture();
  await due(f);
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  for (let i = 0; i < 6; i++) f.posts.push(post(`entry-${String(i)}`));
  f.ctx.assets = {
    prepare() {
      clock += 11_000;
      return Promise.resolve({ images: [] });
    },
    read: () => Promise.resolve(null),
  };
  await runNewsletter(f.ctx, 'owner@example.com', now);
  assert.equal(f.calls.filter((call) => call.path.endsWith('/send')).length, 1);
  assert.equal(await f.storage.sent.count(), 6);
  assert.ok(clock - now < newsletterCron(() => 'owner@example.com').timeout);
});

void test('expired preparation cannot create a broadcast or consume posts', async (t) => {
  const f = fixture();
  await due(f);
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  f.posts.push(post('one'));
  f.ctx.assets = {
    prepare() {
      clock += 10 * 60_000;
      return Promise.resolve({ images: [] });
    },
    read: () => Promise.resolve(null),
  };
  await assert.rejects(
    runNewsletter(f.ctx, 'owner@example.com', now),
    /Send lease expired/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(await f.storage.sent.count(), 0);
  assert.equal(await f.storage.runs.count(), 0);
});

void test('scheduled reconciliation respects an active lease and never retries unknown outcomes', async () => {
  for (const status of ['active', 'sent', 'queued', 'missing']) {
    const f = fixture();
    await due(f);
    await f.storage.runs.put('interrupted', {
      status: 'sending',
      createdAt: Date.now() - 180_000,
      leaseUntil: status === 'active' ? Date.now() + 60_000 : 0,
      postIds: ['one'],
      broadcastId: 'saved-id',
    });
    await f.ctx.kv.set('state', {
      nextSend: Date.now() + 86_400_000,
      lastRun: 'interrupted',
    });
    f.setRespond(() =>
      Promise.resolve(
        status === 'missing'
          ? new Response(null, { status: 404 })
          : Response.json({ status }),
      ),
    );
    await newsletterCron(() => 'owner@example.com').handler(
      { name: 'digest' },
      f.ctx,
    );
    assert.equal(f.calls.length, status === 'active' ? 0 : 1);
    assert.ok(f.calls.every((call) => call.method === 'GET'));
    assert.equal(await f.storage.sent.exists('one'), status === 'sent');
    assert.equal(
      z
        .object({ status: z.string() })
        .parse(await f.storage.runs.get('interrupted')).status,
      status === 'sent' ? 'sent' : 'sending',
    );
  }
});

void test('publication checks that exhaust the send lease keep the saved draft unsent', async (t) => {
  const f = fixture();
  await due(f);
  let clock = now;
  let checks = 0;
  t.mock.method(Date, 'now', () => clock);
  f.posts.push(post('one'));
  f.ctx.assets = {
    prepare() {
      if (++checks === 2) clock += 9 * 60_000;
      return Promise.resolve({ images: [] });
    },
    read: () => Promise.resolve(null),
  };
  await runNewsletter(f.ctx, 'owner@example.com', now);
  assert.equal(f.calls.filter((call) => call.path === '/broadcasts').length, 1);
  assert.ok(!f.calls.some((call) => call.path.endsWith('/send')));
  assert.equal(await f.storage.sent.count(), 0);
  const [saved] = (await f.storage.runs.query()).items;
  assert.equal(
    z.object({ status: z.string() }).parse(saved?.data).status,
    'uncertain',
  );
});

void test('unpublication during preparation cancels dispatch and leaves an unsent provider draft', async () => {
  const f = fixture();
  await due(f);
  f.posts.push(post('one'));
  f.setRespond((call) => {
    if (call.path === '/broadcasts') f.posts.splice(0);
    return Promise.resolve(Response.json({ id: 'draft-id' }));
  });
  await runNewsletter(f.ctx, 'owner@example.com', now);
  assert.equal(
    f.calls.some((call) => call.path.endsWith('/send')),
    false,
  );
});
void test('owner test emails target only the owner, do not consume posts and escape email HTML', async () => {
  const f = fixture();
  await configured(f);
  f.posts.push(post('one'));
  await configureNewsletter(f.ctx, { action: 'test' }, 'owner@example.com');
  assert.deepEqual(
    z.object({ to: z.array(z.string()) }).parse(f.calls[0]?.body).to,
    ['owner@example.com'],
  );
  assert.equal(
    z.object({ subject: z.string() }).parse(f.calls[0]?.body).subject,
    '[test] blog updates',
  );
  assert.equal(await f.storage.sent.count(), 0);
  const email = await digestEmail([
    {
      id: 'x',
      title: '<script>bad</script>',
      day: '2026-10-15',
      url: 'https://jp.bent.build/posts/x',
      excerpt: '<img src=x onerror=bad>',
    },
  ]);
  assert.ok(!email.html.includes('<script>'));
  assert.ok(email.html.includes('&lt;script&gt;'));
  assert.ok(email.html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}'));
});
void test('digests preserve every photo, place the linked shirt after photos and finish with the shop banner', async () => {
  const source = {
    id: 'photos-and-shirt',
    title: 'day 7: tokyo',
    day: '2026-10-15',
    url: 'https://jp.bent.build/posts/tokyo',
    excerpt: 'A journal entry with four photos.',
    images: Array.from({ length: 4 }, (_, index) => ({
      src: `cid:photo-${String(index)}`,
      alt: `Photo ${String(index + 1)}`,
      width: 1120,
      height: 747,
    })),
    shopDesign: {
      productUrl:
        'https://shop.bent.build/featured/3d8ed467-55d4-45ed-ba9d-1eeb687fa5bc',
      color: 'black',
      image: {
        src: 'cid:shirt',
        alt: 'Black shirt design',
        width: 768,
        height: 768,
      },
    },
  };
  const schema = newsletterStatusSchema.shape.posts.element;
  const post = schema.parse(source);
  const email = await digestEmail([post]);
  let previous = -1;
  for (const image of source.images) {
    const position = email.html.indexOf(`src="${image.src}"`);
    assert.ok(position > previous);
    previous = position;
  }
  const shirt = email.html.indexOf('src="cid:shirt"');
  const banner = email.html.indexOf(
    'src="https://jp.bent.build/brand/shop-logo-email.png"',
  );
  assert.ok(shirt > previous);
  assert.ok(banner > shirt);
  assert.ok(email.html.indexOf('unsubscribe') > banner);
  assert.ok(email.html.includes('Color=Black'));
  assert.equal(
    schema.safeParse({
      ...source,
      shopDesign: {
        ...source.shopDesign,
        productUrl: 'https://unrelated.example/product',
      },
    }).success,
    false,
  );
  const withoutDesign = await digestEmail([
    { ...post, images: [], shopDesign: undefined },
  ]);
  assert.ok(!withoutDesign.html.includes('SHOP DESIGN'));
  assert.ok(withoutDesign.html.includes('shop.bent.build ↗'));
});
void test('digest headings retain trip numbering across sent entries and correct stale day prefixes', async () => {
  const f = fixture();
  const first = post('first');
  first.data.day = '2026-10-10';
  f.posts.push(first, post('later'));
  await f.storage.sent.put('first', { runId: 'previous-week' });
  const posts = await pendingDigestPosts(f.ctx);
  assert.equal(posts[0]?.title, 'day 6: synthetic entry later');
  const later = f.posts[1];
  assert.ok(later);
  later.data.title = 'day 9: owner title';
  assert.equal(
    (await pendingDigestPosts(f.ctx))[0]?.title,
    'day 6: owner title',
  );
});

void test('newsletter numbering uses paged Japan captures and ignores earlier unrelated posts and beer entries', async () => {
  const f = fixture();
  const arrival = post('arrival');
  arrival.data.title = 'day 8: Arrival';
  f.posts.push(arrival);
  f.ctx.content = {
    get: (_collection, id) =>
      Promise.resolve(f.posts.find((item) => item.id === id) ?? null),
    list: (collection, options) =>
      Promise.resolve(
        collection === 'media_items'
          ? options?.cursor
            ? {
                items: [
                  {
                    ...post('photo'),
                    type: 'media_items',
                    data: { captured_at: '2026-10-14T15:00:00.001Z' },
                  },
                ],
                hasMore: false,
              }
            : {
                items: [
                  {
                    ...post('draft photo', 'draft'),
                    type: 'media_items',
                    data: { captured_at: '2026-10-01T00:00:00Z' },
                  },
                ],
                hasMore: true,
                cursor: 'next',
              }
          : { items: f.posts, hasMore: false },
      ),
  };
  assert.equal((await pendingDigestPosts(f.ctx))[0]?.title, 'day 1: Arrival');
  const email = await digestEmail(await pendingDigestPosts(f.ctx));
  assert.ok(email.html.includes('day 1: Arrival'));
  assert.ok(!email.html.includes('day 8: Arrival'));
  assert.match(email.text, /day 1: arrival/i);
  assert.doesNotMatch(email.text, /day 8: arrival/i);
});

void test('photo changes after broadcast preparation prevent sending the saved snapshot', async () => {
  const f = fixture();
  await due(f);
  f.posts.push(post('one'));
  let version = 'original';
  f.ctx.assets = {
    prepare: () =>
      Promise.resolve({
        images: [
          {
            src: `https://jp.bent.build/${version}.jpg`,
            alt: 'published photo',
            width: 560,
            height: 400,
          },
        ],
      }),
    read: () => Promise.resolve(null),
  };
  f.setRespond((call) => {
    if (call.path === '/broadcasts') version = 'changed';
    return Promise.resolve(
      Response.json({ id: 'provider-id', status: 'draft' }),
    );
  });
  await runNewsletter(f.ctx, 'owner@example.com', now);
  assert.ok(!f.calls.some((call) => call.path.endsWith('/send')));
  await checkNewsletterRun(f.ctx);
  await assert.rejects(
    configureNewsletter(f.ctx, { action: 'resume' }, 'owner@example.com'),
    /Delivery still needs checking/,
  );
  assert.ok(!f.calls.some((call) => call.path.endsWith('/send')));
});
void test('cleanup removes expired confirmations and unconfirmed addresses without removing confirmed subscriptions', async () => {
  const f = fixture();
  await configured(f);
  await requestSubscription(
    f.ctx,
    { email: 'reader@example.com' },
    'ip',
    'https://jp.bent.build',
    'owner@example.com',
    now,
  );
  await cleanupNewsletter(f.ctx, now + 8 * 86_400_000);
  assert.equal(await f.storage.subscribers.count(), 0);
  assert.equal(await f.storage.confirmations.count(), 0);
});

void test('an invalid replacement key cannot overwrite a working connection', async () => {
  const f = fixture();
  await configured(f);
  f.setRespond(() =>
    Promise.resolve(new Response('invalid key', { status: 401 })),
  );
  await assert.rejects(
    configureNewsletter(
      f.ctx,
      { action: 'connect', apiKey: 're_' + 'x'.repeat(20) },
      'owner@example.com',
    ),
  );
  assert.equal(await f.ctx.settings.get('apiKey'), 'synthetic-key');
  assert.equal(await f.ctx.settings.get('segmentId'), 'japan-only');
});

void test('recovery reuses the saved broadcast and rejects changed live content', async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    await due(f);
    f.posts.push(post('one'));
    let failSend = true;
    f.setRespond((call) => {
      if (call.path.endsWith('/send') && failSend)
        return Promise.reject(new Error('unknown result'));
      return Promise.resolve(
        Response.json({ id: 'saved-id', status: 'draft' }),
      );
    });
    await runNewsletter(f.ctx, 'owner@example.com', now);
    await checkNewsletterRun(f.ctx);
    if (changed) {
      const live = f.posts[0];
      if (live) live.data.title = 'changed after preparation';
    }
    failSend = false;
    if (changed) {
      await assert.rejects(
        configureNewsletter(f.ctx, { action: 'resume' }, 'owner@example.com'),
      );
      assert.equal(await f.storage.sent.exists('one'), false);
    } else {
      await configureNewsletter(
        f.ctx,
        { action: 'resume' },
        'owner@example.com',
      );
      assert.equal(await f.storage.sent.exists('one'), true);
    }
    assert.equal(
      f.calls.filter((call) => call.path === '/broadcasts').length,
      1,
    );
    assert.equal(
      f.calls.filter((call) => call.path === '/broadcasts/saved-id/send')
        .length,
      changed ? 1 : 2,
    );
  }
});

void test('owner can discard a verified unsent changed draft and rebuild at the next due time', async () => {
  const f = fixture();
  await due(f);
  f.posts.push(post('one'));
  let failSend = true;
  f.setRespond((call) => {
    if (call.path.endsWith('/send') && failSend)
      return Promise.reject(new Error('unknown send'));
    if (call.method === 'DELETE')
      return Promise.resolve(Response.json({ deleted: true }));
    return Promise.resolve(Response.json({ id: 'saved-id', status: 'draft' }));
  });
  await runNewsletter(f.ctx, 'owner@example.com', now);
  await checkNewsletterRun(f.ctx);
  const live = f.posts[0];
  if (live) live.data.title = 'corrected public title';
  await assert.rejects(
    configureNewsletter(f.ctx, { action: 'resume' }, 'owner@example.com'),
  );
  await checkNewsletterRun(f.ctx);
  await configureNewsletter(f.ctx, { action: 'discard' }, 'owner@example.com');
  assert.equal(await f.storage.sent.exists('one'), false);
  assert.equal(f.calls.filter((call) => call.method === 'DELETE').length, 1);
  failSend = false;
  await runNewsletter(f.ctx, 'owner@example.com', now + 8 * 86_400_000);
  assert.equal(f.calls.filter((call) => call.path === '/broadcasts').length, 2);
  assert.equal(await f.storage.sent.exists('one'), true);
});

void test('unknown draft deletion stays blocked until its missing saved ID is reconciled', async () => {
  const f = fixture();
  await due(f);
  f.posts.push(post('one'));
  let deleted = false;
  f.setRespond((call) => {
    if (call.path.endsWith('/send'))
      return Promise.reject(new Error('unknown send'));
    if (call.method === 'DELETE') {
      deleted = true;
      return Promise.reject(new Error('lost deletion response'));
    }
    if (deleted) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(Response.json({ id: 'saved-id', status: 'draft' }));
  });
  await runNewsletter(f.ctx, 'owner@example.com', now);
  await checkNewsletterRun(f.ctx);
  await assert.rejects(
    configureNewsletter(f.ctx, { action: 'discard' }, 'owner@example.com'),
  );
  const before = f.calls.length;
  await runNewsletter(f.ctx, 'owner@example.com', now + 8 * 86_400_000);
  assert.equal(f.calls.length, before);
  await checkNewsletterRun(f.ctx);
  assert.equal(
    (await configureNewsletter(f.ctx, { action: 'check' }, 'owner@example.com'))
      .lastRun?.status,
    'discarded',
  );
  assert.equal(await f.storage.sent.exists('one'), false);
});

void test('discard reconciles an already sent broadcast without deleting or releasing its posts', async () => {
  const f = fixture();
  await due(f);
  f.posts.push(post('one'));
  let delivered = false;
  f.setRespond((call) => {
    if (call.path.endsWith('/send'))
      return Promise.reject(new Error('unknown send'));
    return Promise.resolve(
      Response.json({ id: 'saved-id', status: delivered ? 'sent' : 'draft' }),
    );
  });
  await runNewsletter(f.ctx, 'owner@example.com', now);
  await checkNewsletterRun(f.ctx);
  delivered = true;
  await configureNewsletter(f.ctx, { action: 'discard' }, 'owner@example.com');
  assert.equal(
    f.calls.some((call) => call.method === 'DELETE'),
    false,
  );
  assert.equal(await f.storage.sent.exists('one'), true);
});

void test(
  'the native cron pipeline awaits slow providers and photo-heavy publication checks',
  { timeout: 20_000 },
  async (t) => {
    const moduleHooks = registerHooks({
      resolve(specifier, context, next) {
        return specifier === 'virtual:emdash/config'
          ? {
              url: 'data:text/javascript,export default {}',
              shortCircuit: true,
            }
          : next(specifier, context);
      },
      load(url, context, next) {
        return url.includes('/dist/emdash-runtime-')
          ? {
              format: 'module',
              source: `import.meta.env = { DEV: false };\n${readFileSync(new URL(url), 'utf8')}`,
              shortCircuit: true,
            }
          : next(url, context);
      },
    });
    let destroy: (() => Promise<void>) | undefined;
    try {
      const { EmDashRuntime } =
        await import('emdash/internal/plugin-test-runtime');
      const cms = await EmDashRuntime.create({
        config: { database: sqlite({ url: ':memory:' }) },
        createDialect: () => createDialect({ url: ':memory:' }),
        createStorage: null,
        plugins: [],
        sandboxEnabled: false,
        sandboxedPluginEntries: [],
        createSandboxRunner: null,
        siteInfo: { url: 'http://localhost', name: 'synthetic', locale: 'en' },
      });
      destroy = () => cms.db.destroy();
      const f = fixture();
      await due(f);
      await f.ctx.kv.set('state', { nextSend: Date.now() - 1 });
      f.posts.push(post('one'));
      f.setRespond(async (call) => {
        if (call.path === '/broadcasts') await setTimeout(5_500);
        return Response.json({ id: 'slow-id', status: 'sent' });
      });
      const hook = newsletterCron(() => 'owner@example.com');
      const plugin = definePlugin({
        id: 'japan-newsletter',
        version: '1.0.0',
        hooks: {
          cron: { ...hook, handler: (event) => hook.handler(event, f.ctx) },
        },
      });
      const pipeline = createHookPipeline([plugin], { db: cms.db });
      const result = await pipeline.invokeCronHook('japan-newsletter', {
        name: 'digest',
        scheduledAt: new Date().toISOString(),
      });
      assert.equal(result.success, true, result.error?.message);
      assert.equal(await f.storage.sent.exists('one'), true);

      const heavy = fixture();
      await due(heavy);
      for (let i = 0; i < 6; i++) heavy.posts.push(post(`heavy-${String(i)}`));
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
      heavy.ctx.assets = {
        prepare() {
          t.mock.timers.tick(11_000);
          return Promise.resolve({ images: [] });
        },
        read: () => Promise.resolve(null),
      };
      const heavyPlugin = definePlugin({
        id: 'japan-newsletter',
        version: '1.0.0',
        hooks: {
          cron: { ...hook, handler: (event) => hook.handler(event, heavy.ctx) },
        },
      });
      const heavyPipeline = createHookPipeline([heavyPlugin], { db: cms.db });
      const heavyResult = await heavyPipeline.invokeCronHook(
        'japan-newsletter',
        {
          name: 'digest',
          scheduledAt: new Date(now).toISOString(),
        },
      );
      assert.equal(heavyResult.success, true, heavyResult.error?.message);
      assert.equal(await heavy.storage.sent.count(), 6);
      t.mock.timers.reset();
    } finally {
      await destroy?.();
      moduleHooks.deregister();
    }
  },
);

void test('saving a schedule preserves a delivery record created concurrently', async () => {
  const f = fixture();
  await configured(f);
  await f.ctx.kv.set('state', { nextSend: now });
  await f.storage.runs.put('new-run', {
    status: 'sent',
    createdAt: now,
    postIds: [],
  });
  const original = f.ctx.kv.getVersioned.bind(f.ctx.kv);
  let interleave = true;
  f.ctx.kv.getVersioned = async (key) => {
    const previous = await original(key);
    if (key === 'state' && interleave) {
      interleave = false;
      await f.ctx.kv.set('state', { nextSend: now, lastRun: 'new-run' });
    }
    return previous;
  };
  const result = await configureNewsletter(
    f.ctx,
    { action: 'settings', settings: {} },
    'owner@example.com',
  );
  assert.equal(result.lastRun?.id, 'new-run');
});
