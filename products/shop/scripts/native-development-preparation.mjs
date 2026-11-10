import { isDeepStrictEqual as equal } from "node:util";
import { recoveryHash as hash, recoveryCheck as check } from "./native-forward-recovery-inspection.mjs";

// A completion gets its own immutable preparation. The failed preparation and
// journals remain historical evidence under their original byte contracts.
export async function loadDevelopmentPreparation(cf, store, releaseId) {
  const events = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'prepared'", [releaseId]))[0].results;
  check(events.length === 1, "original release preparation missing.");
  const { preparation, ...original } = JSON.parse(events[0].payload);
  check(original.releaseId === releaseId && equal(JSON.parse(await store.read(preparation)), original), "original immutable preparation changed.");
  const verified = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = 'verified'", [releaseId]))[0].results;
  check(verified.length <= 1, "ambiguous completed release.");
  const completion = verified.length ? JSON.parse(verified[0].payload).completion : undefined;
  if (!completion) return original;
  const bytes = await store.read(completion.preparation);
  check(hash(bytes) === completion.preparation.sha256, "completion preparation bytes changed.");
  const prepared = JSON.parse(bytes);
  check(prepared.releaseId === releaseId && prepared.sourceCommit === original.sourceCommit &&
    equal(prepared.completion?.originalPreparation, preparation) && equal(completion.originalPreparation, preparation) &&
    equal(prepared.completion.authority, completion.authority) && equal(prepared.completion.toolIdentity, completion.toolIdentity) &&
    equal(prepared.candidate, original.candidate) && prepared.worker.schemaVersion === 3 && prepared.worker.printExecutor.schemaVersion === 3 &&
    prepared.rollbackQualified === false, "separately recorded completion identity differs.");
  for (const [review, prior, artifacts, priorArtifacts] of [
    [prepared.worker, original.worker, prepared.artifacts, original.artifacts],
    [prepared.worker.printExecutor, original.worker.printExecutor, prepared.artifacts.printExecutor, original.artifacts.printExecutor],
  ]) {
    const { sourceMapData, ...raw } = review.content;
    check(sourceMapData?.algorithm === "complete-json-data-v1" && prior.schemaVersion === 2 && equal(raw, prior.content) &&
      review.sourceCommit === prior.sourceCommit && review.bundleSha256 === prior.bundleSha256 && review.bundleBytes === prior.bundleBytes &&
      equal(artifacts.candidateArtifact, priorArtifacts.candidateArtifact) && equal(artifacts.candidateMapArtifact, priorArtifacts.candidateMapArtifact),
      "completion must retain every original raw artifact and source binding.");
  }
  return prepared;
}
