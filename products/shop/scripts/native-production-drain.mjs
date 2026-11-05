import { releaseProgress } from "./release-progress.mjs";
import { assertReleasePaused, unresolvedArtworkPreparation } from "./native-release-pause.mjs";

// The old Cloudflare renderer has a different lifetime from Lambda. Never
// expire its attempts using Development's five-minute recovery UPDATE.
async function inspectProductionNaturalDrain(cf, releaseId, now = Date.now()) {
  const control = await assertReleasePaused(cf, releaseId);
  if (now < control.paused_at) throw new Error("Production drain clock precedes pause.");
  // A failed third attempt is terminal and cannot represent live work. The
  // admission trigger prevents queued/failed rows from being claimed while
  // paused; only an existing rendering lease can still be in flight.
  const rows = (await cf.query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status = 'rendering'"))[0].results;
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0].count) || rows[0].count < 0) throw new Error("Production drain count is invalid.");
  const printTable = (await cf.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'print_asset_jobs'"))[0].results;
  let unresolvedPrints = 0;
  if (printTable.some(row => row.name === 'print_asset_jobs')) {
    const prints = (await cf.query("SELECT COUNT(*) AS count FROM print_asset_jobs WHERE status = 'running'"))[0].results;
    if (prints.length !== 1 || !Number.isSafeInteger(prints[0].count) || prints[0].count < 0) throw new Error("Production print drain count is invalid.");
    unresolvedPrints = prints[0].count;
  }
  const imageTable=(await cf.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='product_image_jobs'"))[0].results;
  let unresolvedImages=0;
  if(imageTable.some(row=>row.name==='product_image_jobs')) {
    const images=(await cf.query("SELECT count(*) AS count FROM product_image_jobs WHERE status='rendering'"))[0].results;
    if(images.length!==1 || !Number.isSafeInteger(images[0].count) || images[0].count<0) throw new Error("Production image drain count is invalid.");
    unresolvedImages=images[0].count;
  }
  const unresolvedArtwork = await unresolvedArtworkPreparation(cf, releaseId, now);
  await assertReleasePaused(cf, releaseId);
  // The caller selects the proved handler fence. Outstanding rendering rows
  // stop either cutover path, even if their lease looks old.
  return { drained: rows[0].count === 0 && unresolvedPrints === 0 && unresolvedImages === 0 && unresolvedArtwork === 0, unresolvedAttempts: rows[0].count + unresolvedPrints + unresolvedImages + unresolvedArtwork, pausedAt: control.paused_at, elapsedMs: now - control.paused_at };
}

async function waitNaturalDrain(cf, releaseId, wait, now, minimumMs) {
  const started = now(); let quietSince;
  for (;;) {
    const result = await inspectProductionNaturalDrain(cf, releaseId, now());
    releaseProgress(releaseId, "draining", `elapsed-seconds=${Math.floor((now() - started) / 1000)} unresolved-attempts=${result.unresolvedAttempts}`, now());
    if (result.drained) quietSince ??= now(); else quietSince = undefined;
    if (quietSince !== undefined && now() - started >= minimumMs && now() - quietSince >= 60000)
      return { ...result, naturalDrainVerified: true, quietMs: now() - quietSince, minimumFenceMs: now() - started };
    if (now() - started >= 1200000) throw new Error("Production still has in-flight renders after twenty minutes; admissions remain paused for review.");
    await wait(15000);
  }
}

export function waitProductionNaturalDrain(cf,releaseId,wait,now=Date.now) {
  return waitNaturalDrain(cf,releaseId,wait,now,300000);
}
// Call only with the sealed API preparation proving every handler, grant,
// queue consumer, runtime and dependency unchanged. No lease is expired or
// shortened. Old grants and async deliveries retain identical handler code.
export async function waitUnchangedRendererDrain(cf,releaseId,wait,proof,now=Date.now) {
  if(proof?.kind!=='reuse-live-image-v1' || proof.drainPolicy!=='unchanged-render-handlers-v1' ||
    proof.updateCount!==0 || !/^[a-f0-9]{64}$/.test(proof.renderingInputsDigest ?? ''))
    throw Error('Unchanged render handler preparation required for a quiet drain.');
  return waitNaturalDrain(cf,releaseId,wait,now,60000);
}
