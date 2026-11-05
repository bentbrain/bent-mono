import { reusePrValidation } from "./reuse-pr-validation.mjs";
import { reuseComponentValidation } from "./reuse-component-validation.mjs";
import { setTimeout } from "node:timers/promises";
import { githubApi, output, summary } from "./github-actions.mjs";

export function selectCiRun(runs, { sha, repository, branch }) {
  return runs.filter((run) =>
    run.head_sha === sha &&
    run.head_branch === branch &&
    run.head_repository?.full_name === repository &&
    (run.event === "push" || run.event === "pull_request") &&
    run.path === ".github/workflows/ci.yml" &&
    run.conclusion !== "skipped"
  ).sort((a, b) => b.id - a.id)[0];
}

// Prefer existing main receipts. Otherwise independently verify a merged PR
// against protected pre-execution runtime evidence and GitHub Git objects.
export async function reuseMainValidation(input) {
  return await reuseComponentValidation(input) ?? await reusePrValidation(input);
}

export async function reuseCi({
  api, sha, repository, branch, currentRunId, trustedMain = false,
  sleep = setTimeout, now = Date.now, timeoutMs = 20 * 60_000,
}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const result = await api(`actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
    const run = selectCiRun(result.workflow_runs, { sha, repository, branch });
    if (!run) return trustedMain ? reuseMainValidation({ api, sha, repository, branch, currentRunId }) : undefined;
    if (run.status === "completed") {
      if (run.conclusion !== "success") {
        throw new Error(`CI run ${run.id} finished with ${run.conclusion}. Release blocked.`);
      }
      const { jobs } = await api(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      if (!jobs.some((job) => job.name === "check" && job.conclusion === "success")) {
        throw new Error(`CI run ${run.id} has no successful check job. Release blocked.`);
      }
      return trustedMain && branch === "main" ? reuseMainValidation({api,sha,repository,branch,currentRunId}) : run.id;
    }
    if (now() >= deadline) throw new Error(`Timed out waiting for CI run ${run.id}. Release blocked.`);
    console.log(`Waiting for CI run ${run.id} for ${sha}.`);
    await sleep(15_000);
  }
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = await reuseCi({
    api: githubApi({ token: process.env.GH_TOKEN, repository }),
    sha: process.env.GITHUB_SHA,
    branch: process.env.GITHUB_REF_NAME,
    repository,
    currentRunId: process.env.GITHUB_RUN_ID,
    trustedMain: true,
  });
  output("reused", Boolean(runId));
  summary(runId
    ? `Reused trusted validation with matching source and build inputs: https://github.com/${repository}/actions/runs/${runId}`
    : "No trusted validation with matching source and build inputs. Running the full repository checks with caching.");
}
