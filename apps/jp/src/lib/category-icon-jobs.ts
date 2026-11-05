import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import {
  builtInCategoryNames,
  categoryNames,
  iconHash,
  iconModel,
  iconPromptVersion,
  isDefaultCategory,
  supportedIconModels,
} from './category-icons';
import {
  generateCategoryIcon,
  validateStoredCategoryIcon,
} from './category-icon-image';
import type { CategoryIconStatus } from './category-icons';
import { emitCategoryIconDiagnostic } from './category-icon-diagnostics';
import type { CategoryIconDiagnostic } from './category-icon-diagnostics';
import { matchingIcon } from './icon-library';

export interface IconEnvironment {
  DB: D1Database;
  MEDIA: R2Bucket;
  OPENAI_API_KEY?: string;
  CATEGORY_ICON_MODEL?: string;
}
interface CategoryRow {
  id: string;
  normalized: string;
  label: string;
  generation: number;
  ready_key: string | null;
  ready_version: string | null;
}
interface JobRow {
  id: string;
  category_id: string;
  model: string;
  version: string;
  generation: number;
  status: string;
  attempts: number;
  lease_token: string | null;
}
const configured = (env: IconEnvironment) =>
  Boolean(env.OPENAI_API_KEY?.trim()) &&
  supportedIconModels.includes(env.CATEGORY_ICON_MODEL || '');

