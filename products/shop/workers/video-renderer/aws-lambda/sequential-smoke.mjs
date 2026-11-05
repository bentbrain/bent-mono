import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ACCOUNT, BUCKET, NAME } from "./config.mjs";
import { sha256 } from "./contract.mjs";
import { hasPlatformEvidence, jobsFor, parsePlatformReport, verifyResult } from "./benchmark-core.mjs";
import { sequentialJobs, smokePreflight } from "./smoke-core.mjs";
import { aws, ROOT } from "./local-tools.mjs";

const [fixturePath] = process.argv.slice(2);
if (!fixturePath || process.argv.length !== 3) throw new Error("Use sequential-smoke.mjs <fixture.json>. Runs four videos, one at a time.");
const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
const jobs = jobsFor(fixture, 1);
const parent = resolve(ROOT, ".data/aws-lambda");
await mkdir(parent, { recursive: true });
// Prevent accidentally starting two local smoke drivers. Never clear an existing lock automatically.
const lock = resolve(parent, "sequential-smoke.lock");
await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
try {
  const directory = await mkdtemp(resolve(parent, "smoke-"));
  const reportPath = resolve(directory, "report.json");
  const report = { schemaVersion: 1, status: "running", mode: "sequential-smoke", designId: fixture.designId,
    measurement: "Four sequential S3-to-Lambda-to-S3 checks. Not concurrent-customer or storefront latency evidence.", samples: [] };
  try {
    const { fn, capacity } = await smokePreflight(aws);
    report.function = fn;
    report.capacity = capacity;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await aws(["s3api", "head-bucket", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT]);
    await sequentialJobs(jobs, async (job) => {
      const prefix = resolve(directory, job.variantId);
      await writeFile(`${prefix}.input.json`, JSON.stringify(job), { flag: "wx" });
      const start = performance.now();
      const metadata = await aws(["lambda", "invoke", "--function-name", NAME, "--invocation-type", "RequestResponse",
        "--log-type", "Tail", "--cli-read-timeout", "130", "--payload", `fileb://${prefix}.input.json`, `${prefix}.response.json`]);
      const driverInvocationMs = performance.now() - start;
      if (metadata.StatusCode !== 200 || metadata.FunctionError) throw new Error(`${job.variantId}: Lambda failed; private response retained.`);
      const result = verifyResult(job, JSON.parse(await readFile(`${prefix}.response.json`, "utf8")), fn);
      const platform = parsePlatformReport(metadata.LogResult, result.runtime.awsRequestId);
      const sample = { ok: true, variantId: job.variantId, result, platform, driverInvocationMs };
      const path = `${prefix}.mp4`;
      await aws(["s3", "cp", `s3://${BUCKET}/${result.object.key}`, path, "--only-show-errors"]);
      const video = await readFile(path);
      if (video.length !== result.object.size || sha256(video) !== result.object.sha256) throw new Error("Stored video verification failed.");
      return { ...sample, download: { path, verified: true } };
    }, async (sample) => {
      report.samples.push(sample);
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.info(JSON.stringify({ variantId: sample.variantId, renderMs: sample.result.timings.renderMs,
        handlerMs: sample.result.timings.handlerMs, platform: sample.platform, driverInvocationMs: sample.driverInvocationMs }));
    });
    report.status = report.samples.every((sample) => hasPlatformEvidence(sample, fn)) ? "completed-smoke-only" : "incomplete-platform-evidence";
    if (report.status !== "completed-smoke-only") process.exitCode = 1;
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : "Smoke check failed.";
    process.exitCode = 1;
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.info(JSON.stringify({ status: report.status, report: reportPath, error: report.error }));
  }
} finally {
  await unlink(lock);
}
