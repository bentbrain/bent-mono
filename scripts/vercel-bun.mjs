import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
if (!["install --frozen-lockfile", "run build"].includes(args.join(" "))) {
  throw new Error("Expected install --frozen-lockfile or run build");
}
if (process.versions.node.split(".")[0] !== "24") {
  throw new Error("Vercel builds require Node.js 24");
}
const { packageManager } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (!/^bun@\d+\.\d+\.\d+$/.test(packageManager)) {
  throw new Error("The root packageManager must pin an exact Bun version");
}
const version = packageManager.slice(4);
const directory = mkdtempSync(join(tmpdir(), "bent-vercel-bun-"));

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with ${result.signal ?? result.status}`);
  }
}

try {
  // Only bootstrap the pinned tool here. Application dependencies still use Bun
  // and the root frozen lockfile. No global tools or repository files are changed.
  writeFileSync(join(directory, "package.json"), '{"private":true}\n');
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      "--no-audit",
      "--no-fund",
      packageManager,
    ],
    directory,
  );
  const wrapper = join(directory, "node_modules", "bun");
  // bun's npm bin is a placeholder until this script installs its native binary.
  // bunx can silently exit 1 when inherited policy skips that postinstall.
  // Initialise this one pinned package explicitly, preserving the caller's policy.
  run(process.execPath, [join(wrapper, "install.js")], directory);
  const binary = join(wrapper, "bin", "bun.exe");
  const installed = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (installed.error) throw installed.error;
  if (installed.status !== 0 || installed.stdout.trim() !== version) {
    throw new Error(`Pinned Bun ${version} failed its version check`);
  }
  console.log(`Using Bun ${version} with Node.js ${process.versions.node}`);
  run(binary, args, process.cwd());
} finally {
  rmSync(directory, { recursive: true, force: true });
}
