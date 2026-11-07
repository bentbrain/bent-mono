import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi, requireReleaseChecks, validateReleaseEvent } from "./require-release-checks.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fail = message => { throw new Error(message); };
const identifiers = { team: /^team_[A-Za-z0-9-]+$/, prj: /^prj_[A-Za-z0-9-]+$/, dpl: /^dpl_[A-Za-z0-9-]+$/, chk: /^chk_[A-Za-z0-9-]+$/ };
const id = (value, prefix) => typeof value === "string" && identifiers[prefix].test(value);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function configurationHash(project, checks) {
  const fields = ["id", "accountId", "name", "rootDirectory", "nodeVersion", "framework", "sourceFilesOutsideRootDirectory",
    "installCommand", "buildCommand", "outputDirectory", "link", "env", "ssoProtection", "passwordProtection", "trustedIps", "trustedSources"];
  return createHash("sha256").update(canonical({ project: Object.fromEntries(fields.map(key => [key, project[key] ?? null])), checks })).digest("hex");
}

export function validateTarget({ app, config, project, deployment, sha, inspection = false }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !id(config.teamId, "team") || !id(config.projectId, "prj") ||
      !id(config.expectedProductionId, "dpl") || !id(config.requiredCheckId, "chk")) fail("Invalid protected release configuration.");
  if (project.id !== config.projectId || project.accountId !== config.teamId || project.name !== app.project ||
      project.rootDirectory !== app.directory || project.nodeVersion !== "24.x" || project.sourceFilesOutsideRootDirectory !== true ||
      project.link?.type !== "github" || project.link.org !== "bentbrain" || project.link.repo !== "bent-mono" ||
      project.link.productionBranch !== "main") fail("Vercel project does not match the monorepo application.");
  if (deployment.project?.id !== project.id || deployment.team?.id !== config.teamId || deployment.name !== project.name ||
      deployment.target !== "production" || deployment.readyState !== "READY" || deployment.nodeVersion !== "24.x" ||
      deployment.gitSource?.type !== "github" || deployment.gitSource.sha !== sha || deployment.gitSource.ref !== "main" ||
      deployment.gitSource.repoId !== project.link.repoId || deployment.meta?.githubCommitOrg !== "bentbrain" ||
      deployment.meta.githubCommitRepo !== "bent-mono" || deployment.meta.githubCommitSha !== sha) fail("Deployment is not the exact qualified production source.");
  if (project.targets?.production?.id !== config.expectedProductionId &&
      !(inspection && project.targets?.production?.id === deployment.id)) fail("Current production changed.");
}

export function validateRuntime(receipt, { app, deployment, sha, fingerprint, now = Date.now() }) {
  if (!receipt || typeof receipt !== "object") fail("A protected runtime qualification receipt is required.");
  const at = Date.parse(receipt.at);
  if (!Number.isFinite(at) || at > now || now - at > 24 * 60 * 60 * 1000 || receipt.app !== app.name ||
      receipt.deploymentId !== deployment.id || receipt.sourceRevision !== sha || receipt.configurationSha256 !== fingerprint ||
      receipt.runtimeQualified !== true) fail("Runtime qualification is missing, stale or bound to different inputs.");
  const required = app.name === "stay"
    ? ["hostPrivateGuide", "hostPhotos", "hostDraftEditorLoads", "guestGuidePhotos", "guestEditorDenied"] : ["applicationSmoke"];
  if (required.some(name => receipt.checks?.[name] !== true)) fail("Application runtime checks have not passed.");
}

function requiredPolicy(config, definitions) {
  if (!Array.isArray(definitions)) fail("Malformed Vercel check inventory.");
  const selected = definitions.filter(check => check.id === config.requiredCheckId);
  if (selected.length !== 1 || selected[0].name !== "Release qualification" || selected[0].source?.kind !== "git-provider" ||
      selected[0].source.provider !== "github" || selected[0].source.externalCheckName !== "Release qualification" ||
      selected[0].blocks !== "deployment-alias" || canonical(selected[0].targets) !== '["production"]' ||
      selected[0].projectId !== config.projectId || selected[0].ownerId !== config.teamId) fail("Required Vercel check policy changed.");
}

