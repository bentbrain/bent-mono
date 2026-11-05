import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requireShopReleaseChecks } from "./require-shop-release-checks.mjs";

const repository = "bentbrain/bent-mono";
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function apiFixture({ base, source, failure, branch = "preview/storefront" }) {
  let mainReads = 0, branchReads = 0, environmentReads = 0;
  const repo = "bentbrain/bent-mono", head = "b".repeat(40);
  const workflow = { id: 12, path: ".github/workflows/quality.yml", state: "active" };
  const run = { id: 23, head_sha: base, head_branch: "main", event: "push", path: workflow.path,
    workflow_id: 12, repository: { full_name: repo }, head_repository: { full_name: repo },
    status: "completed", conclusion: "success", run_attempt: 2 };
  const branchRun = { ...run, id: 24, head_sha: source, head_branch: branch, event: "pull_request" };
  return async path => {
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: failure === "main-race" && ++mainReads === 4 ? head : base } };
    if (path.includes("/branches/")) return { commit: { sha: failure === "branch-race" && ++branchReads > 1 ? head : source }, protected: failure !== "unprotected" };
    if (path.endsWith("/environments/Preview")) return { deployment_branch_policy:
      failure === "protected-only" || failure === "unprotected" ? { custom_branch_policies: false, protected_branches: true } :
      failure === "no-policy" ? null : { custom_branch_policies: true, protected_branches: false } };
    if (path.includes("/deployment-branch-policies?")) return { branch_policies: [
      { type: failure === "tag-policy" ? "tag" : "branch", name: failure === "environment-denied" || failure === "policy-race" && ++environmentReads > 1 ? "main" : branch },
    ] };
    if (path.endsWith("/workflows/quality.yml")) return workflow;
    if (path.includes("/workflows/12/runs?")) return { workflow_runs: path.includes("event=pull_request") ? [
      failure === "branch-workflow" ? { ...branchRun, path: ".github/workflows/foreign.yml" } :
      failure === "branch-latest-failed" ? { ...branchRun, conclusion: "failure" } : branchRun,
    ] : [run] };
    if (path.includes("/attempts/2/jobs?")) return { jobs:
      ["lint", "typecheck", "test", "knip", "build", "test:integration", "browser", "shop", "public-source", "secret-scan", "dependencies", "CodeQL", "Release qualification"].map(name =>
        ({ name, head_sha: path.includes("/runs/24/") ? source : base, status: "completed", conclusion:
          (failure === "quality-failed" || failure === "branch-quality-failed" && path.includes("/runs/24/")) && name === "CodeQL" ? "failure" : "success" })) };
    if (path.includes("/pulls?")) {
      if (path.includes(`/commits/${source}/`)) return failure === "no-pr" ? [] : [{ number: 3, state: "open", merged_at: null,
        base: { sha: failure === "stale-pr-base" ? head : base, ref: "main", repo: { full_name: repo } },
        head: { sha: source, ref: branch, repo: { full_name: failure === "fork-pr" ? "fork/repo" : repo } } }];
      return [{ number: 2, merged_at: "2026-11-05T00:00:00Z", merge_commit_sha: base,
        base: { ref: "main", repo: { full_name: repo } }, head: { sha: head, repo: { full_name: repo } } }];
    }
    if (path.includes("/check-runs?")) {
      const branchHead = path.includes(`/commits/${source}/`);
      return { check_runs: [{ name: "CodeQL", app: { slug: branchHead && failure === "wrong-security-publisher" ? "github-actions" : "github-advanced-security" },
        head_sha: branchHead ? source : head, status: "completed", conclusion: "success" }] };
    }
    if (path.includes("/statuses?")) {
      const branchHead = path.includes(`/commits/${source}/`);
      return [{ context: "Independent review", state: branchHead && failure === "branch-review-pending" ? "pending" : "success",
        target_url: `https://github.com/${repo}/pull/${branchHead && failure !== "wrong-review-pr" ? 3 : 2}#issuecomment-123` }];
    }
    if (path.endsWith("/actions/runs/23")) return run;
    if (path.endsWith("/actions/runs/24")) return failure === "branch-run-race" ? { ...branchRun, run_attempt: 3 } : branchRun;
    throw new Error("Unexpected admission API request: " + path);
  };
}

