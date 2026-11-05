import { z } from 'zod';
import type {
  PluginContext,
  StorageCollection,
  ContentAccess,
  MediaAccess,
} from 'emdash';
import { confirmationEmail, digestEmail } from '../emails/newsletter';
import {
  newsletterExcerpt,
  newsletterFrom,
  newsletterHash,
  newsletterSettingsSchema,
  newsletterUrl,
  nextNewsletterSend,
  type DigestPost,
} from './newsletter-model';
import { daySchema } from './model';
import { numberedTripTitle, readTripStartDay } from './trip-days';
import type { NewsletterAssets } from './newsletter-assets';

const hour = 3600_000;
// Leave a minute for recording an interrupted run before the hook times out.
const sendLeaseMs = 9 * 60_000;
const cronTimeoutMs = 10 * 60_000;
const providerTimeoutMs = 12_000;
const subscriberSchema = z.object({
  email: z.email(),
  confirmed: z.boolean(),
  createdAt: z.number(),
  requestedAt: z.number(),
  confirmedAt: z.number().optional(),
  consentVersion: z.literal('japan-journal-v1'),
});
const confirmationSchema = z.object({
  emailKey: z.string(),
  expiresAt: z.number(),
  consumed: z.boolean(),
  leaseUntil: z.number().optional(),
});
const runSchema = z.object({
  status: z.enum([
    'preparing',
    'sending',
    'sent',
    'uncertain',
    'failed',
    'draft',
    'discarding',
    'discarded',
  ]),
  createdAt: z.number(),
  postIds: z.array(z.string()),
  broadcastId: z.string().optional(),
  postHashes: z.record(z.string(), z.string()).optional(),
  leaseUntil: z.number().optional(),
  discardRequested: z.boolean().optional(),
});
const stateSchema = z.object({
  nextSend: z.number(),
  lastRun: z.string().optional(),
});
const settingsKey = 'configuration';
type NewsletterNamespace = Pick<
  PluginContext['kv'],
  'set' | 'delete' | 'compareAndSet' | 'compareAndDelete'
> & {
  get(key: string): Promise<unknown>;
  getVersioned(
    key: string,
  ): Promise<{ value: unknown; revision: string } | null>;
};
export type NewsletterContext = {
  storage: PluginContext['storage'];
  kv: NewsletterNamespace;
  settings: Pick<PluginContext['settings'], 'set'> & {
    get(key: string): Promise<unknown>;
  };
  content?: Pick<ContentAccess, 'get' | 'list'>;
  media?: Pick<MediaAccess, 'get' | 'readBytes'>;
  assets?: NewsletterAssets;
  http?: PluginContext['http'];
  cron?: PluginContext['cron'];
  log: Pick<PluginContext['log'], 'warn'>;
};

function store(ctx: NewsletterContext, name: string): StorageCollection {
  const collection = ctx.storage[name];
  if (!collection) throw new Error('Newsletter storage unavailable');
  return collection;
}
async function newsletterSettings(ctx: NewsletterContext) {
  return newsletterSettingsSchema.parse((await ctx.kv.get(settingsKey)) ?? {});
}
async function provider(
  ctx: NewsletterContext,
  path: string,
  method = 'GET',
  body?: unknown,
  idempotency?: string,
  candidateKey?: string,
) {
  const key = z
    .string()
    .min(1)
    .parse(candidateKey ?? (await ctx.settings.get('apiKey')));
  if (!ctx.http) throw new Error('Newsletter transport unavailable');
  const response = await ctx.http.fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(providerTimeoutMs),
  });
  if (response.status === 404 && method === 'GET') return null;
  if (!response.ok)
    throw new Error(
      `Newsletter provider request failed (${String(response.status)})`,
    );
  if (response.status === 204) return null;
  const value: unknown = await response.json();
  return value;
}