export function validateNativeChecks(config, definitions, runs, deployment) {
  requiredPolicy(config, definitions);
  if (!Array.isArray(runs)) fail("Malformed Vercel check inventory.");
  if (runs.some(run => !definitions.some(definition => definition.id === run.checkId))) fail("An unknown native check run requires investigation.");
  for (const definition of definitions.filter(check => check.blocks !== "none" && check.targets?.some(target => ["production", "all"].includes(target)))) {
    const matches = runs.filter(run => run.checkId === definition.id);
    // Manual staged releases validate the authoritative GitHub result directly.
    // Auto-assignment is disabled during staging, so its GitHub mirror may not exist.
    // An existing unsuccessful mirror, or any other missing blocking check, still stops release.
    if (definition.id === config.requiredCheckId && matches.length === 0) continue;
    if (matches.length !== 1 || matches[0].deploymentId !== deployment.id || matches[0].projectId !== config.projectId ||
        matches[0].ownerId !== config.teamId || matches[0].status !== "completed" || matches[0].conclusion !== "succeeded") {
      fail("A native blocking check is missing, ambiguous or unsuccessful.");
    }
  }
}

async function deploymentInventory(vercel, projectId) {
  const deployments = [];
  let until;
  for (let page = 0; page < 100; page++) {
    const result = await vercel(`/v6/deployments?projectId=${projectId}&target=production&limit=100${until ? `&until=${until}` : ""}`);
    if (!Array.isArray(result.deployments)) fail("Malformed production deployment inventory.");
    deployments.push(...result.deployments);
    if (!result.pagination?.next) return deployments;
    if (!Number.isSafeInteger(result.pagination.next) || result.pagination.next <= 0 ||
        (until && result.pagination.next >= until)) fail("Ambiguous production deployment pagination.");
    until = result.pagination.next;
  }
  fail("Production inventory exceeds the safe pagination limit.");
}

export async function protectedJson(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) fail("Release inputs must be private files owned by the operator.");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function releaseJournal(path) {
  const parent = await realpath(dirname(path));
  const metadata = await stat(parent);
  if (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0 ||
      parent === resolve(root) || parent.startsWith(`${resolve(root)}${sep}`)) {
    fail("Release journals require a private operator directory outside the source checkout.");
  }
  return open(path, "wx", 0o600);
}

export async function releaseVercel({ action, app, config, deploymentId, receipt, journalPath, sha }, { vercel, qualify, checkout }) {
  if (!["inspect", "stage", "promote"].includes(action) || app.platform !== "vercel" || !id(config.projectId, "prj") ||
      !id(config.teamId, "team") || !id(config.expectedProductionId, "dpl") || !id(config.requiredCheckId, "chk") ||
      (action !== "stage" && !id(deploymentId, "dpl")) ||
      (action !== "inspect" && (typeof journalPath !== "string" || !isAbsolute(journalPath)))) fail("Unsupported release target, journal or action.");
  await checkout(sha);
  const quality = await qualify(sha);
  const project = await vercel(`/v9/projects/${config.projectId}`);
  if (action === "stage") {
    if (project.id !== config.projectId || project.accountId !== config.teamId || project.name !== app.project ||
        project.rootDirectory !== app.directory || project.autoAssignCustomDomains !== false ||
        project.nodeVersion !== "24.x" || project.sourceFilesOutsideRootDirectory !== true || project.link?.type !== "github" ||
        project.targets?.production?.id !== config.expectedProductionId || project.link?.org !== "bentbrain" ||
        project.link.repo !== "bent-mono" || project.link.productionBranch !== "main") fail("Stage requires the frozen monorepo project with automatic assignment disabled.");
  }
  const definitions = await vercel(`/v2/projects/${config.projectId}/checks`);
  requiredPolicy(config, definitions.checks);
  const fingerprint = configurationHash(project, definitions.checks);
  let deployment;
  let nativeMirrorPresent;
  if (action !== "stage") {
    deployment = await vercel(`/v13/deployments/${deploymentId}?withGitRepoInfo=true`);
    validateTarget({ app, config, project, deployment, sha, inspection: action === "inspect" });
    const runs = await vercel(`/v2/deployments/${deploymentId}/check-runs`);
    validateNativeChecks(config, definitions.checks, runs.runs, deployment);
    nativeMirrorPresent = runs.runs.some(run => run.checkId === config.requiredCheckId);
    if (action === "promote") validateRuntime(receipt, { app, deployment, sha, fingerprint });
  }
  const report = { app: app.name, sha, deploymentId, configurationSha256: fingerprint, quality, nativeMirrorPresent,
    isCurrentProduction: project.targets?.production?.id === deploymentId };
  if (action === "inspect") return report;
  const inventory = await deploymentInventory(vercel, config.projectId);
  if (inventory.some(item =>
    ["INITIALIZING", "QUEUED", "BUILDING"].includes(item.state) ||
    (action === "promote" && item.created > deployment.createdAt))) fail("Production has concurrent or newer deployment work, or an incomplete inventory.");
  const finalProject = await vercel(`/v9/projects/${config.projectId}`);
  const finalDefinitions = await vercel(`/v2/projects/${config.projectId}/checks`);
  if (configurationHash(finalProject, finalDefinitions.checks) !== fingerprint ||
      finalProject.targets?.production?.id !== config.expectedProductionId ||
      finalProject.autoAssignCustomDomains !== false ||
      (finalProject.lastAliasRequest && finalProject.lastAliasRequest.jobStatus !== "success")) fail("Release settings or production changed during admission.");
  await checkout(sha);
  const finalQuality = await qualify(sha);
  if (canonical(finalQuality) !== canonical(quality)) fail("Quality qualification changed during admission.");
  if (action === "promote") {
    const finalRuns = await vercel(`/v2/deployments/${deploymentId}/check-runs`);
    validateNativeChecks(config, finalDefinitions.checks, finalRuns.runs, deployment);
    validateRuntime(receipt, { app, deployment, sha, fingerprint });
  }
  const handle = await releaseJournal(journalPath);
  try {
    await handle.writeFile(JSON.stringify({ ...report, action, at: new Date().toISOString(), status: "intent-recorded-no-retry" }) + "\n");
    await handle.sync();
    // Exactly one mutation. A timeout/HTTP error leaves the journal intact and
    // requires inspection, never an automatic retry or a force/alias fallback.
    const result = action === "stage"
      ? await vercel("/v13/deployments", "POST", { name: app.project, project: config.projectId, target: "production",
        gitSource: { type: "github", repoId: project.link.repoId, ref: "main", sha } })
      : await vercel(`/v10/projects/${config.projectId}/promote/${deploymentId}`, "POST", {});
    await handle.writeFile(JSON.stringify({ status: "accepted-readback-required", result }) + "\n");
    await handle.sync();
    return { ...report, status: "accepted-readback-required" };
  } finally { await handle.close(); }
}

