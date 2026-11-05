import { appendFileSync } from "node:fs";

export function githubApi({ token, repository, fetcher = fetch }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    throw new Error("A GitHub token and owner/repository are required.");
  }
  return async (path) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub ${path.split("?")[0]} returned HTTP ${response.status}.`);
    }
    return response.json();
  };
}

export function output(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

export function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, process.env.GITHUB_ACTIONS === "true" && process.env.SHOP_EVIDENCE_ENCRYPTION_KEY
      ? "Protected release status recorded; full details are in encrypted diagnostics.\n"
      : `${message}\n`);
  }
}