async function limit(
  ctx: NewsletterContext,
  key: string,
  maximum: number,
  window: number,
  now: number,
) {
  const buckets = store(ctx, 'limits');
  const id = `${key}:${String(Math.floor(now / window))}`;
  const schema = z.object({ count: z.number(), expiresAt: z.number() });
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await buckets.getVersioned(id);
    const current = previous
      ? schema.parse(previous.value)
      : { count: 0, expiresAt: now + window * 2 };
    if (current.count >= maximum) return false;
    const saved = await buckets.compareAndSet(id, previous?.revision ?? null, {
      ...current,
      count: current.count + 1,
    });
    if (saved.applied) return true;
  }
  return false;
}

export async function requestSubscription(
  ctx: NewsletterContext,
  input: unknown,
  ip: string,
  publicUrl: string,
  ownerEmail: string,
  now = Date.now(),
) {
  const parsed = z
    .object({
      email: z.email().max(254),
      website: z.string().max(200).default(''),
    })
    .safeParse(input);
  if (!parsed.success)
    return { ok: false, message: 'enter a valid email address.' };
  if (parsed.data.website) return { ok: true };
  if (
    !(await ctx.settings.get('apiKey')) ||
    !(await ctx.settings.get('segmentId')) ||
    !z.email().safeParse(ownerEmail).success
  )
    return {
      ok: false,
      message: 'signups are temporarily unavailable. please try again later.',
    };
  if (
    !(await limit(ctx, `ip:${await newsletterHash(ip)}`, 5, hour, now)) ||
    !(await limit(ctx, 'daily', 90, 24 * hour, now))
  )
    return { ok: true };
  const email = parsed.data.email.toLowerCase();
  const emailKey = await newsletterHash(email);
  const subscribers = store(ctx, 'subscribers');
  const previous = await subscribers.getVersioned(emailKey);
  const current = previous ? subscriberSchema.parse(previous.value) : undefined;
  if (current && current.requestedAt + hour > now) return { ok: true };
  const saved = await subscribers.compareAndSet(
    emailKey,
    previous?.revision ?? null,
    {
      email,
      confirmed: current?.confirmed ?? false,
      createdAt: current?.createdAt ?? now,
      requestedAt: now,
      consentVersion: 'japan-journal-v1',
      ...(current?.confirmedAt ? { confirmedAt: current.confirmedAt } : {}),
    },
  );
  if (!saved.applied) return { ok: true };
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const tokenHash = await newsletterHash(token);
  await store(ctx, 'confirmations').put(tokenHash, {
    emailKey,
    expiresAt: now + 24 * hour,
    consumed: false,
  });
  try {
    const emailBody = await confirmationEmail(
      `${publicUrl}/newsletter/confirm?token=${token}`,
    );
    await provider(
      ctx,
      '/emails',
      'POST',
      {
        from: newsletterFrom,
        to: [email],
        reply_to: ownerEmail,
        subject: 'confirm your email',
        ...emailBody,
      },
      `japan-confirm-${tokenHash}`,
    );
    return { ok: true };
  } catch {
    // Failed delivery must remain retryable. Do not disclose the provider error or address.
    await subscribers.compareAndSet(emailKey, saved.revision, {
      email,
      confirmed: current?.confirmed ?? false,
      createdAt: current?.createdAt ?? now,
      requestedAt: 0,
      consentVersion: 'japan-journal-v1',
      ...(current?.confirmedAt ? { confirmedAt: current.confirmedAt } : {}),
    });
    return {
      ok: false,
      message: 'we couldn’t send the confirmation. please try again.',
    };
  }
}

