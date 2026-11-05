import { resolveProtectedTemplate } from "./protected-config.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changedComponents, deploymentPlan, gitChanges, previousRelease, webOnlyPreviewPlan, } from "./deployment-plan.mjs";
import { githubApi } from "./github-actions.mjs";
import { reuseCi, selectCiRun } from "./reuse-ci.mjs";
const repository = "owner/shop";
const sha = "a".repeat(40);
const base = "b".repeat(40);
const context = { sha, repository, branch: "main" };
const successfulCi = {
    id: 42, head_sha: sha, head_branch: "main", head_repository: { full_name: repository },
    event: "push", path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", run_attempt: 2,
};
const all = { web: true, api: true, renderer: true, lambda: true };
test("repository checks run Knip before Turbo schedules validation and builds together", () => {
    const manifest = JSON.parse(resolveProtectedTemplate(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    assert.equal(manifest.scripts["shop:check"], "bun run knip && bun run test:pipeline && node scripts/task-runtime.mjs run test lint typecheck types:check build --summarize");
});
test("required CI runs for ready pull requests without repeating after merge", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    assert.match(workflow, /types: \[opened, reopened, synchronize, ready_for_review\]/);
    assert.match(workflow, /if: github\.event\.pull_request\.draft == false/);
    assert.doesNotMatch(workflow, /^  push:/m);
    assert.doesNotMatch(workflow, /TURBO_TOKEN|TURBO_TEAM/);
});
test("PR task caches stay in GitHub's merge-ref scope and only main receives remote credentials", () => {
    const action = readFileSync(new URL("../.github/actions/check/action.yml", import.meta.url), "utf8");
    assert.match(action, /uses: actions\/cache\/restore@/);
    assert.match(action, /uses: actions\/cache\/save@/);
    assert.match(action, /if: \(github\.ref == 'refs\/heads\/main' \|\| github\.event_name == 'pull_request'\) && steps\.checks-cache\.outputs\.cache-hit != 'true'/);
    assert.doesNotMatch(action, /pull_request_target/);
    for (const path of ["deploy.yml", "web-production.yml", "native-development.yml"]) {
        const workflow = readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8");
        assert.match(workflow, /TURBO_TOKEN: \$\{\{ github\.ref == 'refs\/heads\/main'/, path);
        assert.match(workflow, /TURBO_TEAM: \$\{\{ github\.ref == 'refs\/heads\/main'/, path);
    }
});
test("retired performance work cannot start native cloud workflows on push", () => {
    for (const path of ["native-development.yml", "native-ci-identity.yml"]) {
        const workflow = readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8");
        assert.doesNotMatch(workflow, /^  push:/m, path);
        assert.doesNotMatch(workflow, /perf\/story-video-family-experiments/, path);
    }
});
test("native renderer changes explicitly require a Lambda release", () => {
    for (const path of ["workers/video-renderer/aws-lambda/app-handler.mjs", "workers/video-renderer/src/renderer.mjs",
        "infra/story-video-lambda/main.tf", "apps/web/public/mockups/tote.png"]) {
        assert.equal(changedComponents([path]).lambda, true, path);
    }
});
test("component selection covers independent services and shared mockup assets", () => {
    assert.deepEqual(changedComponents(["apps/web/src/page.tsx"]), { web: true, api: false, renderer: false, lambda: false });
    assert.deepEqual(changedComponents(["workers/api/migrations/0012.sql"]), { web: false, api: true, renderer: false, lambda: false });
    assert.deepEqual(changedComponents(["workers/video-renderer/src/server.mjs"]), { web: false, api: false, renderer: true, lambda: true });
    assert.deepEqual(changedComponents(["apps/web/public/mockups/tote.png"]), { web: true, api: false, renderer: true, lambda: true });
    assert.deepEqual(changedComponents(["apps/web/src/page.tsx", "workers/api/src/index.ts"]), { web: true, api: true, renderer: false, lambda: false });
});
test("shared dependencies and unknown files force all components; documentation does not", () => {
    for (const path of ["packages/contracts/package.json", "bun.lock", "turbo.json", ".github/workflows/deploy.yml", "scripts/deployment-plan.mjs", "new-service/file.ts"]) {
        assert.deepEqual(changedComponents([path]), all, path);
    }
    assert.deepEqual(changedComponents(["docs/operations.md", "README.md", "AGENTS.md"]), { web: false, api: false, renderer: false, lambda: false });
    assert.deepEqual(changedComponents([]), { web: false, api: false, renderer: false, lambda: false });
});
test("Shopify Production cutover rotates only Shopify Worker secrets before the web deploy", () => {
    const workflow = readFileSync(new URL("../.github/workflows/shopify-production-cutover.yml", import.meta.url), "utf8");
    const pause = workflow.indexOf("pause-sales");
    const secrets = workflow.indexOf("wrangler secret bulk --env production");
    const catalogue = workflow.indexOf("refresh-catalogue");
    const mapping = workflow.indexOf("refresh-variant-mapping");
    const deploy = workflow.indexOf("vercel@59.5.0 deploy");
    assert.ok(pause > 0);
    assert.ok(secrets > pause);
    assert.ok(catalogue > secrets);
    assert.ok(mapping > catalogue);
    assert.ok(deploy > mapping);
    for (const name of [
        "SHOPIFY_ADMIN_STORE_DOMAIN",
        "SHOPIFY_CLIENT_ID",
        "SHOPIFY_CLIENT_SECRET",
    ]) {
        assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ secrets\\.${name} \\}\\}`));
    }
    assert.doesNotMatch(workflow, /wrangler deploy|native-release|video-renderer|terraform/i);
});
test("web-only Production stages only Vercel and shares the Production release lock", () => {
    const workflow = readFileSync(new URL("../.github/workflows/web-production.yml", import.meta.url), "utf8");
    assert.match(workflow, /group: deploy-production/);
    assert.match(workflow, /environment: Production/);
    assert.match(workflow, /node scripts\/reuse-ci\.mjs/);
    assert.match(workflow, /node scripts\/web-production-release\.mjs/);
    const install = workflow.indexOf("bun install --frozen-lockfile");
    const release = workflow.indexOf("node scripts/web-production-release.mjs");
    assert.ok(install >= 0 && install < release);
    assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
    assert.doesNotMatch(workflow, /wrangler|aws-actions|CLOUDFLARE|video-renderer|terraform|workers\/api/);
});
test("web-only Preview accepts feature-branch web changes and its reviewed controls", () => {
    const plan = webOnlyPreviewPlan({
        base,
        environment: "development",
        forceFull: false,
        paths: [
            "apps/web/src/components/route-skeletons.tsx",
            ".github/workflows/deploy.yml",
            "scripts/deployment-plan.mjs",
            "scripts/pipeline.test.mjs",
        ],
        ref: "refs/heads/skeleton-layout-shift",
    });
    assert.deepEqual({
        web: plan.web,
        api: plan.api,
        renderer: plan.renderer,
        lambda: plan.lambda,
    }, { web: true, api: false, renderer: false, lambda: false });
});
test("web-only Preview can refresh the stable Development alias from current main", () => {
    const plan = webOnlyPreviewPlan({
        base,
        environment: "development",
        forceFull: false,
        paths: [],
        ref: "refs/heads/refresh-development-storefront",
    });
    assert.deepEqual({
        web: plan.web,
        api: plan.api,
        renderer: plan.renderer,
        lambda: plan.lambda,
    }, { web: true, api: false, renderer: false, lambda: false });
});
test("web-only Preview rejects unsafe environments, refs and paths", () => {
    const fixture = {
        base,
        environment: "development",
        forceFull: false,
        paths: ["apps/web/src/page.tsx"],
        ref: "refs/heads/feature",
    };
    assert.throws(() => webOnlyPreviewPlan({ ...fixture, environment: "production" }), /require Development/);
    assert.throws(() => webOnlyPreviewPlan({ ...fixture, forceFull: true }), /cannot be combined/);
    assert.throws(() => webOnlyPreviewPlan({ ...fixture, ref: "refs/heads/main" }), /exact current main source/);
    for (const path of [
        "apps/web/public/mockups/tote.png",
        "workers/api/src/index.ts",
        "packages/contracts/src/index.ts",
        "bun.lock",
    ]) {
        assert.throws(() => webOnlyPreviewPlan({ ...fixture, paths: [path] }), new RegExp(path.replaceAll("/", "\\/")));
    }
});
function releaseFixture({ state = "success", run = {}, previous = true, status = {} } = {}) {
    const calls = [];
    const api = async (path) => {
        calls.push(path);
        if (path === "deployments?environment=Production&task=deploy&per_page=100") {
            return [
                { id: 10, environment: "Production", task: "deploy", sha },
                ...(previous ? [{ id: 9, environment: "Production", task: "deploy", sha: base }] : []),
            ];
        }
        if (path === "deployments/10/statuses?per_page=1") {
            return [{ state: "in_progress", log_url: `https://github.com/${repository}/actions/runs/100/job/200` }];
        }
        if (path === "deployments/9/statuses?per_page=1") {
            return [{ state, log_url: `https://github.com/${repository}/actions/runs/90/job/190`, ...status }];
        }
        if (path === "actions/runs/90") {
            return { path: ".github/workflows/deploy.yml", event: "workflow_dispatch", conclusion: "success", head_sha: base, ...run };
        }
        throw new Error(`Unexpected API call: ${path}`);
    };
    return { api, calls, environment: "Production", repository, runId: "100" };
}
test("baseline excludes the current environment job and uses its successful predecessor", async () => {
    assert.equal(await previousRelease(releaseFixture()), base);
    assert.equal(await previousRelease(releaseFixture({ previous: false })), undefined);
});
test("a failed or interrupted predecessor cannot be replaced with an older successful release", async () => {
    for (const state of ["failure", "error", "in_progress", "queued", "pending", "inactive"]) {
        const fixture = releaseFixture({ state });
        assert.equal(await previousRelease(fixture), undefined);
        assert.equal(fixture.calls.some((path) => path === "actions/runs/90"), false);
    }
});
test("an unknown release or missing status cannot establish a baseline", async () => {
    for (const run of [
        { path: ".github/workflows/other.yml" }, { head_sha: sha },
        { event: "push" }, { conclusion: "failure" },
    ]) {
        assert.equal(await previousRelease(releaseFixture({ run })), undefined);
    }
    assert.equal(await previousRelease(releaseFixture({ status: { log_url: "https://vercel.com/a-deployment" } })), undefined);
});
test("release plans compare the entire undeployed range and support forced recovery", async () => {
    const plan = await deploymentPlan({ ...releaseFixture(), sha, changes: (from, to) => {
            assert.equal(from, base);
            assert.equal(to, sha);
            return ["apps/web/src/page.tsx", "workers/api/src/index.ts"];
        } });
    assert.deepEqual({ web: plan.web, api: plan.api, renderer: plan.renderer }, { web: true, api: true, renderer: false });
    for (const options of [
        { forceFull: true, api: () => assert.fail("Forced deployment should not need history") },
        { ...releaseFixture({ state: "failure" }) },
        { ...releaseFixture(), changes: () => undefined },
    ]) {
        const result = await deploymentPlan({ sha, ...options });
        assert.deepEqual({ web: result.web, api: result.api, renderer: result.renderer, lambda: result.lambda }, all);
    }
});
test("baseline lookup is environment-specific and API failures block deployment", async () => {
    await previousRelease({ environment: "Preview", api: async (path) => {
            assert.equal(path, "deployments?environment=Preview&task=deploy&per_page=100");
            return [];
        } });
    await assert.rejects(deploymentPlan({ api: async () => { throw new Error("API unavailable"); } }), /API unavailable/);
});
test("git comparison includes older undeployed changes, deletions and cross-component moves", (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "release-plan-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Pipeline test");
    mkdirSync(join(cwd, "workers/api/src"), { recursive: true });
    mkdirSync(join(cwd, "apps/web/src"), { recursive: true });
    writeFileSync(join(cwd, "workers/api/src/move.ts"), "export const example = 1;\n");
    git("add", "workers/api/src/move.ts");
    git("commit", "-m", "Initial release");
    const released = git("rev-parse", "HEAD");
    git("mv", "workers/api/src/move.ts", "apps/web/src/move.ts");
    git("commit", "-m", "Move module");
    writeFileSync(join(cwd, "README.md"), "Documentation\n");
    git("add", "README.md");
    git("commit", "-m", "Update documentation");
    const current = git("rev-parse", "HEAD");
    const paths = gitChanges(released, current, cwd);
    assert.deepEqual(changedComponents(paths), { web: true, api: true, renderer: false, lambda: false });
    assert.equal(gitChanges(current, released, cwd), undefined);
    assert.equal(gitChanges("--help", current, cwd), undefined);
    assert.equal(gitChanges("0".repeat(40), current, cwd), undefined);
});
test("only the latest exact-SHA CI from this repository and branch is reusable", () => {
    for (const override of [
        { head_sha: base }, { head_branch: "feature" }, { event: "workflow_dispatch" },
        { head_repository: { full_name: "fork/shop" } }, { path: ".github/workflows/other.yml" },
    ]) {
        assert.equal(selectCiRun([{ ...successfulCi, ...override }], context), undefined);
    }
    assert.equal(selectCiRun([{ ...successfulCi, event: "pull_request" }], context)?.id, 42);
    const failure = { ...successfulCi, id: 43, conclusion: "failure" };
    assert.equal(selectCiRun([successfulCi, failure], context), failure);
    const skipped = { ...successfulCi, id: 44, conclusion: "skipped" };
    assert.equal(selectCiRun([successfulCi, skipped], context), successfulCi);
    assert.equal(selectCiRun([skipped], context), undefined);
});
test("successful CI is reused only after checking the latest attempt's check job", async () => {
    const runId = await reuseCi({ ...context, api: async (path) => {
            if (path.startsWith("actions/workflows/ci.yml/runs?"))
                return { workflow_runs: [successfulCi] };
            assert.equal(path, "actions/runs/42/attempts/2/jobs?per_page=100");
            return { jobs: [{ name: "check", conclusion: "success" }] };
        } });
    assert.equal(runId, 42);
    await assert.rejects(reuseCi({ ...context, api: async (path) => path.includes("/jobs?")
            ? { jobs: [{ name: "check", conclusion: "skipped" }] }
            : { workflow_runs: [successfulCi] } }), /no successful check job/);
});
test("running CI is awaited rather than duplicated", async () => {
    let polls = 0;
    let sleeps = 0;
    const runId = await reuseCi({ ...context,
        api: async (path) => {
            if (path.includes("/jobs?"))
                return { jobs: [{ name: "check", conclusion: "success" }] };
            polls += 1;
            return { workflow_runs: [{ ...successfulCi, status: polls === 1 ? "in_progress" : "completed" }] };
        },
        sleep: async () => { sleeps += 1; },
    });
    assert.equal(runId, 42);
    assert.equal(sleeps, 1);
});
test("missing CI falls back to checks; failed, cancelled and timed-out CI block release", async () => {
    assert.equal(await reuseCi({ ...context, api: async () => ({ workflow_runs: [] }) }), undefined);
    assert.equal(await reuseCi({ ...context,
        api: async () => ({ workflow_runs: [{ ...successfulCi, conclusion: "skipped" }] }),
    }), undefined);
    for (const conclusion of ["failure", "cancelled", "timed_out", "neutral"]) {
        await assert.rejects(reuseCi({ ...context,
            api: async () => ({ workflow_runs: [{ ...successfulCi, conclusion }] }),
        }), /Release blocked/);
    }
    await assert.rejects(reuseCi({ ...context, timeoutMs: 0, now: () => 1,
        api: async () => ({ workflow_runs: [{ ...successfulCi, status: "in_progress" }] }),
    }), /Timed out/);
});
test("GitHub HTTP errors are fatal and do not expose token or response content", async () => {
    const api = githubApi({ token: "private-token", repository,
        fetcher: async () => new Response("sensitive response", { status: 403 }),
    });
    await assert.rejects(api("deployments"), { message: "GitHub deployments returned HTTP 403." });
});
test("changing release SHAs invalidates only the web build, not tests or unrelated builds", () => {
    const dryRun = (releaseSha) => JSON.parse(execFileSync("bun", [
        "run", "turbo", "run", "test", "lint", "typecheck", "types:check", "build", "--dry=json",
    ], {
        cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...process.env,
            GITHUB_SHA: releaseSha,
            TURBO_TEAM: "",
            TURBO_TOKEN: "",
            VERCEL_GIT_COMMIT_SHA: releaseSha,
        },
    }));
    const first = dryRun(sha);
    const second = dryRun(base);
    for (const task of first.tasks) {
        const changed = second.tasks.find((other) => other.taskId === task.taskId);
        assert.equal(task.hash === changed.hash, task.taskId !== "@forever-tee/web#build", task.taskId);
    }
});
