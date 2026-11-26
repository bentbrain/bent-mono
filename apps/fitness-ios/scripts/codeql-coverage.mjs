// Checks that a Swift CodeQL database extracted every Swift source its
// analysis must cover. Every tracked Swift file in the repository belongs to
// the app scope, the tools scope or both, and a file in neither fails the
// check:
//
// - app: the fitness-health module's Core, Platform and Module sources, and
//   each Swift file the production app target compiles, including the ones
//   prebuild generates.
// - tools: the module's Core sources and XCTest suite, and the seeder with
//   its UI tests.
// - all: both.
//
//   node scripts/codeql-coverage.mjs [--scope all|app|tools] <database> [<derived data>]
//
// The app and all scopes read the app target's Swift file lists from the
// derived data. Package.swift manifests are build descriptions, not compiled
// sources, so they are left out.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const healthModule = "apps/fitness-ios/modules/fitness-health/ios";
const partition = {
  app: [`${healthModule}/Core/`, `${healthModule}/Platform/`, `${healthModule}/Module/`],
  tools: [`${healthModule}/Core/`, `${healthModule}/Tests/`, "apps/fitness-ios/tools/health-seed/"],
};
const usage = "Usage: node scripts/codeql-coverage.mjs [--scope all|app|tools] <database> [<derived data>]";

/** The scope, database and derived data the arguments name. */
export function coverageArguments(args) {
  let scope = "all";
  let rest = args;
  if (rest[0] === "--scope") {
    scope = rest[1];
    rest = rest.slice(2);
  }
  if (!["all", "app", "tools"].includes(scope)) throw new Error(usage);
  const [database, derived, ...extra] = rest;
  const needsDerived = scope !== "tools";
  if (!database || extra.length || needsDerived !== Boolean(derived)) throw new Error(usage);
  return { scope, database, derived };
}

/**
 * The repository-relative tracked Swift files that the scope covers. Throws
 * when a tracked Swift file is in neither scope.
 */
export function swiftFilesFor(scope, files) {
  const sources = files.filter((file) => file && !file.endsWith("/Package.swift") && file !== "Package.swift");
  const inScope = (file, name) => partition[name].some((prefix) => file.startsWith(prefix));
  const outside = sources.filter((file) => !inScope(file, "app") && !inScope(file, "tools"));
  if (outside.length)
    throw new Error(`Tracked Swift files outside the CodeQL app and tools scopes:\n${outside.join("\n")}`);
  const selected = sources.filter((file) => scope === "all" || inScope(file, scope));
  if (!selected.length) throw new Error(`No tracked Swift files were found for the ${scope} scope.`);
  return selected;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Files listed in the database's source archive, as absolute real paths. */
function databaseSources(path) {
  const listing = execFileSync("unzip", ["-Z1", join(path, "src.zip")], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Set(
    listing
      .split("\n")
      .filter((entry) => entry.endsWith(".swift"))
      .map((entry) => real("/" + entry.replace(/^\/+/, ""))),
  );
}

/** Every file named by the app target's Swift file lists. */
function compiledSources(root) {
  const lists = [];
  const walk = (directory, depth) => {
    if (depth > 12) return;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (name.endsWith(".SwiftFileList")) lists.push(path);
      else if (statSync(path).isDirectory()) walk(path, depth + 1);
    }
  };
  walk(join(root, "Build/Intermediates.noindex"), 0);
  const target = lists.filter((list) => /\/(bentFitness(?:Dev)?)\.build\/.*\/\1\.SwiftFileList$/.test(list));
  if (!target.length) throw new Error("The app target's Swift file list is missing.");
  return target.flatMap((list) =>
    readFileSync(list, "utf8")
      .split("\n")
      .map((line) => line.trim().replace(/\\(.)/g, "$1"))
      .filter(Boolean)
      .map(real),
  );
}

function main() {
  let found;
  try {
    found = coverageArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { scope, database, derived } = found;
  const listed = execFileSync("git", ["ls-files", "-z", "*.swift"], { cwd: repoRoot, encoding: "utf8" }).split("\0");
  const tracked = swiftFilesFor(scope, listed).map((file) => real(join(repoRoot, file)));
  const compiled = derived ? compiledSources(derived) : [];
  const extracted = databaseSources(database);
  const missing = [...new Set([...tracked, ...compiled])].filter((file) => !extracted.has(file));
  if (missing.length) {
    console.error(`CodeQL did not extract ${missing.length} Swift files:\n${missing.join("\n")}`);
    process.exit(1);
  }
  console.log(
    derived
      ? `CodeQL extracted all ${tracked.length} tracked ${scope}-scope and ${compiled.length} app-compiled Swift files.`
      : `CodeQL extracted all ${tracked.length} tracked ${scope}-scope Swift files.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
