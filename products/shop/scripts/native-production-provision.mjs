import { protectedConfig } from "./protected-config.mjs";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertProductionContext, productionAWS } from "./native-production-ci.mjs";
import { runProductionCandidate } from "./native-production-candidate.mjs";
import { foundationEvidenceSaver, verifyFoundationStorage } from "./native-production-foundation.mjs";
import { inspectProductionRuntimePlan, verifyProductionRuntime, PRODUCTION_IMAGE_DIGEST, PRODUCTION_SOURCE_DIGEST } from "./native-production-runtime.mjs";
import { terraformFailureSummary } from "./native-ci-terraform.mjs";
import { verifyStartupProbe } from "./native-ci-health.mjs";
import { normalizeCheckOrder } from "./native-production-alert-recovery.mjs";
const execute = promisify(execFile), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const MODULE = fileURLToPath(new URL("../infra/story-video-production/", import.meta.url));
const check = (value, reason) => { if (!value)
    throw new Error(`Production runtime preparation stopped: ${reason}`); };
const NAME = "forever-tee-video-production";
export function verifyRuntimeStateUnchanged(before, after) {
    check(equal(normalizeCheckOrder(before), normalizeCheckOrder(after)), "state changed before intent.");
}
export async function verifyNoProductionRuntime(call) {
    for (const name of [NAME, `${NAME}-failures`]) {
        try {
            await call(["lambda", "get-function", "--function-name", name]);
        }
        catch (error) {
            if (error.code === "ResourceNotFoundException")
                continue;
            throw new Error("Production function collision read failed; no apply.");
        }
        throw new Error("Production function exists; no automatic takeover or partial-apply retry.");
    }
    const mappings = await call(["lambda", "list-event-source-mappings", "--event-source-arn", "arn:aws:sqs:ap-southeast-2:" + protectedConfig("awsAccountId") + ":" + (NAME) + "-failures"]);
    check(!mappings.NextMarker && mappings.EventSourceMappings?.length === 0, "failure queue already has a mapping.");
}
async function journal(env, body, suffix = "") {
    check(env.GITHUB_TOKEN, "durable journal token required.");
    const response = await fetch(`https://api.github.com/repos/bentbrain/bent-mono/deployments${suffix}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" }, body: JSON.stringify(body),
    });
    check(response.ok, "journal response uncertain; inspect before any retry.");
    return response.json();
}
export async function prepareProductionRuntime(env, candidate) {
    assertProductionContext(env);
    check(env.NATIVE_OPERATION === "prepare-runtime" && process.platform === "linux" && process.arch === "x64" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only explicit preparation.");
    check(candidate.qualifiedImageVerified === true && candidate.alertDeliveryVerified === true && candidate.acceptanceVerified === true &&
        candidate.workerSourceUnchanged === true && candidate.sourceCommit === env.GITHUB_SHA && candidate.imageDigest === PRODUCTION_IMAGE_DIGEST &&
        candidate.sourceDigest === PRODUCTION_SOURCE_DIGEST, "current verified candidate and acceptance evidence.");
    const { call, child } = await productionAWS(env);
    await verifyNoProductionRuntime(call);
    process.umask(0o077);
    const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-production-runtime-"));
    const save = foundationEvidenceSaver(directory, env.GITHUB_RUN_ID, call);
    const files = [".terraform.lock.hcl", "alerts.tf", "main.tf", "runtime.tf", "versions.tf"];
    check(equal((await readdir(MODULE)).sort(), files), "exact Production module inventory.");
    const sourceHash = async () => {
        const entries = [];
        for (const name of files)
            entries.push([name, sha(await readFile(join(MODULE, name)))]);
        return sha(JSON.stringify(entries));
    };
    const source = await sourceHash();
    const response = await fetch("https://releases.hashicorp.com/terraform/1.12.2/terraform_1.12.2_linux_amd64.zip", { redirect: "error", signal: AbortSignal.timeout(30000) });
    check(response.ok, "pinned Terraform download.");
    const bytes = Buffer.from(await response.arrayBuffer());
    check(sha(bytes) === protectedConfig("resource_9519c9b3fa59"), "Terraform checksum.");
    const archive = join(directory, "terraform.zip");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    await execute("/usr/bin/unzip", ["-q", archive, "-d", directory]);
    const tfEnv = { ...child, HOME: directory, TF_DATA_DIR: join(directory, "providers"), TF_CLI_CONFIG_FILE: "/dev/null", TF_INPUT: "false", TF_IN_AUTOMATION: "true",
        TF_WORKSPACE: "default", CHECKPOINT_DISABLE: "1", TF_VAR_enable_alerts: "true", TF_VAR_alert_email: env.NATIVE_ALERT_EMAIL,
        TF_VAR_image_digest: PRODUCTION_IMAGE_DIGEST, TF_VAR_source_digest: PRODUCTION_SOURCE_DIGEST };
    let diagnostic = 0;
    const run = async (args) => {
        try {
            return (await execute(join(directory, "terraform"), args, { cwd: MODULE, env: tfEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300000 })).stdout;
        }
        catch (error) {
            const summary = { operation: args[0], ...terraformFailureSummary(error) };
            // Raw provider errors can contain private plan/contact data. Keep them in
            // the private release bucket and print only selected error categories.
            const reference = await save(`runtime-error-${diagnostic++}.json`, JSON.stringify({ summary, stdout: error.stdout, stderr: error.stderr }));
            console.error(JSON.stringify({ ...summary, privateDiagnostic: reference }));
            throw new Error("Production Terraform response failed or is uncertain; inspect saved state and journal before recovery.");
        }
    };
    await run(["init", "-input=false", "-lockfile=readonly", "-no-color"]);
    await run(["validate", "-no-color"]);
    const before = await run(["state", "pull"]);
    const beforeReference = await save("runtime-before.tfstate", before);
    const planPath = join(directory, "runtime.tfplan");
    await run(["plan", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", `-out=${planPath}`]);
    const planBytes = await readFile(planPath), planReference = await save("runtime.tfplan", planBytes);
    const raw = await run(["show", "-json", planPath]);
    const planJson = await save("runtime-plan.json", raw);
    let review;
    try {
        review = inspectProductionRuntimePlan(JSON.parse(raw), env.NATIVE_ALERT_EMAIL);
    }
    catch (error) {
        console.error(JSON.stringify({ rejectedRuntimePlan: planJson }));
        throw error;
    }
    console.info(JSON.stringify({ ...review, sourceHash: source, planHash: sha(planBytes), sourceCommit: env.GITHUB_SHA }));
    await verifyNoProductionRuntime(call);
    await verifyFoundationStorage(call);
    check(source === await sourceHash() && sha(await readFile(planPath)) === sha(planBytes), "source/plan changed before intent.");
    verifyRuntimeStateUnchanged(JSON.parse(before), JSON.parse(await run(["state", "pull"])));
    const intent = await journal(env, { ref: env.GITHUB_SHA, task: "native-runtime-preparation", auto_merge: false, required_contexts: [], environment: "Production", production_environment: false,
        description: "Create the qualified runtime without Worker changes or provider cutover", payload: { runId: env.GITHUB_RUN_ID, sourceHash: source, plan: planReference, before: beforeReference, candidate: candidate.evidence } });
    check(Number.isSafeInteger(intent.id), "acknowledged intent ID.");
    await journal(env, { state: "in_progress", auto_inactive: false, description: "Applying the exact four-resource runtime plan" }, `/${intent.id}/statuses`);
    await run(["apply", "-input=false", "-no-color", "-parallelism=1", "-lock-timeout=0s", planPath]);
    const state = await save("runtime-after.tfstate", await run(["state", "pull"]));
    const runtime = await verifyProductionRuntime(call);
    const probes = [];
    for (const failure of [false, true]) {
        const path = join(directory, `startup-${failure ? "failure" : "renderer"}.json`);
        const result = await call(["lambda", "invoke", "--function-name", `${NAME}${failure ? "-failures" : ""}`, "--invocation-type", "RequestResponse",
            "--cli-binary-format", "raw-in-base64-out", "--payload", '{"nativeReleaseStartupProbe":true}', path]);
        const bytes = await readFile(path);
        check(bytes.length < 16384, "bounded startup response.");
        probes.push(verifyStartupProbe(result, JSON.parse(bytes), failure));
    }
    const final = { ...review, ...runtime, startupVerified: true, probes, state, candidate: candidate.evidence, sourceHash: source,
        deploymentJournalId: intent.id, sourceCommit: env.GITHUB_SHA, workerChanged: false, productionAdmissionGranted: false };
    const evidence = await save("runtime-complete.json", JSON.stringify(final));
    await journal(env, { state: "success", auto_inactive: false, description: "Runtime prepared and startup verified; Production still uses Cloudflare" }, `/${intent.id}/statuses`);
    return { ...final, evidence };
}
export async function executeProductionPromotion(env, candidate, dependencies = {}) {
    assertProductionContext(env);
    check(env.NATIVE_OPERATION === "promote", "explicit one-pass promotion.");
    const releasePair = dependencies.releasePair ?? (await import("./native-production-release.mjs")).releaseProductionPair;
    const runCanary = dependencies.runCanary ?? (await import("./native-production-canary.mjs")).runProductionCanary;
    const releaseId = `native-${env.GITHUB_RUN_ID}`;
    const release = await releasePair({ ...env, NATIVE_OPERATION: "release" }, candidate);
    check(release.pairedReleaseComplete === true && release.releaseId === releaseId && release.provider === "lambda", "paired native release must complete before canary.");
    const canary = await runCanary({ ...env, NATIVE_OPERATION: "canary", NATIVE_RELEASE_MODE: "full", NATIVE_VERIFY_RELEASE: releaseId });
    check(canary.productionCanaryPassed === true && canary.releaseId === releaseId, "same-release Production canary.");
    return { productionPromotionComplete: true, releaseId, release, canary };
}
export async function runProduction(env = process.env) {
    if (env.NATIVE_OPERATION === "sweep-products") {
        const { sweepProductionProducts } = await import("./native-production-product-sweep.mjs");
        return sweepProductionProducts(env);
    }
    if (env.NATIVE_OPERATION === "repair-featured-videos") {
        const { recoverFeaturedProductVideos } = await import("./native-production-featured-video-recovery.mjs");
        return recoverFeaturedProductVideos(env);
    }
    if (env.NATIVE_OPERATION === "recover-release") {
        const { recoverProductionRelease } = await import("./native-production-preflight-recovery.mjs");
        return recoverProductionRelease(env);
    }
    if (env.NATIVE_OPERATION === "recover-canary") {
        const { recoverProductionCanary } = await import("./native-production-canary-recovery.mjs");
        return recoverProductionCanary(env);
    }
    if (env.NATIVE_OPERATION === "recover-rehearsal") {
        const { recoverProductionRehearsal } = await import("./native-production-rehearsal-recovery.mjs");
        return recoverProductionRehearsal(env);
    }
    if (env.NATIVE_OPERATION === "inspect-release") {
        const { inspectProductionRelease } = await import("./native-production-release-inspection.mjs");
        return inspectProductionRelease(env);
    }
    if (env.NATIVE_OPERATION === "release-storefront") {
        const { releaseProductionStorefront } = await import("./native-production-web-release.mjs");
        return releaseProductionStorefront(env);
    }
    if (env.NATIVE_OPERATION === "rollback") {
        const { rollbackProductionPair } = await import("./native-production-release.mjs");
        return rollbackProductionPair(env);
    }
    if (env.NATIVE_OPERATION === "canary") {
        const { runProductionCanary } = await import("./native-production-canary.mjs");
        return runProductionCanary(env);
    }
    if (["prepare-monitor", "monitor"].includes(env.NATIVE_OPERATION)) {
        const { runProductionMonitor } = await import("./native-production-monitor.mjs");
        return runProductionMonitor(env);
    }
    const candidate = await runProductionCandidate(env);
    if (env.NATIVE_OPERATION === "promote")
        return executeProductionPromotion(env, candidate);
    if (env.NATIVE_OPERATION === "inspect-image-plan") {
        const { call } = await productionAWS(env);
        const { productionReleaseStore } = await import("./native-production-release-store.mjs");
        const { prepareProductionImage } = await import("./native-production-image.mjs");
        const store = await productionReleaseStore(env, call), image = await prepareProductionImage(candidate, env, store);
        return { ...image.review, plan: await image.preserve(), applicationMutations: false };
    }
    if (env.NATIVE_OPERATION === "release") {
        const { releaseProductionPair } = await import("./native-production-release.mjs");
        return releaseProductionPair(env, candidate);
    }
    if (env.NATIVE_OPERATION === "prepare-worker") {
        const { call } = await productionAWS(env);
        const runtime = await verifyProductionRuntime(call);
        const { productionReleaseStore } = await import("./native-production-release-store.mjs");
        const { prepareProductionWorker } = await import("./native-production-worker.mjs");
        const store = await productionReleaseStore(env, call), worker = await prepareProductionWorker(env, store, candidate.qualification?.printExecutor);
        const prepared = { environment: "production", releaseId: `native-${env.GITHUB_RUN_ID}`, sourceCommit: env.GITHUB_SHA,
            candidate: candidate.evidence, runtime, previous: { worker: worker.before, consumer: worker.consumer }, review: worker.review, artifacts: worker.artifacts,
            workerPrepared: true, applicationMutations: false, productionAdmissionGranted: false };
        const evidence = await store.save("worker-preparation.json", Buffer.from(JSON.stringify(prepared)));
        return { ...prepared, evidence };
    }
    return env.NATIVE_OPERATION === "prepare-runtime" ? prepareProductionRuntime(env, candidate) : candidate;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.info(JSON.stringify(await runProduction()));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
