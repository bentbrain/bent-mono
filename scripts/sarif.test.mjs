import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyReports, parseLanguages, readReports, validateManifest } from "./check-sarif.mjs";

function report(language = "javascript") {
  const rule = language === "swift" ? "swift/cleartext-transmission" : "js/request-forgery";
  return { version: "2.1.0", runs: [{
    tool: { driver: { name: "CodeQL", semanticVersion: "2.27.4" }, extensions: [{
      name: `codeql/${language}-queries`, semanticVersion: "2.1.0", rules: [{ id: rule }],
    }] },
    properties: { codeqlConfigSummary: { queries: [
      { type: "builtinSuite", uses: "security-extended" }, { type: "builtinSuite", uses: "security-and-quality" },
    ] } },
    invocations: [{ executionSuccessful: true }], results: [],
  }] };
}

test("complete successful analysis requires zero raw findings in every report", () => {
  assert.deepEqual(classifyReports([report(), report()]), { raw: 0 });
  for (const result of [{ ruleId: "js/request-forgery" }, { level: "note" }, { suppressions: [{ status: "accepted" }] }]) {
    const changed = report(); changed.runs[0].results.push(result);
    assert.throws(() => classifyReports([report(), changed]), /zero raw findings/);
  }
});

test("missing, partial, failed and incremental analyses cannot pass", () => {
  for (const reports of [[], null, [{}], [{ version: "2.1.0", runs: [] }]]) assert.throws(() => classifyReports(reports));
  const mutations = [
    run => { delete run.tool.driver.semanticVersion; },
    run => { run.tool.driver.name = "Other"; },
    run => { run.tool.extensions = []; },
    run => { run.tool.extensions[0].rules = []; },
    run => { run.tool.extensions[0].rules.push(run.tool.extensions[0].rules[0]); },
    run => { run.properties.codeqlConfigSummary.queries.pop(); },
    run => { run.properties.codeqlConfigSummary.queries[0].type = "custom"; },
    run => { run.properties.incrementalMode = "overlay"; },
    run => { run.tool.extensions.push({ name: "codeql-action/pr-diff-range" }); },
    run => { run.externalPropertyFileReferences = {}; },
    run => { delete run.results; },
    run => { run.invocations[0].executionSuccessful = false; },
    run => { run.invocations[0].toolExecutionNotifications = [{ level: "warning" }]; },
    run => { run.invocations[0].toolExecutionNotifications = [{ message: { text: "unknown severity" } }]; },
  ];
  for (const mutate of mutations) { const changed = report(); mutate(changed.runs[0]); assert.throws(() => classifyReports([changed])); }
});

test("the manifest permits zero reviewed exceptions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.github/codeql/reviewed-flows.json", import.meta.url), "utf8"));
  validateManifest(manifest);
  assert.throws(() => validateManifest({ ...manifest, sourceManifestSha256: "0".repeat(64) }), /empty reviewed flow manifest/);
  assert.throws(() => validateManifest({ ...manifest, records: [{ id: "example" }] }), /empty reviewed flow manifest/);
});

test("the reader retains all original SARIF inputs and rejects missing or malformed files", async context => {
  const directory = await mkdtemp(join(tmpdir(), "sarif-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(readReports());
  await assert.rejects(readReports(directory));
  await writeFile(join(directory, "a.sarif"), JSON.stringify(report()));
  await writeFile(join(directory, "b.sarif"), JSON.stringify(report()));
  await writeFile(join(directory, "ignored.txt"), "not a report");
  assert.equal((await readReports(directory)).length, 2);
  await writeFile(join(directory, "b.sarif"), "malformed");
  await assert.rejects(readReports(directory));
});

test("each language's query pack is required and accepted only when requested", () => {
  assert.deepEqual(classifyReports([report("swift")], ["swift"]), { raw: 0 });
  assert.deepEqual(classifyReports([report(), report("swift")], ["javascript", "swift"]), { raw: 0 });
  assert.throws(() => classifyReports([report("swift")]), /query-pack metadata/);
  assert.throws(() => classifyReports([report()], ["swift"]), /query-pack metadata/);
  assert.throws(() => classifyReports([report()], ["javascript", "swift"]), /missing codeql\/swift-queries/);
  const both = report();
  both.runs[0].tool.extensions.push(report("swift").runs[0].tool.extensions[0]);
  assert.throws(() => classifyReports([both], ["javascript", "swift"]), /query-pack metadata/);
  const finding = report("swift"); finding.runs[0].results.push({ ruleId: "swift/cleartext-transmission" });
  assert.throws(() => classifyReports([finding], ["swift"]), /zero raw findings/);
});

test("languages are a distinct list of known analyses", () => {
  assert.deepEqual(parseLanguages(), ["javascript"]);
  assert.deepEqual(parseLanguages("swift"), ["swift"]);
  assert.deepEqual(parseLanguages("javascript, swift"), ["javascript", "swift"]);
  for (const value of ["", "python", "swift,swift", "constructor"]) assert.throws(() => parseLanguages(value));
});