export async function categoryInsertStatements(
  env: IconEnvironment,
  name: { label: string; normalized: string },
  now = Date.now(),
) {
  const id = await iconHash(name.normalized);
  const existing = await env.DB.prepare(
    'SELECT id FROM jp_categories WHERE id=?',
  )
    .bind(id)
    .first();
  const reusable =
    !existing && !isDefaultCategory(name.normalized)
      ? await matchingIcon(env, name.normalized)
      : undefined;
  const needsIcon = !isDefaultCategory(name.normalized) && !reusable;
  return [
    env.DB.prepare(
      'INSERT OR IGNORE INTO jp_categories(id,normalized,label,generation,ready_key,ready_version) VALUES(?,?,?,?,?,?)',
    ).bind(
      id,
      name.normalized,
      name.label,
      needsIcon ? 1 : 0,
      reusable?.storage_key || null,
      reusable?.version || null,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO jp_icon_jobs(id,category_id,version,model,generation,status,available_at,created_at) SELECT ?,?,?,?,1,'pending',?,? WHERE changes() = 1 AND ? = 1`,
    ).bind(
      `${id}:1`,
      id,
      iconPromptVersion,
      env.CATEGORY_ICON_MODEL || iconModel,
      now,
      now,
      needsIcon ? 1 : 0,
    ),
  ];
}

// Each insert pair and its outbox acknowledgement commit together. Concurrent
// drains share the same hashes and conflict keys, so none can create duplicates.
export async function drainIconOutbox(env: IconEnvironment, now = Date.now()) {
  const baseline = await env.DB.prepare(
    'SELECT label FROM jp_icon_baseline LIMIT 100',
  ).all<{ label: string }>();
  for (const { label } of baseline.results) {
    const names = categoryNames([label]);
    const statements = [];
    for (const name of names)
      statements.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO jp_categories(id,normalized,label) VALUES(?,?,?)',
        ).bind(await iconHash(name.normalized), name.normalized, name.label),
      );
    statements.push(
      env.DB.prepare('DELETE FROM jp_icon_baseline WHERE label = ?').bind(
        label,
      ),
    );
    await env.DB.batch(statements);
  }
  // Finish seeding before admitting new categories, even for a large library.
  if (
    await env.DB.prepare('SELECT label FROM jp_icon_baseline LIMIT 1').first()
  )
    return;
  const events = await env.DB.prepare(
    'SELECT id,categories FROM jp_icon_outbox ORDER BY id LIMIT 50',
  ).all<{ id: number; categories: string }>();
  for (const event of events.results) {
    let value: unknown;
    try {
      value = JSON.parse(event.categories);
    } catch {
      value = [];
    }
    const statements = [];
    for (const name of categoryNames(value))
      statements.push(...(await categoryInsertStatements(env, name, now)));
    statements.push(
      env.DB.prepare('DELETE FROM jp_icon_outbox WHERE id = ?').bind(event.id),
    );
    await env.DB.batch(statements);
  }
}

export async function claimIconJob(env: IconEnvironment, now = Date.now()) {
  // A crashed request may already have incurred a charge. Never replay it.
  await env.DB.prepare(
    `UPDATE jp_icon_jobs SET status='uncertain', lease_token=NULL, lease_until=NULL WHERE status='running' AND lease_until <= ?`,
  )
    .bind(now)
    .run();
  if (!configured(env)) return null;
  const blocked = await env.DB.prepare(
    'SELECT provider_blocked FROM jp_icon_settings WHERE id=1',
  ).first<{ provider_blocked: number }>();
  if (blocked?.provider_blocked) return null;
  const builtIns = builtInCategoryNames();
  // Check the actual ordered candidate, and claim that exact ID. A competing
  // worker cannot substitute an unchecked job while storage validation awaits.
  for (let inspected = 0; inspected < 50; inspected++) {
    const candidate = await env.DB.prepare(
      `SELECT j.*,c.normalized,c.ready_key FROM jp_icon_jobs j JOIN jp_categories c ON c.id=j.category_id WHERE j.status='pending' AND j.available_at<=? AND j.attempts<3 AND c.normalized NOT IN (${builtIns.map(() => '?').join(',')}) ORDER BY j.available_at,j.created_at,j.id LIMIT 1`,
    )
      .bind(now, ...builtIns)
      .first<JobRow & { normalized: string; ready_key: string | null }>();
    if (!candidate) return null;
    if (
      candidate.generation === 1 &&
      candidate.attempts === 0 &&
      !candidate.ready_key
    ) {
      const asset = await matchingIcon(env, candidate.normalized);
      if (asset) {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE jp_categories SET ready_key=?,ready_version=? WHERE id=? AND generation=1 AND ready_key IS NULL AND EXISTS(SELECT 1 FROM jp_icon_jobs WHERE id=? AND status='pending' AND attempts=0 AND generation=1)`,
          ).bind(
            asset.storage_key,
            asset.version,
            candidate.category_id,
            candidate.id,
          ),
          env.DB.prepare(
            `UPDATE jp_icon_jobs SET status='ready' WHERE id=? AND status='pending' AND attempts=0 AND changes()=1`,
          ).bind(candidate.id),
        ]);
        continue;
      }
    }
    const token = crypto.randomUUID();
    const result = await env.DB.batch<JobRow>([
      env.DB.prepare(
        `UPDATE jp_icon_jobs SET status='running', attempts=attempts+1, lease_token=?, lease_until=? WHERE id=? AND status='pending' AND available_at<=? AND attempts<3 AND NOT EXISTS(SELECT 1 FROM jp_icon_jobs WHERE status='running') AND (SELECT COUNT(*) FROM jp_icon_attempts WHERE started_at>?)<5 RETURNING *`,
      ).bind(token, now + 180_000, candidate.id, now, now - 86_400_000),
      env.DB.prepare(
        `INSERT INTO jp_icon_attempts(token,job_id,started_at) SELECT ?,id,? FROM jp_icon_jobs WHERE lease_token=? AND status='running'`,
      ).bind(token, now, token),
    ]);
    return result[0]?.results[0] || null;
  }
  // A run that reused fifty icons yields to the next tick without spending.
  return null;
}

