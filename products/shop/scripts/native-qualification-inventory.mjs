import { isDeepStrictEqual } from "node:util";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const check = (condition, message) => { if (!condition) throw Error(`Qualification inventory rejected: ${message}`); };
const rows = async (cf, sql, params = []) => (await cf.query(sql, params))[0].results;
async function qualificationFixture(cf, designId) {
  const designs = await rows(cf, 'SELECT artwork_key, sha256 FROM designs WHERE id = ?', [designId]);
  check(designs.length === 1, 'fixture design missing');
  const products = await rows(cf, 'SELECT id FROM products WHERE design_id = ? ORDER BY id', [designId]);
  const revisions = await rows(cf, 'SELECT id FROM design_revisions WHERE design_id = ? ORDER BY id', [designId]);
  const assets = await rows(cf, `SELECT storage_key FROM print_assets WHERE configured_product_id IN
    (SELECT id FROM products WHERE design_id = ?) ORDER BY id`, [designId]);
  const videos = await rows(cf, `SELECT story_key FROM story_video_jobs WHERE product_id IN
    (SELECT id FROM products WHERE design_id = ?) ORDER BY id`, [designId]);
  return { designId, artworkKey: designs[0].artwork_key, sha256: designs[0].sha256,
    products: products.map(product => product.id), revisions: revisions.map(revision => revision.id), assets: assets.map(asset => asset.storage_key),
    videos: videos.map(video => video.story_key) };
}
export function validateQualificationInventory(inventory, env) {
  check(inventory?.schemaVersion === 1 && inventory.runId === env.GITHUB_RUN_ID &&
    /^[1-9][0-9]*$/.test(inventory.runId) && inventory.releaseId === env.NATIVE_VERIFY_RELEASE &&
    /^native-[1-9][0-9]*$/.test(inventory.releaseId) && inventory.sourceCommit === env.GITHUB_SHA &&
    /^[a-f0-9]{40}$/.test(inventory.sourceCommit) && Array.isArray(inventory.fixtures) && inventory.fixtures.length <= 100,
    'exact original run, release and source');
  check(new Set(inventory.fixtures.map(f => f.designId)).size === inventory.fixtures.length, 'duplicate fixture');
  for (const fixture of inventory.fixtures) {
    check(uuid.test(fixture.designId) && digest.test(fixture.sha256) &&
      fixture.artworkKey === `designs/${fixture.designId}/artwork/${fixture.sha256}` &&
      Array.isArray(fixture.revisions) && fixture.revisions.length <= 100 && fixture.revisions.every(id => uuid.test(id)) &&
      Array.isArray(fixture.products) && fixture.products.length <= 20 && fixture.products.every(id => uuid.test(id)) &&
      new Set(fixture.products).size === fixture.products.length && Array.isArray(fixture.assets) && fixture.assets.length <= 100 &&
      Array.isArray(fixture.videos) && fixture.videos.length <= 100, 'bounded fixture identity');
    for (const key of fixture.assets) check(key === null ||
      /^print-assets\/blobs\/[a-f0-9]{64}\.png$/.test(key) || fixture.products.some(id =>
        new RegExp(`^print-assets/${id}/[a-z0-9_-]+:[0-9]+x[0-9]+/[a-f0-9]{64}\\.png$`).test(key)), 'fixture-owned print key');
    for (const key of fixture.videos) check(key === null || fixture.products.some(id => fixture.revisions.some(revision =>
      new RegExp(`^story-videos/v[0-9]+/${revision}/${id}/(?:black|cream|white)\\.mp4$`).test(key))), 'fixture-owned video key');
  }
  check(Buffer.byteLength(JSON.stringify(inventory)) <= 131072, 'bounded inventory bytes');
  return inventory;
}
export async function captureQualificationInventory(cf, env) {
  const selected = await rows(cf, `SELECT design_id FROM storage_test_fixtures
    WHERE run_id = ? AND purpose = 'native-qualification' ORDER BY design_id`, [env.GITHUB_RUN_ID]);
  check(selected.length <= 100, 'bounded fixture count');
  const fixtures = [];
  for (const fixture of selected) fixtures.push(await qualificationFixture(cf, fixture.design_id));
  return validateQualificationInventory({schemaVersion:1, runId:env.GITHUB_RUN_ID,
    releaseId:env.NATIVE_VERIFY_RELEASE, sourceCommit:env.GITHUB_SHA, fixtures},env);
}

const protectedFixture = `EXISTS (SELECT 1 FROM paid_order_lines AS lines JOIN products
  ON products.id = lines.configured_product_id WHERE products.design_id = ?)
  OR EXISTS (SELECT 1 FROM printify_production_products AS production JOIN products
  ON products.id = production.configured_product_id WHERE products.design_id = ?)`;
