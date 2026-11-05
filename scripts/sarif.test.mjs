import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyReports, describeResult, readReports, sourceManifest, REVIEWED_FLOWS_PATH,
} from "./check-sarif.mjs";
import { descriptions, proposeFlows } from "../.github/codeql/propose-flows.mjs";

const sourcePath = "products/shop/workers/video-renderer/src/stored-render.mjs";
const guardPath = "products/shop/workers/video-renderer/src/storage-contract.mjs";
const testPath = "products/shop/workers/video-renderer/src/stored-render.test.mjs";
const empty = () => ({ schemaVersion: 1, sourceManifestSha256: null, records: [] });
function location(path = sourcePath, line = 12) {
  return { message: { text: "rendered media" }, physicalLocation: {
    artifactLocation: { uri: path }, region: { startLine: line, startColumn: 3, endLine: line, endColumn: 8 },
  } };
}
function report(results = []) {
  return { version: "2.1.0", runs: [{ tool: {
    driver: { name: "CodeQL", semanticVersion: "2.27.4" },
    extensions: [{ name: "codeql/javascript-queries", semanticVersion: "2.5.0+synthetic",
      rules: [{ id: "js/file-access-to-http", properties: { "security-severity": "6.5" } }] }],
  }, properties: { codeqlConfigSummary: { queries: [{ type: "builtinSuite", uses: "security-and-quality" }, { type: "builtinSuite", uses: "security-extended" }] } }, results }] };
}
function finding() {
  return { ruleId: "js/file-access-to-http", level: "warning", message: { text: "File data in outbound request" },
    partialFingerprints: { primaryLocationLineHash: "synthetic-fingerprint:1" },
    locations: [location()], relatedLocations: [location(sourcePath, 4)],
    codeFlows: [{ message: { text: "First source" }, threadFlows: [{ locations: [
      { location: location(sourcePath, 4) }, { location: location() },
    ] }] }, { message: { text: "Second source" }, threadFlows: [{ locations: [
      { location: location(sourcePath, 6) }, { location: location() },
    ] }] }],
  };
}
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "bent-sarif-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const files = [sourcePath, guardPath, testPath, "products/shop/package.json", "packages/ui/src/button.tsx",
    "package.json", "bun.lock", "bunfig.toml", ".github/workflows/quality.yml", "scripts/check-sarif.mjs",
    "scripts/sarif.test.mjs", ".github/codeql/propose-flows.mjs", "AGENTS.md", "README.md", REVIEWED_FLOWS_PATH];
  for (const path of files) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), path === REVIEWED_FLOWS_PATH ? JSON.stringify(empty()) : `synthetic ${path}\n`);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  return { root, source: await sourceManifest(root) };
}
function reviewed(reports, source) {
  const description = describeResult(reports[0].runs[0], reports[0].runs[0].results[0]);
  return { schemaVersion: 1, sourceManifestSha256: source.sha256, records: [{
    id: "rendered-media-storage", disposition: "intentional-safe-flow", ruleId: description.ruleId,
    fingerprint: description.fingerprint, canonicalFlowSha256: description.canonicalFlowSha256,
    analysisSha256: description.analysisSha256,
    rationale: "The locally rendered video is intentionally stored at a fixed internal authenticated storage endpoint.",
    guardPaths: [guardPath], testPaths: [testPath],
    reviewReference: { requiredStatus: "Independent review", evidence: "Synthetic review venue; this text grants no approval." },
  }] };
}

test("empty ledger passes actual zero findings and rejects nonzero analysis", async context => {
  const { source } = await fixture(context);
  assert.deepEqual(classifyReports([report()], empty(), source), { raw: 0, reviewed: 0, unresolved: 0, details: [] });
  const counts = classifyReports([report([finding()])], empty(), source);
  assert.equal(counts.raw, 1); assert.equal(counts.reviewed, 0); assert.equal(counts.unresolved, 1);
});

test("exact source-matched disposition preserves every raw SARIF byte", async context => {
  const { root, source } = await fixture(context);
  const reports = [report([finding()])];
  const serialized = JSON.stringify(reports[0], null, 2);
  const directory = join(root, "reports");
  await mkdir(directory); await writeFile(join(directory, "analysis.sarif"), serialized);
  const loaded = await readReports(directory);
  const before = JSON.stringify(loaded);
  const counts = classifyReports(loaded, reviewed(reports, source), source);
  assert.equal(counts.raw, 1); assert.equal(counts.reviewed, 1); assert.equal(counts.unresolved, 0);
  assert.equal(JSON.stringify(loaded), before);
  assert.equal(await readFile(join(directory, "analysis.sarif"), "utf8"), serialized);
});

test("unknown findings remain unresolved beside an exact known flow", async context => {
  const { source } = await fixture(context);
  const reports = [report([finding()])];
  const manifest = reviewed(reports, source);
  const unknown = finding(); unknown.ruleId = "js/command-line-injection";
  reports[0].runs[0].results.push(unknown);
  const counts = classifyReports(reports, manifest, source);
  assert.equal(counts.reviewed, 1); assert.equal(counts.unresolved, 1);
});

