import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { guardedPersonalCall, PERSONAL_CONFIG_PATH } from "./aws-personal-guard.mjs";
import { personalSsoRoles } from "./aws-personal-sso.mjs";
import { runPersonalTerraform } from "./aws-personal-terraform.mjs";

const exec = promisify(execFile);
// Project-private, Apple-signed AWS CLI 2.36.18. No global install/config change
// and no fallback to a different credential chain or an obsolete CLI.
const personalCLI = fileURLToPath(new URL("../.data/aws-personal/cli-2.36.18/unpacked/aws-cli.pkg/Payload/aws-cli/aws", import.meta.url));
try {
  const args = process.argv.slice(2);
  process.umask(0o077);
  const dependencies = {
    config: await readFile(PERSONAL_CONFIG_PATH, "utf8"), environment: process.env,
    inspectSsoRoles: personalSsoRoles,
    execute: async (args, env) => {
      if (args[0] === "sso" && args[1] === "login") {
        // Login is user-interactive. Show the personal authorization URL
        // immediately, and let the user finish it or cancel with Ctrl-C.
        await new Promise((resolve, reject) => {
          const child = spawn(personalCLI, args, { env, stdio: "inherit" });
          child.on("error", reject);
          child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("Personal SSO login did not complete.")));
        });
        return "";
      }
      const result = await exec(personalCLI, args, {
        env: args[0] === "lambda" && args[1] === "invoke" ? { ...env, AWS_MAX_ATTEMPTS: "1" } : env,
        encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
        timeout: args[0] === "lambda" && args[1] === "invoke" ? 135_000 : 60_000,
      });
      return result.stdout;
    },
    executeTerraform: async (args, env, cwd) => {
      await new Promise((resolve, reject) => {
        const child = spawn("/opt/homebrew/bin/terraform", args, { env, cwd, stdio: "inherit" });
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error("Guarded personal Development Terraform command failed.")));
      });
      return "";
    },
    executeTerraformCapture: async (args, env, cwd) => {
      const result = await exec("/opt/homebrew/bin/terraform", args, {
        env, cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000,
      });
      return result.stdout;
    },
  };
  let result;
  if (args[0] === "production-invoker") {
    const { runProductionInvoker } = await import("./aws-personal-production-invoker.mjs");
    result = await runProductionInvoker(args.slice(1), dependencies);
  } else result = args[0] === "terraform" ? await runPersonalTerraform(args.slice(1), dependencies)
    : await guardedPersonalCall(args, dependencies);
  process.stdout.write(result);
} catch (error) {
  // Never serialize a child-process error: it can contain command payloads.
  const message = error instanceof Error && "stderr" in error && typeof error.stderr === "string"
    ? error.stderr.trim() : error instanceof Error ? error.message : "AWS operation failed.";
  console.error(message);
  process.exitCode = 1;
}
