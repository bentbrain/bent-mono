import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual as equal } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderWranglerConfig, workerProtectedConfiguration } from "./deployment-config.mjs";
import { workerCommandArguments, inspectDevelopmentWorker, activeWorkerSettings, verifyDevelopmentReleaseConfiguration, developmentReleaseVariables } from "./native-ci-worker.mjs";
import { prepareWorkerUpload, readWorkerUpload, readSealedWorkerUpload, verifyWorkerUpload, verifyWorkerUploadEvidence } from "./native-worker-content.mjs";
import { assertArtworkMediaBundle } from "./artwork-media-compatibility.mjs";
import { recoveryHash as hash, recoveryCheck as check } from "./native-forward-recovery-inspection.mjs";
import { sealReleaseEvidence } from "./release-evidence.mjs";
const execute = promisify(execFile);
const API = fileURLToPath(new URL("../workers/api/", import.meta.url));
export async function prepareCompletionApi({ env, cf, store, authority, inputs, platform = process.platform, executeCommand = execute }) {
  check(platform === "linux" && env.RUNNER_TEMP?.startsWith("/"), "cloud-only completion preparation required.");
  const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-completion-"));
  const rendered = await renderWranglerConfig(join(API, "wrangler.jsonc"), join(directory, "api.json"));
  check(rendered.resolvedSha256 === inputs.prepared.worker.configuration.api, "original reviewed API configuration changed.");
  const releaseId = inputs.prepared.releaseId, variables = developmentReleaseVariables(env, inputs.prepared.candidate, releaseId, authority.applicationSourceCommit);
  const secrets = Object.fromEntries(["SHOP_PROTECTED_CONFIG_JSON", "CART_LINE_CAPABILITY_SECRET", "OPENAI_API_KEY", "PRINTIFY_ASSET_DELIVERY_SECRET", "PRINTIFY_WEBHOOK_SECRET", "PRODUCT_IMAGE_RENDERER_BYPASS_SECRET"]
    .map(name => [name, name === "SHOP_PROTECTED_CONFIG_JSON" ? workerProtectedConfiguration() : env[name]]));
  check(Object.values(secrets).every(value => typeof value === "string" && value.length >= 32), "all original atomic API secrets required.");
  // Validate the approved full expected settings as well as exact post-upload
  // equality. The source and original application generation remain explicit.
  verifyDevelopmentReleaseConfiguration(authority.expectedApiSettings, inputs.state.consumer, variables);
  const secretsPath = join(directory, "release-secrets.json");
  await writeFile(secretsPath, JSON.stringify(secrets), { flag: "wx", mode: 0o600 });
  const run = async args => {
    try {
      return await executeCommand(process.execPath, workerCommandArguments(args, rendered.path), { cwd: API, encoding: "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024,
        env: { PATH: env.PATH, HOME: directory, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false",
          CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN } });
    } catch (error) {
      let output = [error.stdout, error.stderr].filter(value => typeof value === "string").join("\n");
      for (const value of [...Object.values(secrets), ...Object.entries(env).filter(([key]) => /SECRET|TOKEN|KEY/.test(key)).map(([, value]) => value)]) if (value) output = output.replaceAll(value, "<REDACTED>");
      await store.save("completion-command-diagnostic.json", Buffer.from(sealReleaseEvidence({ operation: args[0], output: output.slice(0, 2_000_000) },
        { sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, filename: "completion-command-diagnostic.json" }, env)));
      throw Error("Completion API command was not confirmed; inspect encrypted evidence and current state before any further action.");
    }
  };
  // Rehydrate exact original raw bytes, then prove Wrangler's upload transform
  // remains byte-idempotent. This route never bundles current application code.
  const out = join(directory, "bundle");
  await prepareWorkerUpload({ run, directory: out, environment: "development",
    sealed: { store, artifacts: inputs.prepared.artifacts, review: inputs.prepared.worker } });
  const raw = await readSealedWorkerUpload(store, inputs.prepared.artifacts, inputs.prepared.worker);
  assertArtworkMediaBundle(raw.code);
  let started = false;
  return { deploy: async beforeMutation => {
    check(!started, "completion API upload is one-use."); started = true;
    await readSealedWorkerUpload(store, inputs.prepared.artifacts, inputs.prepared.worker);
    await beforeMutation();
    verifyWorkerUpload((await readWorkerUpload(out, inputs.prepared.worker)).content, inputs.prepared.worker);
    check(hash(await readFile(rendered.path)) === rendered.resolvedSha256 &&
      (await readFile(secretsPath, "utf8")) === JSON.stringify(secrets), "prepared original API configuration or atomic secrets changed.");
    await run(["deploy", join(out, "index.js"), "--no-bundle", "--upload-source-maps", "--env", "development", "--keep-vars", "--tag", releaseId,
      "--message", `Native pair ${authority.applicationSourceCommit}`, "--secrets-file", secretsPath,
      ...Object.entries(variables).flatMap(([key, value]) => ["--var", `${key}:${value}`])]);
    const live = await inspectDevelopmentWorker(cf, undefined, inputs.uploads.api);
    await verifyWorkerUploadEvidence(live.content, inputs.uploads.api, { store, env, filename: "completion-api-content-diagnostic.json" });
    check(equal(await activeWorkerSettings(cf, live), authority.expectedApiSettings), "complete original API settings differ after upload.");
    return live;
  } };
}
