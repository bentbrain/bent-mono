import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubApi, releaseArguments, requireReleaseChecks, validateReleaseEvent } from "./require-release-checks.mjs";
import { hasNoPendingMigrations } from "./require-no-pending-migrations.mjs";
import { requireBrowserSuites } from "./require-browser-suites.mjs";
import { requireIosNative } from "./require-ios-native.mjs";

const sha = "a".repeat(40);
const head = "b".repeat(40);
const repo = "bentbrain/bent-mono";
const workflow = { id: 12, path: ".github/workflows/quality.yml", state: "active" };
const run = { id: 23, head_sha: sha, head_branch: "main", event: "push", path: workflow.path,
  workflow_id: workflow.id, repository: { full_name: repo }, head_repository: { full_name: repo },
  status: "completed", conclusion: "success", run_attempt: 2 };
const names = ["lint", "typecheck", "test", "knip", "build", "test:integration", "browser", "public-source",
  "secret-scan", "dependencies", "CodeQL", "fitness-ios", "fitness-ios-native", "Release qualification"];
const qualitySource = () => readFile(new URL("../.github/workflows/quality.yml", import.meta.url), "utf8");
const qualityJob = (source, name) => source.split(`\n  ${name}:\n`)[1]?.split(/^  [a-z][a-z0-9-]*:$/m)[0];
const jobDependencies = job => job.match(/^    needs: \[([^\]]+)\]$/m)?.[1].split(",").map(value => value.trim());

