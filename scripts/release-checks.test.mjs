import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { requireReleaseChecks, validateReleaseEvent } from "./require-release-checks.mjs";
import { hasNoPendingMigrations } from "./require-no-pending-migrations.mjs";
import { requireBrowserSuites } from "./require-browser-suites.mjs";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const repo = "bentbrain/bent-mono";
const workflow = { id: 12, path: ".github/workflows/quality.yml", state: "active" };
const run = { id: 23, head_sha: sha, head_branch: "main", event: "push", path: workflow.path,
  workflow_id: workflow.id, repository: { full_name: repo }, head_repository: { full_name: repo },
  status: "completed", conclusion: "success", run_attempt: 2 };
const names = ["lint", "typecheck", "test", "knip", "build", "test:integration", "browser", "public-source",
  "secret-scan", "dependencies", "CodeQL", "Release qualification"];
const qualitySource = () => readFile(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8");
const qualityJob = (source, name) => source.split(`\n  ${name}:\n`)[1]?.split(/^  [a-z][a-z0-9-]*:$/m)[0];
const jobDependencies = job => job.match(/^    needs: \[([^\]]+)\]$/m)?.[1].split(",").map(value => value.trim());

test("the production aggregate depends on every Quality job and runs after failures", async () => {
  const source = await qualitySource();
  const declared = [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(match => match[1]);
  const aggregate = qualityJob(source, "release-qualification");
  assert.ok(aggregate?.includes("    if: always()"));
  const dependencies = jobDependencies(aggregate);
  assert.ok(dependencies?.includes("browser"));
  const browserDependencies = jobDependencies(qualityJob(source, "browser"));
  assert.deepEqual(browserDependencies, ["browser-scope", "browser-suite"]);
  assert.deepEqual([...dependencies, ...browserDependencies].sort(), declared.filter(name => name !== "release-qualification").sort());
  assert.ok(aggregate.includes('Object.values(jobs).some(job => job.result !== "success")'));
});

test("the required browser aggregate only admits successful work or an intentional empty matrix", async () => {
  const source = await qualitySource();
  const job = qualityJob(source, "browser");
  assert.match(job, /^    name: browser$\n    if: always\(\)$/m);
  assert.ok(job.includes("BROWSER_MATRIX: ${{ needs.browser-scope.outputs.matrix }}"));
  assert.ok(job.includes("run: node scripts/require-browser-suites.mjs"));
  assert.ok(qualityJob(source, "browser-suite").includes("name: ${{ matrix.name }}"));

  const env = {
    SCOPE_RESULT: "success", HAS_WORK: "false", SUITE_RESULT: "skipped",
    BROWSER_MATRIX: JSON.stringify({ include: [] }),
  };
  let lookups = 0;
  const readJobs = () => { lookups++; return []; };
  assert.equal(requireBrowserSuites(env, readJobs), "No browser suites selected.");
  for (const override of [
    { SCOPE_RESULT: "failure" },
    { SCOPE_RESULT: "skipped" },
    { SUITE_RESULT: "failure" },
    { SUITE_RESULT: "success" },
    { HAS_WORK: "" },
    { HAS_WORK: "true" },
    { BROWSER_MATRIX: "{}" },
    { BROWSER_MATRIX: '{"include":[{}]}' },
  ]) {
    assert.throws(() => requireBrowserSuites({ ...env, ...override }, readJobs));
  }
  assert.equal(lookups, 0, "An empty or invalid plan does not query the Actions API.");
});

test("a successful matrix summary still requires one completed success for every shard", () => {
  const include = ["Browser jp (1/2)", "Browser jp (2/2)"].map(name => ({ name }));
  const env = {
    SCOPE_RESULT: "success", HAS_WORK: "true", SUITE_RESULT: "success",
    BROWSER_MATRIX: JSON.stringify({ include }), GITHUB_RUN_ID: "23",
  };
  const [first, second] = include.map(({ name }) => ({ name, run_id: 23, status: "completed", conclusion: "success" }));
  assert.equal(requireBrowserSuites(env, () => [first, second]), "All 2 selected browser jobs passed.");
  assert.throws(() => requireBrowserSuites(env, () => [first]), /found 0/);
  assert.throws(() => requireBrowserSuites(env, () => [first, second, second]), /found 2/);
  for (const override of [
    { conclusion: "cancelled" }, { conclusion: "failure" }, { conclusion: "skipped" },
    { status: "in_progress", conclusion: null }, { run_id: 22 },
  ]) {
    assert.throws(() => requireBrowserSuites(env, () => [first, { ...second, ...override }]), /Browser jp \(2\/2\) did not pass/);
  }
  for (const result of ["failure", "cancelled", "skipped"])
    assert.throws(() => requireBrowserSuites({ ...env, SUITE_RESULT: result }, () => [first, second]), /validation incomplete/);
});
test("only the pinned Wrangler no-pending result permits the migration-free release route", () => {
  assert.equal(hasNoPendingMigrations("Resource location: remote\n\n✅ No migrations to apply!\n"), true);
  for (const output of ["", "No migrations to apply", "│ No migrations to apply! │", "0004_pending.sql", "✅ No migrations to apply!\n✅ No migrations to apply!"]) {
    assert.equal(hasNoPendingMigrations(output), false);
  }
});
test("JP rejects untrusted workflow-run heads before checkout in the protected job", async () => {
  const source = await readFile(new URL("../.github/workflows/deploy-jp.yml", import.meta.url), "utf8");
  const condition = source.split("    if: >-\n")[1]?.split("    runs-on:")[0];
  assert.ok(condition?.includes("github.repository == 'bentbrain/bent-mono'"));
  assert.ok(condition?.includes("github.ref == 'refs/heads/main'"));
  assert.ok(condition?.includes("github.event.workflow_run.event == 'push'"));
  assert.ok(condition?.includes("github.event.workflow_run.head_repository.full_name == 'bentbrain/bent-mono'"));
});
function fixture(change = () => {}) {
  const data = {
    main: { object: { sha } }, workflow: structuredClone(workflow), runs: [structuredClone(run)],
    jobs: names.map(name => ({ name, head_sha: sha, status: "completed", conclusion: "success" })),
    pulls: [{ number: 2, merged_at: "2026-11-05T00:00:00Z", merge_commit_sha: sha,
      base: { ref: "main", repo: { full_name: repo } }, head: { sha: head, repo: { full_name: repo } } }],
    checks: [{ name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: head, status: "completed", conclusion: "success" }],
    statuses: [{ context: "Independent review", state: "success", target_url: `https://github.com/${repo}/pull/2#issuecomment-123` }],
    finalRun: structuredClone(run),
  };
  change(data);
  let mainCalls = 0;
  return async path => {
    if (path.endsWith("/git/ref/heads/main")) return data.changedMain && ++mainCalls > 1 ? data.changedMain : data.main;
    if (path.endsWith("/workflows/quality.yml")) return data.workflow;
    if (path.includes("/workflows/12/runs?")) return { workflow_runs: data.runs };
    if (path.includes("/attempts/2/jobs?")) return { jobs: data.jobs };
    if (path.includes("/check-runs?")) return { check_runs: data.checks };
    if (path.includes("/pulls?")) return data.pulls;
    if (path.includes("/statuses?")) return data.statuses;
    if (path.endsWith("/actions/runs/23")) return data.finalRun;
    throw new Error(`Unexpected qualification request: ${path}`);
  };
}
test("qualifies exact successful main and reviewed merged PR using the latest run attempt", async () => {
  assert.deepEqual(await requireReleaseChecks(sha, fixture()), { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2 });
});
test("fails closed for stale source, newer failed runs, skipped/missing/duplicate jobs and foreign workflows", async () => {
  const mutations = [
    d => { d.main.object.sha = head; },
    d => { d.runs.push({ ...run, id: 24, conclusion: "failure" }); },
    d => { d.runs[0].head_repository.full_name = "elsewhere/repo"; },
    d => { d.workflow.state = "disabled_manually"; },
    d => { d.jobs[0].conclusion = "skipped"; },
    d => { d.jobs.pop(); },
    d => { d.jobs.push(d.jobs[0]); },
    d => { d.jobs[0].head_sha = head; },
    d => { d.changedMain = { object: { sha: head } }; },
    d => { d.finalRun.run_attempt = 3; },
  ];
  for (const mutate of mutations) await assert.rejects(requireReleaseChecks(sha, fixture(mutate)));
});
test("requires actual merged PR, native security publisher and successful exact-head review evidence", async () => {
  const mutations = [
    d => { d.pulls[0].merged_at = null; },
    d => { d.pulls[0].head.repo.full_name = "fork/repo"; },
    d => { d.pulls.push(d.pulls[0]); },
    d => { d.checks[0].app.slug = "github-actions"; },
    d => { d.checks[0].head_sha = sha; },
    d => { d.checks[0].conclusion = "failure"; },
    d => { d.statuses.unshift({ ...d.statuses[0], state: "pending" }); },
    d => { d.statuses[0].target_url = "https://github.com/elsewhere/repo/pull/2#review"; },
  ];
  for (const mutate of mutations) await assert.rejects(requireReleaseChecks(sha, fixture(mutate)));
});
test("validates actual main release events without accepting fabricated push or untrusted workflow-run triggers", () => {
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha, GITHUB_EVENT_NAME: "workflow_dispatch" };
  assert.doesNotThrow(() => validateReleaseEvent(env, { ref: "main" }, sha));
  assert.doesNotThrow(() => validateReleaseEvent(env, { ref: "refs/heads/main" }, sha));
  assert.throws(() => validateReleaseEvent(env, { ref: "refs/tags/main" }, sha));
  assert.doesNotThrow(() => validateReleaseEvent({ ...env, GITHUB_EVENT_NAME: "workflow_run" }, { workflow_run: run }, sha));
  assert.doesNotThrow(() => validateReleaseEvent({}, {}, sha));
  assert.throws(() => validateReleaseEvent({ ...env, GITHUB_EVENT_NAME: "push" }, {}, sha));
  assert.throws(() => validateReleaseEvent({ ...env, GITHUB_REF: "refs/heads/topic" }, { ref: "main" }, sha));
  assert.throws(() => validateReleaseEvent({ ...env, GITHUB_EVENT_NAME: "workflow_run" }, { workflow_run: { ...run, head_sha: head } }, sha));
  assert.throws(() => validateReleaseEvent({ GITHUB_REPOSITORY: "fork/repo" }, {}, sha));
});
