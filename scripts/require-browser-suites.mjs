import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function workflowJobs(environment) {
  const repository = environment.GITHUB_REPOSITORY;
  const run = environment.GITHUB_RUN_ID;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !/^[1-9]\d*$/.test(run ?? "")
  )
    throw new Error("Browser validation requires a GitHub Actions run.");
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
      ],
      { encoding: "utf8", env: environment, timeout: 30_000 },
    ),
  );
  if (
    !Array.isArray(pages) ||
    !pages.every((page) => Array.isArray(page?.jobs))
  )
    throw new Error("Invalid GitHub Actions job response.");
  return pages.flatMap((page) => page.jobs);
}

export function requireBrowserSuites(environment, readJobs = workflowJobs) {
  const {
    SCOPE_RESULT,
    HAS_WORK,
    BROWSER_MATRIX,
    SUITE_RESULT,
    GITHUB_RUN_ID,
  } = environment;
  if (SCOPE_RESULT !== "success")
    throw new Error(`Browser selection ended with ${SCOPE_RESULT}.`);

  const { include } = JSON.parse(BROWSER_MATRIX);
  if (!Array.isArray(include)) throw new Error("Invalid browser matrix.");
  const names = include.map((entry) => entry?.name);
  if (
    names.some(
      (name) => typeof name !== "string" || !name.startsWith("Browser "),
    ) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("Invalid browser job names.");
  }
  if (names.length === 0 && HAS_WORK === "false" && SUITE_RESULT === "skipped")
    return "No browser suites selected.";
  if (!names.length || HAS_WORK !== "true" || SUITE_RESULT !== "success") {
    throw new Error(
      `Browser validation incomplete (work=${HAS_WORK}, suites=${SUITE_RESULT}).`,
    );
  }

  // A successful matrix result can omit a cancelled runner. Check each job
  // in the current run before reporting success to branch protection.
  const jobs = readJobs(environment);
  for (const name of names) {
    const matches = jobs.filter((job) => job?.name === name);
    if (matches.length !== 1)
      throw new Error(
        `Expected one result for ${name}, found ${matches.length}.`,
      );
    const [job] = matches;
    if (
      String(job.run_id) !== GITHUB_RUN_ID ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    ) {
      throw new Error(
        `${name} did not pass (${job.status}, ${job.conclusion}).`,
      );
    }
  }
  return `All ${names.length} selected browser jobs passed.`;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(requireBrowserSuites(process.env));
}
