import { parseArgs } from "node:util";
import { recoverReleaseDiagnostics } from "./recover-release-diagnostics.mjs";

try {
  if (process.env.GITHUB_ACTIONS === "true") throw new Error();
  const { values } = parseArgs({ options: { input: { type: "string" }, output: { type: "string" }, source: { type: "string" }, run: { type: "string" }, attempt: { type: "string" }, job: { type: "string" }, "recover-interrupted": { type: "boolean" } } });
  if (!values.input || !values.output) throw new Error();
  const result = await recoverReleaseDiagnostics(values.input, values.output, { repository: "bentbrain/bent-mono", sourceCommit: values.source, runId: values.run, runAttempt: values.attempt, jobId: values.job }, { recoverInterrupted: values["recover-interrupted"] });
  if (!result.complete) {
    process.stderr.write("Recovered only an authenticated incomplete prefix; inspect the private output.\n");
    process.exitCode = 2;
  }
} catch {
  process.stderr.write("Protected diagnostic verification failed; use the original run/job/attempt and protected key route. No plaintext output was published.\n");
  process.exitCode = 1;
}
