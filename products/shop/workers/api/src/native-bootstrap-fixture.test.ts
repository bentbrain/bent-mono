import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy, type PlatformProxy } from 'wrangler';
import { protectedConfig } from './protected-config';
import { acceptedNativeV5Grant, nativeIdentityDigest, parseNativeV5Target } from './native-v5-target';
import { productImageTransfer } from './product-images';
import { createStoryVideoGrant } from './story-video-grants';
import { handleStoryVideoTransfer } from './story-video-transfer';
import { observeQualification } from './story-video-qualification';
import { printPng } from './testing/print-png';

type FixtureKind = 'v5' | 'v4' | 'video' | 'failure';
interface Fixture {
  probeId: string; kind: FixtureKind; designId: string; revisionId: string; productId: string; jobId: string;
  ownerId: string; artworkBase64: string; sourceKey: string; outputKey: string; sourceSha256: string; sourceBytes: number; width: number; height: number;
}
interface Query { action: string; sql: string; params: (string | number | null)[] }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const callable = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function';
function isFixture(value: unknown): value is Fixture {
  return record(value) && ['probeId', 'designId', 'revisionId', 'productId', 'jobId', 'ownerId', 'artworkBase64', 'sourceKey', 'outputKey', 'sourceSha256'].every(key => typeof value[key] === 'string') &&
    ['v5', 'v4', 'video', 'failure'].includes(String(value['kind'])) && ['sourceBytes', 'width', 'height'].every(key => Number.isSafeInteger(value[key]));
}
function isQuery(value: unknown): value is Query {
  return record(value) && typeof value['action'] === 'string' && typeof value['sql'] === 'string' && Array.isArray(value['params']) &&
    value['params'].every((item: unknown) => item === null || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item));
}
let protocol: Record<string, unknown> | undefined;
let platform: PlatformProxy<Env> | undefined;
const artwork = printPng(320, 240);
// These are transport payloads. Native codec execution is qualified separately.
const image = new Uint8Array(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
const video = new TextEncoder().encode('isolated-bootstrap-video-transfer');
const secret = 'synthetic-bootstrap-grant-key-for-real-hmac-only';
const key = { id: 'bootstrap-test', version: 'synthetic-v1', secret };
const authorityDigest = 'd'.repeat(64), sourceDigest = 'a'.repeat(64), inputsDigest = 'b'.repeat(64);
const functionArn = `arn:aws:lambda:ap-southeast-2:${protectedConfig('awsAccountId')}:function:qualification-native-test`;
function bindings() { if (!platform) throw new Error('Isolated Workerd bindings missing'); return platform.env; }
async function call(name: string, input: unknown, ...rest: unknown[]): Promise<unknown> {
  const fn = protocol?.[name]; if (!callable(fn)) throw new Error(`Actual native fixture protocol export missing: ${name}`); return await fn(input, ...rest);
}
function sql(name: string) {
  const all = protocol?.['nativeFixtureSql']; if (!record(all) || typeof all[name] !== 'string') throw new Error(`Actual fixture SQL missing: ${name}`); return all[name];
}
async function queries(value: unknown) {
  if (!Array.isArray(value) || !value.every(isQuery)) throw new Error('Actual native fixture queries missing');
  const result = []; for (const query of value) result.push(await bindings().DB.prepare(query.sql).bind(...query.params).run()); return result;
}
async function cohort(label: string) {
  const operationId = `native-${await nativeIdentityDigest(label)}`, now = Date.now();
  const imageDigest = await nativeIdentityDigest(image), videoDigest = await nativeIdentityDigest(video), emptyDigest = await nativeIdentityDigest(new Uint8Array());
  const template = { schema: 'shop.native-fixture-template/v1', artwork: { base64: Buffer.from(artwork).toString('base64'), sha256: await nativeIdentityDigest(artwork) },
    cohort: ['v5', 'v4', 'video', 'failure', 'v5', 'v5', 'video'].map((kind, index) => ({ probeId: `probe-${String(index)}`, kind,
      expectedOutput: { sha256: kind === 'v5' || kind === 'v4' ? imageDigest : kind === 'failure' ? emptyDigest : videoDigest, bytes: kind === 'v5' || kind === 'v4' ? image.length : kind === 'failure' ? 0 : video.length } })) };
  const value = await call('materializeNativeFixtures', { template, operationId });
  if (!record(value) || !Array.isArray(value['fixtures']) || !value['fixtures'].every(isFixture)) throw new Error('Actual native fixture materialization missing');
  return { fixtures: value['fixtures'], operationId, now };
}
async function stage(fixture: Fixture, operationId: string, now: number) {
  const signed = await call('createNativeFixtureGrant', { fixture, key, now });
  if (!record(signed) || typeof signed['grant'] !== 'string') throw new Error('Actual native HMAC grant missing');
  const grant = signed['grant'];
  const prepared = await call('nativeFixtureStageQueries', { fixture, operationId, createdAt: now, grant, version: '7', functionArn, sourceDigest, inputsDigest, authorityDigest, grantKeyId: key.id });
  if (!record(prepared)) throw new Error('Actual native fixture stage missing'); await queries(prepared['queries']);
  await bindings().DESIGN_ARTWORK.put(fixture.sourceKey, new Uint8Array(Buffer.from(fixture.artworkBase64, 'base64')), { httpMetadata: { contentType: 'image/png' }, customMetadata: { sha256: fixture.sourceSha256 } });
  return grant;
}
async function cleanup(fixture: Fixture, operationId: string) {
  const fn = protocol?.['nativeFixtureCleanupQueries']; if (!callable(fn)) throw new Error('Cleanup adapter missing');
  await queries(fn(fixture, operationId, authorityDigest)); await bindings().DESIGN_ARTWORK.delete([fixture.sourceKey, fixture.outputKey]); await bindings().STORY_VIDEOS?.delete(fixture.outputKey);
  expect(await bindings().DB.prepare(sql('absent')).bind(fixture.designId,fixture.revisionId,fixture.productId,fixture.jobId,fixture.jobId,fixture.jobId,fixture.designId).first()).toEqual({designs:0,revisions:0,products:0,images:0,videos:0,dispatches:0,markers:0,admissions:0,observations:0});
  expect(await bindings().DB.prepare('SELECT design_id FROM native_video_qualification_faults WHERE design_id=?').bind(fixture.designId).first()).toBeNull();
  expect((await bindings().DB.prepare(sql('observations')).bind(fixture.designId).all()).results).toEqual([]);
  expect(await bindings().DESIGN_ARTWORK.head(fixture.sourceKey)).toBeNull(); expect(await bindings().DESIGN_ARTWORK.head(fixture.outputKey)).toBeNull();
  expect(await bindings().STORY_VIDEOS?.head(fixture.outputKey)).toBeNull();
}
function fixtureAt(fixtures: Fixture[], index: number) { const fixture = fixtures[index]; if (!fixture) throw new Error('Complete native fixture cohort missing'); return fixture; }
function environment(operationId: string) { const videos = bindings().STORY_VIDEOS; if (!videos) throw new Error('Isolated video bucket missing'); return { DB: bindings().DB, DESIGN_ARTWORK: bindings().DESIGN_ARTWORK, STORY_VIDEOS: videos,
  STORY_VIDEO_GRANT_SECRET: secret, STORY_VIDEO_PROVIDER: 'lambda', STORY_VIDEO_ENVIRONMENT: 'development',
  SHOP_NATIVE_BOOTSTRAP_AUTHORITY_DIGEST: authorityDigest, SHOP_NATIVE_BOOTSTRAP_OPERATION_ID: operationId,
  STORY_VIDEO_JOBS: { send: () => Promise.resolve(undefined) } }; }
async function transfer(fixture: Fixture, grant: string, operationId: string, action: string, execution: string, body?: Uint8Array, override: Record<string, string> = {}) {
  const isImage = fixture.kind === 'v5' || fixture.kind === 'v4', family = isImage ? 'product-image' : 'story-video';
  const headers = { authorization: `Bearer ${grant}`, [isImage ? 'x-image-execution-id' : 'x-video-execution-id']: execution,
    ...(body ? { 'content-type': isImage ? 'image/webp' : 'video/mp4', 'content-length': String(body.length), [isImage ? 'x-image-sha256' : 'x-video-sha256']: await nativeIdentityDigest(body) } : {}), ...override };
  const request = new Request(`https://api.example.invalid/v2/internal/${family}-jobs/${fixture.jobId}/${action}`, { method: body ? 'PUT' : action === 'artwork' ? 'GET' : 'POST', headers, ...(body ? { body: new Uint8Array(body) } : {}) });
  const response = await (isImage ? productImageTransfer(request, environment(operationId)) : handleStoryVideoTransfer(request, environment(operationId)));
  if (!response) throw new Error('Real business transfer handler did not match fixture'); return response;
}
beforeAll(async () => {
  const loaded: unknown = await import(new URL('../../../scripts/release-v2/native-fixture-protocol.mjs', import.meta.url).href);
  if (!record(loaded)) throw new Error('Actual fixture protocol module missing'); protocol = loaded;
  platform = await getPlatformProxy<Env>({ configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), environment: '', persist: false, remoteBindings: false });
  const directory = new URL('../drizzle/', import.meta.url), migrations = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  expect(migrations.length).toBeGreaterThanOrEqual(45);
  for (const name of migrations) for (const statement of (await readFile(new URL(name, directory), 'utf8')).split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await bindings().DB.prepare(statement).run();
  for (const statement of (await readFile(new URL('../sql/native-qualification.sql', import.meta.url), 'utf8')).split(';').map(value => value.trim()).filter(Boolean)) await bindings().DB.prepare(statement).run();
}, 30000);
afterAll(async () => { await platform?.dispose(); });

describe('actual native bootstrap fixture adapter and business boundary', () => {
  it('stages and removes every member of the complete cohort using the actual scoped lifecycle SQL', async () => {
    const { fixtures, operationId, now } = await cohort('complete-native-cohort');
    try {
      for (const fixture of fixtures) await stage(fixture, operationId, now);
      const rows = await bindings().DB.prepare('SELECT designs.id,designs.owner_id,designs.sha256 FROM designs JOIN storage_test_fixtures marker ON marker.design_id=designs.id WHERE marker.run_id=?').bind(operationId).all<{id:string;owner_id:string;sha256:string}>();
      expect(rows.results).toHaveLength(7);
      for (const fixture of fixtures) expect(rows.results).toContainEqual({id:fixture.designId,owner_id:fixture.ownerId,sha256:fixture.sourceSha256});
      expect((await bindings().DB.prepare('SELECT count(*) AS count FROM native_v5_dispatches native JOIN product_image_jobs jobs ON jobs.id=native.job_id JOIN products ON products.id=jobs.product_id JOIN storage_test_fixtures marker ON marker.design_id=products.design_id WHERE marker.run_id=?').bind(operationId).first<{count:number}>())?.count).toBe(3);
    } finally { for (const fixture of fixtures) await cleanup(fixture, operationId); }
    for (const fixture of fixtures) {
      expect(await bindings().DB.prepare(sql('absent')).bind(fixture.designId,fixture.revisionId,fixture.productId,fixture.jobId,fixture.jobId,fixture.jobId,fixture.designId).first()).toEqual({designs:0,revisions:0,products:0,images:0,videos:0,dispatches:0,markers:0,admissions:0,observations:0});
      expect(await bindings().DB.prepare(sql('observations')).bind(fixture.designId).all()).toMatchObject({results:[]});
      expect(await bindings().DESIGN_ARTWORK.head(fixture.sourceKey)).toBeNull();
    }
  });

  it('retains schema2 HMAC acceptance, decimal recipe, exact source and output identity with execution fencing', async () => {
    const { fixtures, operationId, now } = await cohort('native-v5-real-business'), fixture = fixtureAt(fixtures, 0), grant = await stage(fixture, operationId, now), execution = crypto.randomUUID();
    try {
      const accepted = await acceptedNativeV5Grant(bindings().DB, grant, fixture.jobId, now); expect(accepted?.attempt).toBe(1);
      if (!accepted) throw new Error('Actual schema2 acceptance missing');
      expect(parseNativeV5Target(accepted.acceptance.target_json)).toMatchObject({ schemaVersion: 2, functionArn: `${functionArn}:7`, bootstrapAuthorityDigest: authorityDigest });
      expect(accepted.acceptance.grant_sha256).toBe(await nativeIdentityDigest(grant));
      expect(JSON.parse(accepted.acceptance.input_json)).toMatchObject({ job: { cropX: 0.47, cropY: 0.62, cropZoom: 1.06, placementWidth: 0.08 } });
      expect(await bindings().DB.prepare('SELECT owner_id,sha256,artwork_width,artwork_height,crop_x,crop_y,crop_zoom FROM designs WHERE id=?').bind(fixture.designId).first()).toMatchObject({ owner_id: fixture.ownerId, sha256: fixture.sourceSha256, artwork_width: 320, artwork_height: 240, crop_x: 0.47, crop_y: 0.62, crop_zoom: 1.06 });
      expect((await transfer(fixture, grant + 'tamper', operationId, 'claim', execution)).status).toBe(403);
      const legacy = await createStoryVideoGrant(secret, fixture.jobId, 1, now); expect((await transfer(fixture, legacy, operationId, 'claim', execution)).status).toBe(403);
      await bindings().DB.prepare('UPDATE design_revisions SET crop_x=0.48 WHERE id=?').bind(fixture.revisionId).run();
      expect((await transfer(fixture, grant, operationId, 'claim', execution)).status).toBe(409);
      await bindings().DB.prepare('UPDATE design_revisions SET crop_x=0.47 WHERE id=?').bind(fixture.revisionId).run();
      const source = await transfer(fixture, grant, operationId, 'claim', execution, undefined, { accept: 'application/vnd.bent.product-image-source' }); expect(source.status).toBe(201);
      expect(new Uint8Array(await source.arrayBuffer())).toEqual(artwork); expect(JSON.parse(source.headers.get('x-image-recipe') ?? '{}')).toMatchObject({ settings: { cropX: 0.47, cropY: 0.62, cropZoom: 1.06 } });
      const corrupted = new Uint8Array(artwork); corrupted[0] = 0;
      await bindings().DESIGN_ARTWORK.put(fixture.sourceKey, corrupted);
      expect((await transfer(fixture, grant, operationId, 'artwork', execution)).status).toBe(409);
      await bindings().DESIGN_ARTWORK.put(fixture.sourceKey, artwork);
      const originalSource = await transfer(fixture, grant, operationId, 'artwork', execution); expect(originalSource.status).toBe(200); expect(new Uint8Array(await originalSource.arrayBuffer())).toEqual(artwork);
      expect((await transfer(fixture, grant, operationId, 'claim', crypto.randomUUID())).status).toBe(204);
      expect((await transfer(fixture, grant, operationId, 'image', crypto.randomUUID(), image)).status).toBe(409);
      expect((await transfer(fixture, grant, operationId, 'image', execution, image, { 'x-image-sha256': '0'.repeat(64) })).status).toBe(422);
      const published = await transfer(fixture, grant, operationId, 'image', execution, image); expect(published.status).toBe(200);
      const output = await bindings().DESIGN_ARTWORK.get(fixture.outputKey); if (!output) throw new Error('Published image missing'); expect(new Uint8Array(await output.arrayBuffer())).toEqual(image);
      expect(output.customMetadata).toMatchObject({ sha256: await nativeIdentityDigest(image), sourceSha256: fixture.sourceSha256, rendererVersion: 'product-images-v5' });
      expect(await bindings().DB.prepare(sql('imageResult')).bind(fixture.jobId, fixture.productId, fixture.revisionId).first()).toMatchObject({ status: 'ready', execution_id: execution, sha256: await nativeIdentityDigest(image), byte_size: image.length });
      const denied = await call('nativeFixtureCleanupQueries', fixture, `native-${'0'.repeat(64)}`, authorityDigest); expect((await queries(denied)).every(result => result.meta.changes === 0)).toBe(true);
      expect(await bindings().DB.prepare('SELECT id FROM designs WHERE id=?').bind(fixture.designId).first()).not.toBeNull();
    } finally { await cleanup(fixture, operationId); }
    expect(await bindings().DB.prepare(sql('absent')).bind(fixture.designId, fixture.revisionId, fixture.productId, fixture.jobId, fixture.jobId, fixture.jobId, fixture.designId).first()).toEqual({ designs: 0, revisions: 0, products: 0, images: 0, videos: 0, dispatches: 0, markers: 0, admissions: 0, observations: 0 });
    expect(await bindings().DESIGN_ARTWORK.head(fixture.sourceKey)).toBeNull(); expect(await bindings().DESIGN_ARTWORK.head(fixture.outputKey)).toBeNull();
  });

  it('uses the actual legacy image handler for v4 source, claim and publication', async () => {
    const { fixtures, operationId, now } = await cohort('native-v4-real-business'), fixture = fixtureAt(fixtures, 1), grant = await stage(fixture, operationId, now), execution = crypto.randomUUID();
    try {
      expect(await acceptedNativeV5Grant(bindings().DB, grant, fixture.jobId, now)).toBeUndefined();
      expect((await transfer(fixture, grant, operationId, 'claim', execution)).status).toBe(201);
      expect(new Uint8Array(await (await transfer(fixture, grant, operationId, 'artwork', execution)).arrayBuffer())).toEqual(artwork);
      expect((await transfer(fixture, grant, operationId, 'image', execution, image)).status).toBe(200);
      expect(await bindings().DB.prepare(sql('imageResult')).bind(fixture.jobId, fixture.productId, fixture.revisionId).first()).toMatchObject({ status: 'ready', sha256: await nativeIdentityDigest(image) });
    } finally { await cleanup(fixture, operationId); }
  });

  it('derives video callback/failure observations from actual handlers and denies unowned observations', async () => {
    const { fixtures, operationId, now } = await cohort('native-video-real-business');
    for (const index of [2, 3]) {
      const fixture = fixtureAt(fixtures, index), grant = await stage(fixture, operationId, now), execution = crypto.randomUUID();
      try {
        expect((await transfer(fixture, grant, operationId, 'claim', execution)).status).toBe(201);
        const source = await transfer(fixture, grant, operationId, 'artwork', execution); expect(source.status).toBe(200); expect(new Uint8Array(await source.arrayBuffer())).toEqual(new Uint8Array(Buffer.from(fixture.artworkBase64, 'base64')));
        if (fixture.kind === 'failure') {
          expect((await transfer(fixture, grant, operationId, 'failure', crypto.randomUUID())).status).toBe(204);
          expect(await bindings().DB.prepare(sql('videoResult')).bind(fixture.jobId, fixture.productId, fixture.revisionId).first()).toMatchObject({ status: 'rendering' });
          expect((await transfer(fixture, grant, operationId, 'failure', execution)).status).toBe(204);
          expect(await bindings().DB.prepare(sql('videoResult')).bind(fixture.jobId, fixture.productId, fixture.revisionId).first()).toMatchObject({ status: 'failed', last_error: 'LAMBDA_DELIVERY_FAILED' });
        } else {
          expect((await transfer(fixture, grant, operationId, 'video', execution, video)).status).toBe(200);
          const object = await bindings().STORY_VIDEOS?.get(fixture.outputKey); if (!object) throw new Error('Published video missing'); expect(new Uint8Array(await object.arrayBuffer())).toEqual(video);
          expect(object.customMetadata).toMatchObject({ sha256: await nativeIdentityDigest(video), sourceSha256: fixture.sourceSha256, jobId: fixture.jobId });
        }
        const observed = await bindings().DB.prepare(sql('observations')).bind(fixture.designId).all();
        expect(observed.results).toEqual(expect.arrayContaining([expect.objectContaining({ job_id: fixture.jobId, stage: 'claim', status: 201, execution_id: execution })]));
        if (fixture.kind === 'failure') expect(observed.results).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'failure-committed', status: 204, execution_id: execution })]));
        const before = observed.results.length;
        await observeQualification({ ...environment(operationId), STORY_VIDEO_ENVIRONMENT: 'production' }, fixture.sourceKey, fixture.jobId, 'claim', 201, execution);
        await observeQualification(environment(operationId), fixture.sourceKey, crypto.randomUUID(), 'claim', 201, execution);
        await observeQualification(environment(`native-${'f'.repeat(64)}`), fixture.sourceKey, fixture.jobId, 'claim', 201, execution);
        expect((await bindings().DB.prepare(sql('observations')).bind(fixture.designId).all()).results).toHaveLength(before);
        await bindings().DB.prepare('UPDATE native_video_qualification_faults SET created_at=?,expires_at=? WHERE design_id=?').bind(now - 600001, now - 1, fixture.designId).run();
        await observeQualification(environment(operationId), fixture.sourceKey, fixture.jobId, 'claim', 201, execution);
        expect((await bindings().DB.prepare(sql('observations')).bind(fixture.designId).all()).results).toHaveLength(before);
      } finally { await cleanup(fixture, operationId); }
    }
  });
});
