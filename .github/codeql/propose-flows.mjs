// Read-only proposal generator. It never writes the accepted ledger, sets a
// review status, edits SARIF or dismisses an alert. A maintainer supplies the
// evidence venue; genuine exact-head approval remains an external merge gate.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonical, classifyReports, describeResult, readReports, sourceManifest,
} from "../../scripts/check-sarif.mjs";

export function descriptions(reports, source) {
  classifyReports(reports, { schemaVersion: 1, sourceManifestSha256: null, records: [] }, source);
  return reports.flatMap(report => report.runs.flatMap(run => run.results.map(result => describeResult(run, result))));
}

export function proposeFlows(reports, guardLedger, source) {
  if (guardLedger?.schemaVersion !== 1 || guardLedger.sourceManifestSha256 !== source.sha256 ||
      Object.keys(guardLedger).sort().join(",") !== "assessments,schemaVersion,sourceManifestSha256" ||
      !Array.isArray(guardLedger.assessments)) {
    throw new Error("A source-matched, separate per-flow guard assessment ledger is required.");
  }
  const known = descriptions(reports, source);
  const candidates = [];
  const unresolved = [];
  const consumed = new Set();
  const ids = new Set();
  for (const description of known) {
    const matches = guardLedger.assessments.filter(assessment => assessment.ruleId === description.ruleId &&
      canonical(assessment.fingerprint) === canonical(description.fingerprint) &&
      assessment.canonicalFlowSha256 === description.canonicalFlowSha256 && assessment.analysisSha256 === description.analysisSha256);
    if (!description.eligible || matches.length !== 1 || consumed.has(matches[0])) {
      unresolved.push(description);
      continue;
    }
    const assessment = matches[0];
    const expected = ["id", "disposition", "ruleId", "fingerprint", "canonicalFlowSha256", "analysisSha256", "rationale", "guardPaths", "testPaths"];
    if (Object.keys(assessment).sort().join("\0") !== expected.sort().join("\0") ||
        typeof assessment.id !== "string" || !/^[a-z0-9-]+$/.test(assessment.id) || ids.has(assessment.id) ||
        assessment.disposition !== "intentional-safe-flow" || typeof assessment.rationale !== "string" || assessment.rationale.trim().length < 40) {
      throw new Error("Guard assessment must explicitly describe a distinct, reviewed safe flow.");
    }
    for (const field of ["guardPaths", "testPaths"]) {
      if (!Array.isArray(assessment[field]) || !assessment[field].length ||
          new Set(assessment[field]).size !== assessment[field].length ||
          assessment[field].some(path => typeof path !== "string" || !path.startsWith("products/shop/") || !source.paths.has(path))) {
        throw new Error("Guard assessment requires existing, pinned Shop guards and tests.");
      }
    }
    if (description.paths.some(path => !source.paths.has(path))) throw new Error("Flow source is missing from the source manifest.");
    consumed.add(assessment); ids.add(assessment.id);
    candidates.push({ ...assessment, reviewReference: null });
  }
  if (consumed.size !== guardLedger.assessments.length) throw new Error("Guard assessments are ambiguous, stale or unused.");
  return {
    schemaVersion: 1, sourceManifestSha256: source.sha256,
    status: "Proposal only. No independent approval or alert dismissal has occurred.",
    candidates, unresolved,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, guardPath] = process.argv.slice(2);
  if (!["--describe", "--guards"].includes(mode) || !directory || (mode === "--guards" && !guardPath)) {
    throw new Error("Use --describe SARIF_DIRECTORY or --guards SARIF_DIRECTORY GUARD_LEDGER_JSON.");
  }
  const source = await sourceManifest(process.cwd());
  const reports = await readReports(directory);
  const output = mode === "--describe"
    ? { sourceManifestSha256: source.sha256, results: descriptions(reports, source) }
    : proposeFlows(reports, JSON.parse(await readFile(guardPath, "utf8")), source);
  console.log(JSON.stringify(output, null, 2));
}
