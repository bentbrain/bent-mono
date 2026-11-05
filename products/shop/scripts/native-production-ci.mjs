import { protectedConfig } from "./protected-config.mjs";
import { promotionInput } from "./release-promotion-input.mjs";
import { promotionManifest } from "./release-manifest.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const check = (value, reason) => { if (!value)
    throw new Error(`Production CI stopped: ${reason}`); };
const PRODUCTION_EVIDENCE_RUNS = new Set([
    promotionManifest.candidate.buildRunId, promotionManifest.qualification.runId, promotionManifest.alertDelivery.runId,
    Number(protectedConfig("resource_ba4d5598a02e")),
    Number(protectedConfig("resource_8d0190ecec7d")),
    Number(protectedConfig("resource_bfc0dfa5a249")),
    Number(protectedConfig("resource_6e1c2913f165")),
    Number(protectedConfig("resource_978ace9f2b86")),
    Number(protectedConfig("resource_8c8b4f5fea88")),
    Number(protectedConfig("resource_e29131b01bc1")),
    Number(protectedConfig("resource_66a926536d4a")),
    Number(protectedConfig("resource_616af7025011")),
    Number(protectedConfig("resource_7acc6e376e5e")),
    Number(protectedConfig("resource_272ed9489471")),
    Number(protectedConfig("resource_722b7b82552b")),
    Number(protectedConfig("resource_902fcbdf18c6")),
]);
export function assertProductionContext(env) {
    const mode = env.NATIVE_RELEASE_MODE ?? "full";
    check(["full", "api"].includes(mode) && (mode !== "api" || ["release", "promote"].includes(env.NATIVE_OPERATION)), "API-only mode requires release or promote.");
    check(env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "bentbrain/bent-mono" && env.GITHUB_REPOSITORY_ID === protectedConfig("githubRepositoryId") &&
        env.GITHUB_REPOSITORY_OWNER_ID === protectedConfig("githubOwnerId") && env.GITHUB_REF === "refs/heads/main" &&
        env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        env.GITHUB_RUN_ATTEMPT === "1" && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") && /^[1-9][0-9]+$/.test(env.GITHUB_RUN_ID ?? "") &&
        env.GITHUB_WORKFLOW_REF === "bentbrain/bent-mono/.github/workflows/native-production.yml@refs/heads/main", "exact main-only first-attempt personal workflow.");
    check(["verify-candidate", "inspect-image-plan", "prepare-runtime", "prepare-worker", "prepare-monitor", "monitor", "release", "promote", "rollback", "canary", "release-storefront", "inspect-release", "recover-release", "recover-rehearsal", "recover-canary", "repair-featured-videos", "sweep-products"].includes(env.NATIVE_OPERATION), "unknown Production operation.");
}
export async function productionAWS(env, run = execute) {
    assertProductionContext(env);
    check(env.AWS_REGION === "ap-southeast-2" && env.AWS_DEFAULT_REGION === "ap-southeast-2" &&
        [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN].every(value => typeof value === "string" && value.length > 0), "explicit temporary Sydney credentials.");
    const child = { PATH: "/usr/local/bin:/usr/bin:/bin", AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: env.AWS_SESSION_TOKEN, AWS_REGION: "ap-southeast-2", AWS_DEFAULT_REGION: "ap-southeast-2", AWS_CONFIG_FILE: "/dev/null",
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null", BOTO_CONFIG: "/dev/null", AWS_EC2_METADATA_DISABLED: "true", AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: "true",
        AWS_MAX_ATTEMPTS: "1", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" };
    const call = async (args) => {
        try {
            const result = await run("aws", [...args, "--region", "ap-southeast-2", "--output", "json", "--no-cli-pager"], { env: child, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
            return result.stdout.trim() ? JSON.parse(result.stdout) : {};
        }
        catch (error) {
            const code = typeof error.stderr === "string" ? /\(([A-Za-z0-9.]+)\) when calling the [A-Za-z0-9]+ operation/.exec(error.stderr)?.[1] : undefined;
            throw Object.assign(new Error("Scoped Production AWS request failed; private output was not logged."), { code });
        }
    };
    const identity = await call(["sts", "get-caller-identity"]);
    check(identity.Account === protectedConfig("awsAccountId") && identity.Arn === "arn:aws:sts::" + protectedConfig("awsAccountId") + ":assumed-role/forever-tee-video-production-ci/native-production-" + (env.GITHUB_RUN_ID), "exact Production CI role/session, never Development or personal SSO.");
    return { call, child };
}
export async function readProductionEvidenceRun(env, runId, request = fetch) {
    assertProductionContext(env);
    const input = promotionInput(env), selected = input?.manifest;
    const pinned = PRODUCTION_EVIDENCE_RUNS.has(runId) || (selected && [selected.candidate.buildRunId, selected.qualification.runId, input.acceptance?.previewRunId].includes(runId));
    check(pinned && typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0, "fixed original evidence run.");
    const response = await request(`https://api.github.com/repos/bentbrain/bent-mono/actions/runs/${runId}`, {
        redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    check(response.ok, "original evidence request failed.");
    const run = await response.json();
    check(run.id === runId && run.status === "completed" && run.conclusion === "success" && run.run_attempt === 1 && run.event === "workflow_dispatch" &&
        run.repository?.id === Number(protectedConfig("githubRepositoryId")) && run.head_repository?.id === Number(protectedConfig("githubRepositoryId")) && run.repository.owner?.id === Number(protectedConfig("githubOwnerId")), "successful first-attempt personal evidence run.");
    return run;
}
