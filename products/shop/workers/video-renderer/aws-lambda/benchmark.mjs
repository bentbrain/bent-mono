import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ACCOUNT, BUCKET, NAME } from "./config.mjs";
import { sha256 } from "./contract.mjs";
import { completedBenchmarkStatus, hasPlatformEvidence, jobsFor, parsePlatformReport, preflight, runRound } from "./benchmark-core.mjs";
import { aws, ROOT } from "./local-tools.mjs";

const [fixturePath, roundsText = "3"] = process.argv.slice(2);
const rounds = Number(roundsText);
if (!fixturePath || !Number.isInteger(rounds) || rounds < 1 || rounds > 5 || process.argv.length > 4) {
  throw new Error("Usage: node benchmark.mjs <fixture.json> [rounds 1-5]. Renders 12 videos per round in AWS.");
}
const fixture = JSON.parse(await readFile(resolve(fixturePath), "utf8"));
jobsFor(fixture, 2); // Fail before contacting AWS if the fixture is incomplete.
const fn = await preflight(aws);
const parent = resolve(ROOT, ".data/aws-lambda");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(resolve(parent, "benchmark-"));
const report = { schemaVersion: 1, function: fn, designId: fixture.designId, artworkSha256: fixture.artwork.sha256,
  status: "running",
  measurement: "Private S3-to-Lambda-to-S3 benchmark. Driver times include local CLI startup, STS identity checks and network. Not storefront readiness or R2 latency.",
  rounds: [] };

for (let round = 0; round < rounds; round += 1) {
  // Alternate cohort order so warm environments don't always favour the two-customer run.
  for (const customers of round % 2 === 0 ? [1, 2] : [2, 1]) {
    const runId = randomUUID();
    const batch = await runRound(jobsFor(fixture, customers, runId, round % 4), async (job) => {
      const prefix = resolve(directory, `${runId}-${job.customerId}-${job.variantId}`);
      await writeFile(`${prefix}.input.json`, JSON.stringify(job), { flag: "wx" });
      const metadata = await aws(["lambda", "invoke", "--function-name", NAME, "--invocation-type", "RequestResponse",
        "--log-type", "Tail", "--cli-read-timeout", "130", "--payload", `fileb://${prefix}.input.json`, `${prefix}.response.json`]);
      if (metadata.StatusCode !== 200 || metadata.FunctionError) throw new Error("Lambda invocation failed; private response retained for diagnosis.");
      const result = JSON.parse(await readFile(`${prefix}.response.json`, "utf8"));
      return { result, platform: parsePlatformReport(metadata.LogResult, result.runtime?.awsRequestId) };
    }, fn, { onResult: (sample) => console.info(JSON.stringify({
      event: "video-result", runId, customers, variantId: sample.job.variantId,
      customerId: sample.job.customerId, ok: sample.ok, readyMs: sample.readyMs ?? null,
    })) });
    report.rounds.push({ round: round + 1, customers, runId, ...batch });
    if (batch.samples.some((sample) => sample.ok && !hasPlatformEvidence(sample, fn))) {
      report.platformTimingsMissing = true;
    }
    await writeFile(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    // Verification happens after timing stops and before the next batch. Download only exact validated keys.
    await aws(["s3api", "head-bucket", "--bucket", BUCKET, "--expected-bucket-owner", ACCOUNT]);
    for (const sample of batch.samples.filter((sample) => sample.ok)) {
      const path = resolve(directory, `${runId}-${sample.job.customerId}-${sample.job.variantId}.mp4`);
      try {
        await aws(["s3", "cp", `s3://${BUCKET}/${sample.result.object.key}`, path, "--only-show-errors"]);
        const bytes = await readFile(path);
        if (bytes.length !== sample.result.object.size || sha256(bytes) !== sample.result.object.sha256) throw new Error("Stored video checksum mismatch.");
        sample.download = { path, verified: true };
      } catch {
        sample.download = { path, verified: false };
        report.verificationFailed = true;
      }
    }
    await writeFile(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.info(JSON.stringify({ event: "round-complete", runId, ...batch.summary }));
    if (batch.summary.failures || report.verificationFailed) {
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode) break;
}
report.status = completedBenchmarkStatus(report);
if (report.status !== "completed") process.exitCode = 1;
await writeFile(resolve(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.info(JSON.stringify({ report: resolve(directory, "report.json") }));