test("JP, shared and non-Shop locations can never receive dispositions", async context => {
  const { source } = await fixture(context);
  for (const path of ["apps/jp/src/server.ts", "packages/ui/src/button.tsx", "apps/home/app/index.ts"]) {
    for (const field of ["primary", "related", "flow"]) {
      const result = finding();
      if (field === "primary") result.locations[0] = location(path);
      if (field === "related") result.relatedLocations[0] = location(path);
      if (field === "flow") result.codeFlows[1].threadFlows[0].locations[0].location = location(path);
      const reports = [report([result])];
      assert.equal(describeResult(reports[0].runs[0], result).eligible, false);
      assert.throws(() => classifyReports(reports, reviewed(reports, source), source), /unused or stale/);
      assert.equal(classifyReports(reports, empty(), source).unresolved, 1);
    }
  }
});

test("all traces, messages, fingerprints, tool and query metadata are bound", async context => {
  const { source } = await fixture(context);
  const original = [report([finding()])];
  const manifest = reviewed(original, source);
  const mutations = [
    run => { run.results[0].codeFlows[1].message.text = "changed second flow"; },
    run => { run.results[0].codeFlows[1].threadFlows[0].locations[1].location.message.text = "changed sink"; },
    run => { run.results[0].codeFlows[1].threadFlows[0].locations[0].location.physicalLocation.region.startColumn += 1; },
    run => { run.results[0].partialFingerprints.primaryLocationLineHash += "changed"; },
    run => { run.tool.driver.semanticVersion = "2.28.0"; },
    run => { run.tool.extensions[0].semanticVersion = "2.6.0"; },
    run => { run.tool.extensions[0].rules[0].properties["security-severity"] = "9.8"; },
    run => { run.properties.codeqlConfigSummary.queries.push({ uses: "another-suite" }); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original); mutate(changed[0].runs[0]);
    assert.throws(() => classifyReports(changed, manifest, source), /unused or stale|query configuration/);
  }
});

test("source, guards, tests, shared code, CI, dependencies and new files invalidate the global pin", async context => {
  const { root, source } = await fixture(context);
  const reports = [report([finding()])]; const manifest = reviewed(reports, source);
  for (const path of [sourcePath, guardPath, testPath, "packages/ui/src/button.tsx", "bun.lock", "package.json",
    "bunfig.toml", ".github/workflows/quality.yml", "scripts/check-sarif.mjs", "scripts/sarif.test.mjs", ".github/codeql/propose-flows.mjs", "AGENTS.md", "README.md"]) {
    const absolute = join(root, path); const before = await readFile(absolute);
    await writeFile(absolute, "changed\n");
    assert.throws(() => classifyReports(reports, manifest, { ...source, sha256: "0".repeat(64) }), /source manifest is stale/);
    const changed = await sourceManifest(root);
    assert.notEqual(changed.sha256, source.sha256, path);
    assert.throws(() => classifyReports(reports, manifest, changed), /source manifest is stale/);
    await writeFile(absolute, before);
  }
  for (const path of ["products/shop/new-guard.mjs", "packages/ui/new-guard.mjs", "root-config.json", ".github/new-config.json"]) {
    await writeFile(join(root, path), "new file\n");
    assert.notEqual((await sourceManifest(root)).sha256, source.sha256, path);
    await rm(join(root, path));
  }
  await writeFile(join(root, REVIEWED_FLOWS_PATH), "changed ledger\n");
  assert.equal((await sourceManifest(root)).sha256, source.sha256, "Ledger excludes only its own content.");
  await rm(join(root, guardPath));
  await assert.rejects(sourceManifest(root), /ENOENT/);
});

test("duplicate, reused, ambiguous, unused, missing and risk-acceptance records fail closed", async context => {
  const { source } = await fixture(context);
  const reports = [report([finding()])]; const manifest = reviewed(reports, source);
  const duplicate = structuredClone(manifest); duplicate.records.push(structuredClone(duplicate.records[0]));
  assert.throws(() => classifyReports(reports, duplicate, source), /Duplicate/);
  duplicate.records[1].id = "different-id";
  assert.throws(() => classifyReports(reports, duplicate, source), /ambiguous/);
  assert.throws(() => classifyReports([report()], manifest, source), /unused or stale/);
  const repeated = [report([finding(), finding()])];
  assert.equal(classifyReports(repeated, manifest, source).unresolved, 1, "One review cannot consume duplicate results.");
  const risk = structuredClone(manifest); risk.records[0].disposition = "risk-accepted";
  assert.throws(() => classifyReports(reports, risk, source), /safe-flow evidence/);
  const pending = structuredClone(manifest); pending.records[0].reviewReference = null;
  assert.throws(() => classifyReports(reports, pending, source), /external review reference/);
  const missing = structuredClone(manifest); missing.records[0].guardPaths = ["products/shop/missing.mjs"];
  assert.throws(() => classifyReports(reports, missing, source), /source is missing/);
  const head = structuredClone(manifest); head.head = "synthetic-sha";
  assert.throws(() => classifyReports(reports, head, source), /manifest fields/);
});

