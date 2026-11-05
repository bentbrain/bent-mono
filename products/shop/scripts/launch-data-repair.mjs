import { protectedConfig } from "./protected-config.mjs";
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { productPurchaseReadiness } from '../workers/api/src/product-purchase-readiness.ts';
import { printSourceResolution } from '../workers/api/src/print-assets.ts';
const ACCOUNT = protectedConfig("cloudflareAccountId");
const DATABASE = protectedConfig("resource_1a1378f0d1dc");
const BUCKET = 'forever-tee-design-artwork-production';
const RELEASE = "native-" + protectedConfig("resource_8d552ad12cd3");
const SOURCE = '113decd1eadde612468c4fa3fa23ac952beff438';
const API_VERSION = protectedConfig("resource_0f41847ac21d");
const PRINT_VERSION = protectedConfig("resource_3f1f85992426");
const REVISION = protectedConfig("resource_02f1c868d95c");
const SHIRT = protectedConfig("resource_a159071759db");
const TOTE = protectedConfig("resource_9e4c210fa7f3");
const INTENT = 'operations/launch-data-repair-2026-10-05/intent.json';
const SHARED_LEGACY_REVISION = "43609485-55c3-419a-bffa-f606edc02d98";
const SHARED_LEGACY_KEY = "designs/" + "8f48ee90-08d8-4c6c-b369-0444a20ddd25" + "/artwork";
const LEGACY_SOURCE_PREDICATE = "(r.artwork_key='designs/'||r.design_id||'/artwork' OR r.artwork_key='designs/'||r.design_id||'/native-production-canary.png' OR (r.id='" + "43609485-55c3-419a-bffa-f606edc02d98" + "' AND r.artwork_key='designs/" + "8f48ee90-08d8-4c6c-b369-0444a20ddd25" + "/artwork'))";
const QUALITY_REASON = 'Legacy family cannot meet 150 PPI for both tee and tote; retain records for a print-quality replacement.';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const check = (value, reason) => { if (!value)
    throw Error(`Launch data repair stopped: ${reason}`); };
