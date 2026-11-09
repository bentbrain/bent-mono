import { runDevelopmentForwardRecovery } from "./native-forward-recovery.mjs";
import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { recoverPausedDevelopmentRollback } from "./native-rollback-recovery.mjs";
import { recoverFailedQualification } from "./native-failed-qualification-cleanup.mjs";
import { restoreDevelopmentPrintExecutor } from "./native-print-executor.mjs";
import { measureReleaseStage } from "./release-stage-timing.mjs";
import { recoverQualification, finishQualification, writeQualificationPointer } from "./native-qualification-recovery.mjs";
import { prepareApiImage } from "./native-api-image.mjs";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { runCloudBuild, verifyCandidateCheckout } from "./native-ci-build.mjs";
import { prepareDevelopmentImage } from "./native-ci-terraform.mjs";
import { loadVerifiedCandidate } from "./native-ci-candidate.mjs";
import { developmentCloudflare, inspectDevelopmentCloudflare } from "./native-ci-cloudflare.mjs";
import { inspectDevelopmentRuntime } from "./native-ci-runtime.mjs";
import { prepareDevelopmentWorker, verifyDevelopmentPairStatus, inspectDevelopmentWorker } from "./native-ci-worker.mjs";
import { createDevelopmentReleaseStore } from "./native-ci-release-store.mjs";
import { executeDevelopmentRelease } from "./native-ci-paired-release.mjs";
import { executeDevelopmentRollback, loadDevelopmentRollback } from "./native-ci-rollback.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { qualifyDevelopmentFamilies, qualifyDevelopmentExhaustion, qualifyDevelopmentFaults, qualifyDevelopmentTermination, qualifyDevelopmentLoad, qualifyDevelopmentRelease, qualifyDevelopmentComponents } from "./native-ci-qualification.mjs";
import { probeDevelopmentFunctions } from "./native-ci-health.mjs";
import { verifySavedDevelopmentQualification } from "./native-ci-qualification-verification.mjs";
import { cleanupDevelopmentQualification, ensureDevelopmentStorageLifecycle } from "./native-ci-qualification-cleanup.mjs";
import { repairDevelopmentSchedule } from "./native-ci-schedule-repair.mjs";
try {
    const env = process.env, operation = developmentOperation(env);
    const cf = developmentCloudflare(env);
    await verifyCandidateCheckout(env);
    const releaseId = `native-${env.GITHUB_RUN_ID}`;
    let operationFailure, functional;
    try {
        if (["plan-forward-recovery", "recover-forward-release"].includes(operation)) {
            console.info(JSON.stringify(await runDevelopmentForwardRecovery(env)));
        }
        else if (operation === "recover-rollback") {
            console.info(JSON.stringify(await recoverPausedDevelopmentRollback(env)));
        }
        else if (operation === "cleanup-failed-qualification") {
            console.info(JSON.stringify(await recoverFailedQualification(env)));
        }
        else if (operation === "cleanup-qualification") {
            console.info(JSON.stringify(await recoverQualification(env)));
        }
        else if (operation === "repair-schedule") {
            const store = await createDevelopmentReleaseStore(env);
            console.info(JSON.stringify(await repairDevelopmentSchedule({ cf, store, env })));
        }
        else if (operation === "build-candidate") {
            console.info(JSON.stringify(await runCloudBuild(env)));
        }
        else if (operation === "qualify") {
            console.info(JSON.stringify(await qualifyDevelopmentFamilies(env)));
        }
        else if (operation === "qualify-exhaustion") {
            console.info(JSON.stringify(await qualifyDevelopmentExhaustion(env)));
        }
        else if (operation === "qualify-faults") {
            console.info(JSON.stringify(await qualifyDevelopmentFaults(env)));
        }
        else if (operation === "qualify-termination") {
            console.info(JSON.stringify(await qualifyDevelopmentTermination(env)));
        }
        else if (operation === "qualify-load") {
            console.info(JSON.stringify(await qualifyDevelopmentLoad(env)));
        }
        else if (["qualify-all", "qualify-components"].includes(operation)) {
            functional = operation === "qualify-all" ? await qualifyDevelopmentRelease(env) : await qualifyDevelopmentComponents(env);
            await writeQualificationPointer(env, functional.evidence);
            console.info(JSON.stringify(functional));
        }
        else if (operation === "verify-qualification") {
            const receipt = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-lambda/development-qualification.json", import.meta.url), "utf8")));
            console.info(JSON.stringify(await verifySavedDevelopmentQualification(receipt, env)));
        }
        else if (operation === "rollback") {
            const store = await createDevelopmentReleaseStore(env);
            const { prepared, target } = await loadDevelopmentRollback(cf, store, env.NATIVE_ROLLBACK_RELEASE);
            await inspectDevelopmentRuntime(env, { allowMixedImages: true });
            const image = await prepareDevelopmentImage(target, env, { recoveryCandidates: [target, prepared.candidate] });
            console.info(JSON.stringify({ operation, releaseId, target, plan: image.review }));
            console.info(JSON.stringify(await executeDevelopmentRollback({ cf, store, prepared, target, image, releaseId, sourceCommit: env.GITHUB_SHA,
                restorePrintExecutor: () => restoreDevelopmentPrintExecutor({ env, api: cf, store, prepared, releaseId, inspectWorker: inspectDevelopmentWorker }),
                probeRuntime: () => probeDevelopmentFunctions(env),
                inspectRuntime: () => inspectDevelopmentRuntime(env, { allowMixedImages: true }), wait: setTimeout })));
        }
        else {
            await ensureDevelopmentStorageLifecycle(cf);
            const bindings = await inspectDevelopmentCloudflare(env);
            const runtime = await inspectDevelopmentRuntime(env);
            console.info(JSON.stringify({ bindings, runtime }));
            let receipt;
            if (env.NATIVE_CANDIDATE_RECEIPT) receipt = JSON.parse(env.NATIVE_CANDIDATE_RECEIPT);
            try {
                if (!receipt && env.NATIVE_RELEASE_MODE === "api") receipt = JSON.parse(resolveProtectedTemplate(await readFile(new URL("../infra/story-video-lambda/development-candidate.json", import.meta.url), "utf8")));
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw new Error("Cannot read the pinned Development candidate receipt.");
            }
            if (env.NATIVE_RELEASE_MODE === "api" && !receipt)
                throw Error("API-only release requires the existing immutable candidate receipt.");
            const candidate = receipt ? await loadVerifiedCandidate(receipt, env) : await runCloudBuild(env);
            console.info(JSON.stringify(candidate));
            const store = await createDevelopmentReleaseStore(env);
            const image = env.NATIVE_RELEASE_MODE === "api"
                ? await prepareApiImage({ environment: "development", sha: env.GITHUB_SHA, cf, store, candidate, runtime,
                    inspectRuntime: () => inspectDevelopmentRuntime(env) })
                : await measureReleaseStage("image-prepare", () => prepareDevelopmentImage(candidate, env));
            const worker = await measureReleaseStage("worker-build", () => prepareDevelopmentWorker(env));
            console.info(JSON.stringify({ plan: image.review, worker: worker.review, previousWorker: worker.before, consumer: worker.consumer }));
            if (operation === "release") {
                if (!env.BENT_SHIRT_OPERATIONS_SECRET)
                    throw new Error("Operations credential is required before the release pause.");
                const artifacts = await worker.preserve(store);
                const planArtifact = await image.preserve(store);
                const release = { releaseId, sourceCommit: env.GITHUB_SHA, environment: "development", accountId: protectedConfig("awsAccountId"), region: "ap-southeast-2",
                    planSha256: image.review.planSha256, candidate, worker: worker.review, artifacts, planArtifact,
                    previous: { runtime, worker: worker.before, consumer: worker.consumer } };
                console.info(JSON.stringify(await executeDevelopmentRelease({ cf, store, release, image, worker,
                    probeRuntime: () => probeDevelopmentFunctions(env),
                    inspectRuntime: () => inspectDevelopmentRuntime(env), verifyStatus: () => verifyDevelopmentPairStatus(env, candidate, releaseId), wait: setTimeout })));
            }
        }
    }
    catch (error) {
        operationFailure = error;
    }
    if (["qualify", "qualify-exhaustion", "qualify-faults", "qualify-termination", "qualify-load", "qualify-all", "qualify-components"].includes(operation)) {
        try {
            console.info(JSON.stringify(functional
                ? await finishQualification(env, cf, await createDevelopmentReleaseStore(env), functional)
                : await cleanupDevelopmentQualification(env, cf)));
        }
        catch (error) {
            if (!operationFailure)
                operationFailure = error;
            else
                console.error("Qualification cleanup failed after the primary operation failure.");
        }
    }
    if (operationFailure)
        throw operationFailure;
}
catch (error) {
    console.error(error instanceof Error ? error.message : "Development operation failed.");
    process.exitCode = 1;
}
