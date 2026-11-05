import { protectedConfig } from "./protected-config.mjs";
import { commerceOnlyPaths, renderingInputManifest, rendererQualificationReusable } from './rendering-inputs.mjs';
import { applicationContractPath } from "./contract-consumers.mjs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { gitChanges } from "./deployment-plan.mjs";
import { assertReleasePaused } from "./native-release-pause.mjs";
const check = (value, reason) => { if (!value)
    throw Error(`API-only release stopped: ${reason}`); };
const hash = value => createHash("sha256").update(value).digest("hex");
// This lane omits image provisioning, not qualification. Unknown paths and
// infrastructure, dependencies, migrations and renderer assets require full.
export function apiOnlyPaths(paths) {
    return Array.isArray(paths) && paths.every(path => applicationContractPath(path) || path.startsWith("workers/api/src/") || path.startsWith("shopify/notifications/") ||
        (path.startsWith("apps/web/") && !path.startsWith("apps/web/public/mockups/")) ||
        path.startsWith("docs/") || ["AGENTS.md", "README.md", "CLAUDE.md",
        "infra/story-video-lambda/development-qualification.json", "infra/story-video-lambda/production-promotion.json"].includes(path));
}
export async function prepareApiImage({ environment, sha, cf, store, candidate, runtime, inspectRuntime, probeRuntime, changes = gitChanges, manifest = renderingInputManifest }) {
    runtime = structuredClone(runtime);
    check(["development", "production"].includes(environment) && /^[a-f0-9]{40}$/.test(sha), "exact environment/source required.");
    const controls = (await cf.query("SELECT paused, release_id, current_release_id FROM native_video_release_control WHERE singleton = 1"))[0].results;
    const control = controls[0];
    check(controls.length === 1 && control.paused === 0 && control.release_id === null && /^native-\d+$/.test(control.current_release_id), "unpaused recorded predecessor required.");
    const readEvent = async (stage) => {
        const rows = (await cf.query("SELECT payload FROM native_video_release_events WHERE release_id = ? AND stage = ?", [control.current_release_id, stage]))[0].results;
        check(rows.length === 1, "completed predecessor evidence missing; use the full lane.");
        return JSON.parse(rows[0].payload);
    };
    const { preparation, ...previous } = await readEvent("prepared");
    check(equal(JSON.parse(await store.read(preparation)), previous) && previous.releaseId === control.current_release_id &&
        previous.environment === environment && previous.accountId === protectedConfig("awsAccountId") && previous.region === "ap-southeast-2" &&
        /^[a-f0-9]{40}$/.test(previous.sourceCommit), "immutable predecessor identity/readback.");
    const verified = await readEvent("verified");
    check(verified.releaseId === previous.releaseId && verified.sourceCommit === previous.sourceCommit &&
        equal(verified.runtime, runtime) && runtime.runtimeVerified === true, "live runtime differs from completed predecessor.");
    check(previous.candidate?.imageDigest === candidate.imageDigest && previous.candidate?.sourceDigest === candidate.sourceDigest &&
        runtime.renderer?.imageDigest === candidate.imageDigest && runtime.failure?.imageDigest === candidate.imageDigest &&
        runtime.renderer?.sourceDigest === candidate.sourceDigest, "image/source change requires full native release.");
    const paths = changes(previous.sourceCommit, sha);
    check(apiOnlyPaths(paths), "unknown, non-ancestor, infrastructure, migration, dependency or renderer changes require full native release.");
    let before, after;
    if (commerceOnlyPaths(paths)) {
        try {
            before = manifest(previous.sourceCommit);
            after = manifest(sha);
        }
        catch { /* Unknown input inventory keeps the full grant fence. */ }
    }
    const unchangedRenderHandlers = commerceOnlyPaths(paths) && rendererQualificationReusable(before, after);
    const proof = { schemaVersion: 1, kind: "reuse-live-image-v1", environment, sourceCommit: sha,
        predecessor: previous.releaseId, predecessorSource: previous.sourceCommit, preparation,
        imageDigest: candidate.imageDigest, sourceDigest: candidate.sourceDigest, runtime: structuredClone(runtime), paths,
        updateCount: 0, fullCloudQualificationRequired: !unchangedRenderHandlers,
        ...(unchangedRenderHandlers ? { drainPolicy: 'unchanged-render-handlers-v1', renderingInputsDigest: after.inputsDigest } : {}) };
    const bytes = Buffer.from(JSON.stringify(proof));
    const review = { ...proof, planSha256: hash(bytes) };
    const verifyBefore = async () => {
        const live = await inspectRuntime();
        check(equal(live, runtime), "runtime drift since preparation.");
        return live;
    };
    let attempted = false;
    return { review, verifyBefore,
        preserve: (target = store) => target.save("reused-image.json", bytes),
        apply: async (activeCf, releaseId) => {
            check(!attempted, "verification already attempted; inspect the recorded release.");
            attempted = true;
            await assertReleasePaused(activeCf, releaseId);
            const rows = (await activeCf.query("SELECT COUNT(*) AS count FROM story_video_jobs WHERE status='rendering'"))[0].results;
            check(rows.length === 1 && rows[0].count === 0, "active render remains after the recorded drain.");
            const live = await verifyBefore();
            const probes = probeRuntime ? await probeRuntime() : undefined;
            await assertReleasePaused(activeCf, releaseId);
            await verifyBefore();
            return { ...review, applied: false, runtime: live, probes, startupVerified: Boolean(probeRuntime) };
        } };
}
