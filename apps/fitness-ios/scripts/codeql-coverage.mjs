// Checks that the Swift CodeQL database extracted every Swift source the
// analysis must cover: each tracked Swift file in this app (the module, its
// tests and the seeder), and each Swift file the production app target
// compiles, including the ones prebuild generates.
//
//   node scripts/codeql-coverage.mjs <database> <derived data>
//
// Package.swift manifests are build descriptions, not compiled sources, so
// they are left out.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [database, derived] = process.argv.slice(2);
if (!database || !derived) {
  console.error("Usage: node scripts/codeql-coverage.mjs <database> <derived data>");
  process.exit(2);
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

const tracked = execFileSync("git", ["ls-files", "*.swift"], { cwd: app, encoding: "utf8" })
  .split("\n")
  .filter((file) => file && !file.endsWith("Package.swift"))
  .map((file) => real(join(app, file)));
if (!tracked.length) throw new Error("No tracked Swift files were found.");
const compiled = compiledSources(derived);
const extracted = databaseSources(database);
const missing = [...new Set([...tracked, ...compiled])].filter((file) => !extracted.has(file));
if (missing.length) {
  console.error(`CodeQL did not extract ${missing.length} Swift files:\n${missing.join("\n")}`);
  process.exit(1);
}
console.log(`CodeQL extracted all ${tracked.length} tracked and ${compiled.length} app-compiled Swift files.`);
