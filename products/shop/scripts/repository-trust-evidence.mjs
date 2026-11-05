import { protectedConfig } from "./protected-config.mjs";
import { requireReleaseChecks } from "../../../scripts/require-release-checks.mjs";
import { isDeepStrictEqual as equal } from "node:util";

export const trustCheck = (value, reason) => { if (!value) throw new Error(`Repository trust stopped: ${reason}`); };
export const targetPrefix = () => `repo:bentbrain@${protectedConfig("githubOwnerId")}/bent-mono@${protectedConfig("githubRepositoryId")}`;
export const trustEnvironments = { development: { role: "aws_iam_role.ci", name: "forever-tee-video-development-ci", environment: "Preview", workflow: "native-ci-identity.yml", job: "proof", step: "Verify signed Preview identity without AWS access", inline: "development-state-and-inspection" },
    production: { role: "aws_iam_role.production_ci", name: "forever-tee-video-production-ci", environment: "Production", workflow: "native-production-identity.yml", job: "identity", step: "Verify signed Production identity without AWS access or deployment", inline: "production-foundation" } };
export function freshTime(value, now) {
    const time = Date.parse(value);
    trustCheck(Number.isFinite(time) && time <= now && now - time <= 30 * 60 * 1000, "fresh evidence within 30 minutes required.");
}
export async function verifyTrustGitHub(github, baseline, stage, now = Date.now()) {
    const read = path => github.trustRead(path), base = "/repos/bentbrain/bent-mono";
    const repo = await read(base);
    trustCheck(repo.id === Number(protectedConfig("githubRepositoryId")) && repo.owner?.id === Number(protectedConfig("githubOwnerId")) && repo.full_name === "bentbrain/bent-mono", "immutable repository identity.");
    const old = await read(`/repos/${protectedConfig("trustOriginalRepository")}`);
    trustCheck(old.id === baseline.original.repositoryId && old.owner?.id === Number(protectedConfig("githubOwnerId")) && old.full_name === protectedConfig("trustOriginalRepository"), "original repository receipt identity.");
    const quality = await requireReleaseChecks(baseline.sourceCommit, read);
    const oidc = await read(`${base}/actions/oidc/customization/sub`);
    trustCheck(oidc.use_default === true && oidc.use_immutable_subject === true && oidc.sub_claim_prefix === targetPrefix(), "exact immutable OIDC default.");
    for (const spec of Object.values(trustEnvironments)) {
        const environment = await read(`${base}/environments/${spec.environment}`);
        const rules = await read(`${base}/environments/${spec.environment}/deployment-branch-policies`);
        trustCheck(equal(environment.deployment_branch_policy, { protected_branches: false, custom_branch_policies: true }) &&
            rules.total_count === 1 && rules.branch_policies?.length === 1 && rules.branch_policies[0].name === "main" && rules.branch_policies[0].type === "branch", "main-only protected environments.");
    }
    // Concurrency groups do not coordinate repositories. A reviewed window must
    // freeze admissions in BOTH repositories; re-read all unfinished runs too.
    freshTime(baseline.window.observedAt, now);
    trustCheck(baseline.window.exclusive === true && baseline.window.admissionsFrozen === true &&
        equal(baseline.window.repositoryIds, [old.id, repo.id]) && Date.parse(baseline.window.expiresAt) > now, "reviewed exclusive two-repository operation window.");
    for (const name of [old.full_name, repo.full_name]) {
        for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
            const runs = await read(`/repos/${name}/actions/runs?status=${status}&per_page=100`);
            trustCheck(runs.total_count === 0 && runs.workflow_runs?.length === 0, "both repositories must be quiescent.");
        }
    }
    const proofs = {};
    for (const [key, spec] of Object.entries(trustEnvironments)) {
        const id = baseline.proofRuns[key];
        trustCheck(Number.isSafeInteger(id) && id > 0, "explicit fresh proof run IDs required.");
        const run = await read(`${base}/actions/runs/${id}`);
        const workflow = await read(`${base}/actions/workflows/${spec.workflow}`);
        trustCheck(workflow.path === `.github/workflows/${spec.workflow}` && workflow.state === "active" && run.workflow_id === workflow.id &&
            run.head_sha === baseline.sourceCommit && run.head_branch === "main" && run.run_attempt === 1 && run.event === "workflow_dispatch" &&
            run.path === workflow.path && run.status === "completed" && run.conclusion === "success" &&
            run.repository?.id === repo.id && run.head_repository?.id === repo.id, "successful exact-source first-attempt canonical proof run.");
        freshTime(run.created_at, now);
        const jobs = await read(`${base}/actions/runs/${id}/attempts/1/jobs?per_page=100`);
        trustCheck(jobs.total_count === jobs.jobs?.length && jobs.jobs.length < 100, "complete job evidence.");
        const matches = jobs.jobs.filter(job => job.name === spec.job);
        trustCheck(matches.length === 1, "one canonical proof job required.");
        const job = matches[0], steps = job.steps?.filter(step => step.name === spec.step);
        trustCheck(job.head_sha === baseline.sourceCommit && job.status === "completed" && job.conclusion === "success" &&
            steps?.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success", "successful exact proof job and step.");
        const log = await github.jobLog(job.id);
        const records = log.split("\n").filter(line => line.includes('"signatureVerified":true')).map(line => JSON.parse(line.slice(line.indexOf("{"))));
        trustCheck(records.length === 1, "one bounded verified signed-claim receipt required.");
        const receipt = records[0];
        for (const [field, expected] of Object.entries({ signatureVerified: true, issuer: "https://token.actions.githubusercontent.com", audience: "sts.amazonaws.com",
            subject: `${targetPrefix()}:environment:${spec.environment}`, repositoryId: String(repo.id), ownerId: String(repo.owner.id),
            environment: spec.environment, ref: "refs/heads/main", sourceCommit: baseline.sourceCommit, runId: String(id), runAttempt: "1",
            workflowRef: `bentbrain/bent-mono/${workflow.path}@refs/heads/main`, awsAccessAttempted: false }))
            trustCheck(receipt[field] === expected, "fresh exact signed target claims required.");
        proofs[key] = { run: id, job: job.id, receipt };
        const finalRun = await read(`${base}/actions/runs/${id}`);
        trustCheck(equal(finalRun, run), "proof changed during inspection.");
    }
    if (stage === "production") {
        // This is a separate, hash-approved receipt from the established paired
        // lane. Do not manufacture release readiness from an identity success.
        const readiness = baseline.developmentReadiness;
        trustCheck(readiness?.sourceCommit === baseline.sourceCommit && readiness.qualified === true && readiness.rollbackVerified === true &&
            /^[a-f0-9]{64}$/.test(readiness.qualificationReceiptSha256 ?? "") && /^[a-f0-9]{64}$/.test(readiness.rollbackReceiptSha256 ?? ""), "fresh independently reviewed Development qualification and rollback receipts required.");
        freshTime(readiness.verifiedAt, now);
        for (const id of [readiness.qualificationRunId, readiness.rollbackRunId]) {
            trustCheck(Number.isSafeInteger(id) && id > 0, "explicit readiness run IDs.");
            const run = await read(`${base}/actions/runs/${id}`);
            trustCheck(run.head_sha === baseline.sourceCommit && run.head_branch === "main" && run.run_attempt === 1 && run.conclusion === "success" &&
                run.status === "completed" && run.repository?.id === repo.id && run.head_repository?.id === repo.id &&
                run.id === id && run.event === "workflow_dispatch" && run.path === ".github/workflows/native-development.yml", "fresh paired Development qualification/rollback run.");
            freshTime(run.updated_at, now);
        }
    }
    return { quality, proofs };
}