export async function runCategoryIconJobs(
  env: IconEnvironment,
  deps: { now?: () => number; generate?: typeof generateCategoryIcon } = {},
) {
  const now = deps.now || Date.now;
  await drainIconOutbox(env, now());
  const job = await claimIconJob(env, now());
  if (!job) return;
  const category = await env.DB.prepare(
    'SELECT * FROM jp_categories WHERE id=?',
  )
    .bind(job.category_id)
    .first<CategoryRow>();
  if (!category || !env.OPENAI_API_KEY) return;
  const started = performance.now();
  let diagnostic: CategoryIconDiagnostic = {
    stage: 'generation',
    reason: 'outcome',
  };
  try {
    let outcome;
    try {
      outcome = await (deps.generate || generateCategoryIcon)(
        {
          key: env.OPENAI_API_KEY,
          model: job.model,
          category: { normalized: category.normalized, label: category.label },
        },
        {
          diagnose: (detail) => {
            diagnostic = detail;
          },
        },
      );
    } catch {
      // Includes local storage/processing failures after a dispatched request.
      outcome = { status: 'uncertain' };
      diagnostic.stage = 'generation';
      diagnostic.reason = 'exception';
    }
    const token = job.lease_token;
    if (outcome.status === 'ready') {
      diagnostic.stage = 'mask';
      diagnostic.reason = 'invalid_mask';
    }
    if (
      outcome.status === 'ready' &&
      'bytes' in outcome &&
      outcome.bytes instanceof Uint8Array &&
      (await validateStoredCategoryIcon(outcome.bytes))
    ) {
      diagnostic.stage = 'identity';
      diagnostic.reason = 'processing_failed';
      const version = await iconHash(
        `${job.version}\n${job.model}\n${String(job.generation)}\n${await iconHash(String(outcome.bytes))}`,
      );
      const key = `category-icons/${category.id}/${version}.png`;
      try {
        diagnostic.stage = 'r2';
        diagnostic.reason = 'write_failed';
        await env.MEDIA.put(key, outcome.bytes, {
          httpMetadata: {
            contentType: 'image/png',
            cacheControl: 'private, no-store',
          },
        });
        diagnostic.stage = 'd1';
        const persisted = await env.DB.batch([
          env.DB.prepare(
            `UPDATE jp_categories SET ready_key=?,ready_version=? WHERE id=? AND EXISTS(SELECT 1 FROM jp_icon_jobs WHERE id=? AND status='running' AND lease_token=?) RETURNING id`,
          ).bind(key, version, category.id, job.id, token),
          env.DB.prepare(
            `UPDATE jp_icon_jobs SET status='ready',lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=? RETURNING id`,
          ).bind(job.id, token),
        ]);
        diagnostic.reason = persisted.every(
          (result) => result.results.length === 1,
        )
          ? 'ready'
          : 'lease_lost';
        return;
      } catch {
        /* Do not re-generate after a storage failure. */
      }
    }
    const status =
      outcome.status === 'rate_limited' && job.attempts < 3
        ? 'pending'
        : outcome.status === 'blocked_configuration'
          ? 'configuration'
          : outcome.status === 'failed' || outcome.status === 'rate_limited'
            ? 'failed'
            : 'uncertain';
    const previous = { ...diagnostic };
    diagnostic.stage = 'd1';
    diagnostic.reason = 'write_failed';
    const persisted = await env.DB.batch([
      env.DB.prepare(
        `UPDATE jp_icon_jobs SET status=?,available_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='running' AND lease_token=?`,
      ).bind(
        status,
        now() + Math.min(3600_000, 60_000 * 2 ** job.attempts),
        job.id,
        token,
      ),
      env.DB.prepare(
        'UPDATE jp_icon_settings SET provider_blocked=CASE WHEN ?=1 THEN 1 ELSE provider_blocked END WHERE id=1',
      ).bind(status === 'configuration' ? 1 : 0),
    ]);
    diagnostic =
      persisted[0]?.meta.changes === 1
        ? previous
        : { ...previous, stage: 'd1', reason: 'lease_lost' };
  } finally {
    emitCategoryIconDiagnostic(started, diagnostic);
  }
}

// Recovery only opens the provider circuit. It never changes a job, creates a
// generation, resets a limit, or retries an uncertain result.
export async function ownerIconProviderStatus(env: IconEnvironment) {
  const settings = await env.DB.prepare(
    'SELECT provider_blocked FROM jp_icon_settings WHERE id=1',
  ).first<{ provider_blocked: number }>();
  const paused = settings?.provider_blocked === 1;
  return { paused, canResume: paused && configured(env) };
}

export async function resumeIconProvider(env: IconEnvironment) {
  if (!configured(env)) return false;
  const result = await env.DB.prepare(
    'UPDATE jp_icon_settings SET provider_blocked=0 WHERE id=1 AND provider_blocked=1',
  ).run();
  return result.meta.changes === 1;
}