export function repairContext(env) {
    check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === 'bentbrain/bent-mono' &&
        env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") && env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") && env.GITHUB_ACTOR_ID === protectedConfig("githubOwnerId") &&
        env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_RUN_ATTEMPT === '1' &&
        /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && /^[1-9][0-9]+$/.test(env.GITHUB_RUN_ID ?? '') &&
        env.GITHUB_WORKFLOW_REF === 'bentbrain/bent-mono/.github/workflows/launch-data-repair.yml@refs/heads/main', 'owner-dispatched first-attempt protected main workflow required.');
    check(env.CLOUDFLARE_ACCOUNT_ID === ACCOUNT && env.CLOUDFLARE_API_TOKEN && ['plan', 'execute', 'verify'].includes(env.REPAIR_OPERATION), 'exact personal account and bounded operation required.');
    check(env.REPAIR_OPERATION !== 'execute' || /^[a-f0-9]{64}$/.test(env.REPAIR_PLAN_DIGEST ?? ''), 'reviewed plan digest required.');
}
export function artworkMigration(row) {
    check(UUID.test(row.id) && UUID.test(row.design_id) && /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.byte_size) && row.byte_size > 0 && row.byte_size <= 25000000 &&
        ['image/png', 'image/webp', 'image/jpeg'].includes(row.content_type) &&
        ([`designs/${row.design_id}/artwork`, `designs/${row.design_id}/native-production-canary.png`].includes(row.artwork_key) ||
            row.id === SHARED_LEGACY_REVISION && row.design_id === SHARED_LEGACY_REVISION && row.artwork_key === SHARED_LEGACY_KEY && row.sha256 === protectedConfig("resource_b08be69bc26f") && row.byte_size === 1429359), 'bounded historical immutable source required.');
    return { ...row, key: `designs/${row.design_id}/artwork/${row.sha256}` };
}
export function verifyArtwork(row, bytes) {
    check(bytes.length === row.byte_size, 'source size mismatch.');
    check(digest(bytes) === row.sha256, 'source checksum mismatch.');
}
export function migrationStatements(row) {
    const target = artworkMigration(row).key;
    return [{ sql: `UPDATE design_revisions SET artwork_key=? WHERE id=? AND design_id=? AND artwork_key=? AND sha256=? AND byte_size=?
 AND NOT EXISTS (SELECT 1 FROM paid_order_lines l JOIN products p ON p.id=l.configured_product_id WHERE p.design_id=design_revisions.design_id)`,
            params: [target, row.id, row.design_id, row.artwork_key, row.sha256, row.byte_size] },
        { sql: `UPDATE designs SET artwork_key=? WHERE id=? AND artwork_key=? AND sha256=? AND byte_size=?
 AND EXISTS (SELECT 1 FROM design_revisions r WHERE r.id=? AND r.artwork_key=?)
 AND NOT EXISTS (SELECT 1 FROM paid_order_lines l JOIN products p ON p.id=l.configured_product_id WHERE p.design_id=designs.id)`,
            params: [target, row.design_id, row.artwork_key, row.sha256, row.byte_size, row.id, target] }];
}
export function inactiveJobStatement(product) {
    check(UUID.test(product.id) && UUID.test(product.design_revision_id) && product.status === 'suspended', 'exact suspended product required.');
    return { sql: "UPDATE print_asset_jobs SET status='ready',lease_id=NULL,updated_at=? WHERE configured_product_id=? AND status IN ('pending','dispatched','ready')\n AND EXISTS (SELECT 1 FROM products p WHERE p.id=print_asset_jobs.configured_product_id AND p.status='suspended' AND p.design_revision_id=?)\n AND EXISTS (SELECT 1 FROM product_lifecycle_transitions t WHERE t.product_id=print_asset_jobs.configured_product_id AND t.to_status='suspended' AND t.actor_id='" + protectedConfig("githubOwnerId") + "' AND t.reason=? AND t.applied_at IS NOT NULL)\n AND NOT EXISTS (SELECT 1 FROM paid_order_lines l WHERE l.configured_product_id=print_asset_jobs.configured_product_id)", params: [Date.now(), product.id, product.design_revision_id, QUALITY_REASON] };
}
export function missingVideoStatements(now) {
    return ['Black', 'White'].map(colour => ({ sql: "INSERT INTO story_video_jobs (id,product_id,design_revision_id,colour,renderer_version,story_key,status,attempt_count,created_at,updated_at)\n SELECT ?,id,design_revision_id,?,'story-video-renderer-v7',?,'queued',0,?,? FROM products\n WHERE id=? AND design_revision_id=? AND status='active' AND base_product_id='" + "a51b7acf-77e9-4762-83c4-62d96dd8942c" + "'\n AND COALESCE(video_design_revision_id,design_revision_id)=design_revision_id\n ON CONFLICT (product_id,colour,renderer_version) DO NOTHING", params: [randomUUID(), colour, `story-videos/v7/${REVISION}/${SHIRT}/${colour.toLowerCase()}.mp4`, now, now, SHIRT, REVISION] }));
}
function client(env, request = fetch) {
    const send = async (path, options = {}) => {
        let response;
        try {
            response = await request(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, { redirect: 'error', signal: AbortSignal.timeout(30000), ...options,
                headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...options.headers } });
        }
        catch {
            throw Error('Launch data repair response uncertain; inspect saved intent and current records before any recovery.');
        }
        check(response.ok || [404, 412].includes(response.status), `HTTP ${response.status}; private response omitted.`);
        return response;
    };
    const api = async (path, body) => {
        const response = await send(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        check(response.ok, 'API request failed.');
        const value = await response.json();
        check(value.success === true, 'unconfirmed API response.');
        return value.result;
    };
    return { api, query: async (sql, params = []) => { const result = await api(`/d1/database/${DATABASE}/query`, { sql, params }); check(result?.length === 1 && result[0].success === true, 'unconfirmed query.'); return result[0]; },
        object: (key, bytes, type = 'application/json') => send(`/r2/buckets/${BUCKET}/objects/${key}`, bytes === undefined ? {} : { method: 'PUT', headers: { 'content-type': type, 'if-none-match': '*' }, body: bytes }) };
}
async function baseline(cf) {
    for (const [worker, id] of [['forever-tee-api', API_VERSION], ['forever-tee-print-executor-production', PRINT_VERSION]]) {
        const state = await cf.api(`/workers/scripts/${worker}/deployments`), current = state.deployments?.[0];
        check(current?.versions?.length === 1 && current.versions[0].version_id === id && current.versions[0].percentage === 100, 'qualified live Worker pair changed.');
    }
    const version = await cf.api(`/workers/scripts/forever-tee-api/versions/${API_VERSION}`);
    for (const [name, value] of Object.entries({ STORY_VIDEO_RELEASE_ID: RELEASE, STORY_VIDEO_RELEASE_COMMIT: SOURCE }))
        check(version.resources?.bindings?.some(b => b.name === name && b.type === 'plain_text' && b.text === value), 'qualified native source changed.');
    const controls = (await cf.query("SELECT paused,release_id,current_release_id FROM native_video_release_control WHERE singleton=1")).results;
    check(controls.length === 1 && controls[0].paused === 0 && controls[0].release_id === null && controls[0].current_release_id === RELEASE, 'native admission state changed.');
    const pause = (await cf.query("SELECT enabled FROM operational_controls WHERE control_key='sales_pause'")).results;
    check(pause.length === 1 && pause[0].enabled === 1, 'purchasing must remain paused throughout repair.');
    const orders = (await cf.query('SELECT id,status,source_payload_sha256,updated_at FROM paid_orders ORDER BY id')).results;
    check(orders.length === 1 && orders[0].status === 'fulfilled', 'expected fulfilled order inventory changed.');
    return digest(JSON.stringify(orders));
}
async function sourceCohort(cf) {
    const rows = (await cf.query(`SELECT DISTINCT r.id,r.design_id,r.artwork_key,r.sha256,r.byte_size,r.content_type,r.artwork_width,r.artwork_height,d.owner_id IS NOT NULL AS owned
 FROM design_revisions r JOIN designs d ON d.id=r.design_id JOIN products p ON p.design_revision_id=r.id JOIN print_asset_jobs j ON j.configured_product_id=p.id
 WHERE p.status IN ('active','suspended') AND (j.status IN ('pending','dispatched') OR (p.status='suspended' AND j.status='ready')) AND ${LEGACY_SOURCE_PREDICATE} ORDER BY r.id`)).results;
    check(rows.length === 24, 'exact 24-revision historical source inventory required.');
    rows.forEach(artworkMigration);
    const products = (await cf.query(`SELECT p.id,p.status,p.design_id,p.design_revision_id,p.base_product_id,p.print_mode,p.placement_x,p.placement_y,p.placement_width,p.placement_depth,p.projection_version,r.crop_x,r.crop_y,r.crop_zoom
 FROM products p JOIN design_revisions r ON r.id=p.design_revision_id JOIN print_asset_jobs j ON j.configured_product_id=p.id
 WHERE p.status IN ('active','suspended') AND (j.status IN ('pending','dispatched') OR (p.status='suspended' AND j.status='ready')) AND ${LEGACY_SOURCE_PREDICATE} ORDER BY p.id`)).results;
    check(products.length === 48 && products.every(p => rows.some(r => r.id === p.design_revision_id)), 'exact 48-product historical cohort required.');
    for (const row of rows) {
        const protectedRows = (await cf.query('SELECT l.id FROM paid_order_lines l JOIN products p ON p.id=l.configured_product_id WHERE p.design_id=?', [row.design_id])).results;
        check(protectedRows.length === 0, 'paid artwork cannot be migrated by this repair.');
    }
    return { rows, products };
}
export const CURRENT_PRINT_GEOMETRIES_SQL = "SELECT DISTINCT s.base_product_id,v.print_width,v.print_height FROM printify_catalogue_variants v JOIN printify_catalogue_snapshots s ON s.id=v.snapshot_id\n WHERE v.snapshot_id IN ((SELECT catalogue_snapshot_id FROM shopify_variant_mapping_snapshots WHERE base_product_id='" + "a51b7acf-77e9-4762-83c4-62d96dd8942c" + "' ORDER BY retrieved_at DESC,id DESC LIMIT 1),(SELECT catalogue_snapshot_id FROM shopify_variant_mapping_snapshots WHERE base_product_id='" + "97b629d7-1d3b-4d2a-a586-537168141e97" + "' ORDER BY retrieved_at DESC,id DESC LIMIT 1))";
async function inspectSources(cf, cohort) {
    const geometries = (await cf.query(CURRENT_PRINT_GEOMETRIES_SQL)).results;
    const sources = [];
    const quality = [];
    for (const row of cohort.rows) {
        const response = await cf.object(row.artwork_key);
        check(response.ok, 'historical source unavailable.');
        const bytes = Buffer.from(await response.arrayBuffer());
        verifyArtwork(row, bytes);
        const meta = await sharp(bytes).metadata();
        check(meta.width > 0 && meta.height > 0 && (!row.artwork_width || row.artwork_width === meta.width) && (!row.artwork_height || row.artwork_height === meta.height), 'decoded source dimensions differ.');
        for (const p of cohort.products.filter(p => p.design_revision_id === row.id)) {
            const sizes = geometries.filter(g => g.base_product_id === p.base_product_id);
            check(sizes.length > 0, 'accepted print geometries missing.');
            const minimumPpi = Math.min(...sizes.map(g => printSourceResolution(meta.width, meta.height, { width: g.print_width, height: g.print_height }, { cropX: p.crop_x, cropY: p.crop_y, cropZoom: p.crop_zoom }).ppi));
            check(Number.isFinite(minimumPpi), 'invalid print density.');
            quality.push({ productId: p.id, revisionId: p.design_revision_id, status: p.status, minimumPpi, safe: minimumPpi >= 150 });
        }
        const target = await cf.object(artworkMigration(row).key);
        if (target.ok)
            verifyArtwork(row, Buffer.from(await target.arrayBuffer()));
        else
            check(target.status === 404, 'canonical target unavailable.');
        sources.push({ ...row, width: meta.width, height: meta.height });
    }
    const blockedRevisions = new Set(quality.filter(p => !p.safe).map(p => p.revisionId));
    return { sources, quality: quality.map(p => ({ ...p, familyPrintable: !blockedRevisions.has(p.revisionId) })) };
}
async function videoInventory(cf) {
    const products = (await cf.query('SELECT id,design_revision_id,base_product_id,status,placement_depth FROM products WHERE id IN (?,?) ORDER BY id', [SHIRT, TOTE])).results;
    check(products.length === 2 && products.every(p => p.status === 'active' && p.design_revision_id === REVISION && p.placement_depth === 5), 'exact incident family changed.');
    const jobs = (await cf.query("SELECT product_id,colour,status,attempt_count FROM story_video_jobs WHERE design_revision_id=? AND renderer_version='story-video-renderer-v7' ORDER BY product_id,colour", [REVISION])).results;
    check(jobs.length === 2 && jobs.every(j => j.product_id === TOTE && j.status === 'ready') && new Set(jobs.map(j => j.colour.toLowerCase())).size === 2, 'exact missing-shirt video gap changed.');
    return { products, jobs };
}
async function verifyResult(cf, intent, orderDigest) {
    check(intent?.schemaVersion === 1 && intent.release === RELEASE && intent.source === SOURCE && intent.cohort?.rows?.length === 24 && intent.cohort.products?.length === 48, 'valid saved repair intent required.');
    let ready = 0, purchaseReady = 0, quarantined = 0;
    const unsafe = new Set(intent.quality.filter(p => !p.familyPrintable).map(p => p.productId));
    const db = { prepare: sql => ({ bind: (...params) => ({ first: async () => (await cf.query(sql, params)).results[0] ?? null }) }) };
    for (const row of intent.cohort.rows) {
        const current = (await cf.query('SELECT artwork_key,sha256,byte_size FROM design_revisions WHERE id=? AND design_id=?', [row.id, row.design_id])).results;
        check(current.length === 1 && current[0].artwork_key === artworkMigration(row).key && current[0].sha256 === row.sha256 && current[0].byte_size === row.byte_size, 'source migration not confirmed.');
        const response = await cf.object(current[0].artwork_key);
        check(response.ok, 'migrated source missing.');
        verifyArtwork(row, Buffer.from(await response.arrayBuffer()));
    }
    for (const p of intent.cohort.products) {
        const jobs = (await cf.query('SELECT status,attempt_count FROM print_asset_jobs WHERE configured_product_id=?', [p.id])).results;
        check(jobs.length === 1, 'print outbox row missing.');
        if (jobs[0].status === 'ready')
            ready++;
        if (unsafe.has(p.id)) {
            const blocked = (await cf.query("SELECT p.id FROM products p WHERE p.id=? AND p.status='suspended' AND EXISTS (SELECT 1 FROM product_lifecycle_transitions t WHERE t.product_id=p.id AND t.to_status='suspended' AND t.actor_id='" + protectedConfig("githubOwnerId") + "' AND t.reason=? AND t.applied_at IS NOT NULL)", [p.id, QUALITY_REASON])).results;
            check(blocked.length === 1 && (await productPurchaseReadiness(db, p.id))?.ready !== true, 'low-resolution legacy product must remain blocked.');
            quarantined++;
        }
        else if ((await productPurchaseReadiness(db, p.id))?.ready === true)
            purchaseReady++;
    }
    const videos = (await cf.query("SELECT product_id,colour,status FROM story_video_jobs WHERE design_revision_id=? AND renderer_version='story-video-renderer-v7' ORDER BY product_id,colour", [REVISION])).results;
    check(orderDigest === intent.orderDigest, 'paid order changed during repair.');
    const expected = new Set([`${SHIRT}:black`, `${SHIRT}:white`, `${TOTE}:black`, `${TOTE}:cream`]);
    check(videos.every(j => expected.has(`${j.product_id}:${j.colour.toLowerCase()}`)) && new Set(videos.map(j => `${j.product_id}:${j.colour.toLowerCase()}`)).size === videos.length, 'incident video inventory differs.');
    if (ready === 48 && purchaseReady === 22 && quarantined === 26 && videos.length === 4 && videos.every(j => j.status === 'ready')) {
        for (const video of videos) {
            const response = await fetch(`https://shop.bent.build/api/configured-product-video/${video.product_id}/${video.colour.toLowerCase()}.mp4`, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30000) });
            check(response.ok && response.headers.get('content-type') === 'video/mp4', 'repaired public video unavailable.');
            await response.body?.cancel();
        }
    }
    return { migratedRevisions: 24, completedOutboxJobs: ready, expectedOutboxJobs: 48, purchaseReadyProducts: purchaseReady, quarantinedProducts: quarantined, videosReady: videos.filter(j => j.status === 'ready').length, videosExpected: 4, complete: ready === 48 && purchaseReady === 22 && quarantined === 26 && videos.length === 4 && videos.every(j => j.status === 'ready'), paidOrderUnchanged: true };
}
async function savePlan(plan) { await mkdir('launch-data-repair-output', { recursive: true }); await writeFile('launch-data-repair-output/plan.json', JSON.stringify(plan, null, 2), { mode: 0o600 }); }
export async function runRepair(env, dependencies = {}) {
    repairContext(env);
    const cf = dependencies.cf ?? client(env);
    const orderDigest = await baseline(cf);
    if (env.REPAIR_OPERATION === 'verify') {
        const saved = await cf.object(INTENT);
        check(saved.ok, 'saved repair intent missing.');
        return verifyResult(cf, await saved.json(), orderDigest);
    }
    const cohort = await sourceCohort(cf), video = await videoInventory(cf), media = await inspectSources(cf, cohort);
    const { sources, quality } = media;
    const plan = { schemaVersion: 1, release: RELEASE, source: SOURCE, apiVersion: API_VERSION, printVersion: PRINT_VERSION, orderDigest, cohort, video, sources, quality };
    const planDigest = digest(JSON.stringify(plan));
    if (env.REPAIR_OPERATION === 'plan') {
        await (dependencies.savePlan ?? savePlan)({ ...plan, planDigest });
        return { planDigest, revisions: 24, printJobs: 48, newVideos: 2, sourceChecksumsVerified: true, printableProducts: quality.filter(p => p.familyPrintable).length, lowResolutionProducts: quality.filter(p => !p.safe).length, quarantineProducts: quality.filter(p => !p.familyPrintable).length, paidOrderUnchanged: true };
    }
    check(quality.filter(p => p.familyPrintable && p.status === 'active').length === 22 && quality.filter(p => !p.familyPrintable && p.status === 'suspended').length === 26, 'exact 22 printable and 26 suspended legacy-family products required.');
    for (const product of quality.filter(p => !p.familyPrintable)) {
        check(cohort.rows.find(r => r.id === product.revisionId)?.owned === 0, 'only historical unowned families can be quarantined.');
        const rows = (await cf.query("SELECT product_id FROM product_lifecycle_transitions WHERE product_id=? AND to_status='suspended' AND actor_id='" + protectedConfig("githubOwnerId") + "' AND reason=? AND applied_at IS NOT NULL", [product.productId, QUALITY_REASON])).results;
        check(rows.length > 0, 'reviewed owner suspension required for unprintable artwork.');
    }
    check(planDigest === env.REPAIR_PLAN_DIGEST, 'reviewed plan no longer matches current source bytes, product settings, orders or video inventory.');
    const intent = { ...plan, planDigest, runId: env.GITHUB_RUN_ID, toolingSource: env.GITHUB_SHA };
    const prior = await cf.object(INTENT);
    check(prior.status === 404, 'durable repair intent already exists; inspect before any recovery.');
    const recorded = await cf.object(INTENT, Buffer.from(JSON.stringify(intent)));
    check(recorded.ok, 'one-shot repair intent not recorded.');
    const saved = await cf.object(INTENT);
    check(saved.ok && (await saved.json()).runId === env.GITHUB_RUN_ID, 'repair intent identity mismatch.');
    for (const row of cohort.rows) {
        const original = await cf.object(row.artwork_key);
        check(original.ok, 'source changed before copy.');
        const bytes = Buffer.from(await original.arrayBuffer());
        verifyArtwork(row, bytes);
        const copy = await cf.object(artworkMigration(row).key, bytes, row.content_type);
        check(copy.ok || copy.status === 412, 'canonical copy not confirmed.');
        const verified = await cf.object(artworkMigration(row).key);
        check(verified.ok, 'canonical copy missing.');
        verifyArtwork(row, Buffer.from(await verified.arrayBuffer()));
    }
    check(await baseline(cf) === orderDigest, 'order changed before database migration.');
    for (const row of cohort.rows) {
        const statements = migrationStatements(row);
        const result = await cf.query(statements[0].sql, statements[0].params);
        check(result.meta?.changes === 1, 'revision source changed during migration.');
        await cf.query(statements[1].sql, statements[1].params);
    }
    for (const statement of missingVideoStatements(Date.now())) {
        const result = await cf.query(statement.sql, statement.params);
        check(result.meta?.changes === 1, 'missing video insertion changed concurrently.');
    }
    for (const p of cohort.products.filter(p => p.status === 'suspended')) {
        const statement = inactiveJobStatement(p);
        await cf.query(statement.sql, statement.params);
    }
    for (const p of cohort.products.filter(p => p.status === 'active')) {
        const result = await cf.query(`UPDATE print_asset_jobs SET next_attempt_at=0 WHERE configured_product_id=? AND status='pending'
 AND EXISTS (SELECT 1 FROM products p JOIN design_revisions r ON r.id=p.design_revision_id WHERE p.id=print_asset_jobs.configured_product_id AND p.design_revision_id=? AND r.artwork_key=?)`, [p.id, p.design_revision_id, artworkMigration(cohort.rows.find(r => r.id === p.design_revision_id)).key]);
        check([0, 1].includes(result.meta?.changes), 'print retry update not confirmed.');
    }
    const printQueues = await cf.api('/queues?name=forever-tee-print-assets-production');
    check(printQueues.length === 1 && printQueues[0].queue_name === 'forever-tee-print-assets-production', 'exact print queue required.');
    for (const p of cohort.products.filter(p => p.status === 'active'))
        await cf.api(`/queues/${printQueues[0].queue_id}/messages`, { body: { configuredProductId: p.id }, content_type: 'json' });
    await cf.api("/queues/" + protectedConfig("resource_2f27c2bd55b6") + "/messages", { body: { designRevisionId: REVISION }, content_type: 'json' });
    return { ...await verifyResult(cf, intent, await baseline(cf)), repairDispatched: true, planDigest };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const result = await runRepair(process.env);
        await mkdir('launch-data-repair-output', { recursive: true });
        await writeFile('launch-data-repair-output/result.json', JSON.stringify(result, null, 2));
        console.info(JSON.stringify(result));
        if (process.env.REPAIR_OPERATION === 'verify' && !result.complete)
            process.exitCode = 1;
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