test("the production aggregate depends on every Quality job and runs after failures", async () => {
  const source = await qualitySource();
  const declared = [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(match => match[1]);
  const aggregate = qualityJob(source, "release-qualification");
  assert.ok(aggregate?.includes("    if: always()"));
  const dependencies = jobDependencies(aggregate);
  assert.deepEqual(dependencies, ["checks", "browser", "public-source", "secrets", "dependencies", "codeql",
    "fitness-ios", "fitness-ios-native"]);
  const browserDependencies = jobDependencies(qualityJob(source, "browser"));
  assert.deepEqual(browserDependencies, ["ci-scope", "browser-suite"]);
  const nativeDependencies = jobDependencies(qualityJob(source, "fitness-ios-native"));
  assert.deepEqual(nativeDependencies, ["ci-scope", "fitness-ios-native-suite"]);
  assert.deepEqual([...new Set([...dependencies, ...browserDependencies, ...nativeDependencies])].sort(),
    declared.filter(name => name !== "release-qualification").sort());
  assert.ok(aggregate.includes('Object.values(jobs).some(job => job.result !== "success")'));
  assert.ok(aggregate.includes('"fitness-ios", "fitness-ios-native"];'));
  assert.ok(!source.includes("codeql-swift"));
});

test("one CI scope job selects the browser suites and the native iPhone suite", async () => {
  const source = await qualitySource();
  const scope = qualityJob(source, "ci-scope");
  assert.match(scope, /^    name: Select CI scope$/m);
  assert.ok(scope.includes("ios_native: ${{ steps.scope.outputs.ios_native }}"));
  assert.ok(scope.includes("run: node scripts/ci-scope.mjs"));
  assert.ok(!source.includes("browser-scope"));
  const suite = qualityJob(source, "browser-suite");
  assert.ok(suite.includes("    needs: ci-scope\n    if: needs.ci-scope.outputs.has_work == 'true'\n"));
  const native = qualityJob(source, "fitness-ios-native-suite");
  assert.ok(native.includes("    needs: ci-scope\n    if: needs.ci-scope.outputs.ios_native == 'true'\n    runs-on: macos-26\n    timeout-minutes: 30\n"));
  assert.ok(native.includes("run: node scripts/roundtrip.mjs"));
  assert.ok(!native.includes("flows.mjs"));
  const gate = qualityJob(source, "fitness-ios-native");
  assert.match(gate, /^    name: fitness-ios-native$\n    if: always\(\)$/m);
  assert.ok(gate.includes("runs-on: ubuntu-latest"));
  assert.ok(gate.includes("IOS_NATIVE: ${{ needs.ci-scope.outputs.ios_native }}"));
  assert.ok(gate.includes("SUITE_RESULT: ${{ needs.fitness-ios-native-suite.result }}"));
  assert.ok(gate.includes("run: node scripts/require-ios-native.mjs"));
});

test("the required native iPhone check admits a passed suite or an intentionally skipped one", () => {
  assert.match(requireIosNative({ SCOPE_RESULT: "success", IOS_NATIVE: "true", SUITE_RESULT: "success" }), /passed/);
  assert.match(requireIosNative({ SCOPE_RESULT: "success", IOS_NATIVE: "false", SUITE_RESULT: "skipped" }), /not selected/);
  for (const scope of ["success", "failure", "cancelled", "skipped", ""]) {
    for (const selected of ["true", "false", "", "TRUE"]) {
      for (const suite of ["success", "failure", "cancelled", "skipped", ""]) {
        const admitted = scope === "success" &&
          ((selected === "true" && suite === "success") || (selected === "false" && suite === "skipped"));
        const check = () => requireIosNative({ SCOPE_RESULT: scope, IOS_NATIVE: selected, SUITE_RESULT: suite });
        if (admitted) assert.doesNotThrow(check);
        else assert.throws(check);
      }
    }
  }
});

const verifySource = () => readFile(new URL("../.github/workflows/fitness-ios-verify.yml", import.meta.url), "utf8");
test("Fitness iOS Verification runs every native check in parallel jobs with pinned actions", async () => {
  const source = await verifySource();
  const pinned = await qualitySource();
  for (const [, action, ref] of source.matchAll(/uses: ([^@\s]+)@(\S+)/g)) {
    assert.match(ref, /^[a-f0-9]{40}$/, action);
    assert.ok(pinned.includes(`uses: ${action}@${ref}`) ||
      (action === "github/codeql-action/init" || action === "github/codeql-action/analyze") && pinned.includes(`@${ref}`), action);
  }
  assert.ok(source.startsWith("name: Fitness iOS Verification\non:\n  workflow_dispatch:\n  schedule:\n    - cron: \"0 17 * * *\"\n  push:\n    branches: [main]\n"));
  assert.ok(source.includes("permissions:\n  contents: read\nconcurrency:\n  group: fitness-ios-verify-${{ github.ref }}\n  cancel-in-progress: true\n"));
  const checkouts = source.match(/uses: actions\/checkout@/g).length;
  assert.equal(source.match(/uses: actions\/checkout@\S+\n        with:\n          persist-credentials: false\n/g).length, checkouts);
  // Every expression in a shell step arrives through env.
  for (const block of source.split(/\n\s+- /)) {
    const script = block.match(/run: ([\s\S]*)/)?.[1];
    if (script) assert.ok(!script.includes("${{"), block);
  }
  const declared = [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(match => match[1]);
  assert.deepEqual(declared, ["fitness-ios-native", "codeql-swift-app", "codeql-swift-tools", "simulator-flow", "verification"]);
  const job = name => qualityJob(source, name);
  assert.equal(source.match(/security-events: write/g).length, 2);
  for (const [name, scope, timeout] of [["codeql-swift-app", "app", 45], ["codeql-swift-tools", "tools", 30]]) {
    const codeql = job(name);
    assert.ok(codeql.includes(`    name: CodeQL Swift (${scope})\n    runs-on: macos-26\n    timeout-minutes: ${timeout}\n`));
    assert.ok(codeql.includes("    permissions:\n      contents: read\n      security-events: write\n"));
    assert.ok(codeql.includes("CODEQL_ACTION_DIFF_INFORMED_QUERIES: 'false'"));
    assert.ok(codeql.includes("CODEQL_ACTION_OVERLAY_ANALYSIS: 'false'"));
    assert.ok(codeql.includes("languages: swift\n          build-mode: manual\n          queries: security-extended,security-and-quality\n"));
    assert.ok(codeql.includes("--install-rosetta"));
    assert.ok(codeql.includes(`category: fitness-codeql-swift-${scope}\n`));
    assert.ok(codeql.includes("CODEQL_LANGUAGES: swift\n        run: node scripts/check-sarif.mjs\n"));
    assert.ok(codeql.includes(`node scripts/codeql-coverage.mjs --scope ${scope} "$RUNNER_TEMP/codeql_databases/swift"`));
    assert.ok(codeql.includes(`        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: codeql-swift-${scope}-original-sarif\n          path: \${{ runner.temp }}/codeql-swift-results/*.sarif\n          if-no-files-found: error\n          retention-days: 14\n`));
    assert.ok(codeql.includes(`name: codeql-swift-${scope}-extractor-logs`));
    assert.ok(codeql.indexOf("codeql-action/init@") < codeql.indexOf(`replay-swift ${scope === "app" ? "app" : "seeder"}`));
  }
  assert.ok(job("codeql-swift-app").includes("SKIP_BUNDLING: '1'"));
  assert.ok(job("codeql-swift-app").includes("SWIFT_PRECOMPILE_BRIDGING_HEADER=NO"));
  assert.ok(!job("codeql-swift-tools").includes("./.github/actions/setup"));
  assert.ok(job("codeql-swift-tools").includes("node scripts/native.mjs core-build"));
  const native = job("fitness-ios-native");
  assert.ok(native.includes("    name: fitness-ios-native\n    runs-on: macos-26\n    timeout-minutes: 30\n"));
  for (const step of ["lint", "prebuild", "build", "artifact", "seeder", "core-test"]) assert.ok(native.includes(`run: node scripts/native.mjs ${step}\n`));
  assert.ok(native.includes("run: node scripts/roundtrip.mjs"));
  const flows = job("simulator-flow");
  assert.ok(flows.includes("    name: Simulator flow (${{ matrix.label }})\n    runs-on: macos-26\n    timeout-minutes: 35\n    strategy:\n      fail-fast: false\n"));
  for (const [label, flow] of [["denied", "testDeniedHealthAccessSendsNothing"],
    ["allowed", "testAllowedHealthAccessSyncsTheSeededHistory"], ["partial", "testPartialHealthAccessHoldsRunsWithoutDistance"]]) {
    assert.ok(flows.includes(`          - label: ${label}\n            flow: ${flow}\n`));
  }
  assert.ok(flows.includes("FLOW: ${{ matrix.flow }}\n        run: node scripts/flows.mjs \"$FLOW\"\n"));
  const aggregate = job("verification");
  assert.ok(aggregate.includes("    name: Fitness iOS verification\n    if: always()\n"));
  assert.deepEqual(jobDependencies(aggregate), declared.filter(name => name !== "verification"));
  assert.ok(aggregate.includes('const expected = ["fitness-ios-native", "codeql-swift-app", "codeql-swift-tools", "simulator-flow"];'));
  assert.ok(aggregate.includes('Object.values(jobs).some(job => job.result !== "success")'));
});

test("the required browser aggregate only admits successful work or an intentional empty matrix", async () => {
  const source = await qualitySource();
  const job = qualityJob(source, "browser");
  assert.match(job, /^    name: browser$\n    if: always\(\)$/m);
  assert.ok(job.includes("BROWSER_MATRIX: ${{ needs.ci-scope.outputs.matrix }}"));
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
const iosWorkflow = { id: 31, path: ".github/workflows/fitness-ios-verify.yml", state: "active" };
const iosRun = { ...run, id: 41, event: "push", path: iosWorkflow.path, workflow_id: iosWorkflow.id, run_attempt: 1 };
const iosNames = ["fitness-ios-native", "CodeQL Swift (app)", "CodeQL Swift (tools)", "Simulator flow (denied)",
  "Simulator flow (allowed)", "Simulator flow (partial)", "Fitness iOS verification"];
function fixture(change = () => {}) {
  const data = {
    main: { object: { sha } }, workflow: structuredClone(workflow), runs: [structuredClone(run)],
    jobs: names.map(name => ({ name, head_sha: sha, status: "completed", conclusion: "success" })),
    pulls: [{ number: 2, merged_at: "2026-11-05T00:00:00Z", merge_commit_sha: sha,
      base: { ref: "main", repo: { full_name: repo } }, head: { sha: head, repo: { full_name: repo } } }],
    checks: [{ name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: head, status: "completed", conclusion: "success" }],
    statuses: [{ context: "Independent review", state: "success", target_url: `https://github.com/${repo}/pull/2#issuecomment-123` }],
    finalRun: structuredClone(run),
    iosWorkflow: structuredClone(iosWorkflow),
    iosRuns: [structuredClone(iosRun)],
    iosJobs: iosNames.map(name => ({ name, head_sha: sha, status: "completed", conclusion: "success" })),
    finalIosRun: structuredClone(iosRun),
  };
  change(data);
  let mainCalls = 0;
  const api = async path => {
    api.paths.push(path);
    if (path.endsWith("/workflows/fitness-ios-verify.yml")) return data.iosWorkflow;
    if (path.includes("/workflows/31/runs?")) return { workflow_runs: data.iosRuns };
    if (path.includes("/runs/41/attempts/1/jobs?")) return { jobs: data.iosJobs };
    if (path.endsWith("/actions/runs/41")) return data.finalIosRun;
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
  api.paths = [];
  return api;
}
test("qualifies exact successful main and reviewed merged PR using the latest run attempt", async () => {
  const api = fixture();
  assert.deepEqual(await requireReleaseChecks(sha, api), { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2 });
  assert.ok(!api.paths.some(path => path.includes("fitness-ios-verify") || path.includes("/workflows/31/")),
    "Without --ios no Fitness iOS Verification request is sent.");
  assert.deepEqual(await requireReleaseChecks(sha, fixture(), { ios: false }), { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2 });
});
test("with ios, also requires the latest exact-commit Fitness iOS Verification run to pass every job", async () => {
  const expected = { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2, iosVerificationRunId: 41, iosVerificationAttempt: 1 };
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    assert.deepEqual(await requireReleaseChecks(sha, fixture(d => { d.iosRuns[0].event = event; }), { ios: true }), expected);
  }
  const api = fixture();
  await requireReleaseChecks(sha, api, { ios: true });
  // The run is read again after every other inspection.
  assert.equal(api.paths.at(-1), "/repos/bentbrain/bent-mono/actions/runs/41");
  assert.ok(api.paths.includes("/repos/bentbrain/bent-mono/actions/workflows/31/runs?branch=main&head_sha=" + sha + "&per_page=100&page=1"));
  // An older failed run does not block a newer passing one.
  assert.deepEqual(await requireReleaseChecks(sha, fixture(d => { d.iosRuns.push({ ...iosRun, id: 40, conclusion: "failure" }); }),
    { ios: true }), expected);
});
test("with ios, fails closed for any missing, stale, foreign or unsuccessful verification", async () => {
  const mutations = [
    d => { d.iosRuns = []; },
    d => { d.iosRuns[0].event = "pull_request"; },
    d => { d.iosRuns[0].event = "workflow_run"; },
    d => { d.iosRuns[0].head_branch = "topic"; },
    d => { d.iosRuns[0].head_sha = head; },
    d => { d.iosRuns[0].repository.full_name = "elsewhere/repo"; },
    d => { d.iosRuns[0].head_repository.full_name = "fork/repo"; },
    d => { d.iosRuns[0].path = ".github/workflows/quality.yml"; },
    d => { d.iosRuns[0].workflow_id = 12; },
    d => { d.iosRuns[0].status = "in_progress"; d.iosRuns[0].conclusion = null; },
    d => { d.iosRuns[0].conclusion = "cancelled"; },
    d => { d.iosRuns.push({ ...iosRun, id: 42, event: "schedule", conclusion: "failure" }); },
    d => { d.iosWorkflow.state = "disabled_manually"; },
    d => { d.iosWorkflow.path = ".github/workflows/quality.yml"; },
    d => { d.iosJobs.pop(); },
    d => { d.iosJobs.push(d.iosJobs[0]); },
    d => { d.iosJobs[1].conclusion = "skipped"; },
    d => { d.iosJobs[3].conclusion = "failure"; },
    d => { d.iosJobs[6].status = "in_progress"; },
    d => { d.iosJobs[2].head_sha = head; },
    d => { d.finalIosRun.run_attempt = 2; },
    d => { d.finalIosRun.conclusion = "failure"; },
    d => { d.finalIosRun.status = "in_progress"; },
  ];
  for (const mutate of mutations) {
    await assert.rejects(requireReleaseChecks(sha, fixture(mutate), { ios: true }));
    // Quality qualification alone does not read the verification workflow.
    await assert.doesNotReject(requireReleaseChecks(sha, fixture(mutate)));
  }
  await assert.rejects(requireReleaseChecks(sha, fixture(d => { d.iosJobs.pop(); }), { ios: true }),
    { message: "Required Fitness iOS Verification job is missing, ambiguous or unsuccessful: Fitness iOS verification" });
  await assert.rejects(requireReleaseChecks(sha, fixture(d => { d.finalIosRun.run_attempt = 2; }), { ios: true }),
    { message: "Release qualification changed during inspection." });
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
const email = "jane.doe@example.com";
test("provider IDs used in request paths must be positive safe integers, and a bad one is never shown", async () => {
  const bad = [email, "12/../../users", 12.5, 0, -1, null];
  for (const id of bad) {
    for (const mutate of [d => { d.workflow.id = id; d.runs[0].workflow_id = id; }, d => { d.runs[0].id = id; }]) {
      await assert.rejects(requireReleaseChecks(sha, fixture(mutate)), error =>
        /^GitHub returned a malformed Quality (workflow|run) ID\.$/.test(error.message) && !error.message.includes(String(id)));
    }
  }
});
test("Fitness iOS Verification IDs must be positive safe integers, and a bad one is never shown", async () => {
  for (const id of [email, "31/../../users", 12.5, 0, -1, null]) {
    for (const [mutate, kind] of [
      [d => { d.iosWorkflow.id = id; d.iosRuns[0].workflow_id = id; }, "workflow ID"],
      [d => { d.iosRuns[0].id = id; }, "run ID"],
      [d => { d.iosRuns[0].run_attempt = id; }, "run attempt"],
    ]) {
      await assert.rejects(requireReleaseChecks(sha, fixture(mutate), { ios: true }), error =>
        error.message === `GitHub returned a malformed Fitness iOS Verification ${kind}.` && !error.message.includes(String(id)));
    }
  }
});
test("the command takes one --sha and at most one --ios", () => {
  assert.deepEqual(releaseArguments(["--sha", sha]), { sha, ios: false });
  assert.deepEqual(releaseArguments(["--sha", sha, "--ios"]), { sha, ios: true });
  assert.deepEqual(releaseArguments(["--ios", "--sha", sha]), { sha, ios: true });
  for (const args of [[], ["--sha"], [sha], ["--sha", sha, "--ios", "--ios"], ["--sha", sha, "--sha", sha],
    ["--sha", sha, "--IOS"], ["--sha", sha, "--ios=true"], ["--sha", sha, "extra"], ["--ios"]]) {
    assert.throws(() => releaseArguments(args), { message: "Usage: node scripts/require-release-checks.mjs --sha <full-sha> [--ios]" });
  }
});
test("the merged pull request number must be a positive safe integer, and a bad one is never shown", async () => {
  for (const number of ["2", email, 2.5, 0, -1, null]) {
    await assert.rejects(requireReleaseChecks(sha, fixture(d => {
      d.pulls[0].number = number;
      d.statuses[0].target_url = `https://github.com/${repo}/pull/${number}#issuecomment-123`;
    })), error => error.message === "GitHub returned a malformed pull request number." && !error.message.includes(String(number)));
  }
});
async function qualify(env, preload = []) {
  const checkout = await mkdtemp(join(tmpdir(), "release-checks-"));
  try {
    const git = args => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
      { cwd: checkout, encoding: "utf8" });
    git(["init", "--quiet"]);
    git(["commit", "--quiet", "--allow-empty", "-m", "test"]);
    const commit = git(["rev-parse", "HEAD"]).trim();
    return spawnSync(process.execPath, [...preload, new URL("./require-release-checks.mjs", import.meta.url).pathname,
      "--sha", commit], { cwd: checkout, encoding: "utf8", timeout: 30_000, env });
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
test("an unreadable GitHub reply fails with a message naming only the request's label", async () => {
  const body = `<html>contact ${email} {`;
  const original = { fetch: globalThis.fetch, token: process.env.GH_TOKEN };
  globalThis.fetch = async () => new Response(body, { status: 200 });
  process.env.GH_TOKEN = "test-token";
  try {
    await assert.rejects(githubApi(`/repos/${repo}/actions/workflows/${email}/runs?per_page=100`, "the Quality runs"), error =>
      error.message === "GitHub returned an unreadable response for the Quality runs.");
  } finally {
    globalThis.fetch = original.fetch;
    if (original.token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = original.token;
  }
  // The command prints that message alone, with no stack.
  const mock = `data:text/javascript,globalThis.fetch=async()=>new Response(${encodeURIComponent(JSON.stringify(body))},{status:200})`;
  const result = await qualify({ PATH: process.env.PATH, GH_TOKEN: "test-token" }, ["--import", mock]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "GitHub returned an unreadable response for the main branch.\n");
});
test("the local GitHub CLI fallback discards the CLI's diagnostics and shows only a fixed message", async () => {
  const bin = await mkdtemp(join(tmpdir(), "release-checks-gh-"));
  const secret = `${email} https://private.example.invalid/x?token=1`;
  try {
    for (const [script, message] of [
      [`echo '${secret}' >&2\nexit 1`, "GitHub CLI request for the main branch failed (exit 1).\n"],
      [`echo '{${secret}'\necho '${secret}' >&2`, "GitHub returned an unreadable response for the main branch.\n"],
    ]) {
      await writeFile(join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      const result = await qualify({ PATH: `${bin}:${process.env.PATH}` });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, message);
    }
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
