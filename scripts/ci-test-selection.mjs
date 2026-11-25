import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { comparison } from "./ci-scope.mjs";

const manifestPath = "scripts/ci-test-map.json";
const applications = {
  "apps/jp": "tests/browser",
  "apps/toolbar": "e2e",
};
const rootInputs = [
  ".github/actions",
  ".github/workflows/quality.yml",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "turbo.json",
  "packages",
  "scripts/ci-check.mjs",
  "scripts/ci-scope.mjs",
  "scripts/ci-test-selection.mjs",
  "scripts/install-browsers.mjs",
  "scripts/install-playwright.mjs",
];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = /^[a-f0-9]{64}$/;
const sourcePath = /^src\/(?:[\w-]+\/)*[\w-]+\.(?:astro|tsx?)$/;
const browserSpec = /^(?:[\w-]+\/)*[\w-]+\.spec\.ts$/;
const unitTest = /^tests\/[\w-]+\.test\.ts$/;
const sharedSource = /(?:^|\/)(?:layouts?|styles?|middleware|workers?|migrations?|fixtures?)(?:\/|\.)|\.config\./i;
const trackingLink = /^([ \t]+href="https:\/\/shop\.bent\.build\/\?utm_source=)[a-z0-9.-]+(&utm_medium=)[a-z0-9.-]+(")$/m;

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Pin the reviewed application, including its tests, configuration and source,
// and the shared build inputs. Unrelated commits can move the base without
// invalidating a map whose inputs still match.
export function testMapSnapshot(app, revision, execute = git) {
  const tree = execute("ls-tree", "-r", "-z", revision, "--", app, ...rootInputs);
  const files = new Set(
    tree.split("\0").flatMap((entry) => {
      const tab = entry.indexOf("\t");
      return entry.startsWith("100644 blob ") ? [entry.slice(tab + 1)] : [];
    }),
  );
  return { fingerprint: createHash("sha256").update(tree).digest("hex"), files };
}

export function testSelectionContext(environment = process.env, execute = git) {
  if (environment.GITHUB_EVENT_NAME !== "pull_request")
    return { reason: "Dependency selection runs on pull requests only." };

  try {
    const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
    const range = comparison("pull_request", event, environment.GITHUB_SHA);
    if (!range || execute("rev-parse", "HEAD").trim() !== range.head)
      return { reason: "The PR comparison does not match the checkout." };
    execute("merge-base", "--is-ancestor", range.base, range.head);
    execute("diff", "--quiet", "HEAD", "--");
    const fields = execute(
      "diff", "--raw", "-z", "--no-renames", range.base, range.head, "--",
    ).split("\0");
    if (fields.pop() !== "" || fields.length % 2 !== 0)
      return { reason: "The PR diff is unavailable." };
    const changes = [];
    for (let i = 0; i < fields.length; i += 2) {
      const [, mode, , , status] = fields[i].split(" ");
      changes.push({ status, mode, path: fields[i + 1] });
    }

    // A manifest edited on the PR can only take effect after full validation
    // and merge. Read the declarations from the exact comparison base.
    if (changes.some(({ path }) => path === manifestPath))
      return { reason: "The test dependency map changed." };

    let manifest;
    try {
      manifest = JSON.parse(execute("show", `${range.base}:${manifestPath}`));
    } catch {
      return { reason: "The base test dependency map is missing or unreadable." };
    }
    if (manifest?.schemaVersion !== 1 || !object(manifest.applications))
      return { reason: "The base test dependency map has an unsupported format." };
    return {
      base: range.base,
      changes,
      applications: manifest.applications,
      readChange: (path) => [range.base, range.head].map((revision) =>
        execute("show", `${revision}:${path}`),
      ),
    };
  } catch {
    return { reason: "The PR comparison is unavailable." };
  }
}

function validFiles(files, pattern, app, snapshot) {
  return Array.isArray(files) && files.length > 0 &&
    files.every((file) => typeof file === "string" && pattern.test(file) &&
      snapshot.files.has(`${app}/${file}`));
}

function trackingValuesOnly(path, readChange) {
  try {
    const [before, after] = readChange(path);
    // Keep every byte outside the two tracking values, including the link
    // destination, attributes, label and layout. These can affect other tests.
    return trackingLink.test(before) && trackingLink.test(after) &&
      before.replace(trackingLink, "$1$2$3") === after.replace(trackingLink, "$1$2$3");
  } catch {
    return false;
  }
}

