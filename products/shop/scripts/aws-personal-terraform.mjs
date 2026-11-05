import { mkdir, chmod, mkdtemp, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { guardedPersonalCall, personalEnvironment } from "./aws-personal-guard.mjs";
import { runPersonalBootstrap } from "./aws-personal-bootstrap.mjs";

export const TERRAFORM_DIRECTORY = fileURLToPath(new URL("../infra/story-video-lambda/", import.meta.url));
export const TERRAFORM_PRIVATE = fileURLToPath(new URL("../.data/terraform-story-video/", import.meta.url));

export function terraformArguments(args) {
  const [operation, ...options] = args;
  if (operation === "lock-provider" && options.length === 0) {
    return ["providers", "lock", "-platform=darwin_arm64", "-platform=linux_amd64"];
  }
  if (["init", "validate", "fmt", "output"].includes(operation) && options.length === 0) {
    return { init: ["init", "-input=false"], validate: ["validate"], fmt: ["fmt"], output: ["output", "-json"] }[operation];
  }
  if (operation === "apply") throw new Error("Application Terraform applies must use the paired GitHub Actions release, not the historical local deployment command.");
  if (operation !== "plan") throw new Error("Only the fixed development Terraform workflow is allowed.");
  const variables = [];
  const seen = new Set();
  for (const option of options) {
    const match = /^--(image-digest|build-id|api-origin)=(.+)$/.exec(option);
    if (!match || seen.has(match[1])) throw new Error("Terraform overrides are forbidden.");
    seen.add(match[1]);
    const [, key, value] = match;
    const valid = key === "image-digest" ? /^sha256:[0-9a-f]{64}$/.test(value)
      : key === "build-id" ? /^[0-9a-f]{64}$/.test(value)
        : /^https:\/\/forever-tee-api-development\.[a-z0-9-]+\.workers\.dev$/.test(value);
    if (!valid) throw new Error("Invalid development release parameter.");
    variables.push(`-var=${key.replaceAll("-", "_")}=${value}`);
  }
  if (seen.size !== 0 && seen.size !== 3) throw new Error("Supply all three release parameters or none for the build foundation.");
  return ["plan", "-input=false", `-out=${TERRAFORM_PRIVATE}deployment.tfplan`, ...variables];
}

export async function runPersonalTerraform(args, dependencies) {
  if (args[0] === "bootstrap") return runPersonalBootstrap(args.slice(1), dependencies);
  if (args[0] === "migrate-state") {
    const { runStateMigration } = await import("./aws-personal-state-migration.mjs");
    return runStateMigration(args.slice(1), dependencies);
  }
  const command = terraformArguments(args);
  // Includes exact project SSO config validation and STS account/role check.
  await guardedPersonalCall(["sts", "get-caller-identity"], dependencies);
  const env = { ...personalEnvironment(dependencies.environment), TF_DATA_DIR: `${TERRAFORM_PRIVATE}providers`,
    TF_CLI_CONFIG_FILE: "/dev/null", TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
  await mkdir(TERRAFORM_PRIVATE, { recursive: true, mode: 0o700 });
  await chmod(TERRAFORM_PRIVATE, 0o700);
  if (args[0] === "lock-provider") {
    // Registry checksum maintenance only; no init, plan, apply or backend write.
    // Retain the previous lockfile and limit the Go download/hash work to one CPU.
    const backup = await mkdtemp(`${TERRAFORM_PRIVATE}provider-lock-`);
    await copyFile(`${TERRAFORM_DIRECTORY}.terraform.lock.hcl`, `${backup}/before.lock.hcl`);
    return dependencies.executeTerraform(command, { ...env, GOMAXPROCS: "1" }, TERRAFORM_DIRECTORY);
  }
  return dependencies.executeTerraform(command, env, TERRAFORM_DIRECTORY);
}
