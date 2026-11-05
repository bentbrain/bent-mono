import { readFile } from "node:fs/promises";

function distribution(values) {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { samples: sorted.length, minimum: sorted[0], median, maximum: sorted.at(-1) };
}
for (const path of process.argv.slice(2)) {
  const report = JSON.parse(await readFile(path, "utf8"));
  const rows = report.rounds;
  console.info(JSON.stringify({
    label: report.label,
    coldFirstRenderMs: distribution(rows.map(row => row.batch.results[0].renderTimeMs)),
    warmRenderMs: distribution(rows.flatMap(row => row.batch.results.slice(1).map(result => result.renderTimeMs))),
    batchRenderSumMs: distribution(rows.map(row => row.batch.results.reduce((sum, result) => sum + result.renderTimeMs, 0))),
    batchWorkerMs: distribution(rows.map(row => row.batch.workerTimeMs).filter(Number.isFinite)),
    batchClientMs: distribution(rows.map(row => row.totalTimeMs)),
    shutdownMs: distribution(rows.map(row => row.batch.shutdownTimeMs)),
    bytes: distribution(rows.flatMap(row => row.batch.results.map(result => result.size))),
  }, null, 2));
}
