import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REVIEWED_FLOWS_PATH = ".github/codeql/reviewed-flows.json";
const ELIGIBLE_RULES = new Set([
  "js/file-access-to-http", "js/http-to-file-access", "js/request-forgery",
]);
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const fail = message => { throw new Error(message); };

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

function keys(value, expected, context) {
  if (!object(value) || Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    fail(`Invalid ${context} fields.`);
  }
}

function repositoryPath(uri) {
  if (!text(uri) || uri.includes("\\") || uri.includes("%") || uri.startsWith("/") || uri.includes(":")) {
    fail("SARIF location must be an unescaped repository-relative path.");
  }
  if (uri.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    fail("SARIF location escapes the repository.");
  }
  return uri;
}

// Git-tracked files plus new, nonignored files catch additions before staging.
// The ledger is excluded because it stores this digest. The verifier and its
// tests, CI, dependency graph and every Shop/shared file remain included.
export async function sourceManifest(root) {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  const included = path => path !== REVIEWED_FLOWS_PATH && (
    path.startsWith("products/shop/") || path.startsWith("packages/") ||
    path.startsWith("scripts/") || path.startsWith(".github/") ||
    !path.includes("/")
  );
  const entries = [];
  for (const path of [...new Set(files.filter(included))].sort()) {
    repositoryPath(path);
    const absolute = join(root, path);
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile()) fail(`Source manifest requires a regular file: ${path}`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.nlink !== after.nlink) {
        fail(`Source manifest file changed during inspection: ${path}`);
      }
      entries.push([path, createHash("sha256").update(bytes).digest("hex")]);
    } finally {
      await handle.close();
    }
  }
  return { sha256: digest(entries), paths: new Set(entries.map(([path]) => path)) };
}

function normalizeLocations(value, run, paths) {
  if (Array.isArray(value)) return value.map(item => normalizeLocations(item, run, paths));
  if (!object(value)) return value;
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "physicalLocation") {
      const region = child?.region;
      if (!object(child) || !object(child.artifactLocation) || !object(region) ||
          !Number.isSafeInteger(region.startLine) || region.startLine < 1 ||
          (region.endLine !== undefined && (!Number.isSafeInteger(region.endLine) || region.endLine < region.startLine))) {
        fail("Invalid SARIF physical location/region.");
      }
    }
    if (key !== "artifactLocation") {
      normalized[key] = normalizeLocations(child, run, paths);
      continue;
    }
    if (!object(child)) fail("Invalid SARIF artifact location.");
    const indexed = child.index === undefined ? undefined : run.artifacts?.[child.index]?.location?.uri;
    if (child.index !== undefined && (!Number.isSafeInteger(child.index) || child.index < 0 || !text(indexed))) {
      fail("Invalid SARIF artifact index.");
    }
    if (child.uri !== undefined && indexed !== undefined && child.uri !== indexed) fail("Conflicting SARIF artifact locations.");
    const uri = repositoryPath(child.uri ?? indexed);
    if (child.uriBaseId !== undefined && child.uriBaseId !== "%SRCROOT%") fail("Unsupported SARIF URI base.");
    paths.add(uri);
    normalized[key] = { ...child, uri };
    delete normalized[key].index;
  }
  return normalized;
}