export async function ownerIconStatuses(
  env: IconEnvironment,
  names: string[],
): Promise<CategoryIconStatus[]> {
  const blocked = await env.DB.prepare(
    'SELECT provider_blocked FROM jp_icon_settings WHERE id=1',
  ).first<{ provider_blocked: number }>();
  const requested = categoryNames(names);
  const rows = new Map<
    string,
    { generation: number; ready_key: string | null; status: string | null }
  >();
  for (let offset = 0; offset < requested.length; offset += 90) {
    const chunk = requested.slice(offset, offset + 90);
    const result = await env.DB.prepare(
      `SELECT c.normalized,c.generation,c.ready_key,j.status FROM jp_categories c LEFT JOIN jp_icon_jobs j ON j.category_id=c.id AND j.generation=c.generation WHERE c.normalized IN (${chunk.map(() => '?').join(',')})`,
    )
      .bind(...chunk.map((name) => name.normalized))
      .all<{
        normalized: string;
        generation: number;
        ready_key: string | null;
        status: string | null;
      }>();
    for (const row of result.results) rows.set(row.normalized, row);
  }
  return requested.map((name): CategoryIconStatus => {
    const category = rows.get(name.normalized);
    const job = category?.status ? { status: category.status } : null;
    const assetPath =
      /^category-icons\/([a-f0-9]{64})\/([a-f0-9]{64})\.png$/.exec(
        category?.ready_key || '',
      );
    const state = isDefaultCategory(name.normalized)
      ? 'default'
      : category?.ready_key && (!job || job.status === 'ready')
        ? 'ready'
        : !configured(env)
          ? 'setup'
          : job?.status === 'uncertain'
            ? 'uncertain'
            : blocked?.provider_blocked
              ? 'configuration'
              : job?.status === 'failed'
                ? 'failed'
                : job?.status === 'configuration'
                  ? 'configuration'
                  : job?.status === 'pending' || job?.status === 'running'
                    ? 'pending'
                    : category?.ready_key
                      ? 'ready'
                      : category
                        ? 'default'
                        : 'pending';
    return {
      ...name,
      state,
      ...(assetPath?.[1] && assetPath[2]
        ? { url: `/api/trip/icon-library/${assetPath[1]}/${assetPath[2]}.png` }
        : {}),
      canRetry:
        Boolean(category) &&
        configured(env) &&
        !isDefaultCategory(name.normalized) &&
        (category?.generation || 0) < 3 &&
        !['pending', 'running'].includes(job?.status || ''),
    };
  });
}

export async function retryCategoryIcon(
  env: IconEnvironment,
  name: string,
  acknowledgeCharge: boolean,
  now = Date.now(),
) {
  const normalized = categoryNames([name])[0]?.normalized;
  if (!normalized || isDefaultCategory(normalized) || !configured(env))
    return false;
  // An explicit category retry can also resume the provider. The separate
  // resume action does not require a category or spend a generation.
  const result = await env.DB.batch<CategoryRow>([
    env.DB.prepare(
      `UPDATE jp_categories SET generation=generation+1 WHERE normalized=? AND generation<3 AND NOT EXISTS(SELECT 1 FROM jp_icon_jobs WHERE category_id=jp_categories.id AND status IN ('pending','running')) AND (?=1 OR NOT EXISTS(SELECT 1 FROM jp_icon_jobs WHERE category_id=jp_categories.id AND generation=jp_categories.generation AND status='uncertain')) RETURNING *`,
    ).bind(normalized, acknowledgeCharge ? 1 : 0),
    env.DB.prepare(
      `INSERT INTO jp_icon_jobs(id,category_id,version,model,generation,status,available_at,created_at) SELECT id || ':' || generation,id,?,?,generation,'pending',?,? FROM jp_categories WHERE normalized=? AND changes()=1`,
    ).bind(iconPromptVersion, env.CATEGORY_ICON_MODEL, now, now, normalized),
    env.DB.prepare(
      'UPDATE jp_icon_settings SET provider_blocked=0 WHERE id=1 AND changes()=1',
    ),
  ]);
  return Boolean(result[0]?.results[0]);
}

export async function readyCategoryIcons(
  env: IconEnvironment,
  names: string[],
) {
  const icons = new Map<string, string>();
  const requested = categoryNames(names);
  for (let offset = 0; offset < requested.length; offset += 90) {
    const chunk = requested.slice(offset, offset + 90);
    const result = await env.DB.prepare(
      `SELECT id,normalized,ready_version FROM jp_categories WHERE normalized IN (${chunk.map(() => '?').join(',')}) AND ready_key IS NOT NULL`,
    )
      .bind(...chunk.map((name) => name.normalized))
      .all<{ id: string; normalized: string; ready_version: string }>();
    for (const row of result.results)
      icons.set(
        row.normalized,
        `/category-icons/${row.id}/${row.ready_version}.png`,
      );
  }
  return icons;
}
