import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkout, fileInventory, recipe, sha256 } from "./linux-candidate.mjs";
import { sealLinuxEvidence } from "./linux-evidence.mjs";

const execute = promisify(execFile);
const env = process.env;
assert.equal(env.GITHUB_ACTIONS, "true", "Hosted validation requires GitHub Actions");
assert.equal(env.GITHUB_REPOSITORY, "bentbrain/bent-mono");
assert.match(env.SOURCE_COMMIT ?? "", /^[a-f0-9]{40}$/);
assert.ok(env.RUNNER_TEMP?.startsWith("/") && env.PRIVATE_EVIDENCE === join(env.RUNNER_TEMP, "shop-linux-private"));
assert.equal((await execute("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(), env.SOURCE_COMMIT);
process.umask(0o077);

async function privateCommand(command, args, logName, options = {}) {
  const log = await open(join(env.PRIVATE_EVIDENCE, logName), "wx", 0o600);
  try {
    await execute(command, args, { cwd: checkout, timeout: 600000, maxBuffer: 1024 * 1024,
      ...options, env: { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR ?? "/tmp", CI: "true", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" },
      // Capture bounded command output privately, including failure messages.
    }).then(async result => { await log.write(result.stdout); await log.write(result.stderr); }, async error => {
      await log.write(error.stdout ?? ""); await log.write(error.stderr ?? ""); throw new Error("Hosted Linux command failed; inspect encrypted evidence");
    });
  } finally { await log.close(); }
}

async function encoder() {
  const archive = join(env.PRIVATE_EVIDENCE, "ffmpeg.deb");
  await privateCommand("curl", ["--fail", "--silent", "--show-error", "--location", recipe.ffmpeg.archive, "--output", archive], "encoder-download.private.log");
  assert.equal(sha256(await readFile(archive)), recipe.ffmpeg.sha256, "Pinned encoder archive checksum mismatch");
  await privateCommand("apt-get", ["update", "--quiet"], "encoder-index.private.log");
  await privateCommand("apt-get", ["install", "--yes", "--no-install-recommends", "--allow-downgrades", archive], "encoder-install.private.log");
}

async function journey() {
  await privateCommand(process.execPath, [join(checkout, "products/shop/scripts/testing/linux-candidate.mjs"), join(env.PRIVATE_EVIDENCE, "candidate")], "package.private.log");
  await privateCommand(join(env.PRIVATE_EVIDENCE, "candidate/runtime/bin/node"), [join(checkout, "products/shop/scripts/testing/linux-journey.mjs"),
    join(env.PRIVATE_EVIDENCE, "candidate"), join(env.PRIVATE_EVIDENCE, "journey")], "journey.private.log");
  const receipt = JSON.parse(await readFile(join(env.PRIVATE_EVIDENCE, "journey/linux-j01.private.json"), "utf8"));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.dirtySnapshot, false);
  assert.equal(receipt.sourceCommit, env.SOURCE_COMMIT);
  assert.equal(receipt.awsImageQualified, false);
  console.info(JSON.stringify({ sourceCommit: env.SOURCE_COMMIT, complete: true, awsImageQualified: false, candidateSha256: receipt.candidateSha256 }));
}

async function seal() {
  const output = join(env.RUNNER_TEMP, "shop-linux-sealed"), archive = join(env.RUNNER_TEMP, "shop-linux-private.tar.gz");
  await mkdir(output, { mode: 0o700 });
  try {
    const files = await fileInventory(env.PRIVATE_EVIDENCE);
    const identity = { schema: "shop.hosted-linux-evidence/v1", sourceCommit: env.SOURCE_COMMIT, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      workflowRef: env.GITHUB_WORKFLOW_REF, repository: env.GITHUB_REPOSITORY, recipe, files, filesSha256: sha256(JSON.stringify(files)) };
    await writeFile(join(env.PRIVATE_EVIDENCE, "evidence-inventory.private.json"), JSON.stringify(identity, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await execute("tar", ["-czf", archive, "shop-linux-private"], { cwd: env.RUNNER_TEMP, timeout: 240000, maxBuffer: 65536 });
    const recipient = JSON.parse(await readFile(new URL("./linux-evidence-recipient.json", import.meta.url), "utf8"));
    await sealLinuxEvidence(archive, join(output, "linux-evidence.tar.gz.enc"), { sourceCommit: env.SOURCE_COMMIT, runId: env.GITHUB_RUN_ID, filename: "linux-evidence.json" }, recipient);
  } finally { await rm(archive, { force: true }); }
}

try {
  assert.equal(process.argv.length, 3);
  const action = { encoder, journey, seal }[process.argv[2]];
  assert.ok(action, "Use encoder, journey or seal");
  await action();
} catch {
  console.error("Linux validation failed. Inspect the encrypted evidence and public recipient configuration.");
  process.exitCode = 1;
}
