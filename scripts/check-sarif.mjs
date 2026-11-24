import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;

export function validateManifest(manifest) {
  if (!object(manifest) || Object.keys(manifest).sort().join(",") !== "records,schemaVersion,sourceManifestSha256" ||
      manifest.schemaVersion !== 1 || manifest.sourceManifestSha256 !== null ||
      !Array.isArray(manifest.records) || manifest.records.length !== 0) {
    fail("CodeQL requires an empty reviewed flow manifest with a null source digest.");
  }
}

export function classifyReports(reports) {
  if (!Array.isArray(reports) || !reports.length) fail("CodeQL produced no analysis reports.");
  let raw = 0;
  for (const report of reports) {
    if (!object(report) || report.version !== "2.1.0" || !Array.isArray(report.runs) || !report.runs.length) {
      fail("CodeQL report is incomplete.");
    }
    for (const run of report.runs) {
      if (!object(run.tool?.driver) || run.tool.driver.name !== "CodeQL" || !text(run.tool.driver.semanticVersion)) {
        fail("CodeQL driver/version metadata is missing.");
      }
      if ((run.properties?.incrementalMode !== undefined && run.properties.incrementalMode !== "") ||
          run.tool.extensions?.some(extension => extension.name === "codeql-action/pr-diff-range")) {
        fail("CodeQL requires full analysis.");
      }
      const pack = run.tool.extensions?.find(extension => extension.name === "codeql/javascript-queries");
      if (!text(pack?.semanticVersion) || !Array.isArray(pack.rules) || !pack.rules.length) {
        fail("CodeQL query-pack metadata is missing.");
      }
      for (const { rules } of [run.tool.driver, ...(run.tool.extensions ?? [])]) {
        if (rules !== undefined && (!Array.isArray(rules) || rules.some(rule => !text(rule?.id)) ||
            new Set(rules.map(rule => rule.id)).size !== rules.length)) {
          fail("CodeQL rule descriptors require distinct, explicit identities.");
        }
      }
      const queries = run.properties?.codeqlConfigSummary?.queries;
      if (!Array.isArray(queries) || queries.length !== 2 || queries.some(query => query.type !== "builtinSuite") ||
          queries.map(query => query.uses).sort().join(",") !== "security-and-quality,security-extended") {
        fail("CodeQL requires both complete security suites.");
      }
      if (run.externalPropertyFileReferences || !Array.isArray(run.results)) fail("CodeQL results are incomplete.");
      if (run.invocations?.some(invocation => invocation.executionSuccessful === false ||
          invocation.toolExecutionNotifications?.some(note => !["none", "note"].includes(note.level)))) {
        fail("CodeQL analysis did not complete successfully.");
      }
      raw += run.results.length;
    }
  }
  if (raw) fail(`CodeQL requires zero raw findings; received ${raw}.`);
  return { raw };
}

export async function readReports(directory) {
  if (!directory) fail("CodeQL report directory is missing.");
  const files = (await readdir(directory)).filter(file => file.endsWith(".sarif")).sort();
  if (!files.length) fail("CodeQL produced no analysis reports.");
  return Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = new URL("../.github/codeql/reviewed-flows.json", import.meta.url);
  validateManifest(JSON.parse(await readFile(manifest, "utf8")));
  const counts = classifyReports(await readReports(process.env.SARIF_DIRECTORY));
  console.log(`CodeQL: ${counts.raw} raw findings.`);
}