async function fixture(t, paths = ["products/shop/apps/web/src/app/page.tsx"]) {
  const directory = await mkdtemp(join(tmpdir(), "shop-branch-admission-")), root = join(directory, "repo");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(root, "products/shop"), { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "synthetic@example.invalid"); git(root, "config", "user.name", "Synthetic fixture");
  await writeFile(join(root, "README.md"), "Synthetic admission fixture\n");
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "Synthetic main");
  const base = git(root, "rev-parse", "HEAD"), branch = "preview/storefront";
  git(root, "checkout", "--quiet", "-b", branch);
  for (const path of paths) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), "Synthetic storefront change\n"); }
  git(root, "add", "."); git(root, "commit", "--quiet", "-m", "Synthetic preview");
  const source = git(root, "rev-parse", "HEAD");
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repository, GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_SHA: source, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/deploy.yml@refs/heads/${branch}` };
  const event = { repository: { full_name: repository }, ref: `refs/heads/${branch}`,
    inputs: { environment: "development", web_only_preview: "true", force_full: "false", expected_source: "", coordination_id: "" } };
  return { directory, root, base, source, branch, env, event, args: { sha: source, root, env, event, api: apiFixture({ base, source, branch }) } };
}

test("the actual workflow admission command accepts an eligible exact branch through its CLI", async t => {
  const f = await fixture(t);
  const workflow = await readFile(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  const commands = [...workflow.matchAll(/      - name: (?:Require authoritative (?:exact-main monorepo quality|storefront release admission)|Recheck authoritative storefront release admission)\n(?:        if: .+\n)?        run: (.+)/g)].map(match => match[1]);
  assert.equal(commands.length, 4);
  for (const command of commands) {
    const match = /^node (\.\.\/\.\.\/scripts\/[\w-]+\.mjs) --sha "\$GITHUB_SHA"$/.exec(command);
    assert.ok(match, "admission must use an explicit source-bound CLI");
    const gate = resolve(repoRoot, "products/shop", match[1]);
    const mock = join(f.directory, "fetch.mjs"), eventPath = join(f.directory, "event.json");
    await writeFile(eventPath, JSON.stringify(f.event));
    await writeFile(mock, `const api = (${apiFixture.toString()})(${JSON.stringify({ base: f.base, source: f.source })});
      globalThis.fetch = async url => { const u = new URL(url); return Response.json(await api(u.pathname + u.search)); };`);
    const output = execFileSync(process.execPath, ["--import", mock, gate, "--sha", f.source], {
      cwd: join(f.root, "products/shop"), encoding: "utf8", timeout: 20_000,
      env: { ...process.env, ...f.env, NODE_OPTIONS: "", GH_TOKEN: "synthetic-token", GITHUB_EVENT_PATH: eventPath }, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.deepEqual(JSON.parse(output), { sha: f.source, base: f.base, lane: "web-only-preview", qualityRunId: 23, qualityAttempt: 2, pullRequest: 2,
      branchQualityRunId: 24, branchQualityAttempt: 2, branchPullRequest: 3 });
  }
  assert.match(workflow.split("  e2e:\n")[1], /fetch-depth: 0/);
  for (const name of ["validate", "deploy", "e2e"]) {
    const block = workflow.split(`  ${name}:\n`)[1].split(/^  \w+:$/m)[0];
    const permissions = block.split("    permissions:\n")[1].split(/^    \S/m)[0];
    for (const scope of ["contents", "actions", "checks", "statuses", "pull-requests"]) {
      assert.ok(permissions.includes(`      ${scope}: read\n`), `${name} needs ${scope} access for authoritative admission`);
    }
  }
  assert.match(workflow, /- name: Reuse CI for the exact release commit\n        if: github.ref == 'refs\/heads\/main'/);
});

test("branch admission preserves Production main authority and exact dispatch identity", async t => {
  const f = await fixture(t);
  assert.equal((await requireShopReleaseChecks({ ...f.args, event: { ...f.event, ref: f.branch } })).sha, f.source);
  for (const change of [
    x => { x.event.inputs.environment = "production"; }, x => { x.event.inputs.web_only_preview = "false"; },
    x => { x.event.inputs.force_full = "true"; }, x => { x.env.GITHUB_SHA = f.base; },
    x => { x.event.ref = "other"; }, x => { x.env.GITHUB_EVENT_NAME = "push"; },
    x => { x.event.ref = `refs/tags/${f.branch}`; },
    x => { x.event.repository.full_name = "fork/repo"; }, x => { x.env.GITHUB_REPOSITORY = "fork/repo"; },
    x => { x.env.GITHUB_WORKFLOW_REF = `${repository}/.github/workflows/other.yml@${f.env.GITHUB_REF}`; },
    x => { x.event.inputs.expected_source = f.source; }, x => { x.event.inputs.coordination_id = "release-correlation"; },
  ]) {
    const args = { ...f.args, env: structuredClone(f.env), event: structuredClone(f.event) }; change(args);
    await assert.rejects(requireShopReleaseChecks(args), /Branch releases require/);
  }
  const args = { ...f.args, env: { ...f.env, GITHUB_REF: "refs/heads/main" }, event: { ...f.event, ref: "main" } };
  await assert.rejects(requireShopReleaseChecks(args), /no longer current main/);
});

test("main Shop admission retains every production quality, merged review and security check", async t => {
  const f = await fixture(t); git(f.root, "checkout", "--quiet", "main");
  const args = { ...f.args, sha: f.base, env: { ...f.env, GITHUB_REF: "refs/heads/main", GITHUB_SHA: f.base }, event: { ref: "main" } };
  assert.equal((await requireShopReleaseChecks(args)).sha, f.base);
  await assert.rejects(requireShopReleaseChecks({ ...args, api: apiFixture({ ...f, failure: "quality-failed" }) }), /unsuccessful: CodeQL/);
});

test("Preview requires qualified current main, permitted environment and stable exact branch", async t => {
  const f = await fixture(t);
  for (const failure of ["environment-denied", "tag-policy", "unprotected", "quality-failed", "branch-race", "policy-race", "main-race"]) {
    await assert.rejects(requireShopReleaseChecks({ ...f.args, api: apiFixture({ ...f, failure }) }), undefined, failure);
  }
  for (const failure of ["protected-only", "no-policy"]) {
    assert.equal((await requireShopReleaseChecks({ ...f.args, api: apiFixture({ ...f, failure }) })).sha, f.source);
  }
  const changedSource = apiFixture({ ...f, source: "c".repeat(40) });
  await assert.rejects(requireShopReleaseChecks({ ...f.args, api: changedSource }), /no longer points/);
  git(f.root, "checkout", "--quiet", "main"); await writeFile(join(f.root, "README.md"), "New canonical main\n");
  git(f.root, "commit", "--quiet", "-am", "Advance main"); const base = git(f.root, "rev-parse", "HEAD"); git(f.root, "checkout", "--quiet", f.branch);
  await assert.rejects(requireShopReleaseChecks({ ...f.args, api: apiFixture({ ...f, base }) }), /must contain current/);
  await writeFile(join(f.root, "README.md"), "Dirty checkout\n");
  await assert.rejects(requireShopReleaseChecks(f.args), /checkout must be clean/);
});

test("branch Preview rejects native assets, controls, root/shared changes and cross-boundary moves", async t => {
  for (const path of ["products/shop/apps/web/public/mockups/source.png", "products/shop/scripts/deployment-plan.mjs",
    "products/shop/.github/workflows/deploy.yml", ".github/workflows/deploy.yml", "bun.lock", "packages/ui/src/button.tsx", "products/shop/workers/api/src/index.ts"]) {
    const f = await fixture(t, [path]); await assert.rejects(requireShopReleaseChecks(f.args), /may change only storefront/);
  }
  const f = await fixture(t); git(f.root, "mv", "README.md", "products/shop/apps/web/README.md");
  git(f.root, "commit", "--quiet", "-m", "Move root content into storefront");
  const source = git(f.root, "rev-parse", "HEAD");
  await assert.rejects(requireShopReleaseChecks({ ...f.args, sha: source, env: { ...f.env, GITHUB_SHA: source }, api: apiFixture({ ...f, source }) }), /may change only storefront/);
});

test("Preview branch code and its ledger evidence require genuine exact-head quality, security and review", async t => {
  const f = await fixture(t, ["products/shop/apps/web/src/app/page.tsx", ".github/codeql/reviewed-flows.json"]);
  assert.equal((await requireShopReleaseChecks(f.args)).branchQualityRunId, 24);
  for (const failure of ["no-pr", "stale-pr-base", "fork-pr", "branch-workflow", "branch-latest-failed", "branch-quality-failed",
    "wrong-security-publisher", "branch-review-pending", "wrong-review-pr", "branch-run-race"]) {
    await assert.rejects(requireShopReleaseChecks({ ...f.args, api: apiFixture({ ...f, failure }) }), undefined, failure);
  }
});
