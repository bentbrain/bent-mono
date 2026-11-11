import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mirrorFile = "/etc/apt/apt-mirrors.txt";
const archive = "https://archive.ubuntu.com/ubuntu\n";

export function prepareUbuntuArchive({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  read = readFileSync,
  run = spawnSync,
} = {}) {
  if (
    platform !== "linux" || arch !== "x64" ||
    env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted"
  ) return false;

  let mirrors;
  try {
    mirrors = read(mirrorFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!/^https?:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?(?:[ \t]+[^\r\n]*)?$/m.test(mirrors)) return false;

  // Keep the image's Ubuntu suites, components and signing keys. Only replace
  // the Azure-first mirror list used by the hosted runner's existing sources.
  const result = run("sudo", ["-n", "tee", mirrorFile], {
    input: archive,
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Could not configure the Ubuntu package archive.");
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (prepareUbuntuArchive()) console.log("Browser dependencies use Ubuntu's signed primary archive.");
}
