import { githubDiagnosticWriter } from "./release-diagnostics.mjs";

const output = console.info.bind(console);
const env = process.env;
const identity = { repository: env.GITHUB_REPOSITORY, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, jobId: env.GITHUB_JOB };
const operation = /^[a-z][a-z-]{0,63}$/.test(env.NATIVE_OPERATION ?? "") ? env.NATIVE_OPERATION : "inspection";
let writer, progress = 0;
const captureFailed = () => {
  output(JSON.stringify({ sourceCommit: identity.sourceCommit, operation, failed: true, diagnosticCaptureFailed: true }));
  process.exit(1);
};
try {
  writer = githubDiagnosticWriter(env);
} catch { captureFailed(); }

function capture(level, args) {
  try {
    writer.write(level, args);
    output(JSON.stringify({ sourceCommit: identity.sourceCommit, operation, progress: ++progress, ...(level === "error" ? { failed: true } : {}), ...(level === "warn" ? { warning: true } : {}), protectedEvidence: true }));
  } catch { captureFailed(); }
}
for (const level of ["info", "log", "error", "warn", "debug"]) console[level] = (...args) => capture(level, args);
process.on("uncaughtException", error => {
  capture("error", [error]);
  process.exit(1);
});
process.on("unhandledRejection", reason => {
  capture("error", [reason]);
  process.exit(1);
});
process.on("exit", () => {
  try { writer.finish(); }
  catch {
    output(JSON.stringify({ sourceCommit: identity.sourceCommit, operation, failed: true, diagnosticCaptureFailed: true }));
    process.exitCode = 1;
  }
});
