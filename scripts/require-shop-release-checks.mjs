import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi, requireQualityChecks, requireReleaseChecks, requireReviewedHead, validateReleaseEvent } from "./require-release-checks.mjs";
import { webOnlyPreviewPlan } from "../products/shop/scripts/deployment-plan.mjs";

const REPOSITORY = "bentbrain/bent-mono";
const PREFIX = `/repos/${REPOSITORY}`;
const SHA = /^[a-f0-9]{40}$/;
const fail = message => { throw new Error(message); };
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

function matchesBranch(rule, branch) {
  if (rule.type !== "branch" || typeof rule.name !== "string" || !/^[\w./*-]+$/.test(rule.name)) return false;
  const expression = rule.name.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${expression}$`).test(branch);
}

async function requirePreviewEnvironment(api, branch) {
  const environment = await api(`${PREFIX}/environments/Preview`);
  const policy = environment.deployment_branch_policy;
  if (policy === null) return;
  if (policy?.custom_branch_policies === true && policy.protected_branches === false) {
    for (let page = 1; page <= 10; page++) {
      const data = await api(`${PREFIX}/environments/Preview/deployment-branch-policies?per_page=100&page=${page}`);
      if (!Array.isArray(data.branch_policies)) fail("Preview branch policy is unavailable.");
      if (data.branch_policies.some(rule => matchesBranch(rule, branch))) return;
      if (data.branch_policies.length < 100) break;
    }
  } else if (policy?.protected_branches === true && policy.custom_branch_policies === false) {
    if ((await api(`${PREFIX}/branches/${encodeURIComponent(branch)}`)).protected === true) return;
  }
  fail("The Preview environment does not permit the selected branch.");
}

export async function requireShopReleaseChecks({ sha, env, event, api, root }) {
  if (!SHA.test(sha) || git(root, ["rev-parse", "HEAD"]) !== sha ||
      git(root, ["status", "--porcelain", "--untracked-files=normal"])) {
    fail("Release checkout must be clean and match the exact source commit.");
  }
  if (env.GITHUB_REF === "refs/heads/main") {
    validateReleaseEvent(env, event, sha);
    return requireReleaseChecks(sha, api);
  }
  const branch = env.GITHUB_REF?.replace(/^refs\/heads\//, "");
  const inputs = event.inputs;
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== REPOSITORY ||
      event.repository?.full_name !== REPOSITORY || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      !env.GITHUB_REF?.startsWith("refs/heads/") || !branch || branch === "main" || ![branch, env.GITHUB_REF].includes(event.ref) ||
      env.GITHUB_SHA !== sha || env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/deploy.yml@${env.GITHUB_REF}` ||
      inputs?.environment !== "development" || ![true, "true"].includes(inputs.web_only_preview) ||
      ![false, "false"].includes(inputs.force_full) || inputs.expected_source || inputs.coordination_id) {
    fail("Branch releases require an exact-source, uncoordinated web-only Development dispatch.");
  }
  const main = (await api(`${PREFIX}/git/ref/heads/main`)).object?.sha;
  if (!SHA.test(main)) fail("Current canonical main is unavailable.");
  const selected = `${PREFIX}/branches/${encodeURIComponent(branch)}`;
  if ((await api(selected)).commit?.sha !== sha) fail("Preview branch no longer points to the dispatched source.");
  try { git(root, ["merge-base", "--is-ancestor", main, sha]); }
  catch { fail("Web-only Preview must contain current canonical main."); }
  const paths = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", main, sha], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  // Release controls, root/shared dependencies and native assets must remain
  // identical to qualified main. Only storefront changes use this branch lane.
  const prefix = "products/shop/apps/web/";
  if (paths.some(path => path !== ".github/codeql/reviewed-flows.json" &&
      (!path.startsWith(prefix) || path.startsWith(prefix + "public/mockups/")))) {
    fail("Branch Preview may change only storefront files, excluding native mockup assets and release controls.");
  }
  webOnlyPreviewPlan({ base: main, environment: "development", forceFull: false,
    paths: paths.filter(path => path !== ".github/codeql/reviewed-flows.json").map(path => path.slice("products/shop/".length)), ref: env.GITHUB_REF });
  await requirePreviewEnvironment(api, branch);
  const qualification = await requireReleaseChecks(main, api);
  const pulls = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api(`${PREFIX}/commits/${sha}/pulls?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) fail("Preview pull request inventory is unavailable.");
    pulls.push(...batch);
    if (batch.length < 100) break;
    if (page === 100) fail("Preview pull request pagination limit exceeded.");
  }
  const reviewed = pulls.filter(pr => pr.state === "open" && !pr.merged_at &&
    pr.base?.ref === "main" && pr.base.sha === main && pr.base.repo?.full_name === REPOSITORY &&
    pr.head?.sha === sha && pr.head.ref === branch && pr.head.repo?.full_name === REPOSITORY);
  if (reviewed.length !== 1) fail("Branch Preview requires one canonical open PR against current main.");
  const branchRun = await requireQualityChecks({ sha, branch, event: "pull_request" }, api);
  await requireReviewedHead({ sha, pullRequest: reviewed[0].number }, api);
  // Repeat mutable source and environment checks after main qualification.
  if ((await api(selected)).commit?.sha !== sha) fail("Preview branch changed during admission.");
  await requirePreviewEnvironment(api, branch);
  if ((await api(`${PREFIX}/git/ref/heads/main`)).object?.sha !== main) fail("Canonical main changed during Preview admission.");
  const finalRun = await api(`${PREFIX}/actions/runs/${branchRun.id}`);
  if (finalRun.run_attempt !== branchRun.run_attempt || finalRun.status !== "completed" || finalRun.conclusion !== "success") {
    fail("Branch Quality qualification changed during admission.");
  }
  return { ...qualification, sha, base: main, lane: "web-only-preview", branchQualityRunId: branchRun.id,
    branchQualityAttempt: branchRun.run_attempt, branchPullRequest: reviewed[0].number };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--sha") fail("Usage: node scripts/require-shop-release-checks.mjs --sha <full-sha>");
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  console.log(JSON.stringify(await requireShopReleaseChecks({ sha: process.argv[3], env: process.env, event, api: githubApi, root })));
}