export async function confirmSubscription(
  ctx: NewsletterContext,
  input: unknown,
  now = Date.now(),
) {
  const parsed = z
    .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(input);
  if (!parsed.success)
    return { ok: false, message: 'this confirmation link is invalid.' };
  const tokenHash = await newsletterHash(parsed.data.token);
  const confirmations = store(ctx, 'confirmations');
  const stored = await confirmations.getVersioned(tokenHash);
  if (!stored)
    return {
      ok: false,
      message: 'this link has expired. please sign up again.',
    };
  const confirmation = confirmationSchema.parse(stored.value);
  if (confirmation.consumed) return { ok: true };
  if (confirmation.expiresAt < now)
    return {
      ok: false,
      message: 'this link has expired. please sign up again.',
    };
  if ((confirmation.leaseUntil ?? 0) > now)
    return {
      ok: false,
      message: 'confirmation is in progress. please try again shortly.',
    };
  const claim = await confirmations.compareAndSet(tokenHash, stored.revision, {
    ...confirmation,
    leaseUntil: now + 120_000,
  });
  if (!claim.applied)
    return { ok: false, message: 'please try confirming again.' };
  const subscribers = store(ctx, 'subscribers');
  const storedSubscriber = await subscribers.getVersioned(
    confirmation.emailKey,
  );
  if (!storedSubscriber) return { ok: false, message: 'please sign up again.' };
  const subscriber = subscriberSchema.parse(storedSubscriber.value);
  try {
    const segmentId = z
      .string()
      .min(1)
      .parse(await ctx.settings.get('segmentId'));
    // Explicit reconfirmation is required before a previously unsubscribed
    // contact may be subscribed again. Repeated confirmation is idempotent.
    const contactPath = `/contacts/${encodeURIComponent(subscriber.email)}`;
    const existing = await provider(ctx, contactPath);
    if (existing)
      await provider(ctx, contactPath, 'PATCH', { unsubscribed: false });
    else
      await provider(ctx, '/contacts', 'POST', {
        email: subscriber.email,
        unsubscribed: false,
      });
    await provider(
      ctx,
      `/contacts/${encodeURIComponent(subscriber.email)}/segments/${encodeURIComponent(segmentId)}`,
      'POST',
    );
    const updated = await subscribers.compareAndSet(
      confirmation.emailKey,
      storedSubscriber.revision,
      { ...subscriber, confirmed: true, confirmedAt: now },
    );
    if (!updated.applied)
      return { ok: false, message: 'please try confirming again.' };
    await confirmations.compareAndSet(tokenHash, claim.revision, {
      ...confirmation,
      consumed: true,
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: 'confirmation is temporarily unavailable. please try again.',
    };
  } finally {
    await confirmations.compareAndSet(tokenHash, claim.revision, {
      ...confirmation,
      leaseUntil: 0,
    });
  }
}

async function newsletterFirstDay(ctx: NewsletterContext) {
  return readTripStartDay(async (collection, cursor) => {
    const page = await ctx.content?.list(collection, {
      where: { status: 'published' },
      limit: 100,
      cursor,
      orderBy: {
        [collection === 'media_items' ? 'captured_at' : 'day']: 'asc',
      },
    });
    return {
      items: page?.items ?? [],
      nextCursor: page?.hasMore ? page.cursor : undefined,
    };
  });
}

async function newsletterPost(
  ctx: NewsletterContext,
  item: NonNullable<Awaited<ReturnType<ContentAccess['get']>>>,
  firstDay: string | undefined,
): Promise<DigestPost | null> {
  if (item.status !== 'published' || !item.slug || item.data.demo) return null;
  const parsed = z
    .object({ title: z.string(), day: daySchema })
    .safeParse(item.data);
  if (!parsed.success) return null;
  const { day, title } = parsed.data;
  return {
    id: item.id,
    title: numberedTripTitle(day, firstDay || day, title),
    day,
    url: `${newsletterUrl}/posts/${encodeURIComponent(item.slug)}`,
    excerpt: newsletterExcerpt(item.data.content),
    ...(await ctx.assets?.prepare(item)),
  };
}

export async function pendingDigestPosts(
  ctx: NewsletterContext,
): Promise<DigestPost[]> {
  if (!ctx.content) throw new Error('Newsletter content unavailable');
  const firstDay = await newsletterFirstDay(ctx);
  const posts: DigestPost[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.content.list('posts', {
      limit: 100,
      cursor,
      where: { status: 'published' },
      orderBy: { day: 'asc' },
    });
    const sent = await store(ctx, 'sent').getMany(
      page.items.map((item) => item.id),
    );
    for (const item of page.items) {
      // ContentAccess reads the live columns, not the staged revision.
      if (
        item.status !== 'published' ||
        !item.slug ||
        item.data.demo ||
        sent.has(item.id)
      )
        continue;
      const post = await newsletterPost(ctx, item, firstDay);
      if (!post) continue;
      posts.push(post);
      if (posts.length === 24) return posts;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return posts;
}

async function completeRun(
  ctx: NewsletterContext,
  id: string,
  run: z.infer<typeof runSchema>,
) {
  await store(ctx, 'sent').putMany(
    run.postIds.map((postId) => ({ id: postId, data: { runId: id } })),
  );
  await store(ctx, 'runs').put(id, { ...run, status: 'sent' });
}

export async function checkNewsletterRun(ctx: NewsletterContext) {
  const state = stateSchema.parse(await ctx.kv.get('state'));
  if (!state.lastRun) return;
  const runs = store(ctx, 'runs');
  const stored = await runs.getVersioned(state.lastRun);
  if (!stored) return;
  const run = runSchema.parse(stored.value);
  if (run.status === 'sent' || run.status === 'discarded') return;
  if (
    ['preparing', 'sending', 'discarding'].includes(run.status) &&
    (run.leaseUntil ?? run.createdAt + 120_000) > Date.now()
  )
    return;
  if (run.broadcastId) {
    const broadcast = z
      .object({ status: z.string() })
      .nullable()
      .parse(
        await provider(
          ctx,
          `/broadcasts/${encodeURIComponent(run.broadcastId)}`,
        ),
      );
    if (!broadcast) {
      if (run.discardRequested)
        await runs.compareAndSet(state.lastRun, stored.revision, {
          ...run,
          status: 'discarded',
        });
      return;
    }
    if (broadcast.status === 'sent') await completeRun(ctx, state.lastRun, run);
    else if (broadcast.status === 'draft')
      await runs.compareAndSet(state.lastRun, stored.revision, {
        ...run,
        status: 'draft',
      });
  } else if (run.createdAt + 120_000 < Date.now()) {
    // Only draft broadcasts are created before the ID is durably saved.
    await runs.compareAndSet(state.lastRun, stored.revision, {
      ...run,
      status: 'failed',
    });
  }
}

async function resumeNewsletterRun(ctx: NewsletterContext) {
  const startedAt = Date.now();
  const state = stateSchema.parse(await ctx.kv.get('state'));
  if (!state.lastRun) throw new Error('No saved newsletter');
  const runs = store(ctx, 'runs');
  const stored = await runs.getVersioned(state.lastRun);
  if (!stored) throw new Error('No saved newsletter');
  const run = runSchema.parse(stored.value);
  if (run.status !== 'draft' || !run.broadcastId)
    throw new Error('Check delivery before resuming a saved draft');
  const claim = await runs.compareAndSet(state.lastRun, stored.revision, {
    ...run,
    status: 'sending',
    leaseUntil: startedAt + sendLeaseMs,
  });
  if (!claim.applied)
    throw new Error('This newsletter is already being checked');
  try {
    const broadcast = z
      .object({ status: z.string() })
      .parse(
        await provider(
          ctx,
          `/broadcasts/${encodeURIComponent(run.broadcastId)}`,
        ),
      );
    if (broadcast.status === 'draft') {
      // A previously prepared draft may contain entries that were later
      // unpublished. Check current live entries before any recovery send.
      const firstDay = await newsletterFirstDay(ctx);
      for (const id of run.postIds) {
        const post = await ctx.content?.get('posts', id);
        if (
          !post ||
          post.status !== 'published' ||
          post.data.demo ||
          !post.slug ||
          !run.postHashes ||
          run.postHashes[id] !==
            (await newsletterHash(
              JSON.stringify(await newsletterPost(ctx, post, firstDay)),
            ))
        )
          throw new Error('Publication changed');
      }
      const current = await runs.getVersioned(state.lastRun);
      if (
        current?.revision !== claim.revision ||
        Date.now() - startedAt >= sendLeaseMs - providerTimeoutMs
      )
        throw new Error('Send lease expired');
      await provider(
        ctx,
        `/broadcasts/${encodeURIComponent(run.broadcastId)}/send`,
        'POST',
        {},
      );
    } else if (broadcast.status !== 'sent')
      throw new Error('Delivery is still uncertain');
    // Always reuse the saved provider ID, even if another request sent it while
    // we were checking. An uncertain run never gets a replacement broadcast.
    await completeRun(ctx, state.lastRun, run);
  } catch {
    await runs.compareAndSet(state.lastRun, claim.revision, {
      ...run,
      status: 'uncertain',
    });
    throw new Error(
      'Delivery still needs checking. No replacement email was created.',
    );
  }
}

async function discardNewsletterRun(ctx: NewsletterContext) {
  const state = stateSchema.parse(await ctx.kv.get('state'));
  if (!state.lastRun) throw new Error('No saved newsletter');
  const runs = store(ctx, 'runs');
  const stored = await runs.getVersioned(state.lastRun);
  if (!stored) throw new Error('No saved newsletter');
  const run = runSchema.parse(stored.value);
  if (run.status !== 'draft' || !run.broadcastId)
    throw new Error('Check delivery before discarding a draft');
  const claim = await runs.compareAndSet(state.lastRun, stored.revision, {
    ...run,
    status: 'discarding',
    leaseUntil: Date.now() + 120_000,
  });
  if (!claim.applied)
    throw new Error('This newsletter is already being checked');
  let discardRequested = false;
  let revision = claim.revision;
  try {
    const path = `/broadcasts/${encodeURIComponent(run.broadcastId)}`;
    const broadcast = z
      .object({ status: z.string() })
      .parse(await provider(ctx, path));
    if (broadcast.status === 'sent') {
      await completeRun(ctx, state.lastRun, run);
      return;
    }
    if (broadcast.status !== 'draft')
      throw new Error('Delivery is still uncertain');
    // Persist intent before deletion. A later confirmed 404 can reconcile a
    // lost deletion response without creating a replacement during uncertainty.
    const intent = await runs.compareAndSet(state.lastRun, claim.revision, {
      ...run,
      status: 'discarding',
      discardRequested: true,
      leaseUntil: Date.now() + 120_000,
    });
    if (!intent.applied) throw new Error('Draft changed');
    discardRequested = true;
    revision = intent.revision;
    z.object({ deleted: z.literal(true) }).parse(
      await provider(ctx, path, 'DELETE'),
    );
    await runs.compareAndSet(state.lastRun, intent.revision, {
      ...run,
      status: 'discarded',
      discardRequested: true,
    });
  } catch {
    await runs.compareAndSet(state.lastRun, revision, {
      ...run,
      status: 'uncertain',
      discardRequested,
    });
    throw new Error(
      'Delivery still needs checking. No replacement email was created.',
    );
  }
}

export function newsletterCron(
  ownerEmail: () => string,
  prepare: (ctx: NewsletterContext) => NewsletterContext = (ctx) => ctx,
) {
  return {
    timeout: cronTimeoutMs,
    async handler(event: { name: string }, ctx: NewsletterContext) {
      if (event.name !== 'digest') return;
      try {
        const prepared = prepare(ctx);
        if (await prepared.kv.get('state')) await checkNewsletterRun(prepared);
        await runNewsletter(prepared, ownerEmail());
        await cleanupNewsletter(ctx);
      } catch {
        ctx.log.warn('newsletter_schedule_failed');
      }
    },
  };
}

export async function runNewsletter(
  ctx: NewsletterContext,
  ownerEmail: string,
  now = Date.now(),
) {
  const startedAt = Date.now();
  const settings = await newsletterSettings(ctx);
  if (!settings.enabled || !(await ctx.settings.get('apiKey')) || !ownerEmail)
    return;
  const previousLock = await ctx.kv.getVersioned('send-lock');
  const expires = z.number().safeParse(previousLock?.value);
  if (expires.success && expires.data > now) return;
  const lock = await ctx.kv.compareAndSet(
    'send-lock',
    previousLock?.revision ?? null,
    now + sendLeaseMs,
  );
  if (!lock.applied) return;
  const lockRevision = lock.revision;
  async function requireSendLease() {
    const currentLock = await ctx.kv.getVersioned('send-lock');
    if (
      currentLock?.revision !== lockRevision ||
      Date.now() - startedAt >= sendLeaseMs - providerTimeoutMs
    )
      throw new Error('Send lease expired');
  }
  try {
    const state = stateSchema.parse(
      (await ctx.kv.get('state')) ?? {
        nextSend: nextNewsletterSend(settings, now),
      },
    );
    if (state.lastRun) {
      const last = runSchema.parse(await store(ctx, 'runs').get(state.lastRun));
      if (
        ['preparing', 'sending', 'uncertain', 'draft', 'discarding'].includes(
          last.status,
        )
      )
        return;
    }
    if (now < state.nextSend) return;
    const posts = await pendingDigestPosts(ctx);
    await requireSendLease();
    const id = crypto.randomUUID();
    if (!posts.length) {
      await ctx.kv.set('state', {
        ...state,
        nextSend: nextNewsletterSend(settings, now, now),
      });
      return;
    }
    const runs = store(ctx, 'runs');
    const postHashes: Record<string, string> = {};
    for (const post of posts)
      postHashes[post.id] = await newsletterHash(JSON.stringify(post));
    const run = {
      status: 'preparing',
      createdAt: now,
      leaseUntil: now + sendLeaseMs,
      postIds: posts.map((post) => post.id),
      postHashes,
    };
    await runs.put(id, run);
    await ctx.kv.set('state', {
      nextSend: nextNewsletterSend(settings, now, now),
      lastRun: id,
    });
    let stage = 'creating';
    try {
      const segmentId = z
        .string()
        .min(1)
        .parse(await ctx.settings.get('segmentId'));
      const body = await digestEmail(posts);
      await requireSendLease();
      const created = z.object({ id: z.string() }).parse(
        await provider(ctx, '/broadcasts', 'POST', {
          from: newsletterFrom,
          reply_to: ownerEmail,
          segment_id: segmentId,
          subject: 'blog updates',
          name: `japan-${id}`,
          ...body,
        }),
      );
      const sending = { ...run, status: 'sending', broadcastId: created.id };
      await runs.put(id, sending);
      stage = 'validating';
      // Recheck the live records immediately before dispatch. Staged revisions
      // and entries unpublished during preparation never enter a send.
      const firstDay = await newsletterFirstDay(ctx);
      for (const post of posts) {
        const live = await ctx.content?.get('posts', post.id);
        if (
          !live ||
          live.status !== 'published' ||
          live.data.demo ||
          JSON.stringify(await newsletterPost(ctx, live, firstDay)) !==
            JSON.stringify(post)
        )
          throw new Error('Publication changed');
      }
      if (!(await newsletterSettings(ctx)).enabled)
        throw new Error('Newsletter paused');
      await requireSendLease();
      stage = 'sending';
      await provider(
        ctx,
        `/broadcasts/${encodeURIComponent(created.id)}/send`,
        'POST',
        {},
      );
      stage = 'recording';
      await completeRun(ctx, id, runSchema.parse(sending));
    } catch {
      const existing = runSchema.parse(await runs.get(id));
      await runs.put(id, { ...existing, status: 'uncertain' });
      ctx.log.warn('newsletter_send_needs_review', { stage });
    }
  } finally {
    await ctx.kv.compareAndDelete('send-lock', lock.revision);
  }
}

export async function newsletterStatus(ctx: NewsletterContext) {
  const settings = await newsletterSettings(ctx);
  const state = stateSchema.parse(
    (await ctx.kv.get('state')) ?? {
      nextSend: nextNewsletterSend(settings, Date.now()),
    },
  );
  const last = state.lastRun
    ? runSchema.parse(await store(ctx, 'runs').get(state.lastRun))
    : null;
  return {
    settings,
    configured: Boolean(
      (await ctx.settings.get('apiKey')) &&
      (await ctx.settings.get('segmentId')),
    ),
    confirmed: await store(ctx, 'subscribers').count({ confirmed: true }),
    posts: await pendingDigestPosts(ctx),
    nextSend: new Date(state.nextSend).toISOString(),
    lastRun:
      last && state.lastRun
        ? {
            id: state.lastRun,
            status: last.status,
            createdAt: last.createdAt,
            postCount: last.postIds.length,
          }
        : null,
  };
}

export async function configureNewsletter(
  ctx: NewsletterContext,
  input: unknown,
  ownerEmail: string,
) {
  const parsed = z
    .discriminatedUnion('action', [
      z.object({
        action: z.literal('settings'),
        settings: newsletterSettingsSchema,
      }),
      z.object({
        action: z.literal('connect'),
        apiKey: z
          .string()
          .trim()
          .regex(/^re_[A-Za-z0-9_-]{10,200}$/),
      }),
      z.object({ action: z.literal('test') }),
      z.object({ action: z.literal('check') }),
      z.object({ action: z.literal('resume') }),
      z.object({ action: z.literal('discard') }),
    ])
    .parse(input);
  if (parsed.action === 'connect') {
    const existingSegment = z
      .string()
      .nullish()
      .parse(await ctx.settings.get('segmentId'));
    // A dedicated segment prevents this blog from mailing other projects.
    if (existingSegment) {
      const segment = await provider(
        ctx,
        `/segments/${encodeURIComponent(existingSegment)}`,
        'GET',
        undefined,
        undefined,
        parsed.apiKey,
      );
      if (!segment)
        throw new Error(
          'This key cannot access the existing newsletter segment. Check the Resend team.',
        );
    } else {
      const segment = z.object({ id: z.string() }).parse(
        await provider(
          ctx,
          '/segments',
          'POST',
          {
            name: 'blog confirmed subscribers',
          },
          undefined,
          parsed.apiKey,
        ),
      );
      await ctx.settings.set('segmentId', segment.id);
    }
    await ctx.settings.set('apiKey', parsed.apiKey);
    await ctx.cron?.schedule('digest', { schedule: '*/5 * * * *' });
  } else if (parsed.action === 'settings') {
    if (
      parsed.settings.enabled &&
      (!ownerEmail ||
        !(await ctx.settings.get('apiKey')) ||
        !(await ctx.settings.get('segmentId')))
    )
      throw new Error('Connect Resend before enabling automatic emails');
    await ctx.kv.set(settingsKey, parsed.settings);
    for (let attempt = 0; ; attempt++) {
      const state = await ctx.kv.getVersioned('state');
      const updated = await ctx.kv.compareAndSet(
        'state',
        state?.revision ?? null,
        {
          ...z.record(z.string(), z.unknown()).parse(state?.value ?? {}),
          nextSend: nextNewsletterSend(parsed.settings, Date.now()),
        },
      );
      if (updated.applied) break;
      if (attempt === 4)
        throw new Error('Schedule changed during save. Please try again.');
    }
    await ctx.cron?.schedule('digest', { schedule: '*/5 * * * *' });
  } else if (parsed.action === 'test') {
    if (!ownerEmail) throw new Error('Owner inbox is not configured');
    const posts = await pendingDigestPosts(ctx);
    if (!posts.length)
      throw new Error('Publish a blog post before sending a test');
    const email = await digestEmail(posts, newsletterUrl, true);
    await provider(ctx, '/emails', 'POST', {
      from: newsletterFrom,
      to: [ownerEmail],
      reply_to: ownerEmail,
      subject: '[test] blog updates',
      ...email,
    });
  } else if (parsed.action === 'discard') await discardNewsletterRun(ctx);
  else if (parsed.action === 'resume') await resumeNewsletterRun(ctx);
  else await checkNewsletterRun(ctx);
  return newsletterStatus(ctx);
}

export async function cleanupNewsletter(
  ctx: NewsletterContext,
  now = Date.now(),
) {
  for (const name of ['confirmations', 'limits']) {
    const collection = store(ctx, name);
    const page = await collection.query({
      where: { expiresAt: { lt: now } },
      limit: 100,
    });
    await collection.deleteMany(page.items.map((item) => item.id));
  }
  const subscribers = store(ctx, 'subscribers');
  const pending = await subscribers.query({
    where: { confirmed: false, requestedAt: { lt: now - 7 * 24 * hour } },
    limit: 100,
  });
  for (const item of pending.items) {
    const current = await subscribers.getVersioned(item.id);
    if (current) {
      const row = subscriberSchema.parse(current.value);
      if (!row.confirmed && row.requestedAt < now - 7 * 24 * hour)
        await subscribers.compareAndDelete(item.id, current.revision);
    }
  }
}
