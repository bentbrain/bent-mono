import assert from "node:assert/strict";
import test from "node:test";
import { shouldBuild } from "./vercel-ignore-build.mjs";

const before = "a".repeat(40);
const head = "b".repeat(40);
const environment = { VERCEL_GIT_PREVIOUS_SHA: before, VERCEL_GIT_COMMIT_SHA: head };
const applications = { www: "apps/www", collage: "apps/collage", drive: "products/drive", trackmap: "apps/trackmap", stay: "apps/stay" };
function git(files, options = {}) {
  return (command, args) => {
    assert.equal(command, "git");
    if (options.unavailable) throw new Error("History unavailable");
    if (args.includes("--show-toplevel")) return "/checkout with spaces\n";
    if (args.includes("rev-parse")) return `${options.head ?? head}\n`;
    assert.deepEqual(args, ["-C", "/checkout with spaces", "diff", "--name-only", "-z", "--no-renames", before, head]);
    return files.join("\0") + "\0";
  };
}

test("application and shared build inputs rebuild while unrelated release changes skip", () => {
  for (const [app, directory] of Object.entries(applications)) {
    for (const file of [directory + "/src/page.tsx", directory + "/vercel.json", "packages/ui/button.tsx", "packages/design-tokens/tokens.css", "bun.lock", "package.json", "turbo.json", "bunfig.toml", ".npmrc", "scripts/vercel-bun.mjs", "scripts/new-build-helper.mjs", "new-root-config.json"]) {
      assert.equal(shouldBuild(app, environment, git([file])), true, `${app}: ${file}`);
    }
    const release = ["README.md", "AGENTS.md", "SOURCE_PROVENANCE.json", ".gitignore", ".github/codeql/reviewed-flows.json", "scripts/release-vercel.mjs", "scripts/require-release-checks.mjs", "scripts/vercel-ignore-build.mjs", "scripts/vercel-ignore-build.test.mjs", "apps/fitness/vercel.json"];
    assert.equal(shouldBuild(app, environment, git(release)), false);
    for (const other of Object.values(applications).filter(value => value !== directory)) {
      assert.equal(shouldBuild(app, environment, git([other + "/src/page.tsx"])), false);
    }
    assert.equal(shouldBuild(app, environment, git([directory + "/deleted.ts", "apps/fitness/moved.ts"])), true);
    assert.equal(shouldBuild(app, environment, git([directory + "/src/page.tsx", ...release])), true);
  }
});

test("missing history, invalid invocations and mismatched checkouts request a build", () => {
  for (const app of Object.keys(applications)) {
    for (const invalid of [undefined, "", "0".repeat(40), "main", "a".repeat(39), "a".repeat(40) + "; command"]) {
      assert.equal(shouldBuild(app, { ...environment, VERCEL_GIT_PREVIOUS_SHA: invalid }, git([])), true);
    }
    for (const invalid of [undefined, "", "main", "b".repeat(39)]) {
      assert.equal(shouldBuild(app, { ...environment, VERCEL_GIT_COMMIT_SHA: invalid }, git([])), true);
    }
    assert.equal(shouldBuild(app, environment, git([], { unavailable: true })), true);
    assert.equal(shouldBuild(app, environment, git([], { head: before })), true);
  }
  for (const app of [undefined, "", "fitness", "unknown", "toString", "__proto__"]) {
    assert.equal(shouldBuild(app, environment, git([])), true);
  }
});
