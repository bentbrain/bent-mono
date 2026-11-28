// Runs Prettier over the files Git manages: tracked files and new files Git
// doesn't ignore. Git's own ignore rules decide what is local, so private
// files and tool output are never read or rewritten, and `.prettierignore`
// adds generated and byte-sensitive files. Each file uses the nearest tracked
// Prettier config, falling back to the root `.prettierrc.json`.
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const configNames = new Set([
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
]);

/**
 * Whether `file`, relative to `root`, is a regular file reached only through
 * real folders. A path Git knows can now be a folder or a symlink, or sit
 * under a symlinked folder; Prettier would follow those, so they're skipped.
 */
export function regularFile(file, root = ".") {
  const parts = file.split("/");
  try {
    for (let index = 1; index < parts.length; index += 1) {
      if (!lstatSync(join(root, ...parts.slice(0, index))).isDirectory())
        return false;
    }
    return lstatSync(join(root, file)).isFile();
  } catch {
    return false;
  }
}

/** Splits Git's NUL-separated path list. */
const paths = (output) => output.split("\0").filter(Boolean);

/** The tracked config files, by the folder they apply to ("" for the root). */
export function configsByFolder(tracked) {
  const configs = new Map();
  for (const file of tracked) {
    if (configNames.has(posix.basename(file)))
      configs.set(posix.dirname(file) === "." ? "" : posix.dirname(file), file);
  }
  return configs;
}

/** The nearest tracked config for `file`, or undefined when none applies. */
export function configFor(file, configs) {
  for (let folder = posix.dirname(file); ; folder = posix.dirname(folder)) {
    const key = folder === "." ? "" : folder;
    if (configs.has(key)) return configs.get(key);
    if (key === "") return undefined;
  }
}

/** Groups files by the config they use, so each Prettier run gets one `--config`. */
export function groupByConfig(files, configs) {
  const groups = new Map();
  for (const file of files) {
    const config = configFor(file, configs) ?? "";
    groups.set(config, [...(groups.get(config) ?? []), file]);
  }
  return groups;
}

/** Prettier's arguments for one batch of files sharing `config`. */
export function prettierArgs(mode, config, files, cacheLocation) {
  if (mode !== "--check" && mode !== "--write")
    throw new Error("Use --check or --write.");
  return [
    mode,
    "--ignore-unknown",
    "--ignore-path",
    ".prettierignore",
    ...(config ? ["--config", config] : ["--no-config"]),
    "--no-editorconfig",
    // Without --cache, Prettier deletes the cache file it would use, so point it at a private one.
    "--cache-location",
    cacheLocation,
    "--",
    ...files,
  ];
}

function main() {
  const mode = process.argv[2] === "--check" ? "--check" : "--write";
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  // A tracked config deleted or replaced in the working tree no longer applies.
  const tracked = paths(git("ls-files", "-z", "--cached")).filter((file) =>
    regularFile(file),
  );
  const files = paths(
    git("ls-files", "-z", "--cached", "--others", "--exclude-standard"),
  ).filter((file) => regularFile(file));
  const prettier = createRequire(import.meta.url).resolve(
    "prettier/bin/prettier.cjs",
  );
  const cache = mkdtempSync(join(tmpdir(), "bent-format-"));
  let status = 0;
  try {
    for (const [config, group] of groupByConfig(
      [...new Set(files)],
      configsByFolder(tracked),
    )) {
      for (let start = 0; start < group.length; start += 500) {
        const batch = group.slice(start, start + 500);
        const result = spawnSync(
          process.execPath,
          [
            prettier,
            ...prettierArgs(mode, config, batch, join(cache, "prettier-cache")),
          ],
          { stdio: "inherit" },
        );
        if (result.status !== 0) status = result.status ?? 1;
      }
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  process.exit(status);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