async function vercelApi(path, method = "GET", body) {
  const token = process.env.VERCEL_TOKEN;
  const team = process.env.VERCEL_ORG_ID;
  if (!token || !id(team, "team") || !path.startsWith("/v")) fail("Scoped Vercel credentials are required.");
  const response = await fetch(`https://api.vercel.com${path}${path.includes("?") ? "&" : "?"}teamId=${team}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`Vercel request failed with HTTP ${response.status}; inspect any recorded release intent before retrying.`);
  return response.status === 204 ? {} : response.json();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!["--app", "--config", "--deployment", "--qualification", "--journal"].includes(name) ||
        !args[index + 1] || options[name]) fail("Usage: bun run release:vercel inspect|stage|promote --app <name> --config <private-file> [--deployment <id> --qualification <private-file> --journal <new-private-file>]");
    options[name] = args[index + 1];
  }
  const applications = JSON.parse(await readFile(new URL("../deployments.json", import.meta.url), "utf8")).applications;
  const app = applications.find(item => item.name === options["--app"] && item.platform === "vercel");
  if (!app) fail("Select a plain Vercel application from deployments.json; paired application releases retain their guarded routes.");
  const config = await protectedJson(options["--config"]);
  if (config.teamId !== process.env.VERCEL_ORG_ID) fail("Vercel credential scope and protected configuration disagree.");
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const sha = git(["rev-parse", "HEAD"]);
  validateReleaseEvent(process.env, process.env.GITHUB_ACTIONS === "true"
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : {}, sha);
  const checkout = async expected => {
    if (git(["rev-parse", "HEAD"]) !== expected || git(["status", "--porcelain", "--untracked-files=normal"])) fail("Release requires a clean exact-source checkout.");
  };
  console.log(JSON.stringify(await releaseVercel({ action, app, config, sha, deploymentId: options["--deployment"],
    receipt: options["--qualification"] ? await protectedJson(options["--qualification"]) : undefined,
    journalPath: options["--journal"] }, { vercel: vercelApi, qualify: sha => requireReleaseChecks(sha, githubApi), checkout })));
}
