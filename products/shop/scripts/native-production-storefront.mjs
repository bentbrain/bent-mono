import { pathToFileURL } from "node:url";
import { assertProductionIdentityContext } from "./native-production-identity.mjs";

const PROJECT = "prj_qJ3JwcSlVixLNHRxfwnvfxp8dMBS", TEAM = "team_ru36uQa1rhHA6N5wW0lblUkz";
const check = (value, reason) => { if (!value) throw new Error(`Production storefront inspection stopped: ${reason}`); };

function inspectProject(project) {
  check(project?.id === PROJECT && project.accountId === TEAM && project.name === "forever-tee-web" &&
    ["apps/web", "products/shop/apps/web"].includes(project.rootDirectory), "project identity and inspection root.");
  check(project.link === null || project.link === undefined, "a Git connection could deploy outside the reviewed Actions workflow.");
  const target = project.targets?.production;
  check(typeof target?.id === "string" && /^dpl_[A-Za-z0-9]+$/.test(target.id) &&
    target.target === "production" && target.readyState === "READY" && typeof target.meta?.githubCommitSha === "string" &&
    /^[a-f0-9]{40}$/.test(target.meta.githubCommitSha), "existing Production deployment and source.");
  return { rootDirectory: project.rootDirectory, deploymentId: target.id, deployedSourceCommit: target.meta.githubCommitSha };
}

function verifyCanonicalAlias(alias, deploymentId) {
  check(alias?.alias === "shop.bent.build" && alias.projectId === PROJECT && alias.deploymentId === deploymentId &&
    (alias.redirect === null || alias.redirect === undefined) && (alias.deletedAt === null || alias.deletedAt === undefined),
  "canonical domain must point directly to the exact existing Production deployment and project.");
}

export async function inspectProductionStorefront(env = process.env, request = fetch) {
  assertProductionIdentityContext(env);
  check(env.VERCEL_PROJECT_ID === PROJECT && env.VERCEL_ORG_ID === TEAM &&
    typeof env.VERCEL_TOKEN === "string" && env.VERCEL_TOKEN.length > 0, "exact personal project configuration.");
  const token = env.VERCEL_TOKEN, inspectionSourceCommit = env.GITHUB_SHA, runId = env.GITHUB_RUN_ID;
  const read = async resource => {
    // Both destinations are fixed provider reads scoped to the same personal team.
    const url = resource === "project" ? `https://api.vercel.com/v9/projects/${PROJECT}?teamId=${TEAM}` :
      `https://api.vercel.com/v4/aliases/shop.bent.build?teamId=${TEAM}`;
    let response;
    try {
      response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}` } });
    } catch {
      check(false, "Vercel read failed; response content omitted.");
    }
    check(response.ok, `read returned HTTP ${response.status}.`);
    try { return await response.json(); }
    catch { check(false, "Vercel read was not valid JSON; response content omitted."); }
  };
  const observed = inspectProject(await read("project"));
  // The dedicated alias API is authoritative. Embedded deployment aliases may be empty.
  verifyCanonicalAlias(await read("alias"), observed.deploymentId);
  const repeated = inspectProject(await read("project"));
  check(repeated.rootDirectory === observed.rootDirectory && repeated.deploymentId === observed.deploymentId &&
    repeated.deployedSourceCommit === observed.deployedSourceCommit, "project root or Production target changed during inspection.");
  verifyCanonicalAlias(await read("alias"), observed.deploymentId);
  // Project responses may contain environment configuration. Never return or
  // log the full response, deployment metadata, or arbitrary settings.
  return { productionStorefrontInspected: true, projectId: PROJECT, teamId: TEAM, ...observed,
    gitConnected: false, domain: "shop.bent.build", inspectionSourceCommit, runId,
    applicationMutations: false, nativePromotionReady: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.info(JSON.stringify(await inspectProductionStorefront())); }
  catch (error) { console.error(error instanceof Error && error.message.startsWith("Production storefront inspection stopped:")
    ? error.message : "Production storefront inspection failed; response content was not logged."); process.exitCode = 1; }
}
