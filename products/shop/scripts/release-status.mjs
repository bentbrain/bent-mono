import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { githubApi } from "./github-actions.mjs";
import { runTimings } from "./release-timings.mjs";

export async function releaseStatus(api, runId) {
  if (!/^[1-9][0-9]+$/.test(String(runId))) throw Error("Supply the numeric Actions run ID.");
  const run = await api(`actions/runs/${runId}`);
  if (run.id !== Number(runId) || run.repository?.full_name !== "bentbrain/bent-mono" ||
    run.head_repository?.full_name !== "bentbrain/bent-mono") throw Error("Run does not belong to the personal repository.");
  const jobs = [];
  for (let page = 1; ; page++) {
    const result = await api(`actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(result.jobs) || page > 10) throw Error("Incomplete job inventory.");
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) break;
  }
  const failed = jobs.flatMap(job => (job.steps ?? []).filter(step => ["failure", "timed_out", "cancelled"].includes(step.conclusion))
    .map(step => ({ job: job.name, step: step.name, conclusion: step.conclusion })));
  return { schemaVersion: 1, runId: run.id, attempt: run.run_attempt, source: run.head_sha, status: run.status,
    conclusion: run.conclusion, url: `https://github.com/bentbrain/bent-mono/actions/runs/${run.id}`,
    jobs: jobs.map(job => ({ name: job.name, status: job.status, conclusion: job.conclusion,
      startedAt: job.started_at, completedAt: job.completed_at,
      currentStep: job.steps?.find(step => step.status === "in_progress")?.name })), failed,
    next: run.status !== "completed" ? "Wait for a status change; do not dispatch a competing release." :
      run.conclusion === "success" ? "Read the saved release evidence before choosing the next operation." :
        "Inspect the failed step and saved evidence. Fix deterministic failures locally; interrupted native mutations require recorded-pair inspection/recovery, not a rerun.",
    timings: runTimings(run, jobs), admissionGranted: false };
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { run: { type: "string" } } });
    const token = process.env.GH_TOKEN || execFileSync("gh", ["auth", "token", "--user", "bentbrain"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    console.log(JSON.stringify(await releaseStatus(githubApi({ token, repository: "bentbrain/bent-mono" }), values.run), null, 2));
  } catch { console.error("Could not read the personal Actions run. Check --run and personal GitHub authentication."); process.exitCode = 1; }
}
