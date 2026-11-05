import { PRODUCT_ROOT, REPOSITORY_ROOT, releasePath } from "./monorepo-source.mjs";
import { applicationContractPath } from "./contract-consumers.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi, output, summary } from "./github-actions.mjs";

const allComponents = { web: true, api: true, renderer: true, lambda: true };
const webOnlyPreviewControlPaths = new Set([
  ".github/workflows/deploy.yml",
  "scripts/deployment-plan.mjs",
  "scripts/pipeline.test.mjs",
  "scripts/reuse-ci.mjs",
]);

export function changedComponents(paths) {
  const components = { web: false, api: false, renderer: false, lambda: false };
  for (const path of paths) {
    // The renderer serves these assets directly through its Wrangler binding.
    if (applicationContractPath(path)) {
      components.web = true;
      components.api = true;
    } else if (path.startsWith("apps/web/public/mockups/")) {
      components.web = true;
      components.renderer = true;
      components.lambda = true;
    } else if (path.startsWith("apps/web/")) {
      components.web = true;
    } else if (path.startsWith("workers/api/")) {
      components.api = true;
    } else if (path.startsWith("workers/video-renderer/")) {
      components.renderer = true;
      components.lambda = true;
    } else if (path.startsWith("infra/story-video-lambda/")) {
      components.lambda = true;
    } else if (path.startsWith("docs/") || ["README.md", "AGENTS.md", "CLAUDE.md"].includes(path)) {
      continue;
    } else {
      // Shared contracts, lockfiles, workflows and unknown paths are conservative.
      return { ...allComponents };
    }
  }
  return components;
}

export async function previousRelease({ api, environment, repository, runId }) {
  const deployments = await api(`deployments?environment=${environment}&task=deploy&per_page=100`);
  for (const deployment of deployments.sort((a, b) => b.id - a.id)) {
    if (deployment.environment !== environment || deployment.task !== "deploy") continue;
    const statuses = await api(`deployments/${deployment.id}/statuses?per_page=1`);
    const status = statuses[0];
    const prefix = `https://github.com/${repository}/actions/runs/`;
    const match = status?.log_url?.startsWith(prefix)
      ? status.log_url.slice(prefix.length).match(/^(\d+)(?:\/|$)/)
      : undefined;
    // The environment job creates its own deployment before this step starts.
    // A rerun of this release still compares all changes against its predecessor.
    if (match?.[1] === String(runId)) continue;
    if (!match || status.state !== "success") return undefined;
    const run = await api(`actions/runs/${match[1]}`);
    if (run.path !== ".github/workflows/deploy.yml" ||
        run.event !== "workflow_dispatch" || run.conclusion !== "success" ||
        run.head_sha !== deployment.sha) return undefined;
    return deployment.sha;
  }
  return undefined;
}

export function gitChanges(base, sha, cwd = PRODUCT_ROOT) {
  if (![base, sha].every((ref) => /^[a-f0-9]{40}$/.test(ref ?? ""))) return undefined;
  const directory = cwd instanceof URL ? fileURLToPath(cwd) : resolve(cwd);
  const repositoryDirectory = resolve(REPOSITORY_ROOT);
  const repositoryPaths = directory === repositoryDirectory || directory.startsWith(repositoryDirectory + sep);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", base, sha], { cwd: directory });
  if (ancestor.status !== 0) return undefined;
  // Disabling rename detection includes both deleted and added component paths.
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, sha], {
    cwd: directory, encoding: "utf8",
  }).split("\0").filter(Boolean).map(path => repositoryPaths ? releasePath(path) : path);
}

export async function deploymentPlan({ forceFull, changes = gitChanges, sha, ...context }) {
  if (forceFull) return { ...allComponents, reason: "Full deployment requested." };
  const base = await previousRelease(context);
  if (!base) {
    return { ...allComponents, reason: "No successful preceding release, or the previous deployment was incomplete." };
  }
  const paths = changes(base, sha);
  if (!paths) return { ...allComponents, reason: "Release history diverged or is unavailable." };
  return { ...changedComponents(paths), base, reason: `Compared against successful release ${base}.` };
}

export function webOnlyPreviewPlan({ base, environment, forceFull, paths, ref }) {
  if (environment !== "development") {
    throw new Error("Web-only Preview deployments require Development.");
  }
  if (forceFull) {
    throw new Error("Web-only Preview cannot be combined with a full deployment.");
  }
  if (!ref?.startsWith("refs/heads/")) {
    throw new Error("Web-only Preview deployments require a branch.");
  }
  if (!Array.isArray(paths)) {
    throw new Error("Web-only Preview requires a verified comparison with current main.");
  }
  if (ref === "refs/heads/main" && paths.length !== 0) {
    throw new Error("Main Preview requires the exact current main source.");
  }
  const blockedPaths = paths.filter((path) => {
    if (webOnlyPreviewControlPaths.has(path)) return false;
    return !path.startsWith("apps/web/") ||
      path.startsWith("apps/web/public/mockups/");
  });
  if (blockedPaths.length > 0) {
    throw new Error(
      `Web-only Preview cannot include these paths: ${blockedPaths.join(", ")}`,
    );
  }
  return {
    web: true,
    api: false,
    renderer: false,
    lambda: false,
    base,
    reason: `Web-only Preview compared with current main ${base}.`,
  };
}

if (import.meta.main) {
  const environment = { production: "Production", development: "Preview" }[process.env.DEPLOY_ENV];
  if (!environment) throw new Error("DEPLOY_ENV must be production or development.");
  if (process.env.DEPLOY_ENV === "production" && process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Production deployments require main.");
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const webOnlyPreview = process.env.WEB_ONLY_PREVIEW ?? "false";
  if (!["true", "false"].includes(webOnlyPreview)) {
    throw new Error("WEB_ONLY_PREVIEW must be true or false.");
  }
  const forceFull = process.env.FORCE_FULL === "true";
  let plan;
  if (webOnlyPreview === "true") {
    const base = execFileSync(
      "git",
      ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
      { encoding: "utf8" },
    ).trim();
    const paths = gitChanges(base, process.env.GITHUB_SHA);
    if (!paths) {
      throw new Error("Web-only Preview must contain current main.");
    }
    plan = webOnlyPreviewPlan({
      base,
      environment: process.env.DEPLOY_ENV,
      forceFull,
      paths,
      ref: process.env.GITHUB_REF,
    });
  } else {
    plan = await deploymentPlan({
      api: githubApi({ token: process.env.GH_TOKEN, repository }),
      environment,
      repository,
      runId: process.env.GITHUB_RUN_ID,
      sha: process.env.GITHUB_SHA,
      forceFull,
    });
  }
  for (const component of Object.keys(allComponents)) output(component, plan[component]);
  summary(`### Deployment plan\n${plan.reason}\n\n| Component | Action |\n| --- | --- |\n${
    Object.keys(allComponents).map((name) => `| ${name} | ${plan[name] ? (name === "lambda" ? "Native release gate required" : "Deploy") : "Unchanged"} |`).join("\n")
  }`);
}
