import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { protectedConfig } from "./protected-config.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { CLOUDFLARE_ACCOUNT } from "./native-ci-cloudflare.mjs";
import { activeWorkerSettings, inspectDevelopmentWorker, inspectDevelopmentConsumer } from "./native-ci-worker.mjs";
import { verifyApiPrintExecutorBinding, verifyPrintExecutorConfig, verifyPrintExecutorSettings, verifyPrintExecutorLifecycle } from "./native-print-executor.mjs";
import { forwardRecoveryObject } from "./native-forward-recovery-reference.mjs";
import { readSealedWorkerUpload, verifySourceMap, workerContentManifest, workerContentResponse } from "./native-worker-content.mjs";
import { verifyPauseSchema } from "./native-release-pause.mjs";

export const recoveryHash = bytes => createHash("sha256").update(bytes).digest("hex");
export const recoveryCheck = (value, reason) => { if (!value) throw Error(`Development forward recovery stopped: ${reason}`); };
const check = recoveryCheck;
export async function recoveryControl(cf) {
  const rows = (await cf.query("SELECT paused, release_id, current_release_id, paused_at, updated_at FROM native_video_release_control WHERE singleton = 1"))[0].results;
  check(rows.length === 1, "single exact pause control required.");
  return rows[0];
}
async function recoveryEvent(cf, releaseId, stage) {
  const rows = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?", [releaseId, stage]))[0].results;
  check(rows.length === 1, "exact interrupted release journal required.");
  return JSON.parse(rows[0].payload);
}

// Approval is installed independently in protected Preview configuration. The
// dispatch carries only immutable references, never a caller-approved snapshot.
export async function loadForwardRecoveryAuthority({ env, store, reference, config = protectedConfig }) {
  check(["plan-forward-recovery", "recover-forward-release"].includes(developmentOperation(env)), "dedicated first-attempt main full operation required.");
  forwardRecoveryObject(reference, "forward-recovery-authority.json");
  const bytes = await store.read(reference);
  check(recoveryHash(bytes) === reference.sha256 && reference.sha256 === config("developmentForwardRecoveryAuthoritySha256"), "independently reviewed protected authority hash required.");
  const authority = JSON.parse(bytes), control = authority?.control, original = authority?.original;
  check(authority.schemaVersion === 1 && authority.kind === "development-interrupted-forward-release-v1" &&
    authority.sourceCommit === env.GITHUB_SHA && authority.sourceCommit === config("developmentForwardRecoverySourceCommit") &&
    authority.environment === "development" && authority.accountId === config("awsAccountId") && authority.cloudflareAccountId === CLOUDFLARE_ACCOUNT &&
    authority.region === "ap-southeast-2" && control?.paused === 1 && /^native-[1-9][0-9]*$/.test(control.release_id ?? "") &&
    /^native-[1-9][0-9]*$/.test(control.current_release_id ?? "") && control.release_id !== control.current_release_id &&
    control.release_id !== `native-${env.GITHUB_RUN_ID}` && Object.keys(control).sort().join() === "current_release_id,paused,paused_at,release_id,updated_at" &&
    [control.paused_at, control.updated_at].every(time => Number.isSafeInteger(time) && time > 0), "source-bound exact old control and Development resources required.");
  check(original?.repository === config("developmentForwardRecoveryOriginalRepository") && original.repository !== "bentbrain/bent-mono" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(original.repository) &&
    Number.isSafeInteger(original.repositoryId) && original.repositoryId > 0 && Number.isSafeInteger(original.ownerId) && original.ownerId > 0 &&
    String(original.repositoryId) === config("developmentForwardRecoveryOriginalRepositoryId") &&
    String(original.ownerId) === config("githubOwnerId") && original.repositoryId !== Number(config("githubRepositoryId")) &&
    Number.isSafeInteger(original.runId) && original.runId > 0 && control.release_id === `native-${original.runId}` &&
    /^[a-f0-9]{40}$/.test(original.sourceCommit ?? ""), "separately pinned original repository/run/source required.");
  forwardRecoveryObject(authority.snapshot, "forward-recovery-snapshot.json");
  check(authority.snapshot.sha256 === config("developmentForwardRecoverySnapshotSha256"), "protected authenticated original snapshot hash required.");
  const snapshotBytes = await store.read(authority.snapshot);
  check(recoveryHash(snapshotBytes) === authority.snapshot.sha256, "snapshot bytes differ.");
  const snapshot = JSON.parse(snapshotBytes), run = snapshot.run;
  check(snapshot.schemaVersion === 1 && snapshot.authentication?.method === "personal-github-api" &&
    snapshot.authentication.repository === original.repository && snapshot.authentication.repositoryId === original.repositoryId &&
    run?.id === original.runId && run.run_attempt === 1 && run.status === "completed" && run.conclusion === "failure" &&
    run.event === "workflow_dispatch" && run.head_branch === "main" && run.head_sha === original.sourceCommit &&
    run.path === ".github/workflows/native-development.yml" && run.repository?.full_name === original.repository &&
    run.repository.id === original.repositoryId && run.repository.owner?.id === original.ownerId && run.head_repository?.id === original.repositoryId &&
    snapshot.operation === "release" && snapshot.releaseMode === "full" &&
    (run.display_title ?? "").startsWith(`Native development · release · full · - · - · main · ${original.sourceCommit} ·`), "reviewed authenticated original first-attempt failed full release required.");
  forwardRecoveryObject(authority.preparation, "prepared.json");
  check(authority.preparation.key === `source/releases/${control.release_id}/prepared.json` &&
    /^[a-f0-9]{64}$/.test(authority.executorIntentSha256 ?? ""), "exact original preparation and intent required.");
  return { authority, snapshot, reference };
}