test("malformed reports, failed analysis and unsupported paths cannot masquerade as clean", async context => {
  const { source } = await fixture(context);
  const malformed = [[], [{}], [{ version: "2.1.0", runs: [] }], [report()]];
  delete malformed[3][0].runs[0].results;
  for (const reports of malformed) assert.throws(() => classifyReports(reports, empty(), source));
  for (const mutate of [
    run => { delete run.tool.driver.semanticVersion; },
    run => { delete run.properties.codeqlConfigSummary; },
    run => { delete run.tool.extensions; },
    run => { run.invocations = [{ executionSuccessful: false }]; },
    run => { run.results = [{}]; },
    run => { delete run.results[0].locations[0].physicalLocation.region; },
  ]) {
    const changed = report([finding()]); mutate(changed.runs[0]);
    assert.throws(() => classifyReports([changed], empty(), source));
  }
  for (const uri of ["../apps/jp/src/server.ts", "products/shop/../jp/server.ts", "/absolute/path", "file:///source.mjs", "products/shop/%2e%2e/server.ts"]) {
    const changed = report([finding()]); changed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = uri;
    assert.throws(() => classifyReports([changed], empty(), source), /SARIF location/);
  }
});


test("proposal helper requires separate source-matched guard assessments and never supplies approval", async context => {
  const { source } = await fixture(context);
  const reports = [report([finding()])];
  const original = JSON.stringify(reports);
  const records = reviewed(reports, source).records;
  const assessment = { ...records[0] };
  delete assessment.reviewReference;
  const guardLedger = { schemaVersion: 1, sourceManifestSha256: source.sha256, assessments: [assessment] };
  const proposal = proposeFlows(reports, guardLedger, source);
  assert.equal(proposal.candidates.length, 1);
  assert.equal(proposal.unresolved.length, 0);
  assert.equal(proposal.candidates[0].reviewReference, null);
  assert.match(proposal.status, /No independent approval/);
  assert.equal(JSON.stringify(reports), original);
  assert.throws(() => classifyReports(reports, { schemaVersion: 1,
    sourceManifestSha256: proposal.sourceManifestSha256, records: proposal.candidates }, source), /external review reference/);
  assert.equal(descriptions(reports, source).length, 1);
  assert.equal(proposeFlows(reports, { ...guardLedger, assessments: [] }, source).unresolved.length, 1);
  assert.throws(() => proposeFlows(reports, { ...guardLedger, sourceManifestSha256: "0".repeat(64) }, source), /source-matched/);
  const changedTool = structuredClone(reports); changedTool[0].runs[0].tool.driver.semanticVersion = "2.28.0";
  assert.throws(() => proposeFlows(changedTool, guardLedger, source), /stale or unused/);
  const stale = structuredClone(guardLedger); stale.assessments[0].canonicalFlowSha256 = "0".repeat(64);
  assert.throws(() => proposeFlows(reports, stale, source), /stale or unused/);
  const duplicate = structuredClone(guardLedger); duplicate.assessments.push(structuredClone(assessment));
  assert.throws(() => proposeFlows(reports, duplicate, source), /ambiguous/);
  const noGuard = structuredClone(guardLedger); noGuard.assessments[0].guardPaths = [];
  assert.throws(() => proposeFlows(reports, noGuard, source), /guards and tests/);
  const risk = structuredClone(guardLedger); risk.assessments[0].disposition = "risk-accepted";
  assert.throws(() => proposeFlows(reports, risk, source), /safe flow/);
});

test("CLI reports raw counts honestly and fails nonzero findings with a blank ledger", async context => {
  const { root } = await fixture(context);
  const directory = join(root, "reports");
  await mkdir(directory);
  const path = join(directory, "analysis.sarif");
  const checker = new URL("./check-sarif.mjs", import.meta.url).pathname;
  const options = { cwd: root, env: { ...process.env, SARIF_DIRECTORY: directory }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  await writeFile(path, JSON.stringify(report()));
  assert.match(execFileSync(process.execPath, [checker], options), /0 raw, 0 source-matched dispositions, 0 unresolved/);
  await writeFile(path, JSON.stringify(report([finding()])));
  assert.throws(() => execFileSync(process.execPath, [checker], options), error =>
    error.status === 1 && /1 raw, 0 source-matched dispositions, 1 unresolved/.test(error.stdout));
});

test("artifact indexes resolve without losing scope and conflicting paths are rejected", async context => {
  const { source } = await fixture(context);
  const original = report([finding()]);
  const manifest = reviewed([original], source);
  const indexed = structuredClone(original);
  indexed.runs[0].artifacts = [{ location: { uri: sourcePath } }];
  for (const step of indexed.runs[0].results[0].codeFlows[0].threadFlows[0].locations) {
    step.location.physicalLocation.artifactLocation = { index: 0 };
  }
  assert.equal(classifyReports([indexed], manifest, source).reviewed, 1);
  indexed.runs[0].artifacts[0].location.uri = "apps/jp/src/private.ts";
  assert.equal(describeResult(indexed.runs[0], indexed.runs[0].results[0]).eligible, false);
  indexed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.index = 0;
  assert.throws(() => classifyReports([indexed], empty(), source), /Conflicting SARIF/);
});
