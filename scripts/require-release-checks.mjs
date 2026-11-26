import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "bentbrain/bent-mono";
const WORKFLOW = ".github/workflows/quality.yml";
const SHA = /^[a-f0-9]{40}$/;
const JOBS = ["lint", "typecheck", "test", "knip", "build", "test:integration", "browser",
  "public-source", "secret-scan", "dependencies", "CodeQL", "fitness-ios", "fitness-ios-native", "Release qualification"];
class QualificationError extends Error {}
const fail = message => { throw new QualificationError(message); };
// Each request has a fixed label; messages name only the label, never a path built from GitHub's data.
const parseReply = (text, label) => {
  try { return JSON.parse(text); } catch { return fail(`GitHub returned an unreadable response for ${label}.`); }
};
const isId = value => Number.isSafeInteger(value) && value > 0;

export function validateReleaseEvent(env, event, sha) {
  if (!SHA.test(sha)) fail("Release source must be a full commit SHA.");
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== REPOSITORY) fail("Unexpected release repository.");
  if (env.GITHUB_ACTIONS !== "true") return;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== "refs/heads/main") fail("Releases require the canonical main branch.");
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    if (env.GITHUB_SHA !== sha || !["main", env.GITHUB_REF].includes(event.ref)) fail("Dispatch must release its exact main commit.");
  } else if (env.GITHUB_EVENT_NAME === "workflow_run") {
    const run = event.workflow_run;
    if (run?.head_sha !== sha || run.head_branch !== "main" || run.event !== "push" ||
        run.path !== WORKFLOW || run.conclusion !== "success" || run.head_repository?.full_name !== REPOSITORY) {
      fail("Release trigger is not a successful canonical main Quality run.");
    }
  } else {
    fail("Unsupported production release event.");
  }
}

async function pages(api, path, field, label) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const result = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, label);
    const batch = field ? result[field] : result;
    if (!Array.isArray(batch)) fail("Malformed release qualification API response.");
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  fail("Release qualification pagination limit exceeded.");
}

// The newest run of the workflow for the exact commit, branch and allowed events in the canonical repository.
async function latestRun(api, workflow, { sha, branch, events, path, label }) {
  const query = `branch=${encodeURIComponent(branch)}${events.length === 1 ? `&event=${events[0]}` : ""}&head_sha=${sha}`;
  const runs = await pages(api, `/repos/${REPOSITORY}/actions/workflows/${workflow.id}/runs?${query}`, "workflow_runs", `the ${label} runs`);
  const candidates = runs.filter(run => run.head_sha === sha && run.head_branch === branch &&
    events.includes(run.event) && run.path === path && run.workflow_id === workflow.id &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY);
  if (candidates.some(run => !isId(run.id))) fail(`GitHub returned a malformed ${label} run ID.`);
  candidates.sort((a, b) => b.id - a.id);
  return candidates[0];
}

const passed = run => run?.status === "completed" && run.conclusion === "success";

// The selected run is still the newest eligible run, on the same attempt, and still passed.
async function requireStillLatest(api, workflow, selector, selected) {
  const direct = await api(`/repos/${REPOSITORY}/actions/runs/${selected.id}`, `the ${selector.label} run`);
  const latest = await latestRun(api, workflow, selector);
  if (direct.run_attempt !== selected.run_attempt || !passed(direct) || latest?.id !== selected.id ||
      latest.run_attempt !== selected.run_attempt || !passed(latest)) fail("Release qualification changed during inspection.");
}

async function qualityWorkflow(api) {
  const workflow = await api(`/repos/${REPOSITORY}/actions/workflows/quality.yml`, "the Quality workflow");
  if (workflow.path !== WORKFLOW || workflow.state !== "active") fail("Canonical Quality workflow is unavailable.");
  if (!isId(workflow.id)) fail("GitHub returned a malformed Quality workflow ID.");
  return workflow;
}

const qualitySelector = ({ sha, branch, event }) => ({ sha, branch, events: [event], path: WORKFLOW, label: "Quality" });

