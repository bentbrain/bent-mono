import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDevelopmentCICall } from "./native-ci-aws.mjs";

export function verifyStartupProbe(result, payload, failure = false) {
  const expected = failure ? "Expected the personal failure-queue Lambda." : "Invalid app job.";
  if (result.StatusCode !== 200 || !["Handled", "Unhandled"].includes(result.FunctionError) || result.ExecutedVersion !== "$LATEST" ||
    payload.errorType !== "Error" || payload.errorMessage !== expected) {
    throw new Error("Native live startup probe failed: the expected handler validation was not reached. Admissions must remain paused.");
  }
  return { handler: failure ? "failure" : "renderer", realRuntimeStarted: true, invalidPayloadRejected: true };
}

export async function probeDevelopmentFunctions(env = process.env) {
  const call = await createDevelopmentCICall(env);
  if (!env.RUNNER_TEMP?.startsWith("/") || process.platform !== "linux" ||
    env.GITHUB_WORKFLOW_REF !== `bentbrain/bent-mono/.github/workflows/native-development.yml@${env.GITHUB_REF}`) {
    throw new Error("Native live startup probes require the exact Development cloud workflow.");
  }
  const directory = await mkdtemp(join(env.RUNNER_TEMP, "native-startup-"));
  const probes = [];
  // Fixed invalid input reaches validation without claiming jobs, rendering,
  // sending callbacks or relying on a service user's runtime credentials.
  for (const failure of [false, true]) {
    const output = join(directory, `${failure ? "failure" : "renderer"}.json`);
    const result = await call(["lambda", "invoke", "--function-name", `forever-tee-video-development${failure ? "-failures" : ""}`,
      "--invocation-type", "RequestResponse", "--cli-binary-format", "raw-in-base64-out", "--payload", '{"nativeReleaseStartupProbe":true}', output]);
    const bytes = await readFile(output);
    if (bytes.length > 16384) throw new Error("Native startup probe response exceeded its limit; response was not logged.");
    probes.push(verifyStartupProbe(result, JSON.parse(bytes), failure));
  }
  return { startupVerified: true, environment: "development", probes };
}