export function qualificationDeletionBatch(fixture, runId, fence) {
  const id = fixture.designId;
  const statements = [
    ...(fence ? [{ sql: `SELECT CASE WHEN ${cleanupFenceSql} THEN 1 ELSE json('cleanup-release-changed') END AS allowed`,
      params: [fence.releaseId, fence.releaseId, fence.verifiedPayload] }] : []),
    {sql: `SELECT CASE WHEN EXISTS (SELECT 1 FROM storage_test_fixtures WHERE design_id = ? AND run_id = ?
      AND purpose = 'native-qualification') AND NOT (${protectedFixture})
      AND NOT EXISTS (SELECT 1 FROM story_video_jobs WHERE status IN ('queued','rendering')
        AND product_id IN (SELECT id FROM products WHERE design_id = ?))
      AND NOT EXISTS (SELECT 1 FROM print_asset_jobs WHERE status IN ('pending','dispatched','running')
        AND configured_product_id IN (SELECT id FROM products WHERE design_id = ?))
      THEN 1 ELSE json('fixture-ownership-or-reference-changed') END AS allowed`, params:[id,runId,id,id,id,id]},
    {sql: `SELECT CASE WHEN (SELECT json_group_array(id) FROM (SELECT id FROM products WHERE design_id = ? ORDER BY id)) = ?
      AND (SELECT json_group_array(id) FROM (SELECT id FROM design_revisions WHERE design_id = ? ORDER BY id)) = ?
      AND (SELECT json_group_array(storage_key) FROM (SELECT storage_key FROM print_assets WHERE configured_product_id IN
        (SELECT id FROM products WHERE design_id = ?) ORDER BY id)) = ?
      AND (SELECT json_group_array(story_key) FROM (SELECT story_key FROM story_video_jobs WHERE product_id IN
        (SELECT id FROM products WHERE design_id = ?) ORDER BY id)) = ?
      AND EXISTS (SELECT 1 FROM designs WHERE id = ? AND artwork_key = ? AND sha256 = ?)
      THEN 1 ELSE json('fixture-inventory-changed') END AS unchanged`,
      params:[id,JSON.stringify(fixture.products),id,JSON.stringify(fixture.revisions),id,JSON.stringify(fixture.assets),id,JSON.stringify(fixture.videos),id,fixture.artworkKey,fixture.sha256]},
  ];
  for (const sql of [
    'DELETE FROM native_video_qualification_observations WHERE design_id = ?',
    'DELETE FROM native_video_qualification_faults WHERE design_id = ?',
    'DELETE FROM story_video_jobs WHERE product_id IN (SELECT id FROM products WHERE design_id = ?)',
    'DELETE FROM print_assets WHERE configured_product_id IN (SELECT id FROM products WHERE design_id = ?)',
    'DELETE FROM products WHERE design_id = ?',
    'DELETE FROM design_upload_grants WHERE design_id = ?',
    'DELETE FROM design_revisions WHERE design_id = ?',
    'DELETE FROM storage_test_fixtures WHERE design_id = ?',
    'DELETE FROM designs WHERE id = ?',
  ]) statements.push({sql,params:[id]});
  return statements;
}
async function fixtureAbsent(cf, fixture) {
  const result = await rows(cf, `SELECT (SELECT COUNT(*) FROM designs WHERE id = ?) +
    (SELECT COUNT(*) FROM storage_test_fixtures WHERE design_id = ?) +
    (SELECT COUNT(*) FROM design_revisions WHERE design_id = ?) +
    (SELECT COUNT(*) FROM products WHERE design_id = ? OR id IN (SELECT value FROM json_each(?))) AS remaining`,
    [fixture.designId,fixture.designId,fixture.designId,fixture.designId,JSON.stringify(fixture.products)]);
  check(result.length === 1 && Number.isSafeInteger(result[0].remaining), 'database absence readback');
  return result[0].remaining === 0;
}
async function bounded(items, execute) {
  const pending = [...items];
  const results = await Promise.allSettled(Array.from({length:Math.min(4,items.length)}, async () => {
    while (pending.length) await execute(pending.shift());
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw Error('Qualification object cleanup incomplete; resume the saved inventory.');
}
export async function deleteQualificationInventory(cf, inventory, env, { fence } = {}) {
  validateQualificationInventory(inventory,env);
  const deferred = new Set();
  for (const fixture of inventory.fixtures) {
    const recoveringObjects = await fixtureAbsent(cf,fixture);
    if (!recoveringObjects) {
      let uncertain;
      try { await cf.batch(qualificationDeletionBatch(fixture,inventory.runId,fence)); }
      catch (error) { uncertain = error; }
      // An uncertain acknowledgement is resolved by a read, never by repeating
      // a write inside this attempt. Recovery repeats only after this inspection.
      if (!await fixtureAbsent(cf,fixture)) throw uncertain ?? Error('Fixture database deletion not confirmed.');
    }
    const keys = [{kind:'artwork',key:fixture.artworkKey},
      {kind:'artwork',key:`designs/${fixture.designId}/artwork-preview-${fixture.sha256}-display-1600-v2.webp`}];
    for (const key of new Set(fixture.assets.filter(Boolean))) {
      if (key.startsWith('print-assets/blobs/')) { deferred.add(key); continue; }
      const references = await rows(cf, `SELECT EXISTS(SELECT 1 FROM print_asset_objects WHERE storage_key = ?)
        OR EXISTS(SELECT 1 FROM print_assets WHERE storage_key = ?) AS referenced`,[key,key]);
      check(references.length === 1 && [0,1].includes(references[0].referenced),'print reference readback');
      if (references[0].referenced === 1) deferred.add(key);
      else keys.push({kind:'artwork',key});
    }
    for (const key of new Set(fixture.videos.filter(Boolean))) keys.push({kind:'video',key});
    await bounded(keys, async ({kind,key}) => {
      const references = await rows(cf, kind === 'video'
        ? 'SELECT EXISTS(SELECT 1 FROM story_video_jobs WHERE story_key = ?) AS referenced'
        : `SELECT EXISTS(SELECT 1 FROM designs WHERE artwork_key = ?)
          OR EXISTS(SELECT 1 FROM design_revisions WHERE artwork_key = ?)
          OR EXISTS(SELECT 1 FROM print_asset_objects WHERE storage_key = ?)
          OR EXISTS(SELECT 1 FROM print_assets WHERE storage_key = ?) AS referenced`, kind === 'video' ? [key] : [key,key,key,key]);
      check(references.length === 1 && [0,1].includes(references[0].referenced),'object reference readback');
      if (references[0].referenced === 1) { deferred.add(key); return; }
      if (fence) await assertQualificationCleanupFence(cf, fence);
      await (kind === 'video' ? cf.deleteQualificationVideo(key,{inspect:recoveringObjects}) : cf.deleteQualificationArtwork(key,{inspect:recoveringObjects}));
    });
  }
  return {qualificationFixturesDeleted:inventory.fixtures.length, sharedObjectsDeferred:[...deferred].sort()};
}


const cleanupFenceSql = `EXISTS (SELECT 1 FROM native_video_release_control
  WHERE singleton = 1 AND paused = 0 AND release_id IS NULL AND current_release_id = ?)
  AND EXISTS (SELECT 1 FROM native_video_release_events WHERE release_id = ? AND stage = 'verified' AND payload = ?)`;
export async function assertQualificationCleanupFence(cf, fence) {
  check(/^native-[1-9][0-9]*$/.test(fence?.releaseId) && typeof fence.verifiedPayload === 'string', 'exact cleanup release fence');
  const found = await rows(cf, `SELECT CASE WHEN ${cleanupFenceSql} THEN 1 ELSE 0 END AS allowed`,
    [fence.releaseId, fence.releaseId, fence.verifiedPayload]);
  check(found.length === 1 && found[0].allowed === 1, 'release changed during cleanup');
}

export async function refreshFailedQualificationInventory(cf, original, env) {
  validateQualificationInventory(original, env);
  check(original.fixtures.length > 0, 'original failed inventory must contain owned fixtures');
  const owned = await rows(cf, `SELECT design_id FROM storage_test_fixtures
    WHERE run_id = ? AND purpose = 'native-qualification' ORDER BY design_id`, [original.runId]);
  check(owned.every(row => original.fixtures.some(fixture => fixture.designId === row.design_id)), 'new fixture appeared outside original inventory');
  const fixtures = [];
  for (const fixture of original.fixtures) {
    if (await fixtureAbsent(cf, fixture)) { fixtures.push(fixture); continue; }
    check(owned.some(row => row.design_id === fixture.designId), 'original fixture ownership changed');
    const current = await qualificationFixture(cf, fixture.designId);
    check(current.artworkKey === fixture.artworkKey && current.sha256 === fixture.sha256 &&
      isDeepStrictEqual(current.products, fixture.products) && isDeepStrictEqual(current.revisions, fixture.revisions),
      'failed fixture identity changed after original inventory');
    fixtures.push(current);
  }
  return validateQualificationInventory({ ...original, fixtures }, env);
}

export async function failedQualificationActiveJobs(cf, inventory) {
  const found = await rows(cf, `SELECT
    (SELECT count(*) FROM story_video_jobs AS jobs JOIN products ON products.id = jobs.product_id
      WHERE products.design_id IN (SELECT value FROM json_each(?)) AND jobs.status IN ('queued','rendering')) AS videos,
    (SELECT count(*) FROM print_asset_jobs AS jobs JOIN products ON products.id = jobs.configured_product_id
      WHERE products.design_id IN (SELECT value FROM json_each(?)) AND jobs.status IN ('pending','dispatched','running')) AS prints`,
    [JSON.stringify(inventory.fixtures.map(fixture => fixture.designId)), JSON.stringify(inventory.fixtures.map(fixture => fixture.designId))]);
  check(found.length === 1 && [found[0].videos, found[0].prints].every(value => Number.isSafeInteger(value) && value >= 0), 'bounded active fixture work');
  return found[0];
}
