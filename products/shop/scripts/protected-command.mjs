import { spawn } from "node:child_process";
import { constants } from "node:os";
import { githubDiagnosticWriter } from "./release-diagnostics.mjs";

// Capture only this child's output. Workflow commands and GITHUB_OUTPUT from
// other steps stay untouched. Binary streams are retained as serialized Buffers.
let writer, child, capturedBytes = 0, captureFailed = false;
const status = value => process.stdout.write(`${JSON.stringify({ protectedCommand: true, ...value })}\n`);
try {
  if (process.argv[2] !== "--" || !process.argv[3]) throw new Error();
  writer = githubDiagnosticWriter(process.env);
  child = spawn(process.argv[3], process.argv.slice(4), { stdio: ["inherit", "pipe", "pipe"] });
  const capture = level => bytes => {
    if (captureFailed) return;
    try { writer.write(level, [bytes]); capturedBytes += bytes.length; }
    catch { captureFailed = true; child.kill("SIGKILL"); }
  };
  child.stdout.on("data", capture("child-stdout"));
  child.stderr.on("data", capture("child-stderr"));
  child.on("error", error => {
    try { writer.write("error", [error]); } catch { captureFailed = true; }
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("close", (code, signal) => {
    try { writer.finish(); } catch { captureFailed = true; }
    status({ capturedBytes, failed: captureFailed || code !== 0 || Boolean(signal), ...(captureFailed ? { diagnosticCaptureFailed: true } : {}) });
    process.exitCode = captureFailed ? 1 : code ?? 128 + (constants.signals[signal] ?? 1);
  });
} catch {
  try { writer?.finish(); } catch { /* Fail closed without exposing diagnostics. */ }
  child?.kill("SIGKILL");
  status({ failed: true, diagnosticCaptureFailed: true });
  process.exitCode = 1;
}