export function selectTestFiles(app, task, context, snapshotAt = testMapSnapshot) {
  const full = (reason) => ({ files: null, reason });
  if (context.reason) return full(context.reason);
  const specDirectory = applications[app];
  if (!specDirectory || !["browser", "test"].includes(task))
    return full("This suite runs at workspace scope.");

  // Unknown files, shared dependencies, config and fixture changes widen the
  // affected workspace. Only explicit source edges and individual tests qualify.
  const prefix = `${app}/`;
  const isSpec = (file) => file.startsWith(`${specDirectory}/`) &&
    browserSpec.test(file.slice(specDirectory.length + 1));
  if (!context.changes.length || context.changes.some(({ path }) => !path.startsWith(prefix)))
    return full("The diff is empty or includes files outside this application.");

  const map = context.applications[app];
  if (!object(map) || typeof map.fingerprint !== "string" ||
      !sha256.test(map.fingerprint) || !object(map.sources))
    return full("This application has no valid dependency map.");
  let snapshot;
  try {
    snapshot = snapshotAt(app, context.base);
  } catch {
    return full("The test dependency map inputs could not be verified.");
  }
  if (snapshot.fingerprint !== map.fingerprint)
    return full("The test dependency map is stale for this base.");

  for (const [source, edges] of Object.entries(map.sources)) {
    if (!sourcePath.test(source) || sharedSource.test(source) ||
        !snapshot.files.has(`${app}/${source}`) || !object(edges) ||
        !validFiles(edges.browser, browserSpec, `${app}/${specDirectory}`, snapshot) ||
        (edges.test !== undefined && !validFiles(edges.test, unitTest, app, snapshot)) ||
        (edges.trackingValuesOnly !== undefined && edges.trackingValuesOnly !== true))
      return full("The test dependency map contains an invalid entry.");
  }

  const reasons = new Map();
  function include(file, reason) {
    if (!reasons.has(file)) reasons.set(file, new Set());
    reasons.get(file).add(reason);
  }
  for (const { path, status, mode } of context.changes) {
    const file = path.slice(prefix.length);
    if (mode !== "100644")
      return full("A changed input was removed or has an unexpected file mode.");
    if (isSpec(file) || unitTest.test(file)) {
      if (status !== "A" && status !== "M")
        return full("A test was removed or changed file type.");
      if ((task === "browser" && isSpec(file)) ||
          (task === "test" && unitTest.test(file)))
        include(file, "new or changed test");
      continue;
    }

    const edges = Object.hasOwn(map.sources, file) ? map.sources[file] : null;
    if (status !== "M" || !edges?.[task]) {
      const input = /^[\w./-]+$/.test(file) ? `\`${file}\`` : "A changed input";
      return full(`${input} has no reviewed mapping for this suite.`);
    }
    if (edges.trackingValuesOnly && !trackingValuesOnly(path, context.readChange))
      return full(`\`${file}\` changed outside the reviewed link tracking values.`);
    for (const test of edges[task])
      include(task === "browser" ? `${specDirectory}/${test}` : test, file);
  }

  if (!reasons.size) return full("The diff identifies no tests for this suite.");
  const files = [...reasons.keys()].sort();
  return {
    files,
    reason: `${files.length} selected test files.`,
    details: files.map((file) => `- \`${file}\` (${[...reasons.get(file)].join(", ")})`),
  };
}

export function reportTestSelection(app, task, plan, environment = process.env) {
  const heading = `${app} · ${task}`;
  const summary = [
    `### ${heading}`,
    "",
    plan.files ? plan.reason : `Full suite. ${plan.reason}`,
    "",
    ...(plan.details ?? []),
    "",
  ].join("\n");
  console.log(summary);
  if (environment.GITHUB_STEP_SUMMARY)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, summary + "\n");
}

export function playwrightFileFilters(files) {
  // Playwright matches the file arguments as regexes against absolute paths.
  return files.map((file) => `(?:^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , command, app, revision = "HEAD"] = process.argv;
  if (command !== "--fingerprint" || !Object.hasOwn(applications, app) ||
      !/^(?:HEAD|[a-f0-9]{40})$/.test(revision))
    throw new Error("Use --fingerprint <application directory> [commit SHA]");
  console.log(testMapSnapshot(app, revision).fingerprint);
}