// This returns interrupted evidence, never a verified executor baseline.
export async function inspectInterruptedDevelopmentRelease({ cf, client, staging, store, authority, snapshot, expectedControl = authority.control, pauseSchema }) {
  check(equal(await recoveryControl(cf), expectedControl), "old control tuple changed.");
  check(!pauseSchema || expectedControl.release_id !== authority.control.release_id, "preserved schema is restricted to the transferred migration boundary.");
  await verifyPauseSchema(cf, pauseSchema);
  const owner = authority.control.release_id;
  const event = await recoveryEvent(cf, owner, "prepared"), { preparation, ...prepared } = event;
  check(equal(event, snapshot.prepared) && equal(preparation, authority.preparation) &&
    equal(JSON.parse(await store.read(preparation)), prepared) && prepared.releaseId === owner &&
    prepared.sourceCommit === authority.original.sourceCommit && prepared.environment === "development" &&
    prepared.accountId === authority.accountId && prepared.region === authority.region, "original D1/S3 preparation changed.");
  const review = prepared.worker?.printExecutor, artifacts = prepared.artifacts?.printExecutor;
  check(review?.schemaVersion === 1 && !review.content && review.releaseId === owner && review.sourceCommit === prepared.sourceCommit &&
    review.accountId === CLOUDFLARE_ACCOUNT && review.worker === "forever-tee-print-executor-development" &&
    artifacts?.foundationArtifact?.key === `source/releases/${owner}/print-executor-foundation.json` &&
    artifacts.candidateArtifact?.key === `source/releases/${owner}/candidate-print-executor.js` && !artifacts.candidateMapArtifact &&
    equal(JSON.parse(await store.read(artifacts.foundationArtifact)), review), "original immutable executor intent required.");
  verifyPrintExecutorConfig(review.config);
  check(equal(review.migrations, [{ tag: "print-execution-v1", new_sqlite_classes: ["PrintAssetExecution"] }]), "creation-only executor lifecycle required.");
  const intent = await recoveryEvent(cf, owner, "print-executor-deploy-started");
  check(equal(intent, snapshot.executorIntent) && recoveryHash(JSON.stringify(intent)) === authority.executorIntentSha256 &&
    equal(intent.review, review) && equal(intent.artifacts, artifacts), "original executor mutation intent changed.");
  const completed = (await cf.query("SELECT stage FROM native_video_release_events WHERE release_id = ? AND stage IN ('print-executor-verified', 'worker-deploy-started', 'worker-verified', 'verified')", [owner]))[0].results;
  check(completed.length === 0, "interrupted release advanced beyond the approved mixed state.");
  const upload = await readSealedWorkerUpload(store, artifacts, review);
  const previous = JSON.parse(await store.read(prepared.artifacts.previousArtifact));
  check(equal(previous.before, prepared.previous.worker) && equal(previous.consumer, prepared.previous.consumer) &&
    equal(authority.observed?.api, previous.before), "old API must equal the sealed predecessor.");
  const api = await inspectDevelopmentWorker(cf, previous), executor = await inspectDevelopmentWorker(client);
  check(equal(api, authority.observed.api) && equal(executor, authority.observed.executor) &&
    equal(await inspectDevelopmentConsumer(cf), previous.consumer), "active/latest provider bytes/resources or queue changed.");
  const response = await client.content();
  const content = await workerContentManifest(response.clone());
  check(equal(content, executor.content) && response.headers.get("content-type")?.startsWith("multipart/"), "exact interrupted multipart upload required.");
  const parts = await response.formData(), mapPart = parts.get("index.js.map"), codePart = parts.get("index.js");
  check(mapPart && typeof mapPart !== "string" && codePart && typeof codePart !== "string", "exact code and observed sidecar required.");
  const map = Buffer.from(await mapPart.arrayBuffer()), code = Buffer.from(await codePart.arrayBuffer()), sidecar = authority.legacySidecar;
  check(sidecar?.name === "index.js.map" && sidecar.originallySealed === false && sidecar.authentication === "independent-review" &&
    typeof sidecar.justification === "string" && sidecar.justification.length >= 40 && sidecar.nonExecutableImportReviewed === true &&
    recoveryHash(map) === sidecar.sha256 && map.length === sidecar.bytes && equal(code, upload.code), "exact independently reviewed observed sidecar required.");
  verifySourceMap(map, code);
  check(equal(content, await workerContentManifest(workerContentResponse({ code, map }))), "unknown or unsealed executable part.");
  const settings = await activeWorkerSettings(client, executor), { namespaceId } = verifyPrintExecutorSettings(settings, review);
  verifyPrintExecutorLifecycle(await client.version(executor.workerVersion), executor.workerVersion);
  check(namespaceId === authority.namespaceId && /^[a-f0-9]{32}$/.test(namespaceId), "existing executor namespace changed.");
  verifyApiPrintExecutorBinding(await activeWorkerSettings(cf, api), { namespaceId });
  const subdomain = await client.subdomain();
  check(subdomain.enabled === false && subdomain.previews_enabled === false, "executor must remain private.");
  check(equal(await staging.read(), authority.stagingLifecycle) && equal(await cf.schedules(), authority.schedules), "staging lifecycle or API schedules changed.");
  check(equal(await inspectDevelopmentWorker(cf, previous), api) && equal(await inspectDevelopmentWorker(client), executor) &&
    equal(await recoveryControl(cf), expectedControl), "mixed state changed during inspection.");
  return { kind: "interrupted-development-release", owner, sourceCommit: prepared.sourceCommit,
    namespaceId, api, executor, sidecar: { ...sidecar, observed: true }, preparation, executorIntentSha256: authority.executorIntentSha256 };
}