function analysisIdentity(run) {
  if ((run.properties?.incrementalMode !== undefined && run.properties.incrementalMode !== "") ||
      run.tool?.extensions?.some(extension => extension.name === "codeql-action/pr-diff-range")) {
    fail("CodeQL requires full analysis; incremental or diff-informed reports are unsupported.");
  }
  if (!object(run.tool?.driver) || run.tool.driver.name !== "CodeQL" || !text(run.tool.driver.semanticVersion)) {
    fail("CodeQL driver/version metadata is missing.");
  }
  const queryPack = run.tool.extensions?.find(extension => extension.name === "codeql/javascript-queries");
  if (!text(queryPack?.semanticVersion) || !Array.isArray(queryPack.rules) || !queryPack.rules.length) {
    fail("CodeQL query-pack metadata is missing.");
  }
  const summary = run.properties?.codeqlConfigSummary;
  if (!object(summary) || !Array.isArray(summary.queries) || summary.queries.length !== 2 ||
      summary.queries.some(query => query.type !== "builtinSuite") ||
      summary.queries.map(query => query.uses).sort().join(",") !== "security-and-quality,security-extended") {
    fail("CodeQL query configuration must retain both complete security suites.");
  }
  // The installation UUID changes on every hosted runner. Preserve every
  // component/pack path and all other metadata, and leave raw SARIF untouched.
  const tool = structuredClone(run.tool);
  // Main scans can add these informational source-archive descriptors. They
  // are not queries or findings. Match their complete schema before excluding
  // them; changed/unknown metadata and actual warning/error notifications stay
  // significant and cannot be accepted by an existing record.
  if (Array.isArray(tool.driver.notifications)) {
    const languages = { typescript: "TypeScript", javascript: "JavaScript", html: "HTML" };
    tool.driver.notifications = tool.driver.notifications.filter(notification =>
      !Object.entries(languages).some(([language, display]) => canonical(notification) === canonical({
        id: `cli/expected-extracted-files/${language}`,
        name: `cli/expected-extracted-files/${language}`,
        shortDescription: { text: "Expected extracted files" },
        fullDescription: { text: "Files appearing in the source archive that are expected to be extracted." },
        defaultConfiguration: { enabled: true },
        properties: { tags: ["expected-extracted-files", "telemetry"], languageDisplayName: display },
      })));
    if (!tool.driver.notifications.length) delete tool.driver.notifications;
  }
  const installation = /^file:\/\/\/home\/runner\/work\/_temp\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/codeql\/qlpacks\//;
  for (const extension of tool.extensions ?? []) {
    for (const location of extension.locations ?? []) {
      if (typeof location.uri === "string") location.uri = location.uri.replace(installation, "codeql-pack:///");
    }
  }
  return digest({ tool, codeqlConfigSummary: summary });
}

export function describeResult(run, result) {
  if (!object(result) || !text(result.ruleId) || !object(result.message) ||
      !Array.isArray(result.locations) || !result.locations.length) fail("Malformed CodeQL result.");
  if (result.rule?.id !== undefined && result.rule.id !== result.ruleId) fail("Conflicting SARIF rule identities.");
  const paths = new Set();
  // Keep the complete flow payload, including every thread, message and region.
  // Only artifact indexes are resolved so unrelated artifact ordering is inert.
  const flow = normalizeLocations({
    ruleId: result.ruleId, rule: result.rule ?? null,
    level: result.level ?? null, kind: result.kind ?? null,
    message: result.message, locations: result.locations,
    relatedLocations: result.relatedLocations ?? [], codeFlows: result.codeFlows ?? [],
    stacks: result.stacks ?? [], graphs: result.graphs ?? [],
  }, run, paths);
  const fingerprints = result.partialFingerprints;
  const hasFlow = Array.isArray(result.codeFlows) && result.codeFlows.length > 0 && result.codeFlows.every(codeFlow =>
    Array.isArray(codeFlow.threadFlows) && codeFlow.threadFlows.length > 0 && codeFlow.threadFlows.every(thread =>
      Array.isArray(thread.locations) && thread.locations.length > 0 && thread.locations.every(step =>
        object(step.location?.physicalLocation?.artifactLocation))));
  const fingerprint = object(fingerprints) && Object.keys(fingerprints).length > 0 &&
    Object.values(fingerprints).every(text) ? structuredClone(fingerprints) : null;
  return {
    ruleId: result.ruleId, fingerprint, canonicalFlowSha256: digest(flow),
    analysisSha256: analysisIdentity(run), paths: [...paths].sort(),
    eligible: ELIGIBLE_RULES.has(result.ruleId) && hasFlow && fingerprint !== null &&
      !result.graphs?.length && !run.graphs?.length && !run.threadFlowLocations?.length &&
      paths.size > 0 && [...paths].every(path => path.startsWith("products/shop/")),
  };
}

