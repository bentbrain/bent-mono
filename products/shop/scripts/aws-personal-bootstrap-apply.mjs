import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { open, readFile, mkdtemp } from "node:fs/promises";
import { readRegularFile } from "./read-regular-file.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APPROVED_BOOTSTRAP, BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE, verifyBootstrapReview } from "./aws-personal-bootstrap.mjs";
import { guardedPersonalCall, PERSONAL_ACCOUNT } from "./aws-personal-guard.mjs";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const STATE = join(BOOTSTRAP_PRIVATE, "terraform.tfstate");
const RENDERER_STATE = fileURLToPath(new URL("../.data/terraform-story-video/terraform.tfstate", import.meta.url));
export async function privateWrite(path, bytes) {
    const handle = await open(path, "wx", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    const parent = await open(join(path, ".."), "r");
    try {
        await parent.sync();
    }
    finally {
        await parent.close();
    }
}
async function optionalRead(path) {
    try {
        return await readRegularFile(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export async function checkBootstrapVacancies(call) {
    const checks = [
        { args: ["iam", "get-role", "--role-name", "forever-tee-video-development-ci"], absent: /\(NoSuchEntity\) when calling the GetRole operation/ },
        { args: ["iam", "get-policy", "--policy-arn", `arn:aws:iam::${PERSONAL_ACCOUNT}:policy/forever-tee-video-development-ci-boundary`], absent: /\(NoSuchEntity\) when calling the GetPolicy operation/ },
        { args: ["kms", "describe-key", "--key-id", "alias/forever-tee-video-development-state"], absent: /\(NotFoundException\) when calling the DescribeKey operation/ },
        { args: ["s3api", "head-bucket", "--bucket", "forever-tee-terraform-state-" + protectedConfig("awsAccountId") + "-ap-southeast-2", "--expected-bucket-owner", PERSONAL_ACCOUNT], absent: /\(404\) when calling the HeadBucket operation/ },
    ];
    for (const check of checks) {
        try {
            await call(check.args);
        }
        catch (error) {
            // Only the exact service's not-found response counts. Auth errors,
            // denied/ambiguous S3 responses and network failures must stop the apply.
            if (typeof error.stderr === "string" && check.absent.test(error.stderr))
                continue;
            throw new Error(`Bootstrap collision check failed for ${check.args[0]} ${check.args[1]}; no apply attempted.`);
        }
        throw new Error(`Bootstrap resource already exists for ${check.args[0]} ${check.args[1]}; takeover is forbidden.`);
    }
    const oidc = JSON.parse(await call(["iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn",
        `arn:aws:iam::${PERSONAL_ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`]));
    if (oidc.Url !== "token.actions.githubusercontent.com" || !Array.isArray(oidc.ClientIDList) || !oidc.ClientIDList.some(audience => audience === "sts.amazonaws.com")) {
        throw new Error("Existing GitHub OIDC provider no longer matches the reviewed issuer/audience.");
    }
}
export async function executeBootstrapOnce({ inspect, vacancies, backup, startJournal, recheck, apply, finishJournal }) {
    await inspect();
    await vacancies();
    const snapshots = await backup();
    await startJournal(snapshots);
    // A failure or process interruption after this point must not be retried.
    await recheck(snapshots);
    await apply();
    return finishJournal(snapshots);
}
export async function applyApprovedBootstrap({ dependencies, env, sourceDigest }) {
    const reviewDirectory = join(BOOTSTRAP_PRIVATE, APPROVED_BOOTSTRAP.review);
    const journal = join(BOOTSTRAP_PRIVATE, "approved-apply-started.json");
    if (await optionalRead(journal))
        throw new Error("Bootstrap apply was already attempted; inspect its private journal and live state. Automatic retry is forbidden.");
    const originalPlan = join(reviewDirectory, "bootstrap.tfplan");
    let runDirectory;
    let snapshotPlan;
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    const call = args => guardedPersonalCall(args, dependencies);
    const verifyHashes = async (path) => {
        if (sha256(await readFile(path)) !== APPROVED_BOOTSTRAP.planSha256 || await sourceDigest() !== APPROVED_BOOTSTRAP.sourceSha256) {
            throw new Error("Approved bootstrap plan or source changed. A new plan requires owner review.");
        }
    };
    const result = await executeBootstrapOnce({
        inspect: async () => {
            await verifyHashes(originalPlan);
            const review = JSON.parse(resolveProtectedTemplate(await readFile(join(reviewDirectory, "review.json"), "utf8")));
            const plan = JSON.parse(await capture(["show", "-json", originalPlan]));
            verifyBootstrapReview(review, plan, APPROVED_BOOTSTRAP.planSha256, APPROVED_BOOTSTRAP.sourceSha256);
            if (plan.applyable !== true || plan.complete !== true || plan.resource_changes.some(change => change.mode === "managed" && JSON.stringify(change.change.actions) !== '["create"]')) {
                throw new Error("The approved bootstrap must be a complete creation-only plan.");
            }
            if (await optionalRead(STATE))
                throw new Error("Bootstrap state already exists; do not apply the original creation plan.");
        },
        vacancies: () => checkBootstrapVacancies(call),
        backup: async () => {
            runDirectory = await mkdtemp(join(BOOTSTRAP_PRIVATE, "apply-"));
            snapshotPlan = join(runDirectory, "approved.tfplan");
            await privateWrite(snapshotPlan, await readFile(originalPlan));
            const snapshots = [];
            for (const [name, path] of [["bootstrap-before", STATE], ["bootstrap-backup-before", `${STATE}.backup`],
                ["renderer-before", RENDERER_STATE], ["renderer-backup-before", `${RENDERER_STATE}.backup`]]) {
                const bytes = await optionalRead(path);
                if (bytes)
                    await privateWrite(join(runDirectory, `${name}.tfstate`), bytes);
                snapshots.push({ name, path, sha256: bytes ? sha256(bytes) : null });
            }
            return snapshots;
        },
        startJournal: async (snapshots) => privateWrite(journal, JSON.stringify({
            status: "started", ...APPROVED_BOOTSTRAP, startedAt: new Date().toISOString(), runDirectory, snapshots,
        }, null, 2) + "\n"),
        recheck: async (snapshots) => {
            await call(["sts", "get-caller-identity"]);
            await verifyHashes(snapshotPlan);
            for (const snapshot of snapshots) {
                const bytes = await optionalRead(snapshot.path);
                if ((bytes ? sha256(bytes) : null) !== snapshot.sha256)
                    throw new Error("Local state changed during bootstrap preflight; stopped before apply.");
            }
        },
        apply: () => dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", snapshotPlan], env, BOOTSTRAP_DIRECTORY),
        finishJournal: async (snapshots) => {
            const state = await readFile(STATE);
            await privateWrite(join(runDirectory, "bootstrap-after.tfstate"), state);
            for (const snapshot of snapshots.filter(item => item.name.startsWith("renderer"))) {
                const bytes = await optionalRead(snapshot.path);
                if ((bytes ? sha256(bytes) : null) !== snapshot.sha256)
                    throw new Error("Renderer state changed during bootstrap. Preserve all files and inspect before continuing.");
            }
            const result = { status: "applied-awaiting-live-verification", planSha256: APPROVED_BOOTSTRAP.planSha256,
                completedAt: new Date().toISOString(), runDirectory, stateSha256: sha256(state), rendererStateUnchanged: true, ciEnabled: false };
            await privateWrite(join(runDirectory, "apply-complete.json"), JSON.stringify(result, null, 2) + "\n");
            return result;
        },
    });
    return JSON.stringify(result, null, 2) + "\n";
}
