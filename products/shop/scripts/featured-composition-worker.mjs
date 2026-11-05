import { compositionRecords, compositionStatements, inspectComposition } from "./featured-composition-records.mjs";
import { productPurchaseReadiness } from "../workers/api/src/product-purchase-readiness.ts";
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b=>b.toString(16).padStart(2,"0")).join("");
const json = (value,status=200) => Response.json(value,{status,headers:{"cache-control":"no-store"}});

// The Actions runner embeds one reviewed manifest in the temporary Worker.
// HTTP callers cannot choose IDs, SQL, keys, settings, sources or environments.
export function compositionOperation(manifest, releaseId, environment, intentKey, runId) {
  const records = compositionRecords(manifest), designId = manifest.designId;
  return { async fetch(request,env) {
    if (typeof env.OPERATION_SECRET !== "string" || env.OPERATION_SECRET.length !== 64 || request.headers.get("authorization") !== `Bearer ${env.OPERATION_SECRET}`) return json({error:"UNAUTHORIZED"},401);
    const intent = await env.DESIGN_ARTWORK.get(intentKey);
    if (!intent || JSON.stringify((await intent.json()).manifest) !== JSON.stringify(manifest)) return json({error:"INTENT_MISMATCH"},409);
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return json({ready:true,runId});
    if (request.method === "POST") {
      if (await inspectComposition(env.DB,manifest)) return json({committed:true,replayed:true});
      if (await env.DB.prepare("SELECT id FROM designs WHERE id=?").bind(designId).first()) return json({error:"IDENTITY_CONFLICT"},409);
      for (const source of records.revisions) {
        const object = await env.DESIGN_ARTWORK.get(source.artwork_key);
        if (!object || object.size !== source.byte_size || await hash(await object.arrayBuffer()) !== source.sha256) return json({error:"SOURCE_MISMATCH"},409);
      }
      await env.DB.batch(compositionStatements(manifest,releaseId,environment).map(s=>env.DB.prepare(s.sql).bind(...s.params)));
      return await inspectComposition(env.DB,manifest) ? json({committed:true,replayed:false}) : json({error:"PRECONDITION_CHANGED"},409);
    }
    const jobs = (await env.DB.prepare("SELECT id,product_id,colour,status,attempt_count,execution_id,story_key,output_byte_size FROM story_video_jobs WHERE design_revision_id=? ORDER BY id").bind(manifest.outerRevisionId).all()).results;
    const assets = (await env.DB.prepare(`SELECT assets.id,assets.configured_product_id,assets.geometry_key,assets.width_px,assets.height_px,
      assets.status,assets.sha256,assets.object_sha256,COALESCE(objects.storage_key,assets.storage_key) AS storage_key
      FROM print_assets assets LEFT JOIN print_asset_objects objects ON objects.sha256=assets.object_sha256
      WHERE assets.design_revision_id=? ORDER BY assets.id`).bind(manifest.outerRevisionId).all()).results;
    if (request.method === "GET") {
      const videos = [];
      for (const job of jobs) {
        const object = await env.STORY_VIDEOS.head(job.story_key);
        videos.push({...job,object:object ? {size:object.size,metadata:object.customMetadata} : null});
      }
      const readiness = await Promise.all(records.products.map(p=>productPurchaseReadiness(env.DB,p.id)));
      return json({committed:await inspectComposition(env.DB,manifest),videos,assets,readiness});
    }
    if (request.method !== "DELETE" || environment !== "development") return json({error:"METHOD_NOT_ALLOWED"},405);
    if (jobs.some(job=>job.status === "rendering" || job.status === "queued")) return json({error:"FIXTURE_ACTIVE"},409);
    const cleanupKey = `${intentKey}.cleanup`;
    let cleanup = await env.DESIGN_ARTWORK.get(cleanupKey);
    if (!cleanup) {
      const keys = { artwork:records.revisions.map(row=>row.artwork_key), videos:records.jobs.map(row=>row.story_key), print:assets.filter(row=>typeof row.storage_key==="string"&&row.storage_key.length>0).map(row=>({key:row.storage_key,sha256:row.object_sha256})) };
      await env.DESIGN_ARTWORK.put(cleanupKey,JSON.stringify(keys),{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"application/json"}});
      cleanup = await env.DESIGN_ARTWORK.get(cleanupKey);
    }
    if (!cleanup) return json({error:"CLEANUP_INTENT_MISSING"},409);
    const keys = await cleanup.json();
    // Existing paid/provider foreign keys block the whole batch if a protected
    // reference appears. No customer record is repointed or released.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM story_video_jobs WHERE design_revision_id=?").bind(manifest.outerRevisionId),
      env.DB.prepare("DELETE FROM print_assets WHERE design_revision_id=?").bind(manifest.outerRevisionId),
      env.DB.prepare("DELETE FROM products WHERE design_id=?").bind(designId),
      env.DB.prepare("DELETE FROM design_revisions WHERE design_id=?").bind(designId),
      env.DB.prepare("DELETE FROM designs WHERE id=?").bind(designId),
    ]);
    for (const item of keys.print) {
      if (item.sha256) {
        await env.DB.prepare("DELETE FROM print_asset_objects WHERE sha256=? AND NOT EXISTS (SELECT 1 FROM print_assets WHERE object_sha256=?)").bind(item.sha256,item.sha256).run();
        if (await env.DB.prepare("SELECT sha256 FROM print_asset_objects WHERE sha256=?").bind(item.sha256).first()) continue;
      } else if (await env.DB.prepare("SELECT id FROM print_assets WHERE storage_key=?").bind(item.key).first()) continue;
      await env.DESIGN_ARTWORK.delete(item.key);
    }
    for (const key of keys.artwork) await env.DESIGN_ARTWORK.delete(key);
    for (const key of keys.videos) await env.STORY_VIDEOS.delete(key);
    const remaining = await env.DB.prepare("SELECT id FROM designs WHERE id=?").bind(designId).first();
    const sources = await Promise.all(keys.artwork.map(key=>env.DESIGN_ARTWORK.head(key)));
    const videos = await Promise.all(keys.videos.map(key=>env.STORY_VIDEOS.head(key)));
    return !remaining && sources.every(v=>!v) && videos.every(v=>!v) ? json({cleaned:true}) : json({error:"CLEANUP_UNCONFIRMED"},409);
  } };
}
