import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  configFor,
  configsByFolder,
  groupByConfig,
  prettierArgs,
  regularFile,
} from "./format.mjs";

const script = fileURLToPath(new URL("./format.mjs", import.meta.url));
const messy = '{"a":1,   "b":2}\n';

test("each file uses the nearest tracked config", () => {
  const configs = configsByFolder([
    ".prettierrc.json",
    "apps/jp/.prettierrc.json",
    "apps/jp/src/a.ts",
    "b.ts",
  ]);
  assert.equal(
    configFor("apps/jp/src/a.ts", configs),
    "apps/jp/.prettierrc.json",
  );
  assert.equal(configFor("b.ts", configs), ".prettierrc.json");
  assert.equal(configFor("x.ts", new Map()), undefined);
  assert.deepEqual(
    [...groupByConfig(["apps/jp/a.ts", "b.ts"], configs)],
    [
      ["apps/jp/.prettierrc.json", ["apps/jp/a.ts"]],
      [".prettierrc.json", ["b.ts"]],
    ],
  );
});

test("only regular files reached through real folders are formatted", () => {
  const root = mkdtempSync(join(tmpdir(), "format-files-"));
  try {
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real/a.json"), "{}");
    symlinkSync(join(root, "real"), join(root, "link"));
    symlinkSync(join(root, "real/a.json"), join(root, "b.json"));
    assert.equal(regularFile("real/a.json", root), true);
    assert.equal(regularFile("real", root), false);
    assert.equal(regularFile("link/a.json", root), false);
    assert.equal(regularFile("b.json", root), false);
    assert.equal(regularFile("missing.json", root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prettier gets one config, no editorconfig and a private cache", () => {
  assert.deepEqual(
    prettierArgs("--check", ".prettierrc.json", ["a.ts"], "/tmp/c"),
    [
      "--check",
      "--ignore-unknown",
      "--ignore-path",
      ".prettierignore",
      "--config",
      ".prettierrc.json",
      "--no-editorconfig",
      "--cache-location",
      "/tmp/c",
      "--",
      "a.ts",
    ],
  );
  assert.equal(
    prettierArgs("--write", "", ["a.ts"], "/tmp/c")[4],
    "--no-config",
  );
  assert.throws(
    () => prettierArgs("--list-different", "", [], "/tmp/c"),
    /--check or --write/,
  );
});

// The public-source job runs these tests without dependencies; Quality's test job runs them with Prettier installed.
let prettierMissing = false;
try {
  createRequire(import.meta.url).resolve("prettier/bin/prettier.cjs");
} catch {
  prettierMissing = "Prettier isn't installed";
}

test(
  "formats what Git manages and leaves local and generated files alone",
  { skip: prettierMissing },
  () => {
    const repo = mkdtempSync(join(tmpdir(), "format-test-"));
    const outside = mkdtempSync(join(tmpdir(), "format-outside-"));
    try {
      const write = (file, text) => {
        mkdirSync(dirname(join(repo, file)), { recursive: true });
        writeFileSync(join(repo, file), text);
      };
      const git = (...args) =>
        execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      git("init", "-q");
      write(".prettierrc.json", "{}\n");
      write(".prettierignore", "generated/\n");
      // A nested .gitignore pattern that matches a tracked file elsewhere.
      write("tools/.gitignore", ".settings.json\n");
      write("tools/.settings.json", messy);
      write("app/.settings.json", messy);
      write("app/data.json", messy);
      write("generated/out.json", messy);
      write("swap.json", "{}\n");
      write("linked/file.json", "{}\n");
      write("cfg/.prettierrc.json", '{ "semi": false }\n');
      write("cfg/a.json", messy);
      git("add", "-A");
      // Tracked paths replaced in the working tree: a file by a folder, a
      // folder by a symlink to files outside the repository, and a config
      // deleted, so its folder falls back to the root config.
      rmSync(join(repo, "swap.json"));
      write("swap.json/local.json", messy);
      rmSync(join(repo, "linked"), { recursive: true });
      writeFileSync(join(outside, "file.json"), messy);
      symlinkSync(outside, join(repo, "linked"));
      unlinkSync(join(repo, "cfg/.prettierrc.json"));
      // Local files: ignored by .git/info/exclude, and by an untracked nested .gitignore.
      write(".git/info/exclude", "local.json\n");
      write("local.json", messy);
      write("scratch/.gitignore", "*\n");
      write("scratch/notes.json", messy);
      // An ignored, invalid config next to a tracked file must not be read.
      write("app/.prettierrc.json", "{ not json");
      write("app/.gitignore", ".prettierrc.json\n");
      // A new file Git doesn't ignore is formatted too.
      write("app/new.json", messy);
      const run = (mode) =>
        spawnSync(process.execPath, [script, mode], {
          cwd: repo,
          encoding: "utf8",
        });

      const check = run("--check");
      assert.equal(check.status, 1);
      const output = check.stdout + check.stderr;
      for (const file of [
        "app/.settings.json",
        "app/data.json",
        "app/new.json",
        "cfg/a.json",
      ])
        assert.match(output, new RegExp(file));
      for (const file of [
        "tools/.settings.json",
        "local.json",
        "notes.json",
        "generated/out.json",
      ])
        assert.doesNotMatch(output, new RegExp(file.replace(".", "\\.")));

      assert.equal(run("--write").status, 0);
      assert.equal(
        readFileSync(join(repo, "app/data.json"), "utf8"),
        '{ "a": 1, "b": 2 }\n',
      );
      assert.equal(
        readFileSync(join(repo, "app/new.json"), "utf8"),
        '{ "a": 1, "b": 2 }\n',
      );
      for (const file of [
        "tools/.settings.json",
        "local.json",
        "scratch/notes.json",
        "generated/out.json",
      ])
        assert.equal(readFileSync(join(repo, file), "utf8"), messy, file);
      assert.equal(
        readFileSync(join(repo, "swap.json/local.json"), "utf8"),
        messy,
      );
      assert.equal(readFileSync(join(outside, "file.json"), "utf8"), messy);
      assert.equal(
        readFileSync(join(repo, "cfg/a.json"), "utf8"),
        '{ "a": 1, "b": 2 }\n',
      );
      assert.equal(run("--check").status, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
