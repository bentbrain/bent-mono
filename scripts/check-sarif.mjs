import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.SARIF_DIRECTORY;
if (!directory) throw new Error("CodeQL report directory is missing.");
const reports = (await readdir(directory)).filter((file) => file.endsWith(".sarif"));
if (!reports.length) throw new Error("CodeQL produced no analysis reports.");
let findings = 0;
for (const file of reports) {
  const report = JSON.parse(await readFile(join(directory, file), "utf8"));
  if (!Array.isArray(report.runs) || !report.runs.length) throw new Error("CodeQL report is incomplete.");
  for (const run of report.runs) {
    if (!Array.isArray(run.results)) throw new Error("CodeQL results are missing.");
    findings += run.results.length;
  }
}
if (findings) throw new Error(`CodeQL reported ${findings} findings. Resolve them before merging.`);
console.log("CodeQL reported no findings.");