export function validateManifest(manifest) {
  keys(manifest, ["schemaVersion", "sourceManifestSha256", "records"], "reviewed flow manifest");
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.records)) fail("Unsupported reviewed flow manifest.");
  if (manifest.records.length ? !HASH.test(manifest.sourceManifestSha256) : manifest.sourceManifestSha256 !== null) {
    fail("Manifest source digest must pin records, and must be null when empty.");
  }
  const ids = new Set();
  const identities = new Set();
  for (const record of manifest.records) {
    keys(record, ["id", "disposition", "ruleId", "fingerprint", "canonicalFlowSha256", "analysisSha256",
      "rationale", "guardPaths", "testPaths", "reviewReference"], "reviewed flow record");
    if (!text(record.id) || !/^[a-z0-9-]+$/.test(record.id) || ids.has(record.id)) fail("Duplicate or invalid reviewed flow ID.");
    ids.add(record.id);
    if (record.disposition !== "intentional-safe-flow" || !ELIGIBLE_RULES.has(record.ruleId) ||
        !HASH.test(record.canonicalFlowSha256) || !HASH.test(record.analysisSha256) ||
        !object(record.fingerprint) || !Object.keys(record.fingerprint).length || !Object.values(record.fingerprint).every(text) ||
        !text(record.rationale) || record.rationale.trim().length < 40) fail("Invalid reviewed safe-flow evidence.");
    for (const field of ["guardPaths", "testPaths"]) {
      if (!Array.isArray(record[field]) || !record[field].length || new Set(record[field]).size !== record[field].length ||
          record[field].some(path => !repositoryPath(path).startsWith("products/shop/"))) fail("Evidence paths must be distinct Shop files.");
    }
    keys(record.reviewReference, ["requiredStatus", "evidence"], "external review reference");
    if (record.reviewReference.requiredStatus !== "Independent review" || !text(record.reviewReference.evidence)) {
      fail("Independent review evidence reference is required; it is not an approval.");
    }
    const identity = digest({ ruleId: record.ruleId, fingerprint: record.fingerprint, canonicalFlowSha256: record.canonicalFlowSha256 });
    if (identities.has(identity)) fail("Duplicate or ambiguous reviewed flow record.");
    identities.add(identity);
  }
}

export function classifyReports(reports, manifest, source) {
  validateManifest(manifest);
  if (!Array.isArray(reports) || !reports.length) fail("CodeQL produced no analysis reports.");
  if (manifest.records.length && manifest.sourceManifestSha256 !== source.sha256) fail("Reviewed flow source manifest is stale.");
  for (const record of manifest.records) {
    if ([...record.guardPaths, ...record.testPaths].some(path => !source.paths.has(path))) fail("Reviewed guard/test source is missing.");
  }
  const counts = { raw: 0, reviewed: 0, unresolved: 0, details: [] };
  const used = new Set();
  for (const report of reports) {
    if (!object(report) || report.version !== "2.1.0" || !Array.isArray(report.runs) || !report.runs.length) fail("CodeQL report is incomplete.");
    for (const run of report.runs) {
      analysisIdentity(run);
      if (run.externalPropertyFileReferences) fail("External SARIF result data is unsupported.");
      if (!Array.isArray(run.results)) fail("CodeQL results are missing.");
      // Missing/unknown severity cannot establish successful extraction. SARIF
      // can default an absent level to warning; accept explicit information only.
      if (run.invocations?.some(invocation => invocation.executionSuccessful === false || invocation.toolExecutionNotifications?.some(note => !["none", "note"].includes(note.level)))) {
        fail("CodeQL analysis did not complete successfully.");
      }
      for (const result of run.results) {
        counts.raw += 1;
        const description = describeResult(run, result);
        const matches = description.eligible && description.paths.every(path => source.paths.has(path))
          ? manifest.records.filter(record => record.ruleId === description.ruleId &&
            canonical(record.fingerprint) === canonical(description.fingerprint) &&
            record.canonicalFlowSha256 === description.canonicalFlowSha256 && record.analysisSha256 === description.analysisSha256)
          : [];
        if (matches.length === 1 && !used.has(matches[0].id)) {
          used.add(matches[0].id);
          counts.reviewed += 1;
        } else {
          counts.unresolved += 1;
          counts.details.push({ ruleId: description.ruleId, paths: description.paths });
        }
      }
    }
  }
  if (manifest.records.some(record => !used.has(record.id))) fail("Reviewed flow records are unused or stale.");
  return counts;
}

export async function readReports(directory) {
  if (!directory) fail("CodeQL report directory is missing.");
  const files = (await readdir(directory)).filter(file => file.endsWith(".sarif")).sort();
  if (!files.length) fail("CodeQL produced no analysis reports.");
  return Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const manifest = JSON.parse(await readFile(join(root, REVIEWED_FLOWS_PATH), "utf8"));
  const source = await sourceManifest(root);
  const counts = classifyReports(await readReports(process.env.SARIF_DIRECTORY), manifest, source);
  console.log(`CodeQL source-manifest SHA-256: ${source.sha256}`);
  console.log(`CodeQL: ${counts.raw} raw, ${counts.reviewed} source-matched dispositions, ${counts.unresolved} unresolved findings.`);
  if (counts.unresolved) fail("Resolve every unreviewed CodeQL finding before merging. JP/shared flows permit no exceptions.");
}
