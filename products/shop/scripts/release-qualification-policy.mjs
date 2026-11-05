import { gitChanges } from './deployment-plan.mjs';
import { shippingOnlyPaths } from './rendering-inputs.mjs';

// This is deliberately an allowlist. A camera change in the shared Worker
// entrypoint can affect admission/retries even when the Lambda image is reused.
export function qualificationPolicy(paths) {
  if (!Array.isArray(paths)) return { kind: 'full', reason: 'Unknown or divergent qualification history.' };
  const native = paths.filter(path => !(path.startsWith('docs/') || path === 'README.md' ||
    path.startsWith('shopify/notifications/') ||
    ['infra/story-video-lambda/development-qualification.json', 'infra/story-video-lambda/production-promotion.json'].includes(path) ||
    (path.startsWith('apps/web/') && !path.startsWith('apps/web/public/mockups/'))));
  if (!native.length) return { kind: 'unchanged', reason: 'No native qualification inputs changed.' };
  if (shippingOnlyPaths(native)) return { kind: 'shipping', reason: 'Isolated shipping boundary; immutable renderer equivalence is still required.' };
  const affected = [...new Set(native.map(path => {
    if (path.startsWith('workers/api/drizzle/') || path.startsWith('workers/api/sql/')) return 'schema';
    if (path.startsWith('infra/')) return 'infrastructure';
    if (path.startsWith('workers/video-renderer/') || path.startsWith('apps/web/public/mockups/')) return 'renderer';
    if (path.startsWith('workers/api/')) return 'Worker admission, queues, retries and shared behavior';
    return 'dependencies, shared code, release policy or unknown inputs';
  }))].sort();
  return { kind: 'full', reason: `Fresh full qualification required for ${affected.join('; ')}.`, affected };
}

// Called by Production as well as preflight. Even legacy committed receipts may
// not carry qualification over changed migrations, scripts or infrastructure.
export function assertQualifiedSource(qualifiedSource, source, changes = gitChanges) {
  const policy = qualificationPolicy(changes(qualifiedSource, source));
  if (policy.kind !== 'unchanged') throw Error(`Production source differs from qualification. ${policy.reason}`);
  return policy;
}
