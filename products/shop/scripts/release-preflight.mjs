import { protectedConfig, resolveProtectedTemplate } from "./protected-config.mjs";
import { qualificationPolicy } from './release-qualification-policy.mjs';
import { parsePromotionInput } from "./release-promotion-input.mjs";
import { promotionManifest } from "./release-manifest.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { changedComponents, deploymentPlan, gitChanges, webOnlyPreviewPlan } from "./deployment-plan.mjs";
import { isReviewedMigrationInventory } from "./native-migration-inventory.mjs";
import { developmentOperation } from "./native-ci-operation.mjs";
import { assertProductionContext } from "./native-production-ci.mjs";
import { enforceWorkerRelease } from "../apps/web/scripts/verify-worker-release.mjs";
import { githubApi } from "./github-actions.mjs";
const repository = "bentbrain/bent-mono";
const root = new URL("../", import.meta.url);
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const load = path => JSON.parse(resolveProtectedTemplate(readFileSync(new URL(path, root), "utf8")));
const promotionOperations = new Set(["promote", "release", "verify-candidate", "inspect-image-plan", "prepare-runtime", "prepare-worker"]);
export function offlinePreflight({ environment, lane, operation, ref, sha, base, paths, migrations, qualification, sourceChanged, manifest = promotionManifest, releaseMode = "full", verifyRelease = "", rollbackRelease = "", rollbackReference = "", qualificationReference = "", rendererReference = "", scheduledQualification = "", releaseBaseVerified = false }) {
    const checks = [];
    const check = (id, passed, message) => checks.push({ id, passed: Boolean(passed), message });
    check("environment", ["development", "production"].includes(environment), "Choose development or production.");
    check("lane", ["web", "native", "wrangler"].includes(lane), "Choose web, native or wrangler; API changes with Lambda require native.");
    check("source", /^[a-f0-9]{40}$/.test(sha ?? "") && /^refs\/heads\/[\w./-]+$/.test(ref ?? ""), "A full source commit and branch ref are required.");
    check("production-ref", environment !== "production" || ref === "refs/heads/main", "Production releases require main.");
    check("migration-inventory", isReviewedMigrationInventory(migrations), "Update the reviewed migration inventory before any release pause.");
    const components = Array.isArray(paths) ? changedComponents(paths) : undefined;
    if (lane === "wrangler")
        check("native-routing", releaseBaseVerified && components && !components.api && !components.lambda, "Use the native lane for API or renderer changes; an unknown baseline requires native review.");
    if (lane === "web" && environment === "development") {
        let valid = true;
        try {
            webOnlyPreviewPlan({ environment, ref, base, paths, forceFull: false });
        }
        catch {
            valid = false;
        }
        check("preview-source", valid, "Preview requires exact current main or only permitted web changes on top of main.");
    }
    if (lane === "native") {
        const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: protectedConfig("githubRepositoryId"),
            GITHUB_REPOSITORY_OWNER_ID: protectedConfig("githubOwnerId"), GITHUB_REF: ref, GITHUB_SHA: sha, GITHUB_RUN_ID: "100",
            GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", NATIVE_OPERATION: operation, NATIVE_RELEASE_MODE: releaseMode,
            GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/native-${environment}.yml@${ref}`,
            NATIVE_VERIFY_RELEASE: verifyRelease, NATIVE_ROLLBACK_RELEASE: rollbackRelease, NATIVE_ROLLBACK_REFERENCE: rollbackReference, NATIVE_QUALIFICATION_REFERENCE: qualificationReference, NATIVE_RENDERER_REFERENCE: rendererReference, NATIVE_SCHEDULED_QUALIFICATION: scheduledQualification };
        let valid = true;
        // Pure argument validation only. Never call a cloud entry point or invent
        // actual identity evidence; Actions must verify its own real environment.
        try {
            if (environment === "production")
                assertProductionContext(env);
            else
                developmentOperation(env);
        }
        catch {
            valid = false;
        }
        if (operation === "rollback" && !/^native-\d+$/.test(rollbackRelease))
            valid = false;
        check("native-request", valid, "This native operation/ref is not supported by the existing identity policy.");
        if (environment === "production" && promotionOperations.has(operation)) {
            const q = qualification, reference = q?.reference;
            check("qualification-reference", q?.schemaVersion === 1 && Number.isSafeInteger(q?.qualificationRunId) && q.qualificationRunId > 0 &&
                /^[a-f0-9]{40}$/.test(q?.expectedQualificationCommit ?? "") && /^native-\d+$/.test(q?.expectedPair?.releaseId ?? "") &&
                ["complete-summary", "receipt"].some(name => reference?.key === "source/releases/native-" + protectedConfig("resource_8d0190ecec7d") + "/qualification-" + (name) + "-" + (q?.expectedPair?.releaseId) + "-run-" + (q?.qualificationRunId) + ".json") &&
                /^[a-zA-Z0-9._~+/=-]{1,1024}$/.test(reference?.version ?? "") && reference.version !== "null" &&
                /^[a-f0-9]{64}$/.test(reference?.sha256 ?? ""), "Qualification requires an exact version, checksum and source/run-bound receipt.");
            check("promotion-manifest", q?.qualificationRunId === manifest.qualification.runId &&
                q?.expectedPair?.releaseId === manifest.qualification.releaseId && q?.expectedPair?.sourceCommit === manifest.qualification.sourceCommit &&
                q?.expectedPair?.imageDigest === manifest.candidate.imageDigest, "Promotion manifest and qualification receipt must describe the same run and pair.");
            check("qualified-worker-source", sourceChanged === false, "Native source, infrastructure or release policy differs from qualification; qualify this source before promotion.");
        }
    }
    return { schemaVersion: 1, source: sha, ref, environment, lane, operation, components,
        observedAt: new Date().toISOString(), checks, passed: checks.every(item => item.passed), admissionGranted: false };
}
export function allowedBranch(policy, branch) {
    if (policy.type !== "branch" || typeof policy.name !== "string")
        return false;
    // GitHub's * does not match /. Reject unsupported patterns rather than
    // claiming permission based on a more permissive glob implementation.
    if (!/^[\w./*-]+$/.test(policy.name))
        return false;
    const expression = policy.name.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    return new RegExp(`^${expression}$`).test(branch);
}
export async function githubPreflight(report, api) {
    const name = report.environment === "production" ? "Production" : "Preview";
    const checks = [];
    const add = (id, passed, message) => checks.push({ id, passed, message });
    await Promise.all([
        (async () => {
            try {
                const environment = await api(`environments/${name}`);
                const policy = environment.deployment_branch_policy;
                let allowed = policy === null;
                if (policy?.custom_branch_policies) {
                    const rules = [];
                    for (let page = 1;; page++) {
                        const data = await api(`environments/${name}/deployment-branch-policies?per_page=100&page=${page}`);
                        if (!Array.isArray(data.branch_policies) || page > 10)
                            throw Error("Invalid policy inventory");
                        rules.push(...data.branch_policies);
                        if (rules.length >= data.total_count)
                            break;
                    }
                    allowed = rules.some(rule => allowedBranch(rule, report.ref.replace(/^refs\/heads\//, "")));
                }
                else if (policy?.protected_branches) {
                    const branch = await api(`branches/${encodeURIComponent(report.ref.replace(/^refs\/heads\//, ""))}`);
                    allowed = branch.protected === true;
                }
                add("github-environment", allowed, `${name} must permit the selected branch before dispatch.`);
            }
            catch {
                add("github-environment", false, `Cannot read ${name} branch policy using the supplied GitHub identity.`);
            }
        })(),
        (async () => {
            try {
                const branch = await api(`branches/${encodeURIComponent(report.ref.replace(/^refs\/heads\//, ""))}`);
                add("github-source", branch.commit?.sha === report.source, "Remote branch must still point to the requested source.");
            }
            catch {
                add("github-source", false, "Remote source could not be verified.");
            }
        })(),
        (async () => {
            try {
                const runs = [];
                for (const status of ["in_progress", "queued", "waiting", "pending"]) {
                    const data = await api(`actions/runs?status=${status}&per_page=100`);
                    if (!Array.isArray(data.workflow_runs) || data.total_count > 100)
                        throw Error("Incomplete run inventory");
                    runs.push(...data.workflow_runs);
                }
                const active = runs.filter(run => [".github/workflows/deploy.yml", ".github/workflows/preview-smoke.yml", `.github/workflows/native-${report.environment}.yml`,
                    ...(report.environment === "production" ? [".github/workflows/web-production.yml"] : [])].includes(run.path));
                add("github-release-activity", active.length === 0, active.length ?
                    `Release workflows need inspection before dispatch: ${[...new Set(active.map(run => run.id))].join(", ")}. General deploy targets are intentionally treated as ambiguous.` : "No conflicting release workflows observed.");
            }
            catch {
                add("github-release-activity", false, "Could not establish release activity.");
            }
        })(),
    ]);
    return checks.sort((a, b) => a.id.localeCompare(b.id));
}
export async function runPreflight(values, env = process.env) {
    const environment = values.environment ?? "development", lane = values.lane ?? "web";
    const sha = git(["rev-parse", "HEAD"]), ref = values.ref ?? env.GITHUB_REF ?? `refs/heads/${git(["branch", "--show-current"])}`;
    let base, paths;
    try {
        base = git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
        paths = gitChanges(base, sha, root);
    }
    catch { /* reported as missing */ }
    if (values["promotion-file"] && values["promotion-input"])
        throw Error("Choose one promotion input source.");
    const request = values["promotion-file"] ? readFileSync(values["promotion-file"], "utf8") : values["promotion-input"] ?? env.NATIVE_PROMOTION_INPUT;
    const input = request ? parsePromotionInput(request, sha) : null;
    const qualification = input?.qualification ?? load("infra/story-video-lambda/development-qualification.json");
    let sourceChanged;
    try {
        sourceChanged = qualificationPolicy(gitChanges(qualification.expectedPair.sourceCommit, sha, root)).kind !== 'unchanged';
    }
    catch { /* reported as unverified */ }
    const report = offlinePreflight({ environment, lane, operation: values.operation ?? (lane === "native" ? "plan" : "deploy"), ref, sha, base, paths,
        releaseMode: values["release-mode"] ?? env.NATIVE_RELEASE_MODE, verifyRelease: values["verify-release"] ?? env.NATIVE_VERIFY_RELEASE, rollbackRelease: values["rollback-release"] ?? env.NATIVE_ROLLBACK_RELEASE, rollbackReference: values["rollback-reference"] ?? env.NATIVE_ROLLBACK_REFERENCE, qualificationReference: values["qualification-reference"] ?? env.NATIVE_QUALIFICATION_REFERENCE, rendererReference: values["renderer-reference"] ?? env.NATIVE_RENDERER_REFERENCE, scheduledQualification: env.NATIVE_SCHEDULED_QUALIFICATION,
        manifest: input?.manifest ?? promotionManifest, migrations: readdirSync(new URL("workers/api/drizzle/", root)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort(), qualification, sourceChanged });
    report.checks.push({ id: "clean-source", passed: git(["status", "--porcelain"]) === "",
        message: "Commit local edits before release preflight; this report describes HEAD, not uncommitted files." });
    if (!["development", "production"].includes(environment))
        return report;
    if (values.github) {
        let token = env.GH_TOKEN;
        if (!token && !env.GITHUB_ACTIONS) {
            try {
                token = execFileSync("gh", ["auth", "token", "--user", "bentbrain"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
            }
            catch { /* reported below */ }
        }
        if (token) {
            const api = githubApi({ token, repository });
            report.checks.push(...await githubPreflight(report, api));
            if (lane === "wrangler") {
                try {
                    const plan = await deploymentPlan({ api, environment: environment === "production" ? "Production" : "Preview",
                        repository, runId: env.GITHUB_RUN_ID, sha, changes: (base, sha) => gitChanges(base, sha, root), forceFull: false });
                    report.deploymentPlan = plan;
                    report.components = { web: plan.web, api: plan.api, renderer: plan.renderer, lambda: plan.lambda };
                    const routing = report.checks.find(item => item.id === "native-routing");
                    routing.passed = !plan.api && !plan.lambda;
                    routing.message = `${plan.reason} ${routing.passed ? "Wrangler lane is compatible." : "Use the native release lane."}`;
                }
                catch { /* keep the unverified baseline blocker */ }
            }
        }
        else
            report.checks.push({ id: "github-auth", passed: false, message: "A personal GitHub login or explicit GH_TOKEN is required." });
    }
    if (values.worker) {
        const apiUrl = `https://forever-tee-api${environment === "development" ? "-development" : ""}.socialqueue.workers.dev`;
        let passed = true;
        try {
            await enforceWorkerRelease({ enforcement: "1", apiUrl, sharedSecret: env.FOREVER_TEE_API_SHARED_SECRET });
        }
        catch {
            passed = false;
        }
        report.checks.push({ id: "worker-capabilities", passed, message: "Live Worker must satisfy every storefront capability using the target environment's shared secret." });
    }
    if (values.aws) {
        let passed = true;
        try {
            const name = `forever-tee-video-${environment}`;
            execFileSync(process.execPath, ["scripts/aws-personal.mjs", "lambda", "get-function-concurrency", "--function-name", name], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        }
        catch {
            passed = false;
        }
        report.checks.push({ id: "personal-aws-read", passed, message: "Personal runner must read the exact Lambda concurrency. Missing private setup or expired SSO stops this read; no other credentials are tried." });
    }
    report.passed = report.checks.every(item => item.passed);
    return report;
}
if (import.meta.main) {
    try {
        const { values } = parseArgs({ options: { environment: { type: "string" }, lane: { type: "string" }, operation: { type: "string" },
                ref: { type: "string" }, "release-mode": { type: "string" }, "verify-release": { type: "string" }, "rollback-release": { type: "string" }, "rollback-reference": { type: "string" }, "qualification-reference": { type: "string" }, "renderer-reference": { type: "string" }, "promotion-input": { type: "string" }, "promotion-file": { type: "string" }, github: { type: "boolean" }, worker: { type: "boolean" }, aws: { type: "boolean" } } });
        const report = await runPreflight(values);
        console.log(JSON.stringify(report, null, 2));
        if (!report.passed)
            process.exitCode = 1;
    }
    catch {
        console.error("Release preflight could not read the requested local source/configuration. No release was started.");
        process.exitCode = 1;
    }
}
