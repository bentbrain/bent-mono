import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BOOTSTRAP_DIRECTORY, BOOTSTRAP_PRIVATE, sourceDigest } from "./aws-personal-bootstrap.mjs";
import { privateWrite } from "./aws-personal-bootstrap-apply.mjs";
import { verifyBootstrapReadback } from "./aws-personal-bootstrap-verification.mjs";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { personalGitHub } from "./github-personal.mjs";
const RUN = Number(protectedConfig("resource_5dafa3f50f08"));
const SHA = "3dfcf57d498373dcc0bde5e4200aba8e6a68a6d2";
const SUBJECT = "repo:bentbrain@" + protectedConfig("githubOwnerId") + "/bent-mono@" + protectedConfig("githubRepositoryId") + ":environment:Preview";
const DESCRIPTION = "Protected Preview with verified personal repository OIDC; state and inspection only";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const requireScope = condition => {
    if (!condition)
        throw new Error("CI activation must change only the verified Development trust and its enabled output.");
};
async function snapshotBytes(path) {
    try {
        return await readFile(path);
    }
    catch (error) {
        if (error.code === "ENOENT" && path.endsWith(".backup"))
            return null;
        throw error;
    }
}
export function inspectCIActivation(plan) {
    requireScope(plan?.complete === true && plan.applyable === true && plan.errored !== true);
    const updates = plan.resource_changes.filter(item => !equal(item.change.actions, ["no-op"]));
    requireScope(updates.length === 1 && updates[0].address === "aws_iam_role.ci" && equal(updates[0].change.actions, ["update"]));
    const role = updates[0];
    const before = role.change.before;
    const after = role.change.after;
    const previous = JSON.parse(before.assume_role_policy);
    requireScope(previous.Statement.length === 2 && previous.Statement.some(item => item.Sid === "DisabledPendingPreviewProtection"));
    const enabled = { ...previous, Statement: previous.Statement.filter(item => item.Sid !== "DisabledPendingPreviewProtection") };
    requireScope(equal(JSON.parse(after.assume_role_policy), enabled) && after.description === DESCRIPTION);
    requireScope(equal({ ...after, assume_role_policy: before.assume_role_policy, description: before.description }, before));
    requireScope(equal(plan.output_changes.ci_assumption_enabled.actions, ["update"]) &&
        plan.output_changes.ci_assumption_enabled.before === false && plan.output_changes.ci_assumption_enabled.after === true);
    requireScope(Object.entries(plan.output_changes).every(([name, change]) => name === "ci_assumption_enabled" || equal(change.actions, ["no-op"])));
    // Reuse the strict disabled readback check on the pre-activation state. This
    // permits known provider parent/child observations, never permission changes.
    const restored = structuredClone(plan);
    restored.resource_changes = restored.resource_changes.map(item => item.address === role.address
        ? { ...item, change: { ...item.change, actions: ["no-op"], after: before } } : item);
    restored.planned_values.outputs.ci_assumption_enabled.value = false;
    const verified = verifyBootstrapReadback(restored);
    return { accountId: verified.accountId, region: verified.region, ciEnabled: true,
        changedResource: role.address, permissionsChanged: false, subject: SUBJECT, identityRun: RUN,
        readAfterCreateObservations: verified.readAfterCreateObservations };
}
export async function verifyGitHubActivation(github) {
    const base = "/repos/bentbrain/bent-mono";
    for (const [name, expected] of [["Preview", ["main", "perf/story-video-family-experiments"]], ["Production", ["main"]]]) {
        const environment = await github.api(`${base}/environments/${name}`);
        requireScope(equal(environment.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true }));
        const rules = await github.api(`${base}/environments/${name}/deployment-branch-policies`);
        requireScope(rules.total_count === expected.length && rules.branch_policies.every(rule => rule.type === "branch") &&
            equal(rules.branch_policies.map(rule => rule.name).sort(), [...expected].sort()));
    }
    const run = await github.api(`${base}/actions/runs/${RUN}`);
    requireScope(run.head_sha === SHA && run.conclusion === "success" && run.event === "push" &&
        run.path === ".github/workflows/native-ci-identity.yml" && run.repository.id === Number(protectedConfig("githubRepositoryId")) && run.head_repository.id === Number(protectedConfig("githubRepositoryId")));
    const jobs = await github.api(`${base}/actions/runs/${RUN}/jobs`);
    requireScope(jobs.total_count === 1 && jobs.jobs[0].conclusion === "success");
    const log = await github.jobLog(jobs.jobs[0].id);
    const records = log.split("\n").filter(line => line.includes('"signatureVerified":true')).map(line => JSON.parse(line.slice(line.indexOf("{"))));
    requireScope(records.length === 1 && records[0].subject === SUBJECT && records[0].signatureVerified === true && records[0].awsAccessAttempted === false);
    return { runId: RUN, sourceSha: SHA, subject: SUBJECT, environmentsVerified: true };
}
export function activationArguments(args) {
    if (args.length === 1 && args[0] === "plan")
        return { operation: "plan" };
    if (args.length === 3 && args[0] === "apply" && /^--review=activation-[A-Za-z0-9]{6}$/.test(args[1]) && /^--plan-sha256=[a-f0-9]{64}$/.test(args[2])) {
        return { operation: "apply", review: args[1].slice(9), planSha256: args[2].slice(14) };
    }
    throw new Error("Use activate-ci plan, or apply with its exact review and SHA-256; overrides are forbidden.");
}
export async function runCIActivation(args, dependencies) {
    const request = activationArguments(args);
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    const githubEvidence = await verifyGitHubActivation(await personalGitHub());
    const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: join(BOOTSTRAP_PRIVATE, "providers"),
        TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
    const capture = args => dependencies.executeTerraformCapture(args, env, BOOTSTRAP_DIRECTORY);
    const directory = request.operation === "plan" ? await mkdtemp(join(BOOTSTRAP_PRIVATE, "activation-")) : join(BOOTSTRAP_PRIVATE, request.review);
    const path = join(directory, "activation.tfplan");
    const sourceSha256 = await sourceDigest();
    if (request.operation === "plan") {
        const output = await capture(["plan", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", `-out=${path}`]);
        await privateWrite(join(directory, "plan.txt"), output);
    }
    const raw = await capture(["show", "-json", path]);
    const inspected = inspectCIActivation(JSON.parse(raw));
    const planSha256 = hash(await readFile(path));
    requireScope(sourceSha256 === await sourceDigest());
    if (request.operation === "plan") {
        await privateWrite(join(directory, "plan.json"), raw);
        await privateWrite(join(directory, "review.json"), JSON.stringify({ ...inspected, planSha256, sourceSha256, githubEvidence }));
        return JSON.stringify({ reviewDirectory: directory, planSha256, sourceSha256, ...inspected }) + "\n";
    }
    const review = JSON.parse(resolveProtectedTemplate(await readFile(join(directory, "review.json"), "utf8")));
    requireScope(request.planSha256 === planSha256 && review.planSha256 === planSha256 && review.sourceSha256 === sourceSha256);
    const journal = join(BOOTSTRAP_PRIVATE, "ci-activation-started.json");
    try {
        await access(journal);
        throw new Error("CI activation already attempted. Inspect live state; no automatic replay.");
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const evidence = await mkdtemp(join(BOOTSTRAP_PRIVATE, "activate-"));
    const snapshots = [];
    for (const [name, state] of [["bootstrap", join(BOOTSTRAP_PRIVATE, "terraform.tfstate")],
        ["renderer", fileURLToPath(new URL("../.data/terraform-story-video/terraform.tfstate", import.meta.url))]]) {
        for (const suffix of ["", ".backup"]) {
            const bytes = await snapshotBytes(`${state}${suffix}`);
            if (bytes)
                await privateWrite(join(evidence, `${name}-before.tfstate${suffix}`), bytes);
            snapshots.push({ path: `${state}${suffix}`, sha256: bytes ? hash(bytes) : null, name });
        }
    }
    await privateWrite(join(evidence, "activation.tfplan"), await readFile(path));
    await privateWrite(journal, JSON.stringify({ planSha256, sourceSha256, githubEvidence, evidence, snapshots, startedAt: new Date().toISOString() }));
    await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
    requireScope(sourceSha256 === await sourceDigest() && planSha256 === hash(await readFile(join(evidence, "activation.tfplan"))));
    const unchanged = async (snapshot) => {
        const bytes = await snapshotBytes(snapshot.path);
        requireScope((bytes ? hash(bytes) : null) === snapshot.sha256);
    };
    for (const snapshot of snapshots)
        await unchanged(snapshot);
    await dependencies.executeTerraform(["apply", "-no-color", "-input=false", "-lock-timeout=30s", "-parallelism=1", join(evidence, "activation.tfplan")], env, BOOTSTRAP_DIRECTORY);
    await privateWrite(join(evidence, "bootstrap-after.tfstate"), await readFile(join(BOOTSTRAP_PRIVATE, "terraform.tfstate")));
    for (const snapshot of snapshots.filter(item => item.name === "renderer"))
        await unchanged(snapshot);
    await privateWrite(join(evidence, "complete.json"), JSON.stringify({ completedAt: new Date().toISOString(), ...inspected }));
    return JSON.stringify({ evidenceDirectory: evidence, ...inspected, rendererStateUnchanged: true }) + "\n";
}
