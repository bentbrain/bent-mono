import { check, canonical, digest, sha256 } from './data.mjs';
import { createStoryVideoGrant } from '../../packages/contracts/src/story-video-grants.js';

const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const id=seed=>{const hex=sha256(seed);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;};
const settings=Object.freeze({cropX:0.47,cropY:0.62,cropZoom:1.06,depth:1,placementX:0,placementY:0,placementWidth:0.08});
export const nativeFixtureSql=Object.freeze({
  design:"INSERT INTO designs(id,owner_id,artwork_key,content_type,byte_size,artwork_width,artwork_height,sha256,crop_x,crop_y,crop_zoom,placement_x,placement_y,placement_width,depth,status,version,finalized_at,created_at,updated_at) VALUES(?,?,?,'image/png',?,?,?,?,0.47,0.62,1.06,0,0,0.08,1,'ready',1,?,?,?)",
  revision:"INSERT INTO design_revisions(id,design_id,fingerprint,artwork_key,content_type,byte_size,artwork_width,artwork_height,sha256,crop_x,crop_y,crop_zoom,placement_x,placement_y,placement_width,depth,created_at) VALUES(?,?,?,?,'image/png',?,?,?,?,0.47,0.62,1.06,0,0,0.08,1,?)",
  product:"INSERT INTO products(id,base_product_id,design_id,design_revision_id,shopify_handle,placement_x,placement_y,placement_width,placement_depth,projection_version,status,created_at) VALUES(?,'a51b7acf-77e9-4762-83c4-62d96dd8942c',?,?,?,0,0,0.08,1,'safe-margin-v1','active',?)",
  marker:"INSERT INTO storage_test_fixtures(design_id,run_id,purpose,created_at,expires_at) VALUES(?,?,'native-qualification',?,?)",
  readDesign:"SELECT * FROM designs WHERE id=? AND owner_id=?",
  readRevision:"SELECT * FROM design_revisions WHERE id=? AND design_id=?",
  readProduct:"SELECT * FROM products WHERE id=? AND design_id=? AND design_revision_id=?",
  readMarker:"SELECT * FROM storage_test_fixtures WHERE design_id=? AND run_id=?",
  readAdmission:"SELECT * FROM native_video_qualification_faults WHERE design_id=? AND run_id=? AND release_id=?",
  readAcceptance:"SELECT * FROM native_v5_dispatches WHERE job_id=? AND attempt=1",
  admission:"INSERT INTO native_video_qualification_faults(design_id,release_id,run_id,point,created_at,expires_at) VALUES(?,?,?,'invoke-ack',?,?)",
  image:"INSERT INTO product_image_jobs(id,product_id,design_revision_id,colour,view,renderer_version,storage_key,status,attempt_count,created_at,updated_at,dispatch_provider) VALUES(?,?,?,'White','flat',?,?,'rendering',1,?,?,?)",
  video:"INSERT INTO story_video_jobs(id,product_id,design_revision_id,colour,renderer_version,story_key,status,attempt_count,created_at,updated_at) VALUES(?,?,?,'White','story-video-renderer-v7',?,'rendering',?,?,?)",
  acceptance:"INSERT INTO native_v5_dispatches(job_id,attempt,target_json,target_digest,input_json,input_digest,grant_sha256,grant_expires_at,request_sha256,accepted_at,dispatch_state) VALUES(?,1,?,?,?,?,?,?,?,?,'prepared')",
  imageResult:"SELECT id,status,execution_id,sha256,byte_size,storage_key,updated_at FROM product_image_jobs WHERE id=? AND product_id=? AND design_revision_id=?",
  videoResult:"SELECT id,status,execution_id,output_byte_size,story_key,last_error,updated_at,rendered_at FROM story_video_jobs WHERE id=? AND product_id=? AND design_revision_id=?",
  observations:"SELECT job_id,stage,status,execution_id,observed_at FROM native_video_qualification_observations WHERE design_id=? ORDER BY observed_at,id",
  deleteAcceptance:"DELETE FROM native_v5_dispatches WHERE job_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteImage:"DELETE FROM product_image_jobs WHERE id=? AND product_id=? AND design_revision_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteVideo:"DELETE FROM story_video_jobs WHERE id=? AND product_id=? AND design_revision_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteObservations:"DELETE FROM native_video_qualification_observations WHERE design_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteAdmission:"DELETE FROM native_video_qualification_faults WHERE design_id=? AND release_id=? AND run_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteProduct:"DELETE FROM products WHERE id=? AND design_id=? AND design_revision_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteRevision:"DELETE FROM design_revisions WHERE id=? AND design_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteDesign:"DELETE FROM designs WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM designs owned WHERE owned.id=? AND owned.owner_id=?)",
  deleteMarker:"DELETE FROM storage_test_fixtures WHERE design_id=? AND run_id=? AND purpose='native-qualification'",
  absent:"WITH owned AS(SELECT ? AS designId,? AS revisionId,? AS productId,? AS imageId,? AS videoId,? AS jobId,? AS markerId) SELECT (SELECT count(*) FROM designs WHERE id=owned.designId) AS designs,(SELECT count(*) FROM design_revisions WHERE id=owned.revisionId) AS revisions,(SELECT count(*) FROM products WHERE id=owned.productId) AS products,(SELECT count(*) FROM product_image_jobs WHERE id=owned.imageId) AS images,(SELECT count(*) FROM story_video_jobs WHERE id=owned.videoId) AS videos,(SELECT count(*) FROM native_v5_dispatches WHERE job_id=owned.jobId) AS dispatches,(SELECT count(*) FROM storage_test_fixtures WHERE design_id=owned.markerId) AS markers,(SELECT count(*) FROM native_video_qualification_faults WHERE design_id=owned.designId) AS admissions,(SELECT count(*) FROM native_video_qualification_observations WHERE design_id=owned.designId) AS observations FROM owned"
});
export const nativeFixtureReadActions=Object.freeze(['imageResult','videoResult','observations','absent','readDesign','readRevision','readProduct','readMarker','readAdmission','readAcceptance']);
export function nativeFixtureQueryData(action,params) {
  const sql=nativeFixtureSql[action];check(sql&&Array.isArray(params)&&params.length===(sql.match(/\?/g)??[]).length&&params.every(value=>value===null||typeof value==='string'&&value.length<=65536||Number.isSafeInteger(value)),'Exact bounded builtin native fixture query parameters required');return {sql,params};
}
export function materializeNativeFixtures({template,operationId}) {
  check(template?.schema==='shop.native-fixture-template/v1'&&/^[A-Za-z0-9_-]{1,128}$/.test(operationId)&&Array.isArray(template.cohort)&&template.cohort.length>=7&&template.cohort.length<=32,'Complete installed native fixture cohort required');
  const artwork=Buffer.from(template.artwork.base64,'base64');check(artwork.toString('base64')===template.artwork.base64&&artwork.length>=24&&artwork.length<=25000000&&sha256(artwork)===template.artwork.sha256&&artwork.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'Exact admitted PNG fixture bytes required');
  const width=artwork.readUInt32BE(16),height=artwork.readUInt32BE(20);check(width>0&&height>0&&width<=12000&&height<=12000,'Bounded actual fixture artwork dimensions required');
  return {schema:'shop.native-fixture-lifecycle/v1',templateDigest:digest(template),operationId,artwork:template.artwork,fixtures:template.cohort.map(item=>{
    check(/^[a-z][a-z0-9-]{0,63}$/.test(item.probeId)&&['v5','v4','video','failure'].includes(item.kind)&&hash(item.expectedOutput?.sha256)&&Number.isSafeInteger(item.expectedOutput.bytes)&&item.expectedOutput.bytes>=(item.kind==='failure'?0:1)&&item.expectedOutput.bytes<=32000000,'Exact real handler/media fixture required');
    const source=item.kind==='failure'?artwork.subarray(0,24):artwork;
    const designId=id(`${operationId}/${item.probeId}/design`),revisionId=id(`${operationId}/${item.probeId}/revision`),productId=id(`${operationId}/${item.probeId}/product`),jobId=id(`${operationId}/${item.probeId}/job`),sourceKey=`designs/${designId}/artwork/${sha256(source)}`;
    const outputKey=['v5','v4'].includes(item.kind)?`designs/${designId}/product-images/${item.kind}/${revisionId}/${productId}/white-flat.webp`:`story-videos/v7/${revisionId}/${productId}/white.mp4`;
    return {...item,designId,revisionId,productId,jobId,ownerId:sha256(`owner/${operationId}/${item.probeId}`),sourceKey,outputKey,sourceSha256:sha256(source),sourceBytes:source.length,artworkBase64:source.toString('base64'),width,height};
  })};
}
export function nativeFixtureEvent(fixture,grant) {
  check(uuid(fixture.jobId)&&typeof grant==='string'&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant),'Owned fixture job and signed grant required');
  if(fixture.kind==='v5')return {kind:'product-image-v5',schemaVersion:1,jobId:fixture.jobId,grant,rendererVersion:'product-images-v5'};
  const common={schemaVersion:1,jobId:fixture.jobId,attempt:fixture.kind==='failure'?3:1,artwork:{sha256:fixture.sourceSha256,size:fixture.sourceBytes},baseProductSlug:'staple-tee',color:'White',settings:{...settings},rendererVersion:fixture.kind==='v4'?'product-images-v4':'story-video-renderer-v7',grant};
  return fixture.kind==='v4'?{kind:'product-image',...common,view:'flat',printMode:'recursive',storageKey:fixture.outputKey}:{...common,storyKey:fixture.outputKey};
}
export async function createNativeFixtureGrant({fixture,key,now=Date.now()}) {
  check(key&&typeof key.secret==='string'&&key.secret.length>=32&&key.secret.length<=4096&&typeof key.id==='string'&&typeof key.version==='string','Explicit installed native fixture grant key/version required');
  const issuedAt=fixture.kind==='failure'&&fixture.failureMode==='destination'?now-180001:now;
  const grant=await createStoryVideoGrant(key.secret,fixture.jobId,fixture.kind==='failure'?3:1,issuedAt);return {grant:fixture.kind==='v5'?`nv5_${grant}`:grant,expiresAt:now+180000,jobExpiresAt:issuedAt+180000,keyId:key.id,secretVersion:key.version};
}
export function nativeFixtureStageQueries({fixture,operationId,createdAt,grant,version,functionArn,sourceDigest,inputsDigest,authorityDigest,grantKeyId}) {
  check(Number.isSafeInteger(createdAt)&&hash(sourceDigest)&&hash(inputsDigest)&&hash(authorityDigest)&&/^[1-9][0-9]{0,15}$/.test(version),'Exact admitted native fixture stage identity required');
  const f=fixture,query=(action,params)=>({action,...nativeFixtureQueryData(action,params)}),queries=[query('design',[f.designId,f.ownerId,f.sourceKey,f.sourceBytes,f.width,f.height,f.sourceSha256,createdAt,createdAt,createdAt]),query('revision',[f.revisionId,f.designId,`bootstrap:${operationId}:${f.probeId}`,f.sourceKey,f.sourceBytes,f.width,f.height,f.sourceSha256,createdAt]),query('product',[f.productId,f.designId,f.revisionId,`native-${f.productId}`,createdAt]),query('marker',[f.designId,operationId,createdAt,createdAt+600000])];
  if(['v5','v4'].includes(f.kind))queries.push(query('image',[f.jobId,f.productId,f.revisionId,f.kind==='v5'?'product-images-v5':'product-images-v4',f.outputKey,createdAt,createdAt,f.kind==='v5'?'native-v5':null]));else queries.push(query('video',[f.jobId,f.productId,f.revisionId,f.outputKey,f.kind==='failure'?3:1,createdAt,createdAt]));
  const event=nativeFixtureEvent(f,grant);
  queries.push(query('admission',[f.designId,authorityDigest,operationId,createdAt,createdAt+600000]));
  if(f.kind==='v5'){
    const target={schemaVersion:2,environment:'qualification',functionArn:`${functionArn}:${version}`,codeDigest:sourceDigest,inputsDigest,bootstrapAuthorityDigest:authorityDigest,grantKeyId};
    const input={job:{jobId:f.jobId,productId:f.productId,designId:f.designId,revisionId:f.revisionId,baseProductId:'a51b7acf-77e9-4762-83c4-62d96dd8942c',colour:'White',view:'flat',storageKey:f.outputKey,rendererVersion:'product-images-v5',artworkKey:f.sourceKey,sourceSha256:f.sourceSha256,sourceSize:f.sourceBytes,cropX:settings.cropX,cropY:settings.cropY,cropZoom:settings.cropZoom,placementX:settings.placementX,placementY:settings.placementY,placementWidth:settings.placementWidth,depth:settings.depth,printMode:'recursive'},source:{key:f.sourceKey,size:f.sourceBytes,sha256:f.sourceSha256,contentType:'image/png'}};
    queries.push(query('acceptance',[f.jobId,canonical(target),digest(target),canonical(input),digest(input),sha256(grant),createdAt+180000,sha256(JSON.stringify(event)),createdAt]));
  }
  return {queries,event};
}
export function nativeFixtureCleanupQueries(f,operationId,authorityDigest) {
  check(hash(authorityDigest),'Exact native fixture cleanup authority required');const owner=sha256('owner/'+operationId+'/'+f.probeId);
  return [['deleteAcceptance',[f.jobId,f.designId,owner]],[f.kind==='v4'||f.kind==='v5'?'deleteImage':'deleteVideo',[f.jobId,f.productId,f.revisionId,f.designId,owner]],['deleteObservations',[f.designId,f.designId,owner]],['deleteAdmission',[f.designId,authorityDigest,operationId,f.designId,owner]],['deleteProduct',[f.productId,f.designId,f.revisionId,f.designId,owner]],['deleteRevision',[f.revisionId,f.designId,f.designId,owner]],['deleteDesign',[f.designId,f.ownerId,f.designId,owner]],['deleteMarker',[f.designId,operationId]]].map(([action,params])=>({action,...nativeFixtureQueryData(action,params)}));
}
