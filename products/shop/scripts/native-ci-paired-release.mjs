import { protectedConfig } from "./protected-config.mjs";
import { waitUnchangedRendererDrain } from './native-production-drain.mjs';
import { measureReleaseStage } from "./release-stage-timing.mjs";
import { isDeepStrictEqual } from "node:util";
import { assertReleasePaused, beginReleasePause, installPauseSchema, inspectDevelopmentDrain, recordReleaseEvent, resumeVerifiedRelease } from "./native-release-pause.mjs";
import { NATIVE_MIGRATION_LATEST } from "./native-migration-inventory.mjs";
const check = (value, reason) => { if (!value)
    throw new Error(`Native paired release stopped: ${reason}`); };
// Dependencies are verified live cloud clients/prepared artifact closures, not
// flags declaring a release safe. There is no automatic catch/finally resume.
export async function executeDevelopmentRelease({ cf, release, image, worker, store, inspectRuntime, probeRuntime, verifyStatus, wait, now = Date.now }) {
    check(typeof probeRuntime === "function", "live startup verifier required before any mutation.");
    check(release.environment === "development" && release.accountId === protectedConfig("awsAccountId") && release.region === "ap-southeast-2" &&
        release.planSha256 === image.review.planSha256 && release.sourceCommit === worker.review.sourceCommit &&
        release.candidate.imageDigest === image.review.imageDigest && release.candidate.sourceDigest === image.review.sourceDigest &&
        release.worker.bundleSha256 === worker.review.bundleSha256 &&
        isDeepStrictEqual(release.worker.printExecutor, worker.review.printExecutor), "prepared source, plan and bundle do not agree.");
    await worker.verifyPrevious();
    const saved = await store.save("prepared.json", Buffer.from(JSON.stringify(release)));
    check(isDeepStrictEqual(JSON.parse(await store.read(saved)), release), "durable preparation readback.");
    await installPauseSchema(cf);
    await beginReleasePause(cf, { ...release, preparation: saved }, now());
    const gate = await cf.query("INSERT INTO story_video_jobs (id, status) VALUES (NULL, 'rendering')");
    // The BEFORE INSERT pause trigger must ignore this statement before NOT NULL
    // checks. If missing/broken, the invalid row errors and cannot persist.
    check(gate.every(result => result.meta?.changes === 0), "cloud admission trigger did not suppress an invalid rendering insert.");
    await recordReleaseEvent(cf, release.releaseId, "cloud-pause-verified", { invalidRenderingInsertIgnored: true }, now());
    await measureReleaseStage("drain", async () => {
        if (image.review.drainPolicy === 'unchanged-render-handlers-v1') {
            const result = await waitUnchangedRendererDrain(cf, release.releaseId, wait, image.review, now);
            await recordReleaseEvent(cf, release.releaseId, "drained", result, now());
            return;
        }
        for (;;) {
            const result = await inspectDevelopmentDrain(cf, release.releaseId, now());
            if (result.drained)
                break;
            await wait(Math.min(15000, result.remainingMs));
        }
        await recordReleaseEvent(cf, release.releaseId, "drained", { minimumHoldMs: 300000 }, now());
    });
    const runtime = await inspectRuntime();
    check(isDeepStrictEqual(runtime.renderer, release.previous.runtime.renderer) &&
        isDeepStrictEqual(runtime.failure, release.previous.runtime.failure), "previous image/configuration changed during drain.");
    await worker.verifyPrevious();
    await worker.migrate(release.releaseId);
    await installPauseSchema(cf);
    await recordReleaseEvent(cf, release.releaseId, "migration-verified", { executionProtocol: "claim-v1", migration: NATIVE_MIGRATION_LATEST }, now());
    await assertReleasePaused(cf, release.releaseId);
    await recordReleaseEvent(cf, release.releaseId, "image-apply-started", image.review, now());
    await measureReleaseStage("image-provision", () => image.apply(cf, release.releaseId));
    const updated = await inspectRuntime();
    check(updated.renderer.imageDigest === release.candidate.imageDigest && updated.failure.imageDigest === release.candidate.imageDigest &&
        updated.renderer.sourceDigest === release.candidate.sourceDigest, "deployed Lambda pair differs from candidate.");
    await recordReleaseEvent(cf, release.releaseId, "image-verified", updated, now());
    await recordReleaseEvent(cf, release.releaseId, "image-startup-verified", await probeRuntime(), now());
    await assertReleasePaused(cf, release.releaseId);
    await recordReleaseEvent(cf, release.releaseId, "worker-deploy-started", { ...worker.review, atomicReleaseSecrets: 4 }, now());
    const liveWorker = await measureReleaseStage("worker-deploy", () => worker.deploy(release.releaseId, release.candidate));
    await recordReleaseEvent(cf, release.releaseId, "worker-verified", liveWorker, now());
    return resumeVerifiedRelease(cf, release.releaseId, async () => {
        if (release.worker.printExecutor) {
            check(typeof worker.verifyPrintExecutor === "function", "print executor verifier required before resume.");
            await worker.verifyPrintExecutor();
        }
        const finalRuntime = await inspectRuntime();
        check(finalRuntime.renderer.imageDigest === release.candidate.imageDigest && finalRuntime.failure.imageDigest === release.candidate.imageDigest &&
            finalRuntime.renderer.sourceDigest === release.candidate.sourceDigest, "Lambda pair changed before resume.");
        const status = await verifyStatus();
        return { releaseId: release.releaseId, sourceCommit: release.sourceCommit, candidate: release.candidate,
            worker: liveWorker, runtime: finalRuntime, status };
    });
}
