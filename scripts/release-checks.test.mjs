import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubApi, needsReview, releaseArguments, requireReleaseChecks, validateReleaseEvent } from "./require-release-checks.mjs";
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
  assert.ok(native.includes("    needs: ci-scope\n    if: needs.ci-scope.outputs.ios_native == 'true'\n    runs-on: macos-26\n    timeout-minutes: 20\n"));
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
  assert.deepEqual(declared, ["codeql-swift-app", "codeql-swift-tools", "simulator-flow", "verification"]);
  const job = name => qualityJob(source, name);
  for (const [name, scope, traces] of [["codeql-swift-app", "app", ["native.mjs replay-swift app"]],
    ["codeql-swift-tools", "tools", ["native.mjs replay-swift seeder", "native.mjs core-build"]]]) {
    const codeql = job(name);
    assert.ok(codeql.includes(`    name: CodeQL Swift (${scope})\n    runs-on: macos-26\n    timeout-minutes: 27\n`));
    assert.match(codeql, /^    permissions:\n      contents: read\n(      #.*\n)?      security-events: read\n    steps:\n/m);
    assert.ok(codeql.includes("CODEQL_ACTION_DIFF_INFORMED_QUERIES: 'false'"));
    assert.ok(codeql.includes("CODEQL_ACTION_OVERLAY_ANALYSIS: 'false'"));
    assert.ok(codeql.includes("languages: swift\n          build-mode: manual\n          queries: security-extended,security-and-quality\n"));
    assert.ok(codeql.includes("--install-rosetta"));
    assert.ok(codeql.includes(`category: fitness-codeql-swift-${scope}\n          output: \${{ runner.temp }}/codeql-swift-results\n          upload: never\n          upload-database: false\n`));
    assert.ok(codeql.includes("CODEQL_LANGUAGES: swift\n        run: node scripts/check-sarif.mjs\n"));
    assert.ok(codeql.includes(`node scripts/codeql-coverage.mjs --scope ${scope} "$RUNNER_TEMP/codeql_databases/swift"`));
    assert.ok(codeql.includes(`        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: codeql-swift-${scope}-original-sarif\n          path: \${{ runner.temp }}/codeql-swift-results/*.sarif\n          if-no-files-found: error\n          retention-days: 90\n`));
    assert.ok(codeql.includes(`name: codeql-swift-${scope}-extractor-logs`));
    // Every trace runs after init and before the single analysis, in order.
    const positions = traces.map(trace => codeql.indexOf(`run: time node scripts/${trace}\n`));
    assert.ok(positions.every(position => position > codeql.indexOf("codeql-action/init@")), name);
    assert.deepEqual([...positions].sort((x, y) => x - y), positions, name);
    assert.ok(positions.at(-1) < codeql.indexOf("codeql-action/analyze@"), name);
    assert.equal(codeql.match(/codeql-action\/(init|analyze)@/g).length, 2, name);
    // The CodeQL builds compile one unoptimised arm64 Simulator slice without a dSYM.
    assert.ok(codeql.includes("          XCODEBUILD_SETTINGS: >-\n" +
      "            CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO\n" +
      "            ARCHS=arm64 ONLY_ACTIVE_ARCH=YES\n" +
      "            SWIFT_COMPILATION_MODE=wholemodule SWIFT_PRECOMPILE_BRIDGING_HEADER=NO\n" +
      "            SWIFT_OPTIMIZATION_LEVEL=-Onone GCC_OPTIMIZATION_LEVEL=0\n" +
      "            DEBUG_INFORMATION_FORMAT=dwarf\n"), name);
  }
  assert.ok(job("codeql-swift-app").includes("SKIP_BUNDLING: '1'"));
  assert.ok(job("codeql-swift-app").includes("run: |\n          node scripts/native.mjs prebuild\n          node scripts/native.mjs build\n"));
  // The tools job builds the seeder untraced, then traces it and the module's package into one database.
  const tools = job("codeql-swift-tools");
  assert.ok(tools.indexOf("run: node scripts/native.mjs seeder\n") < tools.indexOf("codeql-action/init@"));
  assert.ok(!tools.includes("./.github/actions/setup"));
  assert.ok(tools.includes("uses: actions/setup-node@"));
  const flows = job("simulator-flow");
  assert.ok(flows.includes("    name: Simulator flow (${{ matrix.label }})\n    runs-on: macos-26\n    timeout-minutes: ${{ matrix.timeout }}\n"));
  assert.match(flows, /^    env:\n(      #.*\n)*      XCODEBUILD_SETTINGS: ARCHS=arm64 ONLY_ACTIVE_ARCH=YES\n    strategy:\n      fail-fast: false\n/m);
  for (const [label, flow, native, minutes] of [["denied", "testDeniedHealthAccessSendsNothing", "production", 27],
    ["allowed", "testAllowedHealthAccessSyncsTheSeededHistory", "module", 25],
    ["partial", "testPartialHealthAccessHoldsRunsWithoutDistance", "none", 25]]) {
    assert.ok(flows.includes(`          - label: ${label}\n            flow: ${flow}\n            native: ${native}\n            timeout: ${minutes}\n`));
  }
  assert.ok(flows.includes("FLOW: ${{ matrix.flow }}\n        run: node scripts/flows.mjs \"$FLOW\"\n"));
  // The native suite runs in the flow shards: each check once, in its own named step, before the flow.
  const steps = flows.split("\n      - ").slice(1).map(body => `${body}\n`);
  const step = run => {
    const found = steps.filter(body => body.includes(`run: ${run}\n`));
    assert.equal(found.length, 1, run);
    return found[0];
  };
  const flowStep = steps.indexOf(step('node scripts/flows.mjs "$FLOW"'));
  for (const [run, native] of [
    ["node scripts/native.mjs lint", "module"],
    ["node scripts/native.mjs core-test", "module"],
    ["node scripts/roundtrip.mjs", "module"],
    ["node scripts/native.mjs prebuild", "production"],
    ['NATIVE_BUILD_DIR="$PRODUCTION_BUILD_DIR" node scripts/native.mjs build', "production"],
    ['NATIVE_BUILD_DIR="$PRODUCTION_BUILD_DIR" node scripts/native.mjs artifact', "production"],
  ]) {
    const body = step(run);
    assert.match(body, /^name: \S/, run);
    assert.ok(body.includes(`\n        if: matrix.native == '${native}'\n`), run);
    assert.ok(steps.indexOf(body) < flowStep, run);
    if (native === "production") assert.ok(body.includes("        env:\n          APP_VARIANT: production\n"), run);
  }
  assert.ok(step("node scripts/native.mjs lint").includes("name: Lint the Swift sources\n"));
  assert.ok(steps.findIndex(body => body.startsWith("name: Install verified SwiftLint\n        if: matrix.native == 'module'\n")) <
    steps.indexOf(step("node scripts/native.mjs lint")));
  // The production build is checked before the flow's development prebuild replaces ios/.
  const production = ["prebuild", "build", "artifact"].map(name =>
    steps.findIndex(body => body.includes(`node scripts/native.mjs ${name}\n`)));
  assert.deepEqual([...production].sort((x, y) => x - y), production);
  assert.ok(steps.findIndex(body => body.startsWith("name: Start a temporary Postgres\n")) < steps.indexOf(step("node scripts/roundtrip.mjs")));
  const aggregate = job("verification");
  assert.ok(aggregate.includes("    name: Fitness iOS verification\n    if: always()\n"));
  assert.deepEqual(jobDependencies(aggregate), declared.filter(name => name !== "verification"));
  assert.ok(aggregate.includes('const expected = ["codeql-swift-app", "codeql-swift-tools", "simulator-flow"];'));
  assert.ok(aggregate.includes('Object.values(jobs).some(job => job.result !== "success")'));
});

test("Fitness iOS Verification never uploads to Code Scanning and keeps each original SARIF report", async () => {
  const source = await verifySource();
  // A category uploaded from main alone would leave GitHub's CodeQL check on every pull request neutral.
  assert.ok(!source.includes("security-events: write"));
  assert.ok(!source.includes("codeql-action/upload-sarif"));
  assert.ok(!/^\s*upload: (?!never$)/m.test(source));
  const analyses = [...source.matchAll(/uses: github\/codeql-action\/analyze@\S+\n        with:\n((?:          .*\n)+)/g)];
  assert.equal(analyses.length, 2);
  for (const [, inputs] of analyses) {
    assert.match(inputs, /^          upload: never$/m);
    assert.match(inputs, /^          upload-database: false$/m);
    assert.match(inputs, /^          output: \$\{\{ runner\.temp \}\}\/codeql-swift-results$/m);
  }
  assert.ok(!/^\s*upload-database: (?!false$)/m.test(source));
  assert.equal(source.match(/uses: github\/codeql-action\/analyze@/g).length, 2);
  assert.equal(source.match(/run: node scripts\/check-sarif\.mjs\n/g).length, 2);
  assert.equal(source.match(/name: codeql-swift-(app|tools)-original-sarif\n/g).length, 2);
});

const timeouts = (source, name) => {
  const body = qualityJob(source, name);
  return { body, minutes: Number(body?.match(/^    timeout-minutes: (\d+)$/m)?.[1]) };
};
test("every Quality job stops within 20 minutes and the longest job chain stays under 30", async () => {
  const source = await qualitySource();
  const declared = [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(match => match[1]);
  const limits = Object.fromEntries(declared.map(name => [name, timeouts(source, name)]));
  for (const [name, { minutes }] of Object.entries(limits)) {
    assert.ok(Number.isInteger(minutes) && minutes > 0 && minutes <= 20, `${name} needs a job timeout of at most 20 minutes`);
  }
  assert.equal(limits["browser-suite"].minutes, 15);
  const needs = body => body.match(/^    needs: (?:\[([^\]]+)\]|(\S+))$/m)?.slice(1).find(Boolean)?.split(",").map(value => value.trim()) ?? [];
  const longest = name => limits[name].minutes + Math.max(0, ...needs(limits[name].body).map(longest));
  assert.ok(longest("release-qualification") < 30, `The longest Quality chain takes ${longest("release-qualification")} minutes`);
});
test("Fitness iOS Verification runs at most five macOS jobs side by side and finishes within 30 minutes", async () => {
  const source = await verifySource();
  const declared = [...source.split("\njobs:\n")[1].matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(match => match[1]);
  const needs = body => body.match(/^    needs: (?:\[([^\]]+)\]|(\S+))$/m)?.slice(1).find(Boolean)?.split(",").map(value => value.trim()) ?? [];
  // Each job, with a matrix expanded to one entry per shard and its own time limit.
  const jobs = Object.fromEntries(declared.map(name => {
    const body = qualityJob(source, name);
    const shards = [...(body.split("\n        include:\n")[1] ?? "").matchAll(/^          - label: (\S+)\n((?:            .*\n)*)/gm)]
      .map(([, label, fields]) => ({ label, timeout: Number(fields.match(/^            timeout: (\d+)$/m)?.[1]) }));
    const limit = body.match(/^    timeout-minutes: (.+)$/m)?.[1];
    const minutes = limit === "${{ matrix.timeout }}" ? shards.map(shard => shard.timeout) : [Number(limit)];
    if (limit === "${{ matrix.timeout }}") assert.ok(shards.length > 0, name);
    for (const value of minutes) assert.ok(Number.isInteger(value) && value > 0 && value <= 27, `${name} needs a job timeout of at most 27 minutes`);
    return [name, { macos: /^    runs-on: macos-/m.test(body), runners: Math.max(1, shards.length), minutes, needs: needs(body) }];
  }));
  // The repository runs at most five macOS jobs at a time, so every macOS job starts at once and none waits for another.
  const macos = declared.filter(name => jobs[name].macos);
  assert.equal(macos.reduce((total, name) => total + jobs[name].runners, 0), 5);
  for (const name of macos) assert.deepEqual(jobs[name].needs, [], `${name} must not wait for another job`);
  assert.ok(!source.includes("max-parallel"));
  // The worst case follows the dependency graph with every job running to its time limit.
  const worst = name => Math.max(...jobs[name].minutes) + Math.max(0, ...jobs[name].needs.map(worst));
  assert.deepEqual(jobs.verification.needs, macos);
  assert.equal(jobs.verification.macos, false);
  assert.ok(Math.max(...declared.map(worst)) < 30, `A Fitness iOS Verification run can take ${Math.max(...declared.map(worst))} minutes`);
  assert.equal(worst("verification"), 29);
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
function fixture(change = () => {}) {
  const data = {
    main: { object: { sha } }, workflow: structuredClone(workflow), runs: [structuredClone(run)],
    jobs: names.map(name => ({ name, head_sha: sha, status: "completed", conclusion: "success" })),
    pulls: [{ number: 2, merged_at: "2026-11-05T00:00:00Z", merge_commit_sha: sha,
      base: { ref: "main", repo: { full_name: repo } }, head: { sha: head, repo: { full_name: repo } } }],
    checks: [{ name: "CodeQL", app: { slug: "github-advanced-security" }, head_sha: head, status: "completed", conclusion: "success" }],
    statuses: [{ context: "Independent review", state: "success", target_url: `https://github.com/${repo}/pull/2#issuecomment-123` }],
    files: [{ filename: "apps/fitness/src/server/devices.ts" }],
    finalRun: structuredClone(run),
  };
  change(data);
  let mainCalls = 0;
  let qualityLists = 0;
  const api = async path => {
    api.paths.push(path);
    if (path.endsWith("/git/ref/heads/main")) return data.changedMain && ++mainCalls > 1 ? data.changedMain : data.main;
    if (path.endsWith("/workflows/quality.yml")) return data.workflow;
    // A later listing answers with the runs that appeared while qualification was under way.
    if (path.includes("/workflows/12/runs?")) return { workflow_runs: ++qualityLists > 1 && data.laterRuns || data.runs };
    if (path.includes("/attempts/2/jobs?")) return { jobs: data.jobs };
    if (path.includes("/check-runs?")) return { check_runs: data.checks };
    if (path.includes("/pulls/2/files?")) return data.files;
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
  // The Quality run is read and listed again after every other inspection, and main is read last.
  assert.deepEqual(api.paths.slice(-3).map(path => path.replace(/runs\?.*$/, "runs?")), [
    "/repos/bentbrain/bent-mono/actions/runs/23", "/repos/bentbrain/bent-mono/actions/workflows/12/runs?",
    "/repos/bentbrain/bent-mono/git/ref/heads/main"]);
  // Release qualification reads only the Quality workflow's runs.
  assert.ok(!api.paths.some(path => path.includes("fitness-ios-verify")));
});
test("a newer run or a new attempt that appears during qualification supersedes the selected run", async () => {
  const changed = { message: "Release qualification changed during inspection." };
  const qualitySuperseded = [
    d => { d.laterRuns = [d.runs[0], { ...run, id: 24, status: "in_progress", conclusion: null, run_attempt: 1 }]; },
    d => { d.laterRuns = [d.runs[0], { ...run, id: 24, run_attempt: 1 }]; },
    d => { d.laterRuns = [{ ...run, run_attempt: 3, status: "queued", conclusion: null }]; },
    d => { d.laterRuns = [{ ...run, conclusion: "failure" }]; },
    // The selected run disappears from the listing.
    d => { d.laterRuns = [{ ...run, id: 7 }]; },
  ];
  for (const mutate of qualitySuperseded) await assert.rejects(requireReleaseChecks(sha, fixture(mutate)), changed);
  // A newer run outside the eligible set does not supersede the selected one.
  const ignored = d => {
    d.laterRuns = [d.runs[0], { ...run, id: 24, head_sha: head }, { ...run, id: 25, event: "pull_request" },
      { ...run, id: 26, head_branch: "topic" }, { ...run, id: 27, head_repository: { full_name: "fork/repo" } }];
  };
  assert.deepEqual(await requireReleaseChecks(sha, fixture(ignored)), { sha, qualityRunId: 23, qualityAttempt: 2, pullRequest: 2 });
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
test("the command takes exactly one --sha", () => {
  assert.deepEqual(releaseArguments(["--sha", sha]), { sha });
  for (const args of [[], ["--sha"], [sha], ["--sha", sha, "--ios"], ["--ios", "--sha", sha], ["--sha", sha, "--sha", sha],
    ["--sha", sha, "extra"], ["--SHA", sha]]) {
    assert.throws(() => releaseArguments(args), { message: "Usage: node scripts/require-release-checks.mjs --sha <full-sha>" });
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

test("only pull requests that change application, package or release code need review evidence", async () => {
  for (const filename of ["apps/fitness/src/routes/privacy.tsx", "packages/ui/src/button.tsx", "products/drive/app.ts",
    "scripts/release-vercel.mjs", "scripts/require-release-checks.mjs", ".github/workflows/deploy-fitness-ios.yml", "AGENTS.md",
    "package.json", "bun.lock", "bunfig.toml", ".github/actions/setup/action.yml", "scripts/vercel-bun.mjs",
    "scripts/vercel-ignore-build.mjs", "scripts/require-no-pending-migrations.mjs"]) {
    assert.equal(needsReview([{ filename: "README.md" }, { filename }]), true, filename);
    assert.equal(needsReview([{ filename }]), true, `${filename} alone`);
  }
  assert.equal(needsReview([]), true);
  assert.equal(needsReview([{ filename: "docs/new.md", status: "renamed" }]), true);
  assert.throws(() => needsReview([{ filename: "" }]), /malformed pull request file/);
  for (const filename of ["README.md", "docs/setup.md", ".github/workflows/quality.yml", "scripts/ci-scope.mjs", "turbo.json"]) {
    assert.equal(needsReview([{ filename }]), false, filename);
  }
  assert.equal(needsReview([{ filename: "docs/moved.md", previous_filename: "apps/fitness/README.md" }]), true);
  assert.equal(needsReview(Array.from({ length: 3000 }, (_, i) => ({ filename: `docs/${i}.md` }))), true);
  assert.equal(needsReview(null), true);
  assert.throws(() => needsReview([{ filename: 7 }]), /malformed pull request file/);
  const ciOnly = d => { d.files = [{ filename: ".github/workflows/quality.yml" }, { filename: "README.md" }]; d.statuses = []; };
  assert.equal((await requireReleaseChecks(sha, fixture(ciOnly))).pullRequest, 2);
  const unreviewedApp = d => { d.statuses = []; };
  await assert.rejects(requireReleaseChecks(sha, fixture(unreviewedApp)), /independent review evidence/);
  const ciOnlyFailedCodeQL = d => { ciOnly(d); d.checks[0].conclusion = "failure"; };
  await assert.rejects(requireReleaseChecks(sha, fixture(ciOnlyFailedCodeQL)), /Native CodeQL/);
});
