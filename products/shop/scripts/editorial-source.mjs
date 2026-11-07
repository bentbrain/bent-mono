import { releasePath } from "./monorepo-source.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const toolingPaths = new Set([
  ".github/workflows/backup-renderer.yml",
  ".github/workflows/featured-composition.yml",
  "scripts/backup-renderer-policy.mjs",
  "scripts/backup-renderer-policy.test.mjs",
  "scripts/backup-renderer-release.mjs",
  "scripts/editorial-source.mjs",
  "scripts/editorial-source.test.mjs",
  "scripts/editorial-worker-probe.mjs",
  "scripts/editorial-worker-probe.test.mjs",
  "scripts/featured-composition-policy.mjs",
  "scripts/featured-composition-policy.test.mjs",
  "scripts/featured-composition-release.mjs",
  "scripts/web-production-release.mjs",
  "scripts/web-production-release.test.mjs",
]);
const check = (value, reason) => {
  if (!value) throw Error(`Editorial source stopped: ${reason}`);
};

// A tooling repair cannot replace qualification for changed application code,
// artwork, rendering, record construction, dependencies or native release policy.
export async function verifyEditorialSource(sourceCommit, toolingCommit, run = execute) {
  check([sourceCommit, toolingCommit].every(value => /^[a-f0-9]{40}$/.test(value ?? "")), "two exact source commits required.");
  const git = async args => (await run("git", args)).stdout.trim();
  check(await git(["rev-parse", "HEAD"]) === toolingCommit, "current tooling checkout differs.");
  await git(["merge-base", "--is-ancestor", sourceCommit, toolingCommit]);
  const paths = (await git(["diff", "--name-only", sourceCommit, toolingCommit, "--"])).split("\n").filter(Boolean);
  const editorialPath = path => [".github/workflows/backup-renderer.yml", ".github/workflows/featured-composition.yml"].includes(path)
    ? path : releasePath(path);
  check(paths.every(path => toolingPaths.has(editorialPath(path))), "qualified application, artwork or release inputs changed.");
  return { sourceCommit, toolingCommit, changedToolingPaths: paths };
}
