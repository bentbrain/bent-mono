import { protectedConfig } from "./protected-config.mjs";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { runRepair, inactiveJobStatement, CURRENT_PRINT_GEOMETRIES_SQL, artworkMigration, verifyArtwork, repairContext, migrationStatements, missingVideoStatements } from './launch-data-repair.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const revision = '22222222-2222-4222-8222-222222222222';
const bytes = Buffer.from('unchanged portrait');
const hash = createHash('sha256').update(bytes).digest('hex');
const row = { id: revision, design_id: id, artwork_key: `designs/${id}/artwork`, sha256: hash, byte_size: bytes.length, content_type: 'image/png', artwork_width: null, artwork_height: null };
test('legacy sources become content addressed without changing revision identity or checksum', () => {
    const value = artworkMigration(row);
    assert.equal(value.key, `designs/${id}/artwork/${hash}`);
    assert.equal(value.id, revision);
    assert.equal(value.sha256, hash);
    assert.equal(artworkMigration({ ...row, artwork_key: `designs/${id}/native-production-canary.png` }).key, value.key);
});
test('wrong source bytes, size, unrelated keys and malformed identifiers stop migration', () => {
    assert.doesNotThrow(() => verifyArtwork(row, bytes));
    assert.throws(() => verifyArtwork(row, Buffer.from('changed portrait!')), /checksum|size/);
    for (const change of [{ artwork_key: `designs/${id}/preview` }, { sha256: 'a' }, { id: 'invalid' }, { byte_size: 0 }])
        assert.throws(() => artworkMigration({ ...row, ...change }));
});
test('database repair preserves paid provenance and uses compare-and-swap source guards', () => {
    const statements = migrationStatements(row);
    assert.equal(statements.length, 2);
    assert.match(statements[0].sql, /NOT EXISTS.*paid_order_lines/s);
    assert.match(statements[0].sql, /artwork_key=\? AND sha256=\? AND byte_size=\?/);
    assert.ok(!statements.some(s => /DELETE|attempt_count=0|sha256=/.test(s.sql.replace('sha256=?', ''))));
    assert.equal(statements[0].params[0], artworkMigration(row).key);
});
test('missing video repair binds only the incident shirt revision and leaves existing jobs intact', () => {
    const statements = missingVideoStatements(123);
    assert.equal(statements.length, 2);
    assert.match(statements[0].sql, /ON CONFLICT.*DO NOTHING/s);
    assert.ok(statements.every(s => s.params.includes(protectedConfig("resource_a159071759db")) && s.params.includes(protectedConfig("resource_02f1c868d95c"))));
    assert.deepEqual(statements.map(s => s.params[1]), ['Black', 'White']);
});
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'bentbrain/bent-mono', GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"), GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_ACTOR_ID: protectedConfig("githubOwnerId"), GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_WORKFLOW_REF: 'bentbrain/bent-mono/.github/workflows/launch-data-repair.yml@refs/heads/main', CLOUDFLARE_ACCOUNT_ID: protectedConfig("cloudflareAccountId"), CLOUDFLARE_API_TOKEN: 'secret', REPAIR_OPERATION: 'plan' };
test('repair rejects local execution, reruns, other accounts, sources and arbitrary operations', () => {
    assert.doesNotThrow(() => repairContext(env));
    for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_REF: 'refs/heads/test' }, { CLOUDFLARE_ACCOUNT_ID: 'other' }, { REPAIR_OPERATION: 'delete' }])
        assert.throws(() => repairContext({ ...env, ...change }));
    assert.throws(() => repairContext({ ...env, REPAIR_OPERATION: 'execute' }), /digest/);
});
test('paid-order and concurrent artwork guards reject the actual database update', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE design_revisions(id TEXT,design_id TEXT,artwork_key TEXT,sha256 TEXT,byte_size INTEGER); CREATE TABLE products(id TEXT,design_id TEXT); CREATE TABLE paid_order_lines(id TEXT,configured_product_id TEXT)');
    db.prepare('INSERT INTO design_revisions VALUES (?,?,?,?,?)').run(row.id, row.design_id, row.artwork_key, row.sha256, row.byte_size);
    const statement = migrationStatements(row)[0];
    db.prepare('INSERT INTO products VALUES (?,?)').run('paid-product', row.design_id);
    db.prepare('INSERT INTO paid_order_lines VALUES (?,?)').run('paid-line', 'paid-product');
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 0);
    db.exec('DELETE FROM paid_order_lines');
    db.prepare('UPDATE design_revisions SET sha256=?').run('b'.repeat(64));
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 0);
    db.prepare('UPDATE design_revisions SET sha256=?').run(row.sha256);
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 1);
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 0);
    db.close();
});
test('actual missing-video insertion is bounded and idempotent', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE products(id TEXT,design_revision_id TEXT,video_design_revision_id TEXT,status TEXT,base_product_id TEXT); CREATE TABLE story_video_jobs(id TEXT,product_id TEXT,design_revision_id TEXT,colour TEXT,renderer_version TEXT,story_key TEXT,status TEXT,attempt_count INTEGER,created_at INTEGER,updated_at INTEGER,UNIQUE(product_id,colour,renderer_version))');
    db.prepare('INSERT INTO products VALUES (?,?,NULL,?,?)').run(protectedConfig("resource_a159071759db"), protectedConfig("resource_02f1c868d95c"), 'active', "a51b7acf-77e9-4762-83c4-62d96dd8942c");
    for (const s of missingVideoStatements(123))
        assert.equal(db.prepare(s.sql).run(...s.params).changes, 1);
    for (const s of missingVideoStatements(124))
        assert.equal(db.prepare(s.sql).run(...s.params).changes, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM story_video_jobs').get().count, 2);
    db.close();
});
async function repairFixture() {
    const portrait = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#000000' } }).png().toBuffer();
    const sha = createHash('sha256').update(portrait).digest('hex');
    const rows = Array.from({ length: 24 }, (_, n) => { const design = `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`; return { ...row, id: design, design_id: design, artwork_key: `designs/${design}/artwork`, byte_size: portrait.length, sha256: sha }; });
    const products = rows.flatMap(r => [0, 1].map(n => ({ id: `${n}${r.id.slice(1)}`, status: 'active', design_id: r.design_id, design_revision_id: r.id, base_product_id: n ? 'tee' : 'tote', crop_x: 0.5, crop_y: 0.5, crop_zoom: 1 })));
    const mutations = [];
    const cf = {
        api: async (path) => { if (path.endsWith('/deployments'))
            return { deployments: [{ versions: [{ version_id: path.includes('print-executor') ? protectedConfig("resource_3f1f85992426") : protectedConfig("resource_0f41847ac21d"), percentage: 100 }] }] }; return { resources: { bindings: [{ name: 'STORY_VIDEO_RELEASE_ID', type: 'plain_text', text: "native-" + protectedConfig("resource_8d552ad12cd3") }, { name: 'STORY_VIDEO_RELEASE_COMMIT', type: 'plain_text', text: '113decd1eadde612468c4fa3fa23ac952beff438' }] } }; },
        query: async (sql) => {
            if (!sql.startsWith('SELECT'))
                mutations.push(sql);
            let results = [];
            if (sql.includes('FROM native_video_release_control'))
                results = [{ paused: 0, release_id: null, current_release_id: "native-" + protectedConfig("resource_8d552ad12cd3") }];
            else if (sql.includes('FROM operational_controls'))
                results = [{ enabled: 1 }];
            else if (sql.includes('FROM paid_orders'))
                results = [{ id: 'paid', status: 'fulfilled', source_payload_sha256: sha, updated_at: 123 }];
            else if (sql.startsWith('SELECT DISTINCT r.id'))
                results = rows;
            else if (sql.startsWith('SELECT p.id,p.status,p.design_id'))
                results = products;
            else if (sql.startsWith('SELECT DISTINCT s.base_product_id'))
                results = ['tee', 'tote'].map(base_product_id => ({ base_product_id, print_width: 8, print_height: 8 }));
            else if (sql.startsWith('SELECT id,design_revision_id'))
                results = [protectedConfig("resource_a159071759db"), protectedConfig("resource_9e4c210fa7f3")].map(id => ({ id, status: 'active', design_revision_id: protectedConfig("resource_02f1c868d95c"), placement_depth: 5 }));
            else if (sql.startsWith('SELECT product_id,colour'))
                results = ['Black', 'Cream'].map(colour => ({ product_id: protectedConfig("resource_9e4c210fa7f3"), colour, status: 'ready', attempt_count: 1 }));
            return { results };
        },
        object: async (key, bytes) => { if (bytes)
            mutations.push(key); return key.endsWith('/artwork') ? new Response(portrait) : new Response(null, { status: 404 }); }
    };
    return { cf, mutations, rows, products };
}
test('real plan path verifies every source without mutating cloud data', async () => {
    const fixture = await repairFixture();
    let saved;
    const result = await runRepair(env, { cf: fixture.cf, savePlan: async (plan) => { saved = plan; } });
    assert.equal(result.sourceChecksumsVerified, true);
    assert.equal(result.printableProducts, 48);
    assert.equal(saved.cohort.rows.length, 24);
    assert.deepEqual(fixture.mutations, []);
});
test('an unreviewed execute digest stops before durable intent or cloud writes', async () => {
    const fixture = await repairFixture();
    await assert.rejects(runRepair({ ...env, REPAIR_OPERATION: 'execute', REPAIR_PLAN_DIGEST: '0'.repeat(64) }, { cf: fixture.cf }), /exact 22 printable and 26 suspended/);
    assert.deepEqual(fixture.mutations, []);
});
test('the one verified cross-design legacy ledger key has an exact exception, never a general cross-design allowance', () => {
    const shared = { ...row, id: "43609485-55c3-419a-bffa-f606edc02d98", design_id: "43609485-55c3-419a-bffa-f606edc02d98", artwork_key: "designs/" + "8f48ee90-08d8-4c6c-b369-0444a20ddd25" + "/artwork", sha256: protectedConfig("resource_b08be69bc26f"), byte_size: 1429359 };
    assert.doesNotThrow(() => artworkMigration(shared));
    for (const change of [{ id: row.id }, { design_id: row.design_id }, { sha256: 'a'.repeat(64) }, { byte_size: 1 }])
        assert.throws(() => artworkMigration({ ...shared, ...change }));
    assert.throws(() => artworkMigration({ ...row, artwork_key: shared.artwork_key }));
});
test('inactive outbox completion cannot falsely make an active or paid product ready', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE products(id TEXT,design_revision_id TEXT,status TEXT); CREATE TABLE print_asset_jobs(configured_product_id TEXT,status TEXT,lease_id TEXT,updated_at INTEGER); CREATE TABLE paid_order_lines(configured_product_id TEXT); CREATE TABLE product_lifecycle_transitions(product_id TEXT,to_status TEXT,actor_id TEXT,reason TEXT,applied_at INTEGER)');
    db.prepare('INSERT INTO products VALUES (?,?,?)').run(id, revision, 'active');
    db.prepare('INSERT INTO print_asset_jobs VALUES (?, ?, NULL,0)').run(id, 'pending');
    const statement = inactiveJobStatement({ id, design_revision_id: revision, status: 'suspended' });
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 0);
    db.prepare("UPDATE products SET status='suspended'").run();
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 0);
    db.prepare('INSERT INTO product_lifecycle_transitions VALUES (?,?,?,?,?)').run(id, 'suspended', protectedConfig("githubOwnerId"), statement.params[3], 123);
    db.prepare('INSERT INTO paid_order_lines VALUES (?)').run(id);
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 0);
    db.exec('DELETE FROM paid_order_lines');
    assert.equal(db.prepare(statement.sql).run(...statement.params).changes, 1);
    assert.equal(db.prepare('SELECT status FROM products').get().status, 'suspended');
    db.close();
});
test('current geometry lookup uses snapshot indexes rather than scanning catalogue history', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE printify_catalogue_variants(snapshot_id TEXT,print_width INTEGER,print_height INTEGER); CREATE INDEX variants_snapshot ON printify_catalogue_variants(snapshot_id); CREATE TABLE printify_catalogue_snapshots(id TEXT PRIMARY KEY,base_product_id TEXT); CREATE TABLE shopify_variant_mapping_snapshots(id TEXT,base_product_id TEXT,catalogue_snapshot_id TEXT,retrieved_at INTEGER); CREATE INDEX mapping_base_time ON shopify_variant_mapping_snapshots(base_product_id,retrieved_at,id)');
    const bases = ["a51b7acf-77e9-4762-83c4-62d96dd8942c", "97b629d7-1d3b-4d2a-a586-537168141e97"];
    for (const [n, base] of bases.entries()) {
        const snapshot = `snapshot-${n}`;
        db.prepare('INSERT INTO printify_catalogue_snapshots VALUES (?,?)').run(snapshot, base);
        db.prepare('INSERT INTO printify_catalogue_variants VALUES (?,?,?)').run(snapshot, 100, 200);
        db.prepare('INSERT INTO shopify_variant_mapping_snapshots VALUES (?,?,?,?)').run(snapshot, base, snapshot, 123);
    }
    const previous = `SELECT DISTINCT s.base_product_id,v.print_width,v.print_height FROM printify_catalogue_variants v JOIN printify_catalogue_snapshots s ON s.id=v.snapshot_id WHERE s.id=(SELECT m.catalogue_snapshot_id FROM shopify_variant_mapping_snapshots m WHERE m.base_product_id=s.base_product_id ORDER BY m.retrieved_at DESC,m.id DESC LIMIT 1)`;
    assert.deepEqual(db.prepare(CURRENT_PRINT_GEOMETRIES_SQL).all().sort((a, b) => a.base_product_id.localeCompare(b.base_product_id)), db.prepare(previous).all().sort((a, b) => a.base_product_id.localeCompare(b.base_product_id)));
    const old = db.prepare('EXPLAIN QUERY PLAN ' + previous).all().map(r => r.detail).join(' '), current = db.prepare('EXPLAIN QUERY PLAN ' + CURRENT_PRINT_GEOMETRIES_SQL).all().map(r => r.detail).join(' ');
    assert.match(old, /SCAN v/);
    assert.match(current, /SEARCH v USING INDEX variants_snapshot/);
    assert.doesNotMatch(current, /SCAN v/);
    db.close();
});
test('a family with one low-density product is held together, even when its sibling passes', async () => {
    const fixture = await repairFixture();
    fixture.products[0].crop_zoom = 4;
    const result = await runRepair(env, { cf: fixture.cf, savePlan: async () => { } });
    assert.equal(result.lowResolutionProducts, 1);
    assert.equal(result.quarantineProducts, 2);
    assert.equal(result.printableProducts, 46);
    assert.deepEqual(fixture.mutations, []);
});
