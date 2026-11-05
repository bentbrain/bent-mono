import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { captureQualificationInventory, deleteQualificationInventory, qualificationDeletionBatch } from './native-qualification-inventory.mjs';
const design='11111111-1111-4111-8111-111111111111', product='22222222-2222-4222-8222-222222222222', revision='33333333-3333-4333-8333-333333333333';
const sha='a'.repeat(64), source='b'.repeat(40), env={GITHUB_RUN_ID:'123',GITHUB_SHA:source,NATIVE_VERIFY_RELEASE:'native-100'};
function fixture() {
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE designs(id TEXT PRIMARY KEY,artwork_key TEXT,sha256 TEXT);
 CREATE TABLE products(id TEXT PRIMARY KEY,design_id TEXT REFERENCES designs(id));
 CREATE TABLE design_revisions(id TEXT PRIMARY KEY,design_id TEXT REFERENCES designs(id),artwork_key TEXT);
 CREATE TABLE print_assets(id TEXT PRIMARY KEY,configured_product_id TEXT REFERENCES products(id),storage_key TEXT);
 CREATE TABLE print_asset_objects(storage_key TEXT);
 CREATE TABLE print_asset_jobs(configured_product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,status TEXT);
 CREATE TABLE story_video_jobs(id TEXT PRIMARY KEY,product_id TEXT REFERENCES products(id),status TEXT,story_key TEXT);
 CREATE TABLE storage_test_fixtures(design_id TEXT PRIMARY KEY REFERENCES designs(id),run_id TEXT,purpose TEXT);
 CREATE TABLE paid_order_lines(configured_product_id TEXT REFERENCES products(id));
 CREATE TABLE printify_production_products(configured_product_id TEXT REFERENCES products(id));`);
 for(const table of ['native_video_qualification_observations','native_video_qualification_faults','design_upload_grants'])
  db.exec(`CREATE TABLE ${table}(design_id TEXT REFERENCES designs(id))`);
 db.prepare('INSERT INTO designs VALUES(?,?,?)').run(design,`designs/${design}/artwork/${sha}`,sha);
 db.prepare('INSERT INTO products VALUES(?,?)').run(product,design);
 db.prepare('INSERT INTO design_revisions VALUES(?,?,?)').run(revision,design,`designs/${design}/artwork/${sha}`);
 db.prepare('INSERT INTO print_assets VALUES(?,?,?)').run('asset',product,`print-assets/blobs/${sha}.png`);
 db.prepare('INSERT INTO story_video_jobs VALUES(?,?,?,?)').run('job',product,'ready',`story-videos/v7/${revision}/${product}/black.mp4`);
 db.prepare('INSERT INTO storage_test_fixtures VALUES(?,?,?)').run(design,env.GITHUB_RUN_ID,'native-qualification');
 const calls=[],deleted=[];
 const query=async (sql,params=[])=>{
  const statement=db.prepare(sql); return [{success:true,results:statement.all(...params),meta:{changes:0}}];
 };
 const cf={query,batch:async statements=>{
   calls.push(statements); db.exec('BEGIN');
   try {const result=[];for(const {sql,params} of statements){const stmt=db.prepare(sql);if(sql.trim().startsWith('SELECT'))result.push({results:stmt.all(...params),success:true});else result.push({meta:stmt.run(...params),success:true});}db.exec('COMMIT');return result;}
   catch(error){db.exec('ROLLBACK');throw error;}
  },deleteQualificationArtwork:async key=>deleted.push(key),deleteQualificationVideo:async key=>deleted.push(key)};
 return {db,cf,calls,deleted};
}
test('one atomic fixture batch preserves shared blobs and removes exact revision videos',async()=>{
 const f=fixture(),inventory=await captureQualificationInventory(f.cf,env);
 const result=await deleteQualificationInventory(f.cf,inventory,env);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,11);
 assert.equal(result.qualificationFixturesDeleted,1);
 assert.deepEqual(result.sharedObjectsDeferred,[`print-assets/blobs/${sha}.png`]);
 assert.ok(f.deleted.includes(`story-videos/v7/${revision}/${product}/black.mp4`));
 assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM designs').get().n,0);
 f.db.close();
});
test('lost database acknowledgement is resolved by reading absence without replay',async()=>{
 const f=fixture(),inventory=await captureQualificationInventory(f.cf,env),batch=f.cf.batch;
 f.cf.batch=async statements=>{await batch(statements);throw Error('lost acknowledgement');};
 await deleteQualificationInventory(f.cf,inventory,env);
 assert.equal(f.calls.length,1);
 await deleteQualificationInventory(f.cf,inventory,env);
 assert.equal(f.calls.length,1);f.db.close();
});
test('partial object failure can resume an already-removed fixture from its saved inventory',async()=>{
 const f=fixture(),inventory=await captureQualificationInventory(f.cf,env);
 f.cf.deleteQualificationVideo=async()=>{throw Error('R2 timeout');};
 await assert.rejects(deleteQualificationInventory(f.cf,inventory,env),/cleanup incomplete/);
 assert.equal(f.calls.length,1);
 f.cf.deleteQualificationVideo=async key=>f.deleted.push(key);
 await deleteQualificationInventory(f.cf,inventory,env);
 assert.equal(f.calls.length,1);f.db.close();
});
test('ownership, paid references, active jobs and changed inventory abort the complete batch',async()=>{
 for(const mutation of [
  f=>f.db.exec("UPDATE storage_test_fixtures SET run_id='other'"),
  f=>f.db.prepare('INSERT INTO paid_order_lines VALUES(?)').run(product),
  f=>f.db.exec("UPDATE story_video_jobs SET status='rendering'"),
  f=>f.db.prepare("INSERT INTO print_asset_jobs VALUES(?,'running')").run(product),
  f=>f.db.prepare('INSERT INTO print_assets VALUES(?,?,?)').run('late',product,null),
 ]){
  const f=fixture(),inventory=await captureQualificationInventory(f.cf,env);mutation(f);
  await assert.rejects(f.cf.batch(qualificationDeletionBatch(inventory.fixtures[0],env.GITHUB_RUN_ID)));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM products').get().n,1);
  assert.equal(f.deleted.length,0);f.db.close();
 }
});
test('another release, run, source or foreign key cannot authorize cleanup',async()=>{
 const f=fixture(),inventory=await captureQualificationInventory(f.cf,env);
 for(const change of [{releaseId:'native-999'},{runId:'999'},{sourceCommit:'c'.repeat(40)},
  {fixtures:[{...inventory.fixtures[0],artworkKey:`designs/${product}/artwork/${sha}`}]}])
  await assert.rejects(deleteQualificationInventory(f.cf,{...inventory,...change},env),/inventory rejected/);
 assert.equal(f.calls.length,0);f.db.close();
});
test('artwork referenced elsewhere is retained after removing the owned fixture',async()=>{
 const f=fixture(),inventory=await captureQualificationInventory(f.cf,env),key=inventory.fixtures[0].artworkKey;
 f.db.prepare('INSERT INTO designs VALUES(?,?,?)').run('customer',key,sha);
 const result=await deleteQualificationInventory(f.cf,inventory,env);
 assert.ok(result.sharedObjectsDeferred.includes(key));assert.ok(!f.deleted.includes(key));f.db.close();
});