export async function requireQualityChecks({ sha, branch, event }, api, workflow) {
  if (!SHA.test(sha) || typeof branch !== "string" || !branch || !["push", "pull_request"].includes(event)) {
    fail("Quality admission requires an exact source, branch and supported event.");
  }
  const prefix = `/repos/${REPOSITORY}`;
  workflow ??= await qualityWorkflow(api);
  const run = await latestRun(api, workflow, qualitySelector({ sha, branch, event }));
  if (!passed(run) || !isId(run.run_attempt)) fail("The latest canonical Quality run has not passed.");
  const jobs = await pages(api, `${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs", "the Quality run's jobs");
  for (const name of JOBS) {
    const matches = jobs.filter(job => job.name === name);
    if (matches.length !== 1 || matches[0].head_sha !== sha || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      fail(`Required Quality job is missing, ambiguous or unsuccessful: ${name}`);
    }
  }
  return run;
}

// Pull requests that change application, server, shared package or release
// code need an independent review. CI-only and documentation-only pull
// requests merge on their checks alone.
// Root files that production installs, builds or runs count as release code.
const REVIEWED = [/^apps\//, /^packages\//, /^products\//, /^scripts\/[^/]*release[^/]*$/,
  /^scripts\/require-no-pending-migrations\.mjs$/, /^scripts\/vercel-[^/]+$/,
  /^\.github\/workflows\/deploy-[^/]+$/, /^\.github\/actions\//,
  /^package\.json$/, /^bun\.lock$/, /^bunfig\.toml$/, /^deployments\.json$/, /^AGENTS\.md$/];
// GitHub lists at most 3000 files for a pull request; a longer list is treated as reviewed code.
const FILE_LIMIT = 3000;

export function needsReview(files) {
  // An empty or truncated list says nothing about what changed, so it counts as reviewed code.
  if (!Array.isArray(files) || files.length === 0 || files.length >= FILE_LIMIT) return true;
  return files.some(file => {
    if (typeof file?.filename !== "string" || !file.filename) fail("GitHub returned a malformed pull request file.");
    if (file.status === "renamed" && (typeof file.previous_filename !== "string" || !file.previous_filename)) return true;
    const names = [file.filename, ...(typeof file.previous_filename === "string" ? [file.previous_filename] : [])];
    return names.some(name => REVIEWED.some(pattern => pattern.test(name)));
  });
}

export async function requireReviewedHead({ sha, pullRequest }, api) {
  if (!isId(pullRequest)) fail("GitHub returned a malformed pull request number.");
  const prefix = `/repos/${REPOSITORY}`;
  const files = await pages(api, `${prefix}/pulls/${pullRequest}/files`, undefined, "the pull request files");
  const checks = await pages(api, `${prefix}/commits/${sha}/check-runs?filter=latest`, "check_runs", "the check runs");
  const security = checks.filter(check => check.name === "CodeQL" && check.app?.slug === "github-advanced-security");
  if (security.length !== 1 || security[0].head_sha !== sha || security[0].status !== "completed" || security[0].conclusion !== "success") {
    fail("Native CodeQL security analysis has not passed for the reviewed PR head.");
  }
  if (!needsReview(files)) return;
  const statuses = await pages(api, `${prefix}/commits/${sha}/statuses`, undefined, "the commit statuses");
  const review = statuses.find(status => status.context === "Independent review");
  if (!review || review.state !== "success" || !review.target_url?.startsWith(`https://github.com/${REPOSITORY}/pull/${pullRequest}#`)) {
    fail("The pull request lacks its exact-head independent review evidence.");
  }
}

export async function requireReleaseChecks(sha, api) {
  if (!SHA.test(sha)) fail("Release source must be a full commit SHA.");
  const prefix = `/repos/${REPOSITORY}`;
  const main = await api(`${prefix}/git/ref/heads/main`, "the main branch");
  if (main.object?.sha !== sha) fail("Release source is no longer current main.");
  const workflow = await qualityWorkflow(api);
  const run = await requireQualityChecks({ sha, branch: "main", event: "push" }, api, workflow);
  const pulls = await pages(api, `${prefix}/commits/${sha}/pulls`, undefined, "the pull requests");
  const merged = pulls.filter(pr => pr.merged_at && pr.merge_commit_sha === sha && pr.base?.ref === "main" &&
    pr.base.repo?.full_name === REPOSITORY && pr.head?.repo?.full_name === REPOSITORY && SHA.test(pr.head.sha));
  if (merged.length !== 1) fail("Release source must be a reviewed pull request merged into canonical main.");
  if (!isId(merged[0].number)) fail("GitHub returned a malformed pull request number.");
  // GitHub publishes its native code-scanning check on PR heads, not on the
  // squash-main commit. Main must pass the complete raw-SARIF Quality gate;
  // the merged PR must also have passed the native security check.
  await requireReviewedHead({ sha: merged[0].head.sha, pullRequest: merged[0].number }, api);
  // A rerun, a newer run for the commit or a new merge during qualification must not release stale evidence.
  await requireStillLatest(api, workflow, qualitySelector({ sha, branch: "main", event: "push" }), run);
  const finalMain = await api(`${prefix}/git/ref/heads/main`, "the main branch");
  if (finalMain.object?.sha !== sha) fail("Release qualification changed during inspection.");
  return { sha, qualityRunId: run.id, qualityAttempt: run.run_attempt, pullRequest: merged[0].number };
}

export async function githubApi(path, label = "a GitHub endpoint") {
  if (!process.env.GH_TOKEN) {
    if (process.env.GITHUB_ACTIONS === "true") fail("GH_TOKEN is required for CI release qualification.");
    let text;
    try {
      // The CLI's own diagnostics are captured and discarded, since they can quote GitHub's reply.
      text = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL" });
    } catch (error) {
      fail(`GitHub CLI request for ${label} failed${Number.isSafeInteger(error?.status) ? ` (exit ${error.status})` : ""}.`);
    }
    return parseReply(text, label);
  }
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`Release qualification API failed with HTTP ${response.status} for ${label}.`);
  return parseReply(await response.text(), label);
}

/** The commit from `--sha <full-sha>`, given exactly once. */
export function releaseArguments(args) {
  if (args.length !== 2 || args[0] !== "--sha") fail("Usage: node scripts/require-release-checks.mjs --sha <full-sha>");
  return { sha: args[1] };
}

async function main() {
  const { sha } = releaseArguments(process.argv.slice(2));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== sha || execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim()) {
    fail("Release checkout must be clean and match the exact source commit.");
  }
  const event = process.env.GITHUB_ACTIONS === "true" ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  validateReleaseEvent(process.env, event, sha);
  console.log(JSON.stringify(await requireReleaseChecks(sha, githubApi)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Only this script's own messages are shown, never a stack or another error's text.
  await main().catch(error => {
    console.error(error instanceof QualificationError ? error.message : "Release qualification failed unexpectedly.");
    process.exitCode = 1;
  });
}
